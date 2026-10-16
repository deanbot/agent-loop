#!/usr/bin/env node
/**
 * Poll a PR for new review signals and emit them by type.
 *
 * Usage:
 *   node scripts/pr-poll.mjs --repo owner/repo --pr <number> [--require-qa] [--wait [secs] [--max secs]]
 *
 * Output — signal lines then content blocks, exits when done (with --wait: the first output that is
 * news, see lib/wait.mjs):
 *   NONE <timestamp>            no new signals since last run
 *   NEW_COMMENT                 new PR-level discussion comment(s); content follows
 *   NEW_REVIEW_SUBMISSION       new formal review (approve/request-changes/comment); content follows
 *   NEW_INLINE_COMMENT          new line-level review comment(s); content follows
 *   CI_FAILING                  a CI check failed or was cancelled on the current head; emitted once per
 *                               distinct failure set (re-emitted when a re-run fails again); content follows
 *   MERGE_READY                 [reviewer] LGTM posted after last commit + CI passing (+ [qa] PASS with --require-qa); no content block
 *   MERGED                      PR is merged; executor should stop
 *
 * Content block format (after each signal line):
 *   ---
 *   author: <login>
 *   [state: <APPROVED|CHANGES_REQUESTED|...>]   (review submissions only)
 *   [path: <file>  line: <n>]                   (inline comments only)
 *   <body>
 *
 * CI_FAILING content block:
 *   ---
 *   check: <name>  state: <state>
 *   <link>
 *
 * --require-qa: MERGE_READY additionally requires the QA verdict to be PASS. Without it the QA role is
 * optional: a live [qa] BLOCKED is still surfaced as NEW_COMMENT, but no [qa] PASS is needed.
 *
 * A role's verdict is its NEWEST [role] comment posted after the last commit: a later finding revokes
 * an earlier LGTM/PASS without a push. Reviewer comment kinds by prefix: "[reviewer] LGTM" (verdict),
 * "[reviewer] Question" (for the operator; not actionable for the executor), anything else is a
 * finding. "[reviewer] Verified" (a 0.2 draft kind) is tolerated the same way; a "[reviewer] Reviewing
 * (<clone>)" claim is ignored. CI is evaluated here only: if the checks cannot be read (auth, network, old gh), MERGE_READY
 * is withheld and the error is passed through on stderr; "no checks reported" counts as no CI.
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-poll-<pr>.json across sessions, one file
 * per PR so two executors never write the same file: { comments, reviews, reviewComments,
 * ciFailedKey } last-seen IDs. A PR with no file yet takes its entry from the shared file earlier
 * versions kept (<owner>-<repo>-pr-poll-state.json, keyed by PR number), which is left alone.
 */

import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { runSignalScript, usageError } from './lib/wait.mjs'

const USAGE = 'pr-poll.mjs --repo owner/repo --pr <number> [--require-qa] [--wait [secs] [--max secs]]'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? (process.argv[i + 1] ?? null) : null
}
function flag(name) {
  return process.argv.includes(name)
}

const repo = arg('--repo')
const prNumber = arg('--pr')
const requireQa = flag('--require-qa')

if (!repo || !prNumber) usageError(USAGE)
if (!/^\d+$/.test(prNumber)) usageError(USAGE, `--pr: expected a PR number, got "${prNumber}"`)

// `gh api --paginate` prints one JSON document per page; `--slurp` wraps them in one array (gh ≥ 2.43).
function ghApiAll(gh, path) {
  const pages = JSON.parse(gh(`gh api --paginate --slurp "${path}"`))
  return pages.flat()
}

const repoSlug = repo.replace('/', '-')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, `${repoSlug}-pr-poll-${prNumber}.json`)
const SHARED_STATE_FILE = path.join(STATE_DIR, `${repoSlug}-pr-poll-state.json`)

mkdirSync(STATE_DIR, { recursive: true })

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function pass({ gh, save, dry }) {
  let prState = readJson(STATE_FILE)
  if (prState === undefined) prState = readJson(SHARED_STATE_FILE)?.[prNumber]

  // Migrate state written by the initial pr-poll.mjs version (plain databaseId number → typed object)
  if (typeof prState === 'number') {
    prState = { comments: prState, reviews: null, reviewComments: null }
  } else if (!prState) {
    prState = { comments: null, reviews: null, reviewComments: null }
  }

  // Check PR state first — exit early if merged
  const pr = JSON.parse(gh(`gh api "repos/${repo}/pulls/${prNumber}"`))
  if (pr.merged) return 'MERGED\n'
  const headSha = pr.head?.sha ?? null

  // Fetch all three signal sources via REST API
  // A reviewer's "[reviewer] Reviewing (<clone>)" claim (several reviewers, pr-watch.mjs) is neither a
  // verdict nor a finding: nothing for the executor, so it is dropped before anything reads the thread.
  const issueComments = ghApiAll(gh, `repos/${repo}/issues/${prNumber}/comments`).filter(
    (c) => !/^\[reviewer\] Reviewing \(/.test(c.body ?? '')
  )
  const reviewSubmissions = ghApiAll(gh, `repos/${repo}/pulls/${prNumber}/reviews`)
  const inlineComments = ghApiAll(gh, `repos/${repo}/pulls/${prNumber}/comments`)

  // CI checks. bucket is gh's normalised status: pass | fail | pending | skipping | cancel.
  // `gh pr checks` exits non-zero with "no checks reported" when the PR has none — that is "no CI
  // configured" (empty list). Any other failure (auth, network, rate limit, an older gh without these
  // JSON fields) is UNKNOWN: returned as null so MERGE_READY is withheld (fail closed), with gh's
  // stderr passed through so the failure is visible to whoever runs the loop.
  function fetchChecks() {
    try {
      const raw = gh(
        `gh pr checks ${prNumber} --repo ${repo} --json name,state,bucket,link,completedAt`,
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const parsed = JSON.parse(raw || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch (e) {
      const stderr = String(e?.stderr ?? '')
      if (/no checks reported/i.test(stderr)) return []
      if (!dry) process.stderr.write(`pr-poll: could not read CI checks (MERGE_READY withheld): ${stderr.trim() || e?.message}\n`)
      return null
    }
  }
  const checks = fetchChecks()
  const failingChecks = (checks ?? []).filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
  const ciPassed = checks !== null && checks.every((c) => c.bucket === 'pass' || c.bucket === 'skipping')

  // First run: seed cursors to current max IDs and emit nothing.
  // Only subsequent runs emit NEW_* signals for activity since last check.
  const firstComments = prState.comments === null
  const firstReviews = prState.reviews === null
  const firstInline = prState.reviewComments === null

  // Seed to 0 when the list is empty: leaving the cursor null would make every poll a "first run"
  // until something is posted, and then swallow that first comment as baseline.
  if (firstComments) prState.comments = issueComments.at(-1)?.id ?? 0
  if (firstReviews) prState.reviews = reviewSubmissions.at(-1)?.id ?? 0
  if (firstInline) prState.reviewComments = inlineComments.at(-1)?.id ?? 0

  // Own-prefix filter: this script serves the executor, so the executor's own [executor] posts are
  // never a signal (same rule as pr-watch.mjs for [reviewer] and pr-qa.mjs for [qa]). Cursors still
  // advance past them below.
  const isOwn = (b) => /^\[executor\]/.test(b ?? '')

  // Filter to new items only
  const newComments = firstComments
    ? []
    : issueComments.filter((c) => c.id > prState.comments && !isOwn(c.body))

  const newReviews = (firstReviews
    ? []
    : reviewSubmissions.filter((r) => r.id > prState.reviews)
  ).filter((r) => r.state !== 'PENDING')

  const newInline = firstInline
    ? []
    : inlineComments.filter((c) => c.id > prState.reviewComments && !isOwn(c.body))

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
  const reviewerComments = issueComments.filter((c) => /^\[reviewer\]/.test(c.body ?? ''))
  const qaComments = issueComments.filter((c) => /^\[qa\]/.test(c.body ?? ''))
  const isLgtm = (b) => /^\[reviewer\] LGTM/.test(b ?? '')
  const isQaPass = (b) => /^\[qa\] PASS/.test(b ?? '')
  // "[reviewer] Question …" (a question for the operator) is not a finding: nothing for the executor
  // to do, so it must not re-surface as a live blocker. Reviewer → executor communication is always
  // findings; reviewer → operator is Question. "Verified" is a retired kind, tolerated for old threads.
  const isReviewerFinding = (b) =>
    /^\[reviewer\]/.test(b ?? '') && !isLgtm(b) && !/^\[reviewer\] (Verified|Question)\b/.test(b ?? '')
  const isQaBlocked = (b) => /^\[qa\] BLOCKED/.test(b ?? '')
  const blockingCandidates = issueComments.filter((c) => isQaBlocked(c.body) || isReviewerFinding(c.body))

  // Fetch the last commit date once if any verdict (positive or negative) needs liveness checking.
  let lastCommitDate = null
  if (reviewerComments.length > 0 || qaComments.length > 0) {
    const commits = ghApiAll(gh, `repos/${repo}/pulls/${prNumber}/commits`)
    lastCommitDate = new Date(commits.at(-1)?.commit?.committer?.date ?? 0)
  }

  // Surface live blocking verdicts even if the cursor has already passed them (mirrors
  // unansweredInline). Re-surfaces each poll until a fix push makes the verdict stale.
  // NOTE: the reviews API path (firstReviews → seed) has the same first-run swallow, but in
  // single-account mode the reviewer posts [reviewer] comments, not formal CHANGES_REQUESTED
  // reviews, so the issue-comment path above is the one that matters. Operator (unprefixed)
  // comments present at first poll are not covered here — the commit-based liveness rule fits
  // verdicts, not free-form operator direction.
  // "Addressed" = an [executor] comment posted after the verdict (the executor has engaged:
  // a fix push, an answer, or a clarifying question). Without this, a [reviewer] comment or
  // question that needs no commit would never go stale (no superseding commit) and would
  // re-surface every poll, thrashing the loop. The guard is safe: an [executor] comment can
  // only post-date a verdict the executor already saw, so it never hides an unaddressed one.
  const lastExecutorId = issueComments.filter((c) => /^\[executor\]/.test(c.body ?? '')).at(-1)?.id ?? 0
  const liveBlocking = blockingCandidates.filter(
    (c) => c.id > lastExecutorId && lastCommitDate && new Date(c.created_at) > lastCommitDate
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

  // CI_FAILING — once per distinct failure set on a head commit. The key is the head sha plus the
  // failing checks' names and completion times, so a new push, a re-run that fails again, or a
  // different check failing later on the same head is reported, while an unchanged failing head is
  // not re-reported every poll.
  const ciFailedKey = failingChecks.length > 0 && headSha
    ? `${headSha}:${failingChecks.map((c) => `${c.name}@${c.completedAt ?? ''}`).sort().join(',')}`
    : null
  if (ciFailedKey && prState.ciFailedKey !== ciFailedKey) {
    out.push('CI_FAILING')
    for (const c of failingChecks) {
      out.push(`---\ncheck: ${c.name}  state: ${c.state}\n  ${c.link ?? ''}`)
    }
    prState.ciFailedKey = ciFailedKey
  }

  // Check merge threshold: the reviewer's NEWEST comment after the last commit is an LGTM (and with
  // --require-qa, QA's newest is a PASS), + CI passing. Comments predating new commits are stale —
  // agents must re-approve after each push — and a later finding from the same role revokes its
  // earlier approval even without a push.
  const newestAfterCommit = (list) =>
    lastCommitDate ? list.filter((c) => new Date(c.created_at) > lastCommitDate).at(-1) : undefined
  const hasReviewerLgtm = isLgtm(newestAfterCommit(reviewerComments)?.body)
  const hasQaPass = isQaPass(newestAfterCommit(qaComments)?.body)
  const qaSatisfied = requireQa ? hasQaPass : true
  if (hasReviewerLgtm && qaSatisfied && unansweredInline.length === 0 && ciPassed) {
    out.push('MERGE_READY')
  }

  // Persist state only after all signals are collected.
  // Use Math.max, not .at(-1): liveBlocking / unansweredInline append cursor-independent items
  // that may be older than the newest, so .at(-1) could regress the cursor and re-emit comments.
  // Own [executor] posts were filtered out of newComments/newInline, so also advance past the newest
  // item of each list — otherwise an own post would sit above the cursor and never be skipped.
  prState.comments = Math.max(prState.comments ?? 0, ...newComments.map((c) => c.id), issueComments.at(-1)?.id ?? 0)
  if (newReviews.length > 0)
    prState.reviews = Math.max(prState.reviews ?? 0, ...newReviews.map((r) => r.id))
  prState.reviewComments = Math.max(prState.reviewComments ?? 0, ...newInline.map((c) => c.id), inlineComments.at(-1)?.id ?? 0)
  save(JSON.stringify(prState))

  return out.length === 0 ? `NONE ${new Date().toISOString()}\n` : out.join('\n') + '\n'
}

await runSignalScript({ argv: process.argv, usage: USAGE, stateFile: STATE_FILE, pass })
