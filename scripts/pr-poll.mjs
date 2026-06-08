#!/usr/bin/env node
/**
 * Poll a PR for new review signals and emit them by type.
 *
 * Usage:
 *   node scripts/pr-poll.mjs --repo owner/repo --pr <number>
 *
 * Output — signal lines then content blocks, exits when done:
 *   NONE <timestamp>            no new signals since last run
 *   NEW_COMMENT                 new PR-level discussion comment(s); content follows
 *   NEW_REVIEW_SUBMISSION       new formal review (approve/request-changes/comment); content follows
 *   NEW_INLINE_COMMENT          new line-level review comment(s); content follows
 *   MERGE_READY                 [reviewer] LGTM + [qa] PASS both posted after last commit + CI passing; no content block
 *   MERGED                      PR is merged; executor should stop
 *
 * Content block format (after each signal line):
 *   ---
 *   author: <login>
 *   [state: <APPROVED|CHANGES_REQUESTED|...>]   (review submissions only)
 *   [path: <file>  line: <n>]                   (inline comments only)
 *   <body>
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-poll-state.json across sessions.
 * Keyed by PR number → { comments, reviews, reviewComments } last-seen IDs.
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? (process.argv[i + 1] ?? null) : null
}

const repo = arg('--repo')
const prNumber = arg('--pr')

if (!repo || !prNumber) {
  process.stderr.write('Usage: pr-poll.mjs --repo owner/repo --pr <number>\n')
  process.exit(1)
}

const repoSlug = repo.replace('/', '-')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, `${repoSlug}-pr-poll-state.json`)

mkdirSync(STATE_DIR, { recursive: true })

let state = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  // no prior state
}

// Migrate state written by the initial pr-poll.mjs version (plain databaseId number → typed object)
let prState = state[prNumber]
if (typeof prState === 'number') {
  prState = { comments: prState, reviews: null, reviewComments: null }
} else if (!prState) {
  prState = { comments: null, reviews: null, reviewComments: null }
}

// Check PR state first — exit early if merged
const pr = JSON.parse(
  execSync(`gh api "repos/${repo}/pulls/${prNumber}"`, { encoding: 'utf8' })
)
if (pr.merged) {
  process.stdout.write('MERGED\n')
  process.exit(0)
}

// Fetch all three signal sources via REST API
const issueComments = JSON.parse(
  execSync(
    `gh api --paginate "repos/${repo}/issues/${prNumber}/comments"`,
    { encoding: 'utf8' }
  )
)
const reviewSubmissions = JSON.parse(
  execSync(
    `gh api --paginate "repos/${repo}/pulls/${prNumber}/reviews"`,
    { encoding: 'utf8' }
  )
)
const inlineComments = JSON.parse(
  execSync(
    `gh api --paginate "repos/${repo}/pulls/${prNumber}/comments"`,
    { encoding: 'utf8' }
  )
)

// First run: seed cursors to current max IDs and emit nothing.
// Only subsequent runs emit NEW_* signals for activity since last check.
const firstComments = prState.comments === null
const firstReviews = prState.reviews === null
const firstInline = prState.reviewComments === null

if (firstComments && issueComments.length > 0) prState.comments = issueComments.at(-1).id
if (firstReviews && reviewSubmissions.length > 0) prState.reviews = reviewSubmissions.at(-1).id
if (firstInline && inlineComments.length > 0) prState.reviewComments = inlineComments.at(-1).id

// Filter to new items only
const newComments = firstComments
  ? []
  : issueComments.filter((c) => c.id > prState.comments)

const newReviews = (firstReviews
  ? []
  : reviewSubmissions.filter((r) => r.id > prState.reviews)
).filter((r) => r.state !== 'PENDING')

const newInline = firstInline
  ? []
  : inlineComments.filter((c) => c.id > prState.reviewComments)

// Surface unanswered top-level inline comments even if cursor has already passed them.
// A top-level comment is unanswered if no other comment has in_reply_to_id pointing to it.
const replyToIds = new Set(inlineComments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id))
const unansweredInline = inlineComments.filter(
  (c) =>
    !c.in_reply_to_id &&
    !/^\[reviewer\]/.test(c.body ?? '') &&
    !/^\[executor\]/.test(c.body ?? '') &&
    !replyToIds.has(c.id)
)
for (const c of unansweredInline) {
  if (!newInline.some((n) => n.id === c.id)) newInline.push(c)
}

// --- Review verdicts (cursor-independent) ---
// LGTM / PASS / BLOCKED / reviewer findings describe the PR's *current* state, not one-off
// events, so evaluate them fresh each poll regardless of the comment cursor. This is what lets
// a [qa] BLOCKED / [reviewer] finding posted in the gap before the executor's first poll survive:
// first-run baseline seeding (intentional, to skip resolved history on a state wipe) would
// otherwise swallow it as "pre-existing". Inline comments (unansweredInline) and positive verdicts
// (MERGE_READY below) already ignore the cursor; negative verdicts were the lone asymmetry.
// "Live" = newer than the last commit — a fix push supersedes the verdict until the agent re-runs.
const lgtmComments = issueComments.filter((c) => (c.body ?? '').startsWith('[reviewer] LGTM'))
const qaPassComments = issueComments.filter((c) => (c.body ?? '').startsWith('[qa] PASS'))
const isReviewerFinding = (b) => /^\[reviewer\]/.test(b ?? '') && !/^\[reviewer\] LGTM/.test(b ?? '')
const isQaBlocked = (b) => /^\[qa\] BLOCKED/.test(b ?? '')
const blockingCandidates = issueComments.filter((c) => isQaBlocked(c.body) || isReviewerFinding(c.body))

// Fetch the last commit date once if any verdict (positive or negative) needs liveness checking.
let lastCommitDate = null
if (lgtmComments.length > 0 || qaPassComments.length > 0 || blockingCandidates.length > 0) {
  const commits = JSON.parse(
    execSync(`gh api --paginate "repos/${repo}/pulls/${prNumber}/commits"`, { encoding: 'utf8' })
  )
  lastCommitDate = new Date(commits.at(-1)?.commit?.committer?.date ?? 0)
}

// Surface live blocking verdicts even if the cursor has already passed them (mirrors
// unansweredInline). Re-surfaces each poll until a fix push makes the verdict stale.
// NOTE: the reviews API path (firstReviews → seed) has the same first-run swallow, but in
// single-account mode the reviewer posts [reviewer] comments, not formal CHANGES_REQUESTED
// reviews, so the issue-comment path above is the one that matters. Operator (unprefixed)
// comments present at first poll are not covered here — the commit-based liveness rule fits
// verdicts, not free-form operator direction.
const liveBlocking = blockingCandidates.filter(
  (c) => lastCommitDate && new Date(c.created_at) > lastCommitDate
)
for (const c of liveBlocking) {
  if (!newComments.some((n) => n.id === c.id)) newComments.push(c)
}

// Indent body lines so signal keywords inside comment text don't confuse loop parsers
function indentBody(body) {
  return (body ?? '').split('\n').map((l) => `  ${l}`).join('\n')
}

const out = []

if (newComments.length > 0) {
  out.push('NEW_COMMENT')
  for (const c of newComments) {
    out.push(`---\nauthor: ${c.user.login}\n${indentBody(c.body)}`)
  }
}

if (newReviews.length > 0) {
  out.push('NEW_REVIEW_SUBMISSION')
  for (const r of newReviews) {
    const meta = `---\nauthor: ${r.user.login}\nstate: ${r.state}`
    out.push(r.body ? `${meta}\n${indentBody(r.body)}` : meta)
  }
}

if (newInline.length > 0) {
  out.push('NEW_INLINE_COMMENT')
  for (const c of newInline) {
    const line = c.line ?? c.original_line ?? '?'
    out.push(`---\nauthor: ${c.user.login}\nid: ${c.id}\npath: ${c.path}  line: ${line}\n${indentBody(c.body)}`)
  }
}

// Check merge threshold: [reviewer] LGTM + [qa] PASS both posted AFTER the last commit + CI passing.
// Comments predating new commits are stale — both agents must re-approve after each push.
// lgtmComments / qaPassComments / lastCommitDate are computed above with the other verdicts.
const lastLgtm = lgtmComments.at(-1)
const lastQaPass = qaPassComments.at(-1)
let hasReviewerLgtm = false
let hasQaPass = false
if (lastCommitDate) {
  if (lastLgtm) hasReviewerLgtm = new Date(lastLgtm.created_at) > lastCommitDate
  if (lastQaPass) hasQaPass = new Date(lastQaPass.created_at) > lastCommitDate
}
if (hasReviewerLgtm && hasQaPass && unansweredInline.length === 0) {
  const checks = JSON.parse(
    execSync(
      `gh pr checks ${prNumber} --repo ${repo} --json name,state`,
      { encoding: 'utf8' }
    )
  )
  const failStates = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'failure', 'error'])
  const pendingStates = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'pending', 'in_progress', 'queued'])
  const ciPassed =
    checks.length === 0 ||
    checks.every((c) => !failStates.has(c.state) && !pendingStates.has(c.state))
  if (ciPassed) {
    out.push('MERGE_READY')
  }
}

// Persist state only after all signals are collected.
// Use Math.max, not .at(-1): liveBlocking / unansweredInline append cursor-independent items
// that may be older than the newest, so .at(-1) could regress the cursor and re-emit comments.
if (newComments.length > 0)
  prState.comments = Math.max(prState.comments ?? 0, ...newComments.map((c) => c.id))
if (newReviews.length > 0)
  prState.reviews = Math.max(prState.reviews ?? 0, ...newReviews.map((r) => r.id))
if (newInline.length > 0)
  prState.reviewComments = Math.max(prState.reviewComments ?? 0, ...newInline.map((c) => c.id))
state[prNumber] = prState
writeFileSync(STATE_FILE, JSON.stringify(state))

if (out.length === 0) {
  process.stdout.write(`NONE ${new Date().toISOString()}\n`)
} else {
  process.stdout.write(out.join('\n') + '\n')
}
