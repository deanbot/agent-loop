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
 * [executor] and [reviewer] comments do not trigger re-evaluation (executor fixes
 * produce SHA changes; reviewer findings are irrelevant to A.C. evaluation).
 *
 * Usage:
 *   node scripts/pr-qa.mjs --repo owner/repo [--skip <n,n,...>]
 *
 * Output — one line, then exits:
 *   NONE <timestamp>         no PRs changed since last run
 *   QA_READY:<n>             PR has new commits or new operator comments; needs A.C. evaluation
 *   MERGE_CONFLICT:<n>       PR has new commits but branch conflicts with base
 *
 * Multiple signals space-separated on one line.
 *
 * State persisted to ~/.agent-loop/state/<owner>-<repo>-pr-qa-state.json
 * State format: { [prNumber]: { sha: string, lastComment: number | null } }
 *   lastComment — cursor for issues/{n}/comments; tracks operator comments only
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
  process.stderr.write('Usage: pr-qa.mjs --repo owner/repo [--skip <n,n,...>]\n')
  process.exit(1)
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

let state = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  // no prior state
}

const prs = JSON.parse(
  execSync(`gh pr list --repo ${repo} --json number,headRefOid,mergeable --limit 50`, { encoding: 'utf8' })
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
    const comments = JSON.parse(
      execSync(`gh api "repos/${repo}/issues/${number}/comments"`, { encoding: 'utf8' })
    )
    entry.lastComment = comments.length > 0 ? comments.at(-1).id : (entry.lastComment ?? 0)
  } else {
    // No new commits — check for new operator (unprefixed) comments.
    // These may be manual-verification confirmations for observation-required items.
    const comments = JSON.parse(
      execSync(`gh api "repos/${repo}/issues/${number}/comments"`, { encoding: 'utf8' })
    )
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

// Remove state for PRs no longer open
const openNumbers = new Set(prs.map((p) => String(p.number)))
for (const key of Object.keys(state)) {
  if (!openNumbers.has(key)) delete state[key]
}

writeFileSync(STATE_FILE, JSON.stringify(state))

const signals = [
  ...mergeConflicts.map((n) => `MERGE_CONFLICT:${n}`),
  ...qaReady.map((n) => `QA_READY:${n}`),
]

if (signals.length === 0) {
  process.stdout.write(`NONE ${new Date().toISOString()}\n`)
} else {
  process.stdout.write(signals.join(' ') + '\n')
}
