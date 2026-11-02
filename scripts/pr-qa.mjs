#!/usr/bin/env node
/**
 * Watch open PRs for new commits or operator comments that need QA evaluation.
 *
 * SCOPE: single-account mode. QA agent reads acceptance criteria from issue and
 * project conventions, maps each criterion to evidence, posts [qa] PASS or [qa] BLOCKED.
 *
 * Two triggers per PR:
 *   SHA change    — new commits; always triggers QA_READY
 *   Operator comment (unprefixed) — may be manual-verification confirmation for
 *                   observation-required items; triggers QA_READY so QA can re-evaluate
 *
 * [qa] own posts are not tracked as operator comments (own prefix filtered).
 * A comment counts only from a trusted author (#151): `trusted-authors`, else
 * `allow-author-associations`, in the block on the default branch. An outsider's unprefixed comment
 * is not the operator confirming a criterion, so it triggers nothing. QA reads the thread through
 * pr-thread.mjs, which drops the same comments. A run that can't read the block prints NONE and keeps
 * its state (everything withheld); a waiter logs it and retries.
 * [executor] and [reviewer] comments do not trigger re-evaluation (executor fixes
 * produce SHA changes; reviewer findings are irrelevant to A.C. evaluation).
 *
 * Usage:
 *   node scripts/pr-qa.mjs --repo owner/repo [--skip <n,n,...>] [--idle-after <n>] [--wait [secs] [--max secs] [--inbox <folder>]]
 *
 * Output — one line, then exits (with --wait: the first line that is news, see lib/wait.mjs):
 *   NONE <timestamp>         no PRs changed since last run
 *   QA_READY:<n>             PR has new commits or new operator comments; needs A.C. evaluation
 *   MERGE_CONFLICT:<n>       PR has new commits but branch conflicts with base
 *   CLOSED:<n>               PR the script was tracking is no longer open (merged or closed); emitted once
 *
 * Multiple signals space-separated on one line. With --idle-after <n>, a run that is the n-th or later
 * in a row to bring nothing new adds a second line, IDLE <count> (lib/wait.mjs).
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-qa-state.json
 * State format: { [prNumber]: { sha: string, lastComment: number | null } }
 *   lastComment — cursor for issues/{n}/comments; tracks operator comments only
 */

import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { runSignalScript, usageError } from './lib/wait.mjs'
import { fetchAgents, trustedItems, REPO_NAME } from './lib/block.mjs'

const USAGE = 'pr-qa.mjs --repo owner/repo [--skip <n,n,...>] [--idle-after <n>] [--wait [secs] [--max secs] [--inbox <folder>]]'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? (process.argv[i + 1] ?? null) : null
}

const repo = arg('--repo')
if (!repo) usageError(USAGE)
if (!REPO_NAME.test(repo)) usageError(USAGE, `--repo: expected owner/repo, got "${repo}"`)

// The default branch's AGENTS.md text, or null when it can't be read. Kept once read. A waiter's
// pass (dry) throws instead, so the failure is logged and retried, never a silent NONE.
let agentsText
function readAgents(gh, dry) {
  if (agentsText !== undefined) return agentsText
  try {
    agentsText = fetchAgents(gh, repo)
  } catch (e) {
    if (dry) throw e
    process.stderr.write(`pr-qa: could not read the Agent loop block (signals withheld): ${e.message}\n`)
    return null
  }
  return agentsText
}

// `gh api --paginate` prints one JSON document per page; `--slurp` wraps them in one array (gh ≥ 2.43).
function ghApiAll(gh, path) {
  const pages = JSON.parse(gh(`gh api --paginate --slurp "${path}"`))
  return pages.flat()
}

const repoSlug = repo.replace('/', '-')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, `${repoSlug}-pr-qa-state.json`)

mkdirSync(STATE_DIR, { recursive: true })

const skip = new Set(
  (arg('--skip') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
)

function pass({ gh, save, dry }) {
  // Whose comments are the operator's comes from the block (#151). Without it nothing here can be
  // decided safely, so the run withholds everything and keeps the state for the next one.
  const agents = readAgents(gh, dry)
  if (agents === null) return `NONE ${new Date().toISOString()}\n`
  const commentsOf = (number) => trustedItems(agents, ghApiAll(gh, `repos/${repo}/issues/${number}/comments`))
  let state = {}
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    // no prior state
  }

  const prs = JSON.parse(
    gh(`gh pr list --repo ${repo} --json number,headRefOid,mergeable --limit 50`)
  )

  const qaReady = []
  const mergeConflicts = []

  for (const { number, headRefOid, mergeable } of prs) {
    if (skip.has(number)) {
      state[number] = { sha: headRefOid, lastComment: state[number]?.lastComment ?? null }
      continue
    }

    if (!state[number]) state[number] = { sha: null, lastComment: null }
    const entry = state[number]

    const shaChanged = entry.sha !== headRefOid
    if (shaChanged) {
      entry.sha = headRefOid
      if (mergeable === 'CONFLICTING') {
        mergeConflicts.push(number)
      } else {
        qaReady.push(number)
      }
      // Seed comment cursor when SHA changes — prevents pre-existing comments from
      // re-firing as QA_READY on the next cycle after a commit.
      const comments = commentsOf(number)
      entry.lastComment = comments.length > 0 ? comments.at(-1).id : (entry.lastComment ?? 0)
    } else {
      // No new commits — check for new operator (unprefixed) comments.
      // These may be manual-verification confirmations for observation-required items.
      const comments = commentsOf(number)
      if (entry.lastComment === null) {
        // First comment tracking run — seed cursor, emit nothing.
        entry.lastComment = comments.length > 0 ? comments.at(-1).id : 0
      } else {
        const newOperator = comments.filter(
          (c) => c.id > entry.lastComment && !/^\[/.test(c.body ?? '')
        )
        if (newOperator.length > 0) {
          qaReady.push(number)
          entry.lastComment = comments.length > 0 ? comments.at(-1).id : entry.lastComment
        }
      }
    }
  }

  // PRs the script was tracking that are no longer open (merged or closed): say so once, then forget them.
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
    ...qaReady.map((n) => `QA_READY:${n}`),
  ]

  return signals.length === 0 ? `NONE ${new Date().toISOString()}\n` : signals.join(' ') + '\n'
}

await runSignalScript({ argv: process.argv, usage: USAGE, stateFile: STATE_FILE, pass })
