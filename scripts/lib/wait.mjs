// Shared driver for the signal scripts: one-shot runs and `--wait` runs.
//
// A script supplies `pass({ gh, save, dry })`, its one-shot body: it reads its state file,
// evaluates the PRs, hands the new state text to `save`, and returns the text it would print.
// `gh` runs a gh command and returns stdout, memoised within one evaluation. `dry` is true when
// nothing will be written (the script then keeps its stderr warnings to itself).
//
// One-shot (no --wait): run the pass, write the state, print the output, exit. Output is unchanged
// from the scripts' original behaviour. It also records the baseline (below) in a sidecar file
// next to the state, `<state>-wait.json`: after a pass that changed the state, a dry pass
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
// Idle count (#75): the sidecar also counts one-shot runs in a row that brought nothing new: the
// state unchanged, the output equal to the previous baseline (a standing signal the agent already
// handled is not new), and the pass's activity key, if it marks one, unchanged (pr-poll marks the
// head sha and the CI state, which its state does not hold). Any other run resets it to 0. With
// --idle-after <n>, a one-shot run whose count has reached n prints `IDLE <count>` as its last
// line, after the baseline is taken, so the waiter never compares against it. The agent picks
// its longer wait from that; the script names no wait. Waiters accept the flag and ignore it.
//
// Inbox (#77): a waiter given --inbox <folder> also ends with `PENDING` as soon as the folder holds
// a message file inbox.mjs has not reported yet, so one waiter carries both GitHub news and
// direction. It reads inbox.mjs's record and never writes it; a folder that does not exist is never
// news. One-shot runs accept the flag and ignore it: the agent runs inbox.mjs itself.
//
// One waiter per state file: a pid lock (`<state>-wait.lock`). A new waiter that finds the lock held
// by a live waiter it can verify takes it over (#116): the holder gets SIGUSR2, prints `TAKEN_OVER`
// and exits 4, releasing the lock, and the new one waits as usual. Verified means all of: the lock
// names this script and this state file (a lock without them, from an older version, is never
// verified); the holder runs as this user; its command line runs this script with --wait; and it
// started when the lock says (a reused pid did not). Anything else, a platform where a command line
// can't be read, or a holder still alive after a few seconds, and the new waiter prints
// `WATCHER_RUNNING <pid>` and exits 3, as before; it never sends SIGKILL, and it tries a takeover
// at most once, so two new waiters never take the lock back and forth. Exit codes 3 and 4 let a
// harness that reports only exit codes tell both cases apart. A failed pass (network, rate limit,
// auth) is reported on stderr and retried on the next interval; a one-shot run still fails as
// before.
import { execSync, execFileSync } from 'child_process'
import { readFileSync, writeFileSync, writeSync, openSync, closeSync, unlinkSync, renameSync } from 'fs'
import path from 'path'
import { unreported, expandHome } from './inbox.mjs'

export function usageError(usage, message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${usage}\n`)
  process.exit(1)
}

// --wait takes an optional value; --max, --idle-after and --inbox require one.
// Returns { wait: secs | null, max: secs, idleAfter: n | null, inbox: folder | null }.
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
  let idleAfter = null
  const ii = argv.indexOf('--idle-after')
  if (ii !== -1) {
    const v = argv[ii + 1]
    if (/^[1-9]\d*$/.test(v ?? '')) idleAfter = Number(v)
    else usageError(usage, `--idle-after: expected a count of runs, got "${v ?? ''}"`)
  }
  let inbox = null
  const bi = argv.indexOf('--inbox')
  if (bi !== -1) {
    const v = argv[bi + 1]
    if (v === undefined || v === '' || v.startsWith('--')) usageError(usage, '--inbox: expected a folder')
    inbox = expandHome(v)
  }
  return { wait, max, idleAfter, inbox }
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

// A process this user may signal (EPERM, which pidAlive counts as alive, is another user's).
function signallable(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// `ps` elapsed time, [[dd-]hh:]mm:ss, in seconds; null when it isn't one.
function elapsedSecs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text)
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : null
}

// Whether the lock's holder is verifiably a waiter for this same state file (see the header).
// Every doubt is a no.
function verifiedWaiter(held, self) {
  if (process.platform === 'win32') return false
  if (!Number.isInteger(held.pid) || held.script !== self.script || held.stateFile !== self.stateFile) return false
  if (!signallable(held.pid)) return false
  let line
  try {
    line = execFileSync('ps', ['-ww', '-o', 'etime=,command=', '-p', String(held.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
  } catch {
    return false
  }
  const m = /^(\S+)\s+(.+)$/.exec(line)
  const secs = m ? elapsedSecs(m[1]) : null
  if (secs === null) return false
  // The lock is written a moment after the process starts, and ps counts whole seconds.
  const lag = held.started - (Date.now() - secs * 1000)
  if (!(lag > -3000 && lag < 30000)) return false
  const words = m[2].split(/\s+/)
  return words.some((w) => path.basename(w) === path.basename(self.script)) && words.includes('--wait')
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// Asks a verified holder to give the lock up; true once it has exited, false if it is still alive
// after the grace period (it is then left alone).
async function takeOver(pid) {
  try {
    process.kill(pid, 'SIGUSR2')
  } catch {
    return !signallable(pid)
  }
  for (let waited = 0; waited < 5000; waited += 100) {
    if (!signallable(pid)) return true
    await pause(100)
  }
  return !signallable(pid)
}

async function acquireLock(lockFile, max, self) {
  let triedTakeover = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, started: Date.now(), max, script: self.script, stateFile: self.stateFile }))
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
      if (held.pid && held.pid !== process.pid && pidAlive(held.pid) && !expired) {
        if (triedTakeover || !verifiedWaiter(held, self)) return held.pid
        triedTakeover = true
        if (!(await takeOver(held.pid))) return held.pid
        // It released the lock on its way out; if it couldn't, the lock is stale now.
      }
      // Remove the stale lock, unless another waiter has written its own since it was read.
      let stillStale = true
      try {
        stillStale = JSON.parse(readFileSync(lockFile, 'utf8')).pid === held.pid
      } catch {
        // gone, or unreadable: stale either way
      }
      try {
        if (stillStale) unlinkSync(lockFile)
      } catch {
        // another run removed it first
      }
    }
  }
  return null
}

export async function runSignalScript({ argv, usage, stateFile, pass }) {
  const { wait, max, idleAfter, inbox } = waitArgs(argv, usage)
  const base = stateFile.replace(/\.json$/, '')
  const waitFile = `${base}-wait.json`
  const lockFile = `${base}-wait.lock`
  const loadSidecar = () => {
    try {
      return JSON.parse(readOr(waitFile, '{}')) ?? {}
    } catch {
      return {}
    }
  }
  const loadBaseline = () => loadSidecar().baseline ?? null

  if (wait === null) {
    const gh = memoGh()
    const prev = loadSidecar()
    const before = readOr(stateFile, null)
    let activity = null
    const out = pass({ gh, save: (text) => writeAtomic(stateFile, text), dry: false, mark: (key) => (activity = key) })
    const changed = readOr(stateFile, null) !== before
    const baseline = changed ? fingerprint(dryPass(pass, gh).out) : fingerprint(out)
    const quiet = !changed && prev.baseline != null && fingerprint(out) === prev.baseline && activity === (prev.activity ?? null)
    const idle = quiet ? (Number.isInteger(prev.idle) ? prev.idle : 0) + 1 : 0
    writeAtomic(waitFile, JSON.stringify({ baseline, activity, idle }))
    process.stdout.write(idleAfter !== null && idle >= idleAfter ? `${out}IDLE ${idle}\n` : out)
    return
  }

  const holder = await acquireLock(lockFile, max, { script: path.resolve(argv[1]), stateFile: path.resolve(stateFile) })
  if (holder) {
    process.stdout.write(`WATCHER_RUNNING ${holder}\n`)
    process.exit(3)
  }
  // A newer waiter took the lock over: say so and leave, releasing it on the way out ('exit').
  // Written synchronously, so the line is out before the process ends.
  process.on('SIGUSR2', () => {
    writeSync(1, 'TAKEN_OVER\n')
    process.exit(4)
  })
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
    // The inbox first, apart from the pass: a message ends the wait even while GitHub is failing.
    if (inbox !== null) {
      try {
        if (unreported(inbox).length > 0) {
          process.stdout.write('PENDING\n')
          return
        }
      } catch (e) {
        process.stderr.write(`${new Date().toISOString()} inbox check failed, retrying: ${e?.message}\n`)
      }
    }
    try {
      const current = readOr(stateFile, null)
      const { out, saved } = dryPass(pass, memoGh())
      const wouldChange = saved !== null && saved !== current
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
