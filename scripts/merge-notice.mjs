#!/usr/bin/env node
/**
 * A merge notice: when the reviewer sees a PR it was tracking leave the open list (`CLOSED:<n>`), and
 * the PR merged, it writes one message to its outbox for the executor that holds the PR. Delivered
 * to that executor's inbox, it ends the executor's waiter, and the executor's next poll sees `MERGED`
 * without a live PR waiter (spec: "Inbox folder", "Merge notice"). The notice is a wake, never
 * direction: the executor acts on its poll alone and never replies to it.
 *
 * Usage, from the reviewer's clone:
 *   node scripts/merge-notice.mjs --repo owner/repo --pr <n> --outbox <folder> --from <clone>
 *
 * The executor is the one whose `[executor] Claimed by <clone>` comment is the newest the PR's author
 * posted on an issue the PR's body names with `Closes #<n>` (the first such issue that has one), as
 * pick-next.mjs reads claims. Same-repository PRs only. `<clone>` becomes the message's metadata.to:
 * the deployment routes an outbox by it.
 *
 * The message: role ROLE_AGENT, contextId `owner/repo#<n>`, taskId `merged <merge commit sha>`, one
 * text part `PR #<n> merged at <short sha>.`, metadata.from <--from>, metadata.to <clone>.
 *
 * Output, one line, exit 0:
 *   SENT:<messageId> TO:<clone>   the notice is in the outbox
 *   SKIPPED: <reason>             nothing written: not merged, a fork's PR, no `Closes #<n>`, no claim
 *                                 by the PR's author, a claim naming no valid clone, or already sent
 * A failed gh call: `merge-notice: <message>` on stderr, exit 2, nothing written. A usage error: exit 1.
 *
 * State: merge-notice-<hash>.json in the state folder the signal scripts share, one per outbox
 * (<hash>: the first 16 hex digits of the SHA-256 of the folder's real path, through its nearest
 * existing folder while it does not exist yet): { sent: ["owner/repo#n", …] },
 * the newest 500. Written after the message, so a crash between the two sends it again rather than
 * never.
 */

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import path from 'path'
import { sendMessage, expandHome, realish } from './lib/inbox.mjs'

const USAGE = 'merge-notice.mjs --repo owner/repo --pr <n> --outbox <folder> --from <clone>'

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (v === undefined || v === '' || v.startsWith('--')) usageError(`${name}: expected a value`)
  return v
}

const VALUED = new Set(['--repo', '--pr', '--outbox', '--from'])
for (let i = 2; i < process.argv.length; i++) {
  if (VALUED.has(process.argv[i])) i++
  else usageError(`unexpected argument "${process.argv[i]}"`)
}

const CLONE = /^[A-Za-z0-9._-]+$/
const repo = arg('--repo')
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const prArg = arg('--pr')
if (!prArg || !/^\d+$/.test(prArg)) usageError(prArg ? `--pr: expected a PR number, got "${prArg}"` : '--pr is required')
const pr = Number(prArg)
const outboxArg = arg('--outbox')
if (!outboxArg) usageError('--outbox is required')
const from = arg('--from')
if (!from || !CLONE.test(from)) usageError(from ? `--from: expected a clone name, got "${from}"` : '--from is required')
const outbox = path.resolve(expandHome(outboxArg))

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')

// One record per outbox: the outbox is where a notice lands. Keyed by its real path, resolved
// through its nearest existing folder, so the name stays the same once the first send creates it.
function recordFile() {
  return path.join(homedir(), '.agent-loop', 'state', `merge-notice-${createHash('sha256').update(realish(outbox)).digest('hex').slice(0, 16)}.json`)
}

function readSent(file) {
  try {
    const sent = JSON.parse(readFileSync(file, 'utf8')).sent
    return Array.isArray(sent) ? sent : []
  } catch {
    return []
  }
}

const key = `${repo}#${pr}`

// The clone that holds the PR, or a reason there is none.
function holder(view) {
  const author = view.author?.login
  if (view.isCrossRepository === true || !author) return { reason: "a fork's PR, or one with no author" }
  const issues = [...new Set([...(view.body ?? '').matchAll(/Closes #(\d+)(?![0-9])/gi)].map((m) => Number(m[1])))]
  if (issues.length === 0) return { reason: 'the PR names no issue with Closes #<n>' }
  for (const n of issues) {
    const claims = gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments`)
      .flat()
      .filter((c) => c.user?.login === author && (c.body ?? '').startsWith('[executor] Claimed by '))
      .sort((a, b) => a.id - b.id)
    const newest = claims.at(-1)
    if (!newest) continue
    const clone = newest.body.trim().slice('[executor] Claimed by '.length)
    if (!CLONE.test(clone)) return { reason: `the claim on #${n} names no valid clone` }
    return { clone }
  }
  return { reason: `no claim by ${author} on ${issues.map((n) => `#${n}`).join(', ')}` }
}

try {
  const file = recordFile()
  const sent = readSent(file)
  if (sent.includes(key)) {
    process.stdout.write(`SKIPPED: a notice for ${key} was already sent\n`)
    process.exit(0)
  }
  const view = gh('pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergeCommit,body,author,isCrossRepository')
  if (view?.state !== 'MERGED') {
    process.stdout.write(`SKIPPED: PR #${pr} is ${String(view?.state ?? 'unknown').toLowerCase()}, not merged\n`)
    process.exit(0)
  }
  const { clone, reason } = holder(view)
  if (!clone) {
    process.stdout.write(`SKIPPED: ${reason}\n`)
    process.exit(0)
  }
  const sha = view.mergeCommit?.oid ?? ''
  const messageId = sendMessage(outbox, {
    role: 'ROLE_AGENT',
    contextId: key,
    taskId: `merged ${sha || 'unknown'}`,
    from,
    to: clone,
    text: `PR #${pr} merged${sha ? ` at ${sha.slice(0, 7)}` : ''}.`,
  })
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ sent: [...sent, key].slice(-500) }) + '\n')
  renameSync(tmp, file)
  process.stdout.write(`SENT:${messageId} TO:${clone}\n`)
} catch (e) {
  process.stderr.write(`merge-notice: ${(String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]}\n`)
  process.exit(2)
}
