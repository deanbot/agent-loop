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
 *                             [--needs-operator-label <name>] [--idle-after <n>] [--wait [secs] [--max secs] [--inbox <folder>]]
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
 *   MERGE_CONFLICT:<n>            PR has new commits but branch has merge conflicts, or (standing) it carries
 *                                 the needs-operator label and conflicts with its base: a PR that was ready
 *                                 and fell into conflict when main moved. Repeated every run until the label
 *                                 is off or the conflict is gone, whether or not an executor holds the PR.
 *   REVIEW_COMMENTS:<n>           PR has new operator (unprefixed) comments or inline review comments
 *   CLOSED:<n>                    PR the script was tracking is no longer open (merged or closed); emitted once
 *   CI_DONE:<n>                   only with `review-waits-for-ci: on` in the Agent loop block of AGENTS.md on the
 *                                 default branch: a check on the PR's head (any commit status or check run)
 *                                 reached a final state since the last run (success, failure, error, cancelled,
 *                                 skipped, …; a rerun that finishes again counts again). Not for a head first
 *                                 seen this run: REVIEW covers a push. The reviewer reads the checks itself.
 *                                 A block that can't be read withholds it for that run (a pr-watch: line on
 *                                 stderr) and reports it on the next run that reads the block.
 *
 * Multiple signals are space-separated on one line. With --idle-after <n>, a run that is the n-th or
 * later in a row to bring nothing new (no state change, the same signals as the run before) adds a
 * second line, IDLE <count> (lib/wait.mjs).
 * REVIEW:<n> takes precedence over REVIEW_COMMENTS:<n> for the same PR.
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-state.json across sessions.
 * State format: { [prNumber]: { sha: string, lastComment: number | null, lastReviewComment: number | undefined,
 *   ci: { [check]: state } | undefined } }
 *   ci                — the head's check states at the last run (CI_DONE)
 *   lastComment       — cursor for issues/{n}/comments (timeline comments)
 *   lastReviewComment — cursor for pulls/{n}/comments (inline diff review comments)
 *
 * --needs-operator-label <name> (default needs-operator): the label the standing MERGE_CONFLICT looks for.
 *
 * On first encounter of a PR, CHANGES_REQUESTED review suppresses the signal — the PR
 * already has a blocking review. A new commit re-triggers normally.
 */

import { readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import path from 'path'
import { runSignalScript, usageError } from './lib/wait.mjs'
import { blockValue, fetchAgents } from './lib/block.mjs'

const USAGE =
  'pr-watch.mjs --repo owner/repo [--skip <n,n,...>] [--reviewer <clone> [--stale-after <secs>] [--check-claim <n>]] [--needs-operator-label <name>] [--idle-after <n>] [--wait [secs] [--max secs] [--inbox <folder>]]'

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
const needsOperatorLabel = arg('--needs-operator-label')
if (process.argv.includes('--needs-operator-label') && !needsOperatorLabel)
  usageError(USAGE, '--needs-operator-label: expected a label name')
const NEEDS_OPERATOR = needsOperatorLabel ?? 'needs-operator'

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

// The default branch's AGENTS.md text, or null when it can't be read. Kept once read: the block
// changes rarely, and a waiter would otherwise fetch it every interval.
let agentsText
function readAgents(gh, dry) {
  if (agentsText !== undefined) return agentsText
  try {
    agentsText = fetchAgents(gh, repo)
  } catch (e) {
    if (!dry) process.stderr.write(`pr-watch: could not read the Agent loop block (CI_DONE withheld): ${e.message}\n`)
    return null
  }
  return agentsText
}

// The head's checks as { key: state }: every commit status by context and every check run by
// workflow and name, from the PR list's statusCheckRollup. A check run that isn't completed, and a
// status that is PENDING or EXPECTED, is PENDING; any other state is final. Two entries under one
// key (the same job name twice in a workflow) give their states sorted and joined.
function ciStates(rollup) {
  const byKey = {}
  for (const c of rollup ?? []) {
    const run = c.__typename === 'CheckRun'
    const key = run ? `check:${c.workflowName ?? ''}/${c.name}` : `status:${c.context}`
    const s = run ? (c.status === 'COMPLETED' ? c.conclusion || 'COMPLETED' : 'PENDING') : c.state === 'EXPECTED' ? 'PENDING' : c.state || 'PENDING'
    ;(byKey[key] ??= []).push(s)
  }
  return Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.sort().join(',')]))
}
const isFinal = (s) => !s.split(',').includes('PENDING')

function pass({ gh, save, dry }) {
  // review-waits-for-ci: on → CI_DONE (the header). null: the block couldn't be read this run.
  const agents = readAgents(gh, dry)
  const waitsForCi = agents === null ? null : blockValue(agents, 'review-waits-for-ci')?.toLowerCase() === 'on'
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
    gh(`gh pr list --repo ${repo} --json number,headRefOid,mergeable,labels,statusCheckRollup --limit 50`)
  )

  const toReview = []
  const mergeConflicts = []
  const reviewComments = []
  const ciDone = []

  for (const { number, headRefOid, mergeable, labels, statusCheckRollup } of prs) {
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
      // A standing conflict on a PR in the operator's inbox as ready: main moved under an unchanged
      // head (#48). Nobody else may report it: with no executor polling, pr-poll never runs. Reported
      // whether or not an executor holds the PR (an executor that polls sees it as well), until the
      // reviewer takes the label off or the conflict goes. The comment checks below still run.
      const labelled = (labels ?? []).some((l) => l.name === NEEDS_OPERATOR)
      if (hasReviewerPost && labelled && mergeable === 'CONFLICTING') mergeConflicts.push(number)
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
        // this script's last run (the executor's "Pushed fix" note). Operator and [qa]
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

    // CI_DONE: a check on the head reached a final state since the last run. A new head, a PR seen
    // for the first time and a state from before this signal existed are recorded silently: REVIEW
    // covers a push. A standing REVIEW (no reviewer post yet) does not suppress it: a first review
    // held for CI is the case it exists for. Only final states are stored, so a check that appears
    // or stays pending changes no state (a state change wakes a waiter and resets the idle count),
    // while a re-run drops its key and its next finish counts again. With the key off nothing is
    // stored, so the state is what it was before this signal existed, and turning the key on seeds
    // silently: only what finishes after is reported. Left as it was when the block couldn't be
    // read, so the next run still reports it; a new head is seeded even then.
    const ci = Object.fromEntries(Object.entries(ciStates(statusCheckRollup)).filter(([, s]) => isFinal(s)))
    if (waitsForCi === false) delete entry.ci
    else if (shaChanged || entry.ci === undefined) entry.ci = ci
    else if (waitsForCi) {
      if (Object.entries(ci).some(([k, s]) => entry.ci[k] !== s)) ciDone.push(number)
      entry.ci = ci
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
    ...ciDone.map((n) => `CI_DONE:${n}`),
  ]

  return signals.length === 0 ? `NONE ${new Date().toISOString()}\n` : signals.join(' ') + '\n'
}

if (checkClaim) {
  const holder = holderOf((cmd) => execSync(cmd, { encoding: 'utf8' }), checkClaim)
  process.stdout.write(holder === null ? 'OPEN\n' : holder === reviewer ? 'MINE\n' : `THEIRS ${holder}\n`)
} else {
  await runSignalScript({ argv: process.argv, usage: USAGE, stateFile: STATE_FILE, pass })
}
