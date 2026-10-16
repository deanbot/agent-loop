#!/usr/bin/env node
/**
 * Pick the executor's next issue: list, filter, check dependencies, print one line, exit.
 *
 * Usage:
 *   node scripts/pick-next.mjs --repo owner/repo [--milestone <title>] [--in-progress-label <l>]
 *                              [--blocked-label <l>] [--skip <n,n,...>]
 *
 * Output — one line, then exits:
 *   ISSUE:<n>                    the lowest-numbered open issue (in the milestone, when given) without
 *                                the in-progress or blocked label, not skipped, whose dependencies are
 *                                all closed
 *   WAIT:<blocker> PR:<n|none>   milestone only: open issues, none startable. The blocker is the first
 *                                open dependency of the first open issue, or that issue itself when
 *                                it carries the in-progress or blocked label; PR is the open PR whose
 *                                body says "Closes #<blocker>", or none
 *   MOVE_ON <title>              milestone only: it has no open issues; <title> is the first open
 *                                milestone numbered after it (the rest of the line, spaces included)
 *   NONE                         nothing to pick: no candidate without a milestone, no open
 *                                milestone after an empty one, or every open issue was skipped
 *
 * Dependencies are named in an issue body as "Depends on #a, #b" (also "#a and #b"); only the list
 * right after "Depends on" counts, so "Depends on #5. See #9." depends on #5 alone. A dependency's
 * state comes from the REST issues endpoint, which also resolves a PR (`gh issue view` reports a
 * merged PR as MERGED, not CLOSED); only state "closed" counts as done. --skip lists issues this session already turned
 * down (author check failed, claim lost), so a pick never returns them again. Labels default to
 * in-progress and is-blocked. The listing runs fresh on every call: an issue filed while the
 * executor waited is seen at the next pick. No state is kept.
 *
 * A failed gh call (network, rate limit, auth) prints `pick-next: <message>` on stderr and exits 2
 * with nothing on stdout: the caller retries later and never picks by hand.
 */

import { execFileSync } from 'child_process'

const USAGE =
  'pick-next.mjs --repo owner/repo [--milestone <title>] [--in-progress-label <l>] [--blocked-label <l>] [--skip <n,n,...>]'

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

const repo = arg('--repo')
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : undefined)
const milestone = arg('--milestone')
const inProgress = arg('--in-progress-label') ?? 'in-progress'
const blocked = arg('--blocked-label') ?? 'is-blocked'
const skipArg = arg('--skip') ?? ''
if (skipArg && !/^\d+(,\d+)*$/.test(skipArg)) usageError(`--skip: expected n,n,…, got "${skipArg}"`)
const skip = new Set(skipArg.split(',').filter(Boolean).map(Number))

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')

function listOpen(title) {
  const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,body,labels']
  if (title !== null) args.push('--milestone', title)
  return gh(...args).sort((a, b) => a.number - b.number)
}

const DEPENDS = /depends on:?\s*(#\d+(?:\s*(?:,|and|&)\s*#\d+)*)/gi
function dependencies(body) {
  const deps = []
  for (const m of (body ?? '').matchAll(DEPENDS)) {
    for (const d of m[1].matchAll(/#(\d+)/g)) deps.push(Number(d[1]))
  }
  return deps
}

const stateCache = new Map()
function isOpen(n, openNumbers) {
  if (openNumbers.has(n)) return true
  if (!stateCache.has(n)) stateCache.set(n, gh('api', `repos/${repo}/issues/${n}`).state)
  return stateCache.get(n) !== 'closed'
}

const hasLabel = (issue, name) => (issue.labels ?? []).some((l) => l.name === name)

function pick(title) {
  const open = listOpen(title).filter((i) => !skip.has(i.number))
  const openNumbers = new Set(open.map((i) => i.number))
  const startable = (i) =>
    !hasLabel(i, inProgress) && !hasLabel(i, blocked) && dependencies(i.body).every((d) => !isOpen(d, openNumbers))

  const candidate = open.find(startable)
  if (candidate) return `ISSUE:${candidate.number}`
  if (title === null) return 'NONE'

  if (open.length === 0) {
    // The skipped issues still count as open: a milestone is empty only when nothing is left in it.
    if (skip.size > 0 && listOpen(title).length > 0) return 'NONE'
    const milestones = gh('api', `repos/${repo}/milestones?state=all&per_page=100`).sort((a, b) => a.number - b.number)
    const current = milestones.find((m) => m.title === title)
    if (!current) return 'NONE'
    const next = milestones.find((m) => m.state === 'open' && m.number > current.number)
    return next ? `MOVE_ON ${next.title}` : 'NONE'
  }

  const first = open[0]
  const blocker =
    hasLabel(first, inProgress) || hasLabel(first, blocked)
      ? first.number
      : (dependencies(first.body).find((d) => isOpen(d, openNumbers)) ?? first.number)
  const prs = gh('pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,body')
  const closes = new RegExp(`Closes #${blocker}([^0-9]|$)`, 'i')
  const pr = prs.find((p) => closes.test(p.body ?? ''))
  return `WAIT:${blocker} PR:${pr ? pr.number : 'none'}`
}

let line
try {
  line = pick(milestone)
} catch (e) {
  const detail = String(e?.stderr ?? '').trim() || e?.message || String(e)
  process.stderr.write(`pick-next: ${detail.split('\n')[0]}\n`)
  process.exit(2)
}
process.stdout.write(line + '\n')
