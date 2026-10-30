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
 *                         when the text after the marker starts with no clone name)
 *   CLAIM_NONE            open, in progress, and no claim comment at all (claimed before claim
 *                         comments existed): the caller's own word decides
 * A losing claim is deleted (spec: "Claim comments"), so the newest one left is the holder's.
 * Labels default to in-progress and is-blocked. A failed gh call (an issue that doesn't exist
 * included): `claims: <message>` on stderr, exit 2. A usage error: exit 1.
 */

import { execFileSync } from 'child_process'

const USAGE = 'claims.mjs --repo owner/repo --issue <N> --clone <clone> [--in-progress-label <l>] [--blocked-label <l>]'
const OPTIONS = ['--repo', '--issue', '--clone', '--in-progress-label', '--blocked-label']

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
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const issueArg = arg('--issue')
if (!issueArg || !/^#?\d+$/.test(issueArg)) usageError(issueArg ? `--issue: expected an issue number, got "${issueArg}"` : '--issue is required')
const issue = issueArg.replace(/^#/, '')
const CLONE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const clone = arg('--clone')
if (!clone || !CLONE.test(clone)) usageError(clone ? `--clone: expected a clone name, got "${clone}"` : '--clone is required')
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
  const comments = gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments`).flat()
  const newest = comments.filter((c) => (c.body ?? '').startsWith(MARKER)).sort((a, b) => a.id - b.id).at(-1)
  if (!newest) return 'CLAIM_NONE'
  const holder = newest.body.slice(MARKER.length).trim()
  if (holder === clone) return 'CLAIM_HELD'
  // The name is comment text anyone can write: print it only when it is a clone name.
  const named = holder.split(/\s/)[0]
  return `CLAIM_LOST ${CLONE.test(named) ? named : '(unnamed)'}`
}

let line
try {
  line = decide()
} catch (e) {
  process.stderr.write(`claims: ${(String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]}\n`)
  process.exit(2)
}
process.stdout.write(`${line}\n`)
