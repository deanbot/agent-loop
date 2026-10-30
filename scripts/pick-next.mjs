#!/usr/bin/env node
/**
 * Pick the executor's next issue: list, filter, check dependencies, print one line, exit.
 *
 * Usage:
 *   node scripts/pick-next.mjs --repo owner/repo [--milestone <title>] [--in-progress-label <l>]
 *                              [--blocked-label <l>] [--skip <n,n,...>] [--clone <clone>]
 *
 * Output — one line, then exits:
 *   RULES_PENDING: <files>: run node <scripts>/rules-ack.mjs, then pick again
 *                                before anything else, and without calling gh: a pull of main in
 *                                this clone changed a rules file (pull.mjs) and nobody has read the
 *                                diff yet. Nothing is picked. <files> is "(unreadable record)" when
 *                                the record can't be read
 *   RESUME:<n> PR:<p>           with --clone only, before anything else: an open PR <p> whose body
 *                                says "Closes #<n>", where #<n> is open, carries neither the
 *                                in-progress nor the blocked label, is not skipped, and its newest
 *                                "[executor] Claimed by" comment by the PR's author names <clone>: an issue this
 *                                executor parked with a PR open and the operator has unblocked.
 *                                Lowest <n> first, whatever the milestone; never a fork's PR
 *   ISSUE:<n>                    the lowest-numbered open issue (in the milestone, when given) without
 *                                the in-progress or blocked label, not skipped, whose dependencies are
 *                                all closed
 *   WAIT:<blocker> PR:<n|none>   milestone only: open issues, none startable. The blocker is the first
 *                                open dependency of the first open issue, or that issue itself when
 *                                it carries the in-progress or blocked label; PR is the open PR whose
 *                                body says "Closes #<blocker>", or none
 *   MOVE_ON <title>              milestone only: it has no open issues; <title> is the first open
 *                                milestone numbered after it (the rest of the line, spaces included)
 *   NONE                         nothing to pick: no candidate without a milestone, or no open
 *                                milestone after an empty one. With a milestone whose only open
 *                                issues are skipped, it is WAIT on the lowest of them, not NONE
 *
 * Dependencies are named in an issue body as "Depends on #a, #b" (also "#a and #b"); only the list
 * right after "Depends on" counts, so "Depends on #5. See #9." depends on #5 alone; "#a, #b, and #c",
 * "**Depends on:** #a" and "_Depends on_ #a" are read too. --skip none (or empty) is an empty list. A dependency's
 * state comes from the REST issues endpoint, which also resolves a PR (`gh issue view` reports a
 * merged PR as MERGED, not CLOSED); only state "closed" counts as done. --skip lists issues this session already turned
 * down (author check failed, claim lost), so a pick never returns them again. Labels default to
 * in-progress and is-blocked. The listing runs fresh on every call: an issue filed while the
 * executor waited is seen at the next pick. No state is kept; the clone's pending rules record
 * (lib/rules.mjs) is read, never written. Run it in the clone (any folder of it).
 *
 * A failed gh call (network, rate limit, auth) prints `pick-next: <message>` on stderr and exits 2
 * with nothing on stdout: the caller retries later and never picks by hand.
 */

import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import { recordFile, readPending, pendingFiles, shellWord } from './lib/rules.mjs'

const USAGE =
  'pick-next.mjs --repo owner/repo [--milestone <title>] [--in-progress-label <l>] [--blocked-label <l>] [--skip <n,n,...>] [--clone <clone>]'

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
// "none" (or an empty value) is an empty list, so a wake prompt can carry "--skip none" as is.
const skipArg = (arg('--skip') ?? '').replace(/^none$/i, '')
if (skipArg && !/^\d+(,\d+)*$/.test(skipArg)) usageError(`--skip: expected n,n,…, got "${skipArg}"`)
const skip = new Set(skipArg.split(',').filter(Boolean).map(Number))
const clone = arg('--clone')
if (clone !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clone)) usageError(`--clone: expected a clone name, got "${clone}"`)

// A rules change pulled and not read yet: the session would pick and build under the rules it
// loaded at its start, so nothing is picked until rules-ack.mjs has printed it.
const pending = readPending(recordFile())
if (pending === null || pending.length > 0) {
  const ack = shellWord(path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-ack.mjs'))
  const files = pending === null ? '(unreadable record)' : pendingFiles(pending).join(' ')
  process.stdout.write(`RULES_PENDING: ${files}: run node ${ack}, then pick again\n`)
  process.exit(0)
}

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')

function listOpen(title) {
  const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,title,body,labels']
  if (title !== null) args.push('--milestone', title)
  return gh(...args).sort((a, b) => a.number - b.number)
}

// "Depends on #a, #b", "#a and #b", "#a, #b, and #c", "**Depends on:** #a", "_Depends on_ #a". The list
// ends at the first character that is not a #number, a comma, "and", "&" or a space on the same line.
// No \b around "depends on": "_" is a word character, so \b fails inside "_Depends on_".
const DEPENDS = /(?<![a-z0-9])depends on(?![a-z0-9])[*_:]*[ \t]*((?:#\d+|,|&|\band\b|[ \t])+)/gi
function dependencies(body) {
  const deps = []
  for (const m of (body ?? '').matchAll(DEPENDS)) {
    for (const d of m[1].matchAll(/#(\d+)/g)) deps.push(Number(d[1]))
  }
  return deps
}

const issueCache = new Map()
const fetchIssue = (n) => {
  if (!issueCache.has(n)) issueCache.set(n, gh('api', `repos/${repo}/issues/${n}`))
  return issueCache.get(n)
}
function isOpen(n, openNumbers) {
  if (openNumbers.has(n)) return true
  return fetchIssue(n).state !== 'closed'
}

const hasLabel = (issue, name) => (issue.labels ?? []).some((l) => l.name === name)

let prCache = null
const openPrs = () => (prCache ??= gh('pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,body,isCrossRepository,author'))

// An issue this clone parked while its PR was open, unblocked since: its PR comes back to it, so
// the review findings on it keep an owner. The claim comment is the record of whose it was. Both
// are text others can write, so a fork's PR is never offered ("Closes #<n>" in its body), and only
// claims posted by the PR's own author count.
function resumable() {
  const closing = []
  for (const p of openPrs().filter((p) => p.isCrossRepository !== true && p.author?.login)) {
    for (const m of (p.body ?? '').matchAll(/Closes #(\d+)(?![0-9])/gi)) closing.push({ n: Number(m[1]), pr: p.number, author: p.author.login })
  }
  closing.sort((a, b) => a.n - b.n || a.pr - b.pr)
  for (const { n, pr, author } of closing) {
    if (skip.has(n)) continue
    let issue
    try {
      issue = fetchIssue(n)
    } catch (e) {
      // "Closes #<n>" naming no issue (a typo, a deleted one) is not this pick's failure.
      if (/HTTP 404|Not Found/.test(String(e?.stderr ?? ''))) continue
      throw e
    }
    if (issue.state !== 'open' || hasLabel(issue, inProgress) || hasLabel(issue, blocked)) continue
    const pages = gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments`)
    const claims = pages.flat().filter((c) => c.user?.login === author && (c.body ?? '').startsWith('[executor] Claimed by '))
    const newest = claims.sort((a, b) => a.id - b.id).at(-1)
    if (newest && newest.body.trim() === `[executor] Claimed by ${clone}`) return `RESUME:${n} PR:${pr}`
  }
  return null
}

function pick(title) {
  if (clone !== null) {
    const back = resumable()
    if (back) return back
  }
  const listed = listOpen(title)
  const open = listed.filter((i) => !skip.has(i.number))
  const openNumbers = new Set(open.map((i) => i.number))
  const startable = (i) =>
    !hasLabel(i, inProgress) && !hasLabel(i, blocked) && dependencies(i.body).every((d) => !isOpen(d, openNumbers))

  const candidate = open.find(startable)
  if (candidate) return `ISSUE:${candidate.number}`
  if (title === null) return 'NONE'

  // Only skipped issues left (an untrusted author, or a claim another executor won and is still
  // working on): the milestone is not empty, so wait on the lowest of them rather than end.
  if (open.length === 0 && listed.length > 0) return waitOn(listed[0].number)
  if (open.length === 0) {
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
  return waitOn(blocker)
}

function waitOn(blocker) {
  const closes = new RegExp(`Closes #${blocker}([^0-9]|$)`, 'i')
  const pr = openPrs().find((p) => closes.test(p.body ?? ''))
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
