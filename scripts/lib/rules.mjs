/**
 * The record of a rules change a clone has pulled and its session has not read yet: written by
 * pull.mjs, read by pick-next.mjs (which refuses to pick while it holds anything) and cleared by
 * rules-ack.mjs once it has printed the diff (spec: "Rules that change while a loop runs").
 *
 * One file per clone in the state folder the signal scripts share, named by the SHA-256 of the
 * clone's real root path, so a session can't miss it by running a script from a subfolder or
 * through a symlink. It lives outside the clone: PR code runs there and could clear it.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import path from 'path'

// The clone's root: git's top level for the current directory, else the directory itself.
export function cloneRoot() {
  let root = process.cwd()
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || root
  } catch {
    // not a git work tree
  }
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

export function recordFile(root = cloneRoot()) {
  return path.join(homedir(), '.agent-loop', 'state', `rules-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`)
}

const RANGE = /^[0-9a-f]{4,64}$/

// The pending ranges, oldest first: [{ from, to, files }]. No record → []. A record that can't be
// read or parsed → null: something is pending, but not what.
export function readPending(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    return null
  }
  try {
    const pending = JSON.parse(text).pending
    if (!Array.isArray(pending)) return null
    const ok = (r) => r && RANGE.test(r.from) && RANGE.test(r.to) && Array.isArray(r.files) && r.files.length > 0 && r.files.every((f) => typeof f === 'string' && f)
    return pending.every(ok) ? pending : null
  } catch {
    return null
  }
}

// Add one range to the record, after any still pending (an unreadable record is replaced: its
// ranges are lost, and this one is still pending). Written atomically.
export function addPending(file, range) {
  const pending = [...(readPending(file) ?? []), range]
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ clone: cloneRoot(), pending }, null, 2) + '\n')
  renameSync(tmp, file)
}

export function clearPending(file) {
  try {
    unlinkSync(file)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

// The files of every pending range, each once, in the order they were first recorded.
export const pendingFiles = (pending) => [...new Set(pending.flatMap((r) => r.files))]

// A path as one shell word: bare when plain, else single-quoted.
export const shellWord = (p) => (/^[\w./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)

export const diffCommand = (r) => `git diff ${r.from.slice(0, 12)}..${r.to.slice(0, 12)} -- ${r.files.map(shellWord).join(' ')}`
