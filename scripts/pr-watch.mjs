#!/usr/bin/env node
/**
 * Watch open PRs for SHA changes and new operator comments.
 *
 * SCOPE: single-account mode — one GitHub user runs both executor and reviewer agents.
 * Comment roles:
 *   unprefixed       — operator (product owner); always triggers REVIEW_COMMENTS
 *   [executor]       — developer agent; answers reviewer questions, triggers REVIEW_COMMENTS
 *   [reviewer]       — this agent's own posts; filtered out to prevent ping-pong loops
 *
 * Only [reviewer] comments are suppressed. All other comments (including [executor]) are
 * treated as meaningful signals.
 *
 * Usage:
 *   node scripts/pr-watch.mjs --repo owner/repo [--skip <n,n,...>]
 *
 * Output — one line, then exits:
 *   NONE <timestamp>              no PRs changed since last run
 *   REVIEW:<n>                    PR has new commits; ready for code review
 *   MERGE_CONFLICT:<n>            PR has new commits but branch has merge conflicts
 *   REVIEW_COMMENTS:<n>           PR has new operator (unprefixed) comments
 *
 * Multiple signals are space-separated on one line.
 * REVIEW:<n> takes precedence over REVIEW_COMMENTS:<n> for the same PR.
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-state.json across sessions.
 * State format: { [prNumber]: { sha: string, lastComment: number | null } }
 *
 * On first encounter of a PR, CHANGES_REQUESTED review suppresses the signal — the PR
 * already has a blocking review. A new commit re-triggers normally.
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
if (!repo) {
  process.stderr.write('Usage: pr-watch.mjs --repo owner/repo [--skip <n,n,...>]\n')
  process.exit(1)
}

const repoSlug = repo.replace('/', '-')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, `${repoSlug}-pr-state.json`)

mkdirSync(STATE_DIR, { recursive: true })

const skip = new Set(
  (arg('--skip') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
)

let state = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  // no prior state
}

// Migrate old state format: { [n]: sha_string } → { [n]: { sha, lastComment: null } }
for (const key of Object.keys(state)) {
  if (typeof state[key] === 'string') {
    state[key] = { sha: state[key], lastComment: null }
  }
}

const prs = JSON.parse(
  execSync(`gh pr list --repo ${repo} --json number,headRefOid,mergeable --limit 50`, { encoding: 'utf8' })
)

const toReview = []
const mergeConflicts = []
const reviewComments = []

for (const { number, headRefOid, mergeable } of prs) {
  if (skip.has(number)) {
    state[number] = { sha: headRefOid, lastComment: state[number]?.lastComment ?? null }
    continue
  }

  if (!state[number]) state[number] = { sha: null, lastComment: null }
  const entry = state[number]
  const isNew = entry.sha === null

  // SHA check
  const shaChanged = entry.sha !== headRefOid
  if (shaChanged) {
    const prData = JSON.parse(
      execSync(
        `gh pr view ${String(number)} --repo ${repo} --json reviewDecision`,
        { encoding: 'utf8' }
      )
    )
    entry.sha = headRefOid
    if (!(isNew && prData.reviewDecision === 'CHANGES_REQUESTED')) {
      if (mergeable === 'CONFLICTING') {
        mergeConflicts.push(number)
      } else {
        toReview.push(number)
      }
    }
    // Advance comment cursor — reviewer reads thread during REVIEW, so seeding here
    // prevents pre-REVIEW comments from re-firing as REVIEW_COMMENTS next run.
    const comments = JSON.parse(
      execSync(`gh api "repos/${repo}/issues/${number}/comments"`, { encoding: 'utf8' })
    )
    entry.lastComment = comments.length > 0 ? comments.at(-1).id : (entry.lastComment ?? 0)
  } else {
    // No new commits — check for new non-reviewer comments
    const comments = JSON.parse(
      execSync(`gh api "repos/${repo}/issues/${number}/comments"`, { encoding: 'utf8' })
    )
    const hasReviewerPost = comments.some((c) => /^\[reviewer\]/.test(c.body ?? ''))
    if (!hasReviewerPost) {
      // Reviewer has never posted — PR needs initial review regardless of session
      if (mergeable === 'CONFLICTING') {
        mergeConflicts.push(number)
      } else {
        toReview.push(number)
      }
      entry.lastComment = comments.length > 0 ? comments.at(-1).id : 0
    } else if (entry.lastComment === null) {
      // First comment tracking run — seed cursor, emit nothing
      entry.lastComment = comments.length > 0 ? comments.at(-1).id : 0
    } else {
      const newNonAgent = comments.filter(
        (c) => c.id > entry.lastComment && !/^\[reviewer\]/.test(c.body ?? '')
      )
      if (newNonAgent.length > 0) {
        reviewComments.push(number)
        entry.lastComment = comments.at(-1).id
      }
    }
  }
}

// Remove state for PRs no longer open (merged or closed)
const openNumbers = new Set(prs.map((p) => String(p.number)))
for (const key of Object.keys(state)) {
  if (!openNumbers.has(key)) delete state[key]
}

writeFileSync(STATE_FILE, JSON.stringify(state))

const signals = [
  ...mergeConflicts.map((n) => `MERGE_CONFLICT:${n}`),
  ...toReview.map((n) => `REVIEW:${n}`),
  ...reviewComments.map((n) => `REVIEW_COMMENTS:${n}`),
]

if (signals.length === 0) {
  process.stdout.write(`NONE ${new Date().toISOString()}\n`)
} else {
  process.stdout.write(signals.join(' ') + '\n')
}
