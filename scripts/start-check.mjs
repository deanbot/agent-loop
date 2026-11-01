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
 *   0. Executor only: reads the branch and the working tree (`git branch --show-current`, `git
 *      status --porcelain`), before step 1 writes anything: `BRANCH <name> CLEAN|DIRTY`,
 *      `BRANCH_DETACHED CLEAN|DIRTY` (no branch checked out), or `BRANCH_UNKNOWN` and a ⚠ line when
 *      git fails. The start decides where the clone is from this line alone (#142).
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
 *   4. Executor only: clears stale claims. The clone's block names the repo; the `## Agent loop`
 *      block of AGENTS.md on that repo's default branch (the contents API, never the clone's copy,
 *      which on a PR's branch is the PR's) must name the same repo and gives the
 *      `in-progress-label` (default `in-progress`). It lists the repo's closed issues that still
 *      carry the label, and removes it from each,
 *      one `gh issue edit` per issue: `CLEARED <n> #a #b …` (the ones cleared), `CLEARED_NONE`
 *      (none to clear), or `CLEARED_UNKNOWN` (nothing cleared: no repo in the block, the default
 *      branch's block unreadable or naming another repo, or gh failed). Each gh call times out after 10 s, all of them together after 30 s; a failure or
 *      a timeout adds a ⚠ line and never stops the start.
 *   5. With a mailbox and at least one ⚠ line, the ⚠ lines go to the outbox as one message to the
 *      operator as well, for a deployment where nobody watches the terminal. A failed send adds a
 *      ⚠ line of its own.
 * Lines: the session line, the mailbox line, for the executor the branch line and the clear's
 * line, then the ⚠ lines. Exit 0 whatever it found (a start carries on through every warning);
 * exit 1 on a usage error.
 *
 * Text that comes from a file in the clone (the models entry) is printed with control characters
 * removed and cut to 80 characters: on a PR's branch the file is the PR's.
 */

import { execFileSync, execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { blockValue, fetchAgents } from './lib/block.mjs'
import { expandHome, mailboxProblem, mailboxWarning, sendMessage } from './lib/inbox.mjs'

const USAGE = 'start-check.mjs --role executor|reviewer|qa --session <id> --model "<model>" [--effort <effort>] [--inbox <folder>] [--outbox <folder>]'
const OPTIONS = ['--role', '--session', '--model', '--effort', '--inbox', '--outbox']
const ROLES = ['executor', 'reviewer', 'qa']

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

// --session and --effort are filled in by the tool, unquoted: an empty fill leaves no word at all
// (`--session --model …`), so these two take the next word only when it is not an option, and are
// empty otherwise. Every other option needs its value.
const OPTIONAL = ['--session', '--effort']
const hasValue = (i) => process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--')

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  if (hasValue(i)) return process.argv[i + 1]
  if (OPTIONAL.includes(name)) return ''
  usageError(`${name}: expected a value`)
}

for (let i = 2; i < process.argv.length; i++) {
  if (OPTIONS.includes(process.argv[i])) {
    if (hasValue(i)) i++
  } else usageError(`unexpected argument "${process.argv[i]}"`)
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

// 0. The executor's branch and tree, read by this script so the start never decides them from a
// status it remembers or a context snapshot (#142). Read before session.mjs writes
// .agent-loop/session, which a clone without the ignore would otherwise show as a change.
const LOCAL_TIMEOUT_MS = 10000
let branchLine = null
let branchWarning = null
if (role === 'executor') {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LOCAL_TIMEOUT_MS })
  try {
    const name = git('branch', '--show-current').trim()
    const tree = git('status', '--porcelain').trim() === '' ? 'CLEAN' : 'DIRTY'
    // A branch name holds no spaces or control characters (git refuses them); stripped anyway.
    branchLine = name ? `BRANCH ${name.replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')} ${tree}` : `BRANCH_DETACHED ${tree}`
  } catch (e) {
    branchLine = 'BRANCH_UNKNOWN'
    branchWarning = `⚠ Could not read the branch or the working tree: ${clean(String(e?.stderr || e?.message).trim().split('\n')[0])}`
  }
}

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
    warnings.push(`⚠ AGENTS.md expects ${clean(entry)} for the ${role}; this session runs ${clean(model)} · ${effort ?? 'unknown effort'}. Restart it on that model and effort if that is wrong.`)
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

// 4. The executor's stale claims: closed issues that still carry the in-progress label (a loop
// stopped after MERGE_READY never sees the merge that would remove it). A closed issue has no claim
// to protect, so this is safe while other executors run. It is the script's only network call: each
// gh call is bounded, all of them together too, and a failure warns and never stops the start.
let clearedLine = null
if (role === 'executor') {
  if (branchWarning) warnings.push(branchWarning)
  const callMs = Number(process.env.AGENT_LOOP_START_GH_TIMEOUT_MS) > 0 ? Number(process.env.AGENT_LOOP_START_GH_TIMEOUT_MS) : 10000
  const deadline = Date.now() + 3 * callMs
  const ghFailure = (e) => (e?.code === 'ETIMEDOUT' || e?.signal ? `gh timed out after ${callMs / 1000} s` : clean(String(e?.stderr || e?.message).trim().split('\n')[0]))
  const gh = (...args) => {
    const left = deadline - Date.now()
    if (left <= 0) throw Object.assign(new Error('out of time'), { code: 'ETIMEDOUT' })
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(callMs, left) })
  }
  // The clear is a write, so what drives it (the repo and the label) comes from the block on the
  // default branch, never from the clone's copy, which on a PR's branch is the PR's (#129's rule).
  // The clone's copy only names where to look, and the default branch's block must name the same
  // repo.
  const ghShell = (cmd, opts) => {
    const left = deadline - Date.now()
    try {
      if (left <= 0) throw Object.assign(new Error('out of time'), { code: 'ETIMEDOUT' })
      return execSync(cmd, { ...opts, encoding: 'utf8', timeout: Math.min(callMs, left) })
    } catch (e) {
      if (e?.code === 'ETIMEDOUT' || e?.signal) throw Object.assign(new Error(`gh timed out after ${callMs / 1000} s`), { stderr: `gh timed out after ${callMs / 1000} s` })
      throw e
    }
  }
  const named = blockValue(agents, 'repo')
  let repo = null
  let label = null
  // GitHub's own name characters only: the name goes into fetchAgents' gh command line.
  if (!named || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(named)) {
    warnings.push('⚠ Stale claims not cleared: the ## Agent loop block names no repo (owner/repo).')
  } else {
    try {
      const main = fetchAgents(ghShell, named)
      if (blockValue(main, 'repo') !== named) throw new Error(`the default branch's block names ${clean(blockValue(main, 'repo') ?? 'no repo')}, not ${named}`)
      repo = named
      label = blockValue(main, 'in-progress-label') ?? 'in-progress'
    } catch (e) {
      warnings.push(`⚠ Stale claims not cleared: could not read the default branch's block: ${clean(String(e?.message).trim().split('\n')[0])}.`)
    }
  }
  if (!repo) {
    clearedLine = 'CLEARED_UNKNOWN'
  } else {
    let stale = null
    try {
      stale = JSON.parse(gh('issue', 'list', '--repo', repo, '--state', 'closed', '--label', label, '--limit', '100', '--json', 'number') || '[]')
        .map((i) => i?.number)
        .filter((n) => Number.isInteger(n) && n > 0)
    } catch (e) {
      clearedLine = 'CLEARED_UNKNOWN'
      warnings.push(`⚠ Stale claims not cleared: ${e instanceof SyntaxError ? 'gh printed no list' : ghFailure(e)}.`)
    }
    if (stale) {
      const cleared = []
      const failed = []
      let reason = null
      for (const n of stale) {
        try {
          gh('issue', 'edit', String(n), '--repo', repo, '--remove-label', label)
          cleared.push(n)
        } catch (e) {
          failed.push(n)
          reason ??= ghFailure(e)
        }
      }
      clearedLine = cleared.length ? `CLEARED ${cleared.length} ${cleared.map((n) => `#${n}`).join(' ')}` : stale.length ? 'CLEARED_UNKNOWN' : 'CLEARED_NONE'
      if (failed.length) warnings.push(`⚠ Stale claims not cleared on ${failed.map((n) => `#${n}`).join(' ')}: ${reason}.`)
    }
  }
}

// 5. The outbox copy.
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

process.stdout.write([sessionLine, mailboxLine, ...(branchLine ? [branchLine, clearedLine] : []), ...warnings].join('\n') + '\n')
