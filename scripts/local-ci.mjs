#!/usr/bin/env node
/**
 * A local CI runner: runs the project's gate once per pull request head and posts the result as a
 * commit status, so `gh pr checks` (and pr-poll.mjs) see it like any other check. No agent in it.
 *
 * Usage, from the root of a clone kept for it (no role marker):
 *   node scripts/local-ci.mjs --repo owner/repo --gate "<command>" [--context local-ci]
 *                             [--install "<command>" [--lockfiles a,b]]
 *                             [--trusted-authors a,b] [--log-url <base>] [--wait [secs]]
 *
 * Each pass:
 *   - lists open pull requests whose author is trusted and whose head branch is in the repository
 *     itself (never a fork), oldest (lowest number) first. Trusted authors are --trusted-authors, or
 *     `trusted-authors` in the `## Agent loop` block of AGENTS.md on the default branch (read from
 *     origin each pass, never from the working tree, which sits at a pull request's head);
 *   - posts `pending` under the context on every listed head with no status there yet, so a head
 *     waiting its turn already shows CI as present;
 *   - for each head whose status under the context is `pending`, one at a time: fetches it, checks it
 *     out detached (forced, then `git clean -fd`), runs the gate through the shell with its output
 *     in a log file, and posts `success` or `failure` with the gate's last line as the description
 *     (cut to 140 characters). A head that cannot be fetched or checked out gets `error`.
 *   - with --install, before the gate: when the head's lockfiles differ from those of the clone's
 *     last successful install, in either direction, runs the install command through the shell
 *     (output in the same log). A failed install posts `error` (`install failed: <last line>`) and
 *     the gate does not run.
 * Lockfiles are the tracked files with one of LOCKFILES' names, in any folder, or --lockfiles: a
 * name without a slash matches in any folder, one with a slash is a path from the clone's root.
 * The install record (local-ci-install-<hash of the clone's path>.json, next to the lock) holds a
 * hash of the lockfiles' paths and contents and of the install command. It is removed before an
 * install starts and written only after one succeeds, so a failed or stopped install leaves no
 * record and the next head installs again.
 * A head with any other status under the context (`success`, `failure`, `error`) is done. A
 * `pending` the runner finds is never one of its own runs (one runner per repository and context, a
 * pid lock, and runs are one at a time), so it is run: a crash or a stopped runner never leaves a
 * pull request waiting, and posting `pending` by hand under the context re-runs a head.
 *
 * Logs: ~/.agent-loop/local-ci/<owner>-<repo>/<pr>-<sha>-<time>.log. The status's target_url is
 * `<log-url>/<log file name>` with --log-url (a place the project serves the logs from), and none
 * without: a local path means nothing on GitHub.
 *
 * Output: one line per finished run, `#<pr> <short sha> <state>: <description>`, or `NONE
 * <timestamp>` for a one-shot pass with nothing to run. Without --wait it runs one pass and exits (a
 * failed gh or git call: `local-ci: <message>` on stderr, exit 2). With --wait [secs] (default 30)
 * it passes every interval and keeps going: a failed pass is reported on stderr and retried. It
 * exits only on a usage error or no trusted authors (exit 1, one-shot too), or when another runner
 * holds the lock (`RUNNER_RUNNING <pid>`, exit 3). Stopping it (SIGTERM, SIGINT, SIGHUP) stops a running gate too; that head stays
 * `pending` and runs again at the next start.
 */

import { execFileSync, spawn } from 'child_process'
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { createHash } from 'crypto'
import path from 'path'

const USAGE =
  'local-ci.mjs --repo owner/repo --gate "<command>" [--context <name>] [--install "<command>" [--lockfiles a,b]] [--trusted-authors a,b] [--log-url <base>] [--wait [secs]]'

// Dependency lockfiles by name, matched in any folder.
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'mix.lock',
  'pubspec.lock',
  'Package.resolved',
  'packages.lock.json',
]

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
const gate = arg('--gate')
if (!gate || !gate.trim()) usageError('--gate: expected the gate command')
const context = arg('--context') ?? 'local-ci'
const install = arg('--install')
if (install !== null && !install.trim()) usageError('--install: expected the install command')
const lockfilesArg = arg('--lockfiles')
if (lockfilesArg !== null && install === null) usageError('--lockfiles needs --install')
const lockfiles = lockfilesArg === null ? LOCKFILES : lockfilesArg.split(',').map((s) => s.trim()).filter(Boolean)
if (lockfiles.length === 0) usageError('--lockfiles: expected file names or paths, a,b')
const trustedArg = arg('--trusted-authors')
const logUrl = arg('--log-url')
let wait = null
{
  const i = process.argv.indexOf('--wait')
  if (i !== -1) {
    const v = process.argv[i + 1]
    if (v === undefined || v.startsWith('--')) wait = 30
    else if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) wait = Number(v)
    else usageError(`--wait: expected seconds, got "${v}"`)
  }
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (...args) => run('git', args)
// Every gh call takes an argument array, never a shell string: a description is the gate's last
// line, which the pull request's code writes. -f (raw) keeps a value starting with "@" a string.
const gh = (...args) => JSON.parse(run('gh', args) || 'null')

// The runner's clone: a checkout root, and never an agent's clone (a forced checkout and a clean
// would destroy its work).
const root = process.cwd()
let top = null
try {
  top = git('rev-parse', '--show-toplevel').trim()
} catch {
  // not a checkout
}
if (!top || realpathSync(top) !== realpathSync(root)) usageError('run it from the root of a clone kept for the runner')
// origin must be --repo: pull/<n>/head from another repository never matches a listed head, and
// its pending would wait forever.
let originUrl = ''
try {
  originUrl = git('remote', 'get-url', 'origin').trim()
} catch {
  // no origin
}
const repoAt = new RegExp(`[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.git)?/?$`, 'i')
if (!repoAt.test(originUrl)) usageError(`origin is ${originUrl ? `"${originUrl}"` : 'not set'}, not ${repo}: the runner's clone must be a clone of --repo`)
if (existsSync(path.join(root, '.agent-loop', 'role'))) {
  usageError(`this clone is an agent's (.agent-loop/role is ${readFileSync(path.join(root, '.agent-loop', 'role'), 'utf8').trim()}): give the runner a clone of its own`)
}

const slug = repo.replace('/', '-')
const contextSlug = context.replace(/[^\w.-]/g, '_')
const STATE_DIR = path.join(homedir(), '.agent-loop', 'state')
const LOCK_FILE = path.join(STATE_DIR, `${slug}-local-ci-${contextSlug}.lock`)
const LOG_DIR = path.join(homedir(), '.agent-loop', 'local-ci', slug)
// What is installed belongs to the clone, not the context: keyed by the clone's real path, and kept
// outside it, where the pull request's code runs.
const INSTALL_RECORD = path.join(STATE_DIR, `local-ci-install-${createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)}.json`)
mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(LOG_DIR, { recursive: true })

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// One runner per repository and context. Liveness is the pid alone: a runner has no end time, so
// the lock never expires while its holder lives.
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, started: Date.now() }))
      closeSync(fd)
      return null
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = {}
      try {
        held = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
      } catch {
        // unreadable: stale
      }
      if (held.pid && held.pid !== process.pid && pidAlive(held.pid)) return held.pid
      try {
        unlinkSync(LOCK_FILE)
      } catch {
        // removed meanwhile
      }
    }
  }
  return null
}

const holder = acquireLock()
if (holder) {
  process.stdout.write(`RUNNER_RUNNING ${holder}\n`)
  process.exit(3)
}

// The install or gate running now, if any.
let child = null
process.on('exit', () => {
  if (child) killChild()
  try {
    if (JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) unlinkSync(LOCK_FILE)
  } catch {
    // already gone
  }
})
const signalCodes = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
for (const [sig, code] of Object.entries(signalCodes)) process.on(sig, () => process.exit(128 + code))

// The install and the gate run in their own process group, so a stop reaches what they started (a
// test runner's workers).
function killChild() {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // already exited
  }
}

class SetupError extends Error {}

let defaultBranch = null
function trustedAuthors() {
  if (trustedArg !== null) return trustedArg.split(',').map((s) => s.trim()).filter(Boolean)
  defaultBranch ??= gh('api', `repos/${repo}`).default_branch
  git('fetch', '--quiet', 'origin', defaultBranch)
  const agents = git('show', 'FETCH_HEAD:AGENTS.md')
  const block = agents.split(/^## /m).find((s) => s.startsWith('Agent loop')) ?? ''
  const line = /^trusted-authors:[ \t]*(.*)$/m.exec(block)?.[1] ?? ''
  return line
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"@]+|['"]+$/g, ''))
    .filter(Boolean)
}

// The status under our context on a commit: its state, or null when there is none. The combined
// status holds the newest status per context.
function statusOf(sha) {
  const combined = gh('api', `repos/${repo}/commits/${sha}/status`)
  return (combined?.statuses ?? []).find((s) => s.context === context)?.state ?? null
}

const cut = (text) => [...text].slice(0, 140).join('')
function post(sha, state, description, targetUrl) {
  const fields = ['-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${cut(description)}`]
  if (targetUrl) fields.push('-f', `target_url=${targetUrl}`)
  gh('api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, ...fields)
}

// A command's last line: the last non-empty one of the log from byte `from` on (the gate's output
// follows the install's), ANSI colour codes removed.
function lastLine(file, from = 0) {
  let text = ''
  try {
    text = readFileSync(file).subarray(from).toString('utf8')
  } catch {
    // no output
  }
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}

// Runs a command through the shell in the clone, its output appended to the log.
function runShell(command, logFile) {
  const fd = openSync(logFile, 'a')
  return new Promise((resolve) => {
    child = spawn(command, { shell: true, cwd: root, stdio: ['ignore', fd, fd], detached: true })
    child.on('error', (e) => {
      child = null
      closeSync(fd)
      resolve({ code: null, signal: null, error: e })
    })
    child.on('exit', (code, signal) => {
      child = null
      closeSync(fd)
      resolve({ code, signal })
    })
  })
}

const sizeOf = (file) => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// What the install depends on at a commit: the tracked lockfiles' paths and blob ids, and the
// install command, hashed. A lockfile added, removed or changed changes it.
function installKey(sha) {
  const byName = lockfiles.filter((l) => !l.includes('/'))
  const byPath = lockfiles.filter((l) => l.includes('/')).map((l) => l.replace(/^\.?\/+/, ''))
  const entries = git('ls-tree', '-r', '-z', '--full-tree', sha)
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t')
      return { file: e.slice(tab + 1), blob: e.slice(0, tab).split(' ')[2] }
    })
    .filter(({ file }) => byName.includes(path.posix.basename(file)) || byPath.includes(file))
    .map(({ file, blob }) => `${blob} ${file}`)
    .sort()
  return createHash('sha256').update(JSON.stringify({ install, lockfiles: entries })).digest('hex')
}

function installedKey() {
  try {
    return JSON.parse(readFileSync(INSTALL_RECORD, 'utf8')).key ?? null
  } catch {
    return null
  }
}

function forgetInstall() {
  try {
    unlinkSync(INSTALL_RECORD)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function recordInstall(key, sha) {
  const tmp = `${INSTALL_RECORD}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ clone: realpathSync(root), key, sha, installed: new Date().toISOString() }, null, 2) + '\n')
  renameSync(tmp, INSTALL_RECORD)
}

const failedRun = (result, what) =>
  result.signal ? `${what} stopped by ${result.signal}` : result.error ? `${what} did not start: ${result.error.message}` : `${what} failed (exit ${result.code})`

async function runOne(pr) {
  const sha = pr.headRefOid
  const short = sha.slice(0, 7)
  try {
    git('fetch', '--quiet', 'origin', `pull/${pr.number}/head`)
    const fetched = git('rev-parse', 'FETCH_HEAD').trim()
    // The head moved since the listing: the next pass lists the new one, and the old head's status
    // no longer matters to the pull request. Said on stderr, so a mismatch that persists is seen.
    if (fetched !== sha) {
      process.stderr.write(`${new Date().toISOString()} local-ci: #${pr.number} is listed at ${short} but origin's pull/${pr.number}/head is ${fetched.slice(0, 7)}; skipped this pass\n`)
      return null
    }
    git('checkout', '--quiet', '--force', '--detach', sha)
    git('clean', '-fdq')
  } catch (e) {
    const detail = String(e?.stderr ?? '').trim().split('\n')[0] || e?.message
    post(sha, 'error', `local-ci could not check out ${short}: ${detail}`)
    return `#${pr.number} ${short} error: could not check out: ${detail}`
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logName = `${pr.number}-${sha.slice(0, 12)}-${stamp}.log`
  const logFile = path.join(LOG_DIR, logName)
  writeFileSync(logFile, '')
  const targetUrl = logUrl ? `${logUrl.replace(/\/+$/, '')}/${logName}` : null
  if (install !== null) {
    let key
    try {
      key = installKey(sha)
    } catch (e) {
      const detail = detailOf(e)
      post(sha, 'error', `local-ci could not read the lockfiles of ${short}: ${detail}`)
      return `#${pr.number} ${short} error: could not read the lockfiles: ${detail}`
    }
    if (key !== installedKey()) {
      // Whatever was installed is unknown from here until the install succeeds: a failed or stopped
      // install leaves no record, so the next head installs again.
      forgetInstall()
      const installed = await runShell(install, logFile)
      if (installed.code !== 0) {
        const description = `install failed: ${lastLine(logFile) || failedRun(installed, 'install')}`
        post(sha, 'error', description, targetUrl)
        return `#${pr.number} ${short} error: ${cut(description)}`
      }
      recordInstall(key, sha)
    }
  }
  const gateFrom = sizeOf(logFile)
  const result = await runShell(gate, logFile)
  const last = lastLine(logFile, gateFrom)
  const ok = result.code === 0
  const description = last || (ok ? 'gate passed' : failedRun(result, 'gate'))
  post(sha, ok ? 'success' : 'failure', description, targetUrl)
  return `#${pr.number} ${short} ${ok ? 'success' : 'failure'}: ${cut(description)}`
}

async function pass() {
  const trusted = new Set(trustedAuthors())
  if (trusted.size === 0) throw new SetupError('no trusted authors: pass --trusted-authors or set trusted-authors in AGENTS.md on the default branch')
  const prs = gh('pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,author,headRefOid,isCrossRepository')
    .filter((p) => !p.isCrossRepository && trusted.has(p.author?.login) && p.headRefOid)
    .sort((a, b) => a.number - b.number)
  const queue = []
  for (const pr of prs) {
    const state = statusOf(pr.headRefOid)
    if (state === null) {
      post(pr.headRefOid, 'pending', `queued: ${gate}`)
      queue.push(pr)
    } else if (state === 'pending') {
      queue.push(pr)
    }
  }
  const lines = []
  for (const pr of queue) {
    const line = await runOne(pr)
    if (line) {
      lines.push(line)
      process.stdout.write(`${line}\n`)
    }
  }
  return lines
}

const detailOf = (e) => (String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]

if (wait === null) {
  try {
    const lines = await pass()
    if (lines.length === 0) process.stdout.write(`NONE ${new Date().toISOString()}\n`)
  } catch (e) {
    process.stderr.write(`local-ci: ${detailOf(e)}\n`)
    process.exit(e instanceof SetupError ? 1 : 2)
  }
} else {
  for (;;) {
    try {
      await pass()
    } catch (e) {
      // No trusted authors is a setup error, not a blip: say so and stop.
      if (e instanceof SetupError) {
        process.stderr.write(`local-ci: ${e.message}\n`)
        process.exit(1)
      }
      process.stderr.write(`${new Date().toISOString()} local-ci: pass failed, retrying: ${detailOf(e)}\n`)
    }
    await new Promise((r) => setTimeout(r, wait * 1000))
  }
}
