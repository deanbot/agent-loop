// Shared driver for the signal scripts: one-shot runs and `--wait` runs.
//
// A script supplies `pass({ gh, save, dry })`, its one-shot body: it reads its state file,
// evaluates the PRs, hands the new state text to `save`, and returns the text it would print.
// `gh` runs a gh command and returns stdout, memoised within one evaluation. `dry` is true when
// nothing will be written (the script then keeps its stderr warnings to itself).
//
// One-shot (no --wait): run the pass, write the state, print the output, exit. Output is unchanged
// from the scripts' original behaviour. It also records the baseline (below) in a sidecar file
// next to the state, `<state>[-<key>]-wait.json`: after a pass that changed the state, a dry pass
// over the same cached responses (no API calls) gives what the next quiet run will print.
//
// --wait [secs] (default 30), --max <secs> (default 1500): a waiter. It never writes state. Every
// interval it runs a dry pass; when a one-shot run would print news, it prints `PENDING` and exits
// 0, and the agent then runs the script one-shot as usual. When --max passes first it prints
// `NONE <timestamp>` and exits 0. Output is news when it is not NONE and either
//   - the pass would change the state (an event to consume: a new comment, commit, CI failure,
//     close), or
//   - it differs from the baseline: what the script reports steadily while nothing happens.
//     MERGE_READY, a re-surfaced live verdict and REVIEW:<n> for a PR with no reviewer post repeat
//     on every run, so without the baseline a waiter would return at once, every time.
// No baseline yet (no one-shot run since this version) → any non-NONE output is news.
//
// One waiter per state file (and key): a pid lock (`<state>[-<key>]-wait.lock`). A second waiter
// while the first is alive prints `WATCHER_RUNNING <pid>` and exits 3, so a harness that reports
// only exit codes can tell it apart. A failed pass (network, rate limit, auth) is reported on
// stderr and retried on the next interval; a one-shot run still fails as before.
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from 'fs'

export function usageError(usage, message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${usage}\n`)
  process.exit(1)
}

// --wait takes an optional value; --max requires one. Returns { wait: secs | null, max: secs }.
export function waitArgs(argv, usage) {
  const num = (v) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null)
  let wait = null
  const wi = argv.indexOf('--wait')
  if (wi !== -1) {
    const v = argv[wi + 1]
    if (v === undefined || v.startsWith('--')) wait = 30
    else if (num(v) > 0) wait = num(v)
    else usageError(usage, `--wait: expected seconds, got "${v}"`)
  }
  let max = 1500
  const mi = argv.indexOf('--max')
  if (mi !== -1) {
    const v = argv[mi + 1]
    if (num(v) > 0) max = num(v)
    else usageError(usage, `--max: expected seconds, got "${v ?? ''}"`)
    if (wait === null) usageError(usage, '--max needs --wait')
  }
  return { wait, max }
}

function readOr(file, fallback) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

const fingerprint = (out) => out.replace(/^NONE .*$/m, 'NONE').trim()
const isNone = (out) => fingerprint(out) === 'NONE'

function memoGh() {
  const cache = new Map()
  return (cmd, opts = {}) => {
    if (!cache.has(cmd)) {
      try {
        cache.set(cmd, { ok: execSync(cmd, { encoding: 'utf8', ...opts }) })
      } catch (e) {
        cache.set(cmd, { err: e })
      }
    }
    const hit = cache.get(cmd)
    if (hit.err) throw hit.err
    return hit.ok
  }
}

// The part of the state this run owns: all of it, or one key (pr-poll keeps every PR of a repo in
// one file, and another executor's PR must not count as news here).
function own(text, key) {
  if (key === undefined || text === null) return text
  try {
    return JSON.stringify(JSON.parse(text)[key] ?? null)
  } catch {
    return text
  }
}

// One dry evaluation: the output and the state text the pass would write (null: none).
function dryPass(pass, gh) {
  let saved = null
  const out = pass({ gh, save: (text) => (saved = text), dry: true })
  return { out, saved }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function acquireLock(lockFile, max) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, started: Date.now(), max }))
      closeSync(fd)
      return null
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = {}
      try {
        held = JSON.parse(readFileSync(lockFile, 'utf8'))
      } catch {
        // unreadable lock: treat as stale
      }
      const expired = Date.now() > (held.started ?? 0) + ((held.max ?? 0) + 120) * 1000
      if (held.pid && held.pid !== process.pid && pidAlive(held.pid) && !expired) return held.pid
      try {
        unlinkSync(lockFile)
      } catch {
        // another run removed it first
      }
    }
  }
  return null
}

export async function runSignalScript({ argv, usage, stateFile, key, pass }) {
  const { wait, max } = waitArgs(argv, usage)
  const base = `${stateFile.replace(/\.json$/, '')}${key === undefined ? '' : `-${key}`}`
  const waitFile = `${base}-wait.json`
  const lockFile = `${base}-wait.lock`
  const loadBaseline = () => {
    try {
      return JSON.parse(readOr(waitFile, '{}')).baseline ?? null
    } catch {
      return null
    }
  }

  if (wait === null) {
    const gh = memoGh()
    const before = own(readOr(stateFile, null), key)
    const out = pass({ gh, save: (text) => writeAtomic(stateFile, text), dry: false })
    const changed = own(readOr(stateFile, null), key) !== before
    const baseline = changed ? fingerprint(dryPass(pass, gh).out) : fingerprint(out)
    writeAtomic(waitFile, JSON.stringify({ baseline }))
    process.stdout.write(out)
    return
  }

  const holder = acquireLock(lockFile, max)
  if (holder) {
    process.stdout.write(`WATCHER_RUNNING ${holder}\n`)
    process.exit(3)
  }
  const release = () => {
    try {
      if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile)
    } catch {
      // already gone
    }
  }
  process.on('exit', release)
  // A stopped waiter (killed by its harness, Ctrl-C) prints nothing and leaves through 'exit',
  // releasing the lock.
  const signalCodes = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  for (const [sig, code] of Object.entries(signalCodes)) process.on(sig, () => process.exit(128 + code))

  const deadline = Date.now() + max * 1000
  for (;;) {
    try {
      const current = readOr(stateFile, null)
      const { out, saved } = dryPass(pass, memoGh())
      const wouldChange = saved !== null && own(saved, key) !== own(current, key)
      if (!isNone(out) && (wouldChange || fingerprint(out) !== loadBaseline())) {
        process.stdout.write('PENDING\n')
        return
      }
    } catch (e) {
      const detail = String(e?.stderr ?? '').trim() || e?.message
      process.stderr.write(`${new Date().toISOString()} pass failed, retrying: ${detail}\n`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(wait * 1000, remaining)))
    if (Date.now() >= deadline) break
  }
  process.stdout.write(`NONE ${new Date().toISOString()}\n`)
}
