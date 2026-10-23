#!/usr/bin/env node
/**
 * An inbox folder as a signal source: message files a loop reads like GitHub news, for a route
 * that needs only a shared folder (a session in a container or VM, a tool without messaging).
 *
 * Usage (paths are relative to the working directory, normally the clone's root):
 *   node scripts/inbox.mjs [--dir <folder>] [--wait [secs] [--max secs]]
 *   node scripts/inbox.mjs --send [--dir <folder>] --role user|agent --from <name> --to <name>
 *                          --context <contextId> [--task <taskId>] --text <text>
 *
 * Reading (default folder .agent-loop/inbox) — one line per message not reported before, oldest
 * first (by sentAt), then exits (with --wait: see lib/wait.mjs):
 *   MESSAGE:<messageId>   a new message: read <folder>/<messageId>.json
 *   INVALID:<messageId>   a new file with a message name that is not a valid message (the reason
 *                         goes to stderr); reported once, like a message
 *   NONE <timestamp>      nothing new, or no such folder
 * A first run reports every message already there: a message is direction, not history.
 *
 * Sending (default folder .agent-loop/outbox) writes `<messageId>.json` atomically (a temporary
 * dotfile, then a rename) and prints `SENT:<messageId>`. messageId and sentAt are filled in.
 *
 * State persisted in the state folder the other signal scripts use, as inbox-<hash>.json, one per folder (<hash>: the first 16
 * hex digits of the SHA-256 of the folder's real path). State format: { reported: [messageId, …] },
 * pruned to the files still in the folder.
 */

import { readFileSync, mkdirSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import path from 'path'
import { runSignalScript, usageError } from './lib/wait.mjs'
import { listMessages, sendMessage, ROLES } from './lib/inbox.mjs'

const USAGE =
  'inbox.mjs [--dir <folder>] [--wait [secs] [--max secs]] | inbox.mjs --send [--dir <folder>] --role user|agent --from <name> --to <name> --context <contextId> [--task <taskId>] --text <text>'

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (v === undefined || v === '' || v.startsWith('--')) usageError(USAGE, `${name}: expected a value`)
  return v
}

const send = process.argv.includes('--send')
const dir = path.resolve(arg('--dir') ?? path.join('.agent-loop', send ? 'outbox' : 'inbox'))

if (send) {
  if (process.argv.includes('--wait') || process.argv.includes('--max')) usageError(USAGE, '--send takes no --wait or --max')
  const role = arg('--role')
  if (!ROLES.includes(role)) usageError(USAGE, `--role: expected ${ROLES.join(' or ')}, got "${role ?? ''}"`)
  const fields = { role, from: arg('--from'), to: arg('--to'), contextId: arg('--context'), taskId: arg('--task') ?? undefined, text: arg('--text') }
  for (const [key, flag] of [['from', '--from'], ['to', '--to'], ['contextId', '--context'], ['text', '--text']]) {
    if (fields[key] === null) usageError(USAGE, `${flag} is required`)
  }
  process.stdout.write(`SENT:${sendMessage(dir, fields)}\n`)
  process.exit(0)
}

let real = dir
try {
  real = realpathSync(dir)
} catch {
  // no folder yet: nothing to report, and nothing recorded under its real path
}
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const STATE_FILE = path.join(STATE_DIR, `inbox-${createHash('sha256').update(real).digest('hex').slice(0, 16)}.json`)

mkdirSync(STATE_DIR, { recursive: true })

function pass({ save, dry }) {
  let reported = new Set()
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (Array.isArray(state.reported)) reported = new Set(state.reported)
  } catch {
    // no prior state
  }

  const messages = listMessages(dir)
  const fresh = messages.filter((m) => !reported.has(m.id))
  if (!dry) for (const m of fresh) if (m.error) process.stderr.write(`inbox: ${m.id}.json: ${m.error}\n`)

  save(JSON.stringify({ reported: messages.map((m) => m.id).sort() }))

  const lines = fresh.map((m) => `${m.error ? 'INVALID' : 'MESSAGE'}:${m.id}`)
  return lines.length === 0 ? `NONE ${new Date().toISOString()}\n` : lines.join('\n') + '\n'
}

await runSignalScript({ argv: process.argv, usage: USAGE, stateFile: STATE_FILE, pass })
