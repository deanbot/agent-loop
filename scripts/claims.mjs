#!/usr/bin/env node
/**
 * Whether this clone holds an issue: the executor's claim check when it resumes (#129). Its line is
 * what the resume step branches on, so the check can't be skipped and the step still be followed.
 *
 * Usage:
 *   node scripts/claims.mjs --repo owner/repo --issue <N> --clone <clone>
 *                           [--in-progress-label <l>] [--blocked-label <l>]
 *
 * Output, one line, exit 0, the first that applies:
 *   CLAIM_CLOSED          the issue is closed
 *   CLAIM_BLOCKED         it carries the blocked label (parked)
 *   CLAIM_RELEASED        open without the in-progress label: nobody holds it (released on a stop,
 *                         or never claimed); claim it again before any work
 *   CLAIM_HELD            open, in progress, and its newest "[executor] Claimed by" comment names
 *                         <clone> exactly
 *   CLAIM_LOST <clone>    open, in progress, and the newest claim names another clone (`(unnamed)`
 *                         when the text after the marker is not exactly one clone name)
 *   CLAIM_NONE            open, in progress, and no claim comment at all (claimed before claim
 *                         comments existed): the caller's own word decides
 * A losing claim is deleted (spec: "Claim comments"), so the newest one left is the holder's.
 * Only a trusted author's claim counts (#134): `trusted-authors` in the `## Agent loop` block of
 * AGENTS.md on the default branch (the contents API, never the clone's copy), or, when it lists
 * nobody, `allow-author-associations` (default OWNER, MEMBER, COLLABORATOR). Anyone else's claim is
 * ignored as if it weren't there; an executor whose own login isn't trusted never sees its claim.
 * A block that can't be read is a failed call (exit 2).
 * Labels default to in-progress and is-blocked. A failed gh call (an issue that doesn't exist
 * included): `claims: <message>` on stderr, exit 2. A usage error: exit 1.
 *
 * The claim race (spec: "Claim comments"), right after the executor posts its claim:
 *   node scripts/claims.mjs --repo owner/repo --issue <N> --race <your claim's comment id>
 * one line, exit 0, and never a comment's text (#153: anyone can post "[executor] Claimed by …"
 * with more lines after it):
 *   RACE_WON              of the trusted claims, yours and those posted no more than 10 minutes
 *                         before it (by created_at), yours has the lowest id
 *   RACE_LOST             another of them has a lower id
 *   RACE_UNTRUSTED <login>  your claim's author isn't trusted, so its claims never count
 *   RACE_UNKNOWN          no claim with that id on the issue (deleted, or a wrong id)
 * Only a trusted author's claim takes part, by the same rule as above.
 */

import { execFileSync, execSync } from 'child_process'
import { fetchAgents, trustTest, REPO_NAME } from './lib/block.mjs'

const USAGE = 'claims.mjs --repo owner/repo --issue <N> (--clone <clone> [--in-progress-label <l>] [--blocked-label <l>] | --race <comment id>)'
const OPTIONS = ['--repo', '--issue', '--clone', '--in-progress-label', '--blocked-label', '--race']

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) usageError(`${name}: expected a value`)
  return v
}

for (let i = 2; i < process.argv.length; i++) {
  if (OPTIONS.includes(process.argv[i])) i++
  else usageError(`unexpected argument "${process.argv[i]}"`)
}

const repo = arg('--repo')
if (!repo || !REPO_NAME.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const issueArg = arg('--issue')
if (!issueArg || !/^#?\d+$/.test(issueArg)) usageError(issueArg ? `--issue: expected an issue number, got "${issueArg}"` : '--issue is required')
const issue = issueArg.replace(/^#/, '')
const CLONE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const race = arg('--race')
if (race !== null && !/^\d+$/.test(race)) usageError(`--race: expected a comment id, got "${race}"`)
if (race !== null && ['--clone', '--in-progress-label', '--blocked-label'].some((o) => process.argv.includes(o))) usageError('--race takes only --repo and --issue')
const clone = arg('--clone')
if (race === null && (!clone || !CLONE.test(clone))) usageError(clone ? `--clone: expected a clone name, got "${clone}"` : '--clone is required')
const inProgress = arg('--in-progress-label') ?? 'in-progress'
const blocked = arg('--blocked-label') ?? 'is-blocked'

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')

const MARKER = '[executor] Claimed by '

function decide() {
  const found = gh('api', `repos/${repo}/issues/${issue}`)
  const labels = (found?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name))
  if (found?.state !== 'open') return 'CLAIM_CLOSED'
  if (labels.includes(blocked)) return 'CLAIM_BLOCKED'
  if (!labels.includes(inProgress)) return 'CLAIM_RELEASED'
  // A claim is text anyone who can comment can post: only a trusted author's counts (#134), whom the
  // block on the default branch names, never the clone's copy. An unreadable block decides nothing.
  const trusted = trustTest(fetchAgents((cmd, opts) => execSync(cmd, { ...opts, encoding: 'utf8' }), repo))
  const comments = gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments`).flat()
  const newest = comments.filter((c) => (c.body ?? '').startsWith(MARKER) && trusted(c)).sort((a, b) => a.id - b.id).at(-1)
  if (!newest) return 'CLAIM_NONE'
  const holder = newest.body.slice(MARKER.length).trim()
  if (holder === clone) return 'CLAIM_HELD'
  // The name is comment text anyone can write: print it only when the whole of it is one clone name,
  // so "exec-a and more" never prints this clone's own name.
  return `CLAIM_LOST ${CLONE.test(holder) ? holder : '(unnamed)'}`
}

// The race after a claim: decided on ids, times and trust alone, so no comment text is printed.
const RACE_WINDOW_MS = 10 * 60 * 1000
function raceResult() {
  const trusted = trustTest(fetchAgents((cmd, opts) => execSync(cmd, { ...opts, encoding: 'utf8' }), repo))
  const claims = gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments`).flat().filter((c) => (c?.body ?? '').startsWith(MARKER))
  const mine = claims.find((c) => String(c.id) === race)
  if (!mine) return 'RACE_UNKNOWN'
  if (!trusted(mine)) {
    const login = mine.user?.login ?? ''
    return `RACE_UNTRUSTED ${/^[A-Za-z0-9-]+(\[bot\])?$/.test(login) ? login : '(unknown)'}`
  }
  const at = Date.parse(mine.created_at)
  const live = claims.filter((c) => trusted(c) && Date.parse(c.created_at) <= at && at - Date.parse(c.created_at) <= RACE_WINDOW_MS)
  return live.every((c) => c.id >= mine.id) ? 'RACE_WON' : 'RACE_LOST'
}

let line
try {
  line = race !== null ? raceResult() : decide()
} catch (e) {
  process.stderr.write(`claims: ${(String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]}\n`)
  process.exit(2)
}
process.stdout.write(`${line}\n`)
