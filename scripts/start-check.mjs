#!/usr/bin/env node
/**
 * A loop's start checks, in one command whose output the start goes on from (#128). Each warning
 * the operator must see is a `⚠ ` line of this output rather than a line the session is asked to
 * write itself, which live starts dropped. An adapter whose tool has a post-tool hook shows the
 * lines to the operator from there (Claude Code: hooks/operator-lines.mjs).
 *
 * Usage (run in the clone's root):
 *   node scripts/start-check.mjs --role executor|reviewer|qa --session <id> --model "<model>"
 *                                [--effort <effort>] [--inbox <folder>] [--outbox <folder>]
 *
 * What it does, in order:
 *   1. Takes the clone for the session (`session.mjs --start <id>`) and prints that script's line
 *      (NEW, MINE, TOOK_OVER <id> <secs>), or `SESSION_NONE` when no usable id was given. A
 *      takeover and a missing id each add a ⚠ line.
 *   2. The model check: with a `models:` entry for the role in the `## Agent loop` block of the
 *      clone's AGENTS.md that differs from --model (its model word is not in the model's name) or
 *      --effort (it names an effort and the given one differs; an effort not given is not
 *      compared), a ⚠ line.
 *   3. The mailbox, from whichever of --inbox and --outbox were given: `MAILBOX <inbox>` (folders
 *      as given, ~ expanded) when both are and the pair is acceptable, else `NO_MAILBOX`. One folder
 *      without the other, a refused pair and an inbox that does not exist yet each add a ⚠ line.
 *   4. With a mailbox and at least one ⚠ line, the ⚠ lines go to the outbox as one message to the
 *      operator as well, for a deployment where nobody watches the terminal. A failed send adds a
 *      ⚠ line of its own.
 * Lines: the session line, then the mailbox line, then the ⚠ lines. Exit 0 whatever it found (a
 * start carries on through every warning); exit 1 on a usage error.
 *
 * Text that comes from a file in the clone (the models entry) is printed with control characters
 * removed and cut to 80 characters: on a PR's branch the file is the PR's.
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { blockValue } from './lib/block.mjs'
import { expandHome, mailboxProblem, mailboxWarning, sendMessage } from './lib/inbox.mjs'

const USAGE = 'start-check.mjs --role executor|reviewer|qa --session <id> --model "<model>" [--effort <effort>] [--inbox <folder>] [--outbox <folder>]'
const OPTIONS = ['--role', '--session', '--model', '--effort', '--inbox', '--outbox']
const ROLES = ['executor', 'reviewer', 'qa']

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

// A value may be empty (an id the tool didn't fill in); a missing one is a usage error.
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

const role = arg('--role')
if (!ROLES.includes(role)) usageError(`--role: expected ${ROLES.join(', ')}`)
const session = arg('--session') ?? ''
const model = arg('--model')
if (!model) usageError('--model is required')
// An effort the tool didn't substitute (`${…}` left as is) is no effort.
const effort = /^[A-Za-z0-9._-]+$/.test(arg('--effort') ?? '') ? arg('--effort') : null
const inbox = arg('--inbox')
const outbox = arg('--outbox')

const clean = (s) => [...String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')].slice(0, 80).join('')
const warnings = []

// 1. The session.
const here = path.dirname(fileURLToPath(import.meta.url))
let sessionLine = 'SESSION_NONE'
if (/^[A-Za-z0-9._:-]{1,128}$/.test(session)) {
  try {
    sessionLine = execFileSync(process.execPath, [path.join(here, 'session.mjs'), '--start', session], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    warnings.push(`⚠ Could not take the clone for this session: ${clean(String(e?.stderr ?? e?.message).trim().split('\n')[0])}`)
  }
} else {
  warnings.push('⚠ No session id: a second session in this clone would go unnoticed.')
}
const took = /^TOOK_OVER (\S+) (\d+)$/.exec(sessionLine)
if (took) {
  warnings.push(`⚠ Took over this clone from session ${took[1]}, last active ${Math.round(Number(took[2]) / 60)} min ago. If it still runs, its next command is refused and it stops.`)
}

// 2. The model check.
let agents = ''
try {
  agents = readFileSync('AGENTS.md', 'utf8')
} catch {
  // no file: nothing to compare (the start stops on the missing block itself)
}
const entry = (blockValue(agents, 'models') ?? '')
  .split(',')
  .map((s) => s.trim())
  .map((s) => /^([A-Za-z]+)\s*=\s*(\S+)$/.exec(s))
  .find((m) => m && m[1].toLowerCase() === role)?.[2]
if (entry) {
  const [word, wantEffort] = entry.split('/')
  const modelDiffers = !model.toLowerCase().includes(word.toLowerCase())
  const effortDiffers = Boolean(wantEffort && effort && wantEffort.toLowerCase() !== effort.toLowerCase())
  if (modelDiffers || effortDiffers) {
    warnings.push(`⚠ AGENTS.md expects ${clean(entry)} for the ${role}; this session runs ${clean(model)} · ${effort ?? 'unknown effort'}. Restart it with /model and /effort if that is wrong.`)
  }
}

// 3. The mailbox.
let mailboxLine = 'NO_MAILBOX'
let inboxDir = null
let outboxDir = null
if ((inbox === null) !== (outbox === null)) {
  warnings.push('⚠ No mailbox: --inbox and --outbox go together.')
} else if (inbox !== null) {
  inboxDir = expandHome(inbox)
  outboxDir = expandHome(outbox)
  const problem = mailboxProblem(inboxDir, outboxDir, process.cwd())
  if (problem) {
    warnings.push(`⚠ No mailbox: ${problem}.`)
    inboxDir = outboxDir = null
  } else {
    mailboxLine = `MAILBOX ${inboxDir}`
    if (mailboxWarning(inboxDir)) warnings.push(`⚠ Inbox ${inboxDir}: does not exist yet; nothing arrives until it is created.`)
  }
}

// 4. The outbox copy.
if (outboxDir && warnings.length > 0) {
  try {
    sendMessage(outboxDir, {
      role: 'ROLE_AGENT',
      contextId: blockValue(agents, 'repo') ?? 'start',
      from: path.basename(process.cwd()),
      to: 'operator',
      text: `${role} start:\n${warnings.join('\n')}`,
    })
  } catch (e) {
    warnings.push(`⚠ Could not copy these lines to the outbox: ${clean(e?.message ?? e)}`)
  }
}

process.stdout.write([sessionLine, mailboxLine, ...warnings].join('\n') + '\n')
