#!/usr/bin/env node
/**
 * The open pull request that closes an issue: the executor's lookup before it claims an issue it was
 * started on (#110). It replaces a `gh pr list … --jq` filter whose quoted regex drew Claude Code's
 * safety check, and so an approval prompt, whatever the allow rules.
 *
 * Usage:
 *   node scripts/pr-for-issue.mjs --repo owner/repo --closes <N>
 *
 * Output, one line, exit 0:
 *   PR:<number> <head branch>   the newest (highest-numbered) open, same-repository PR whose body
 *                               says `Closes #<N>` (case-insensitive, not followed by another
 *                               digit, as pick-next.mjs reads it, and the one its blocker check
 *                               and the --jq filter this replaced name when several do)
 *   NONE                        no such PR
 * A failed gh call: `pr-for-issue: <message>` on stderr, exit 2. A usage error: exit 1.
 *
 * A fork's PR is never returned: its body is text anyone can write, and an executor's own work is
 * always on a branch in the repository.
 */

import { execFileSync } from 'child_process'

const USAGE = 'pr-for-issue.mjs --repo owner/repo --closes <N>'

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
  if (process.argv[i] === '--repo' || process.argv[i] === '--closes') i++
  else usageError(`unexpected argument "${process.argv[i]}"`)
}

const repo = arg('--repo')
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const closesArg = arg('--closes')
if (!closesArg || !/^#?\d+$/.test(closesArg)) usageError(closesArg ? `--closes: expected an issue number, got "${closesArg}"` : '--closes is required')
const issue = closesArg.replace(/^#/, '')

let prs
try {
  prs = JSON.parse(
    execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,body,headRefName,isCrossRepository'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) || '[]'
  )
} catch (e) {
  process.stderr.write(`pr-for-issue: ${(String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]}\n`)
  process.exit(2)
}

const closes = new RegExp(`Closes #${issue}(?![0-9])`, 'i')
const pr = prs
  .filter((p) => p.isCrossRepository !== true && closes.test(p.body ?? ''))
  .sort((a, b) => b.number - a.number)[0]
process.stdout.write(pr ? `PR:${pr.number} ${pr.headRefName}\n` : 'NONE\n')
