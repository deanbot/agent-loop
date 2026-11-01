#!/usr/bin/env node
/**
 * The end of a head's latest local-ci run log on this machine (#137), so an executor on the runner's
 * machine reads a failure there instead of re-running the whole gate to see it. The script prints the
 * log itself: the session needs no read access to the runner's log folder.
 *
 * Usage:
 *   node scripts/local-ci-log.mjs --repo owner/repo --pr <n> --sha <sha>
 *
 * Looks in the runner's log folder, ~/.agent-loop/local-ci/<owner>-<repo>/, for the files
 * local-ci.mjs writes, `<pr>-<first 12 of sha>-<time>.log`, and prints either
 *   LOG <path>     the newest log of that PR's head <sha> (a sha of 7 to 40 hex digits; one shorter
 *                  than 12 matches the logs whose sha starts with it), then its last 200 lines, each
 *                  indented by two spaces, with ANSI sequences and control characters removed (a
 *                  carriage return keeps what was written after it, as a terminal shows it; a line
 *                  over 2000 characters is cut), then
 *   LOG_CUT        when the log has more than what was printed (earlier lines, or a cut line)
 * or
 *   NO_LOCAL_LOG   no such log here: the runner runs elsewhere (or as another user), the folder or
 *                  the log isn't readable by this script, or this head has no run yet
 * Exit 0 either way; exit 1 on a usage error. It reads the log's last 1 MiB at most and writes
 * nothing.
 */

import { readdirSync, openSync, fstatSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

const USAGE = 'local-ci-log.mjs --repo owner/repo --pr <n> --sha <sha>'
const OPTIONS = ['--repo', '--pr', '--sha']
const TAIL_LINES = 200
const TAIL_BYTES = 1024 * 1024
const LINE_CHARS = 2000

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
  if (OPTIONS.includes(process.argv[i])) i++
  else usageError(`unexpected argument "${process.argv[i]}"`)
}

const repo = arg('--repo')
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const pr = arg('--pr')
if (!pr || !/^\d+$/.test(pr)) usageError(pr ? `--pr: expected a PR number, got "${pr}"` : '--pr is required')
const shaArg = arg('--sha')
if (!shaArg || !/^[0-9a-fA-F]{7,40}$/.test(shaArg)) usageError(shaArg ? `--sha: expected a commit sha (7 to 40 hex digits), got "${shaArg}"` : '--sha is required')
const sha = shaArg.toLowerCase().slice(0, 12)

// local-ci.mjs's LOG_DIR and log name, `${pr}-${sha.slice(0, 12)}-${stamp}.log`.
const dir = path.join(homedir(), '.agent-loop', 'local-ci', repo.replace('/', '-'))
const NAME = /^(\d+)-([0-9a-f]{12})-([0-9TZ-]+)\.log$/

let names = []
try {
  names = readdirSync(dir)
} catch {
  // no folder, or not readable: no log here
}
// The time stamps are ISO times with ':' and '.' as '-': for one PR and sha they sort by name.
const newest = names
  .map((n) => [n, NAME.exec(n)])
  .filter(([, m]) => m && m[1] === pr && m[2].startsWith(sha))
  .map(([n]) => n)
  .sort()
  .at(-1)

// The log's last TAIL_BYTES, or null when it can't be read.
function readTail(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got)
      if (n === 0) break
      got += n
    }
    return { text: buf.subarray(0, got).toString('utf8'), partial: size > len }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// A log line as plain text: ANSI sequences (CSI, OSC, other ESC pairs) out, a carriage return keeps
// what follows it, every other control character (C0, DEL, C1) out, a tab as a space.
function clean(line) {
  const noAnsi = line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
  const shown = noAnsi.replace(/\r+$/, '').split('\r').at(-1)
  return shown.replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

const tail = newest ? readTail(path.join(dir, newest)) : null
if (!tail) {
  process.stdout.write('NO_LOCAL_LOG\n')
} else {
  const lines = tail.text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  // A tail that starts mid-file starts mid-line: that first piece is dropped.
  if (tail.partial) lines.shift()
  let cut = tail.partial || lines.length > TAIL_LINES
  const shown = lines.slice(-TAIL_LINES).map((l) => {
    const c = clean(l)
    if (c.length <= LINE_CHARS) return c
    cut = true
    return `${c.slice(0, LINE_CHARS)}…`
  })
  const out = [`LOG ${path.join(dir, newest)}`, ...shown.map((l) => `  ${l}`)]
  if (cut) out.push('LOG_CUT')
  process.stdout.write(`${out.join('\n')}\n`)
}
