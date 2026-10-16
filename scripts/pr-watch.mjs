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
 * treated as meaningful signals. The exception: an [executor] comment older than the reviewer's
 * newest post was already read (the reviewer re-reads the thread immediately before posting).
 *
 * Usage:
 *   node scripts/pr-watch.mjs --repo owner/repo [--skip <n,n,...>] [--reviewer <clone> [--stale-after <secs>]]
 *                             [--wait [secs] [--max secs]]
 *   node scripts/pr-watch.mjs --repo owner/repo --reviewer <clone> --check-claim <n> [--stale-after <secs>]
 *
 * Several reviewers (--reviewer <clone>): each reviewer claims a PR with a "[reviewer] Reviewing
 * (<clone>)" comment before its first post on it, and handles only the PRs it holds or that nobody
 * holds. The holder: claims in id order, the first one holds; a later claim by another clone takes
 * over only if the holder was stale at that moment (no non-claim [reviewer] comment since the later
 * of the head commit and the holder's claim, for longer than --stale-after, default 1800s). A
 * holder that is stale now holds nothing: the PR is open to every reviewer. A PR another reviewer
 * holds yields no signal and is dropped from this reviewer's state (no CLOSED for it). State is per
 * reviewer, <owner>-<repo>-pr-state-<clone>.json. --check-claim <n> prints MINE, THEIRS <clone> or
 * OPEN for one PR and exits without touching state. Without --reviewer nothing here applies.
 * Claim comments never count as a reviewer post.
 *
 * Output — one line, then exits (with --wait: the first line that is news, see lib/wait.mjs):
 *   NONE <timestamp>              no PRs changed since last run
 *   REVIEW:<n>                    PR has new commits; ready for code review
 *   MERGE_CONFLICT:<n>            PR has new commits but branch has merge conflicts
 *   REVIEW_COMMENTS:<n>           PR has new operator (unprefixed) comments or inline review comments
 *   CLOSED:<n>                    PR the script was tracking is no longer open (merged or closed); emitted once
 *
 * Multiple signals are space-separated on one line.
 * REVIEW:<n> takes precedence over REVIEW_COMMENTS:<n> for the same PR.
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-state.json across sessions.
 * State format: { [prNumber]: { sha: string, lastComment: number | null, lastReviewComment: number | undefined } }
 *   lastComment       — cursor for issues/{n}/comments (timeline comments)
 *   lastReviewComment — cursor for pulls/{n}/comments (inline diff review comments)
 *
 * On first encounter of a PR, CHANGES_REQUESTED review suppresses the signal — the PR
 * already has a blocking review. A new commit re-triggers normally.
 */

import { readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import path from 'path'
import { runSignalScript, usageError } from './lib/wait.mjs'

const USAGE =
  'pr-watch.mjs --repo owner/repo [--skip <n,n,...>] [--reviewer <clone> [--stale-after <secs>] [--check-claim <n>]] [--wait [secs] [--max secs]]'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? (process.argv[i + 1] ?? null) : null
}

const repo = arg('--repo')
if (!repo) usageError(USAGE)

// `gh api --paginate` prints one JSON document per page; `--slurp` wraps them in one array (gh ≥ 2.43).
function ghApiAll(gh, path) {
  const pages = JSON.parse(gh(`gh api --paginate --slurp "${path}"`))
  return pages.flat()
}

const reviewer = arg('--reviewer')
if (process.argv.includes('--reviewer') && !/^[A-Za-z0-9._-]+$/.test(reviewer ?? ''))
  usageError(USAGE, `--reviewer: expected a clone name, got "${reviewer ?? ''}"`)
const checkClaim = arg('--check-claim')
if (process.argv.includes('--check-claim') && (!reviewer || !/^\d+$/.test(checkClaim ?? '')))
  usageError(USAGE, '--check-claim needs a PR number and --reviewer')
const staleArg = arg('--stale-after')
if (process.argv.includes('--stale-after') && !/^\d+$/.test(staleArg ?? ''))
  usageError(USAGE, `--stale-after: expected seconds, got "${staleArg ?? ''}"`)
const STALE_MS = Number(staleArg ?? 1800) * 1000

const repoSlug = repo.replace('/', '-')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, reviewer ? `${repoSlug}-pr-state-${reviewer}.json` : `${repoSlug}-pr-state.json`)

mkdirSync(STATE_DIR, { recursive: true })

const skip = new Set(
  (arg('--skip') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
)

const CLAIM = /^\[reviewer\] Reviewing \(([^)]+)\)/
const isClaim = (c) => CLAIM.test(c.body ?? '')
const isReviewerPost = (c) => /^\[reviewer\]/.test(c.body ?? '') && !isClaim(c)

// The clone that holds a PR, or null when nobody does (see the header).
function claimHolder(comments, commits, now) {
  const time = (c) => Date.parse(c.created_at)
  const posts = comments.filter(isReviewerPost).map(time)
  const commitTimes = commits.map((c) => Date.parse(c.commit?.committer?.date)).filter((t) => !Number.isNaN(t))
  const headAt = (at) => Math.max(-Infinity, ...commitTimes.filter((t) => t <= at))
  const stale = (claim, at) => {
    const start = Math.max(headAt(at), time(claim))
    return !posts.some((t) => t > start && t <= at) && at - start > STALE_MS
  }
  let holder = null
  for (const c of comments.filter(isClaim).sort((a, b) => a.id - b.id)) {
    const clone = c.body.match(CLAIM)[1]
    if (!holder || clone === holder.clone || stale(holder.claim, time(c))) holder = { clone, claim: c }
  }
  return holder && !stale(holder.claim, now) ? holder.clone : null
}

function holderOf(gh, number) {
  return claimHolder(
    ghApiAll(gh, `repos/${repo}/issues/${number}/comments`),
    ghApiAll(gh, `repos/${repo}/pulls/${number}/commits`),
    Date.now()
  )
}

function pass({ gh, save }) {
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
    gh(`gh pr list --repo ${repo} --json number,headRefOid,mergeable --limit 50`)
  )

  const toReview = []
  const mergeConflicts = []
  const reviewComments = []

  for (const { number, headRefOid, mergeable } of prs) {
    if (skip.has(number)) {
      state[number] = { sha: headRefOid, lastComment: state[number]?.lastComment ?? null }
      continue
    }

    if (reviewer) {
      const holder = holderOf(gh, number)
      if (holder && holder !== reviewer) {
        delete state[number]
        continue
      }
    }

    if (!state[number]) state[number] = { sha: null, lastComment: null }
    const entry = state[number]
    const isNew = entry.sha === null

    // SHA check
    const shaChanged = entry.sha !== headRefOid
    if (shaChanged) {
      const prData = JSON.parse(gh(`gh pr view ${String(number)} --repo ${repo} --json reviewDecision`))
      entry.sha = headRefOid
      if (!(isNew && prData.reviewDecision === 'CHANGES_REQUESTED')) {
        if (mergeable === 'CONFLICTING') {
          mergeConflicts.push(number)
        } else {
          toReview.push(number)
        }
      }
      // Advance comment cursors — reviewer reads thread during REVIEW, so seeding here
      // prevents pre-REVIEW comments from re-firing as REVIEW_COMMENTS next run.
      const comments = ghApiAll(gh, `repos/${repo}/issues/${number}/comments`)
      const inlineComments = ghApiAll(gh, `repos/${repo}/pulls/${number}/comments`)
      entry.lastComment = comments.length > 0 ? comments.at(-1).id : (entry.lastComment ?? 0)
      entry.lastReviewComment = inlineComments.length > 0 ? inlineComments.at(-1).id : (entry.lastReviewComment ?? 0)
    } else {
      // No new commits — check for new non-reviewer comments (timeline + inline review)
      const comments = ghApiAll(gh, `repos/${repo}/issues/${number}/comments`)
      const inlineComments = ghApiAll(gh, `repos/${repo}/pulls/${number}/comments`)
      const hasReviewerPost = comments.some(isReviewerPost)
      if (!hasReviewerPost) {
        // Reviewer has never posted — PR needs initial review regardless of session
        if (mergeable === 'CONFLICTING') {
          mergeConflicts.push(number)
        } else {
          toReview.push(number)
        }
        entry.lastComment = comments.length > 0 ? comments.at(-1).id : 0
        entry.lastReviewComment = inlineComments.length > 0 ? inlineComments.at(-1).id : 0
      } else if (entry.lastComment === null) {
        // First comment tracking run — seed cursors, emit nothing
        entry.lastComment = comments.length > 0 ? comments.at(-1).id : 0
        entry.lastReviewComment = inlineComments.length > 0 ? inlineComments.at(-1).id : 0
      } else {
        // The reviewer re-reads the thread and the inline threads immediately before it posts, so an
        // [executor] comment older than its newest post was already read, even when it landed after
        // this script's last run (the executor's "Pushed fix" note, loom#72). Operator and [qa]
        // comments stay news whenever unseen: one landing between that re-read and the post would
        // otherwise be lost. Timeline ids are one sequence; inline comments have their own, so they
        // compare by time (a tie, or no timestamp, counts as news).
        const own = [...comments, ...inlineComments].filter(isReviewerPost)
        const ownLastId = Math.max(0, ...own.filter((c) => comments.includes(c)).map((c) => c.id))
        const ownLastAt = Math.max(-Infinity, ...own.map((c) => Date.parse(c.created_at)).filter((t) => !Number.isNaN(t)))
        const isExecutor = (c) => /^\[executor\]/.test(c.body ?? '')
        const newNonAgent = comments.filter(
          (c) =>
            c.id > entry.lastComment &&
            !(isExecutor(c) && c.id < ownLastId) &&
            !/^\[reviewer\]/.test(c.body ?? '')
        )
        const lastReviewComment = entry.lastReviewComment ?? 0
        const newInlineNonAgent = inlineComments.filter(
          (c) =>
            c.id > lastReviewComment &&
            !(isExecutor(c) && Date.parse(c.created_at) < ownLastAt) &&
            !/^\[reviewer\]/.test(c.body ?? '')
        )
        // Surface unanswered top-level inline comments even if cursor has passed them
        const replyToIds = new Set(inlineComments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id))
        const unansweredInline = inlineComments.filter(
          (c) =>
            !c.in_reply_to_id &&
            !/^\[reviewer\]/.test(c.body ?? '') &&
            !/^\[executor\]/.test(c.body ?? '') &&
            !replyToIds.has(c.id) &&
            !newInlineNonAgent.some((n) => n.id === c.id)
        )
        if (newNonAgent.length > 0 || newInlineNonAgent.length > 0 || unansweredInline.length > 0) {
          reviewComments.push(number)
          entry.lastComment = comments.length > 0 ? comments.at(-1).id : entry.lastComment
          entry.lastReviewComment = inlineComments.length > 0 ? inlineComments.at(-1).id : lastReviewComment
        }
      }
    }
  }

  // PRs the script was tracking that are no longer open (merged or closed): say so once, then forget
  // them. Without this a merged PR silently vanishes and the agent's status never acknowledges it.
  const openNumbers = new Set(prs.map((p) => String(p.number)))
  const closed = []
  for (const key of Object.keys(state)) {
    if (!openNumbers.has(key)) {
      closed.push(Number(key))
      delete state[key]
    }
  }

  save(JSON.stringify(state))

  const signals = [
    ...closed.sort((a, b) => a - b).map((n) => `CLOSED:${n}`),
    ...mergeConflicts.map((n) => `MERGE_CONFLICT:${n}`),
    ...toReview.map((n) => `REVIEW:${n}`),
    ...reviewComments.map((n) => `REVIEW_COMMENTS:${n}`),
  ]

  return signals.length === 0 ? `NONE ${new Date().toISOString()}\n` : signals.join(' ') + '\n'
}

if (checkClaim) {
  const holder = holderOf((cmd) => execSync(cmd, { encoding: 'utf8' }), checkClaim)
  process.stdout.write(holder === null ? 'OPEN\n' : holder === reviewer ? 'MINE\n' : `THEIRS ${holder}\n`)
} else {
  await runSignalScript({ argv: process.argv, usage: USAGE, stateFile: STATE_FILE, pass })
}
