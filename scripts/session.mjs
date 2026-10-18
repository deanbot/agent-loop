#!/usr/bin/env node
/**
 * Which session runs this clone: one loop session per clone, the newest start wins.
 *
 * Usage (run in the clone's root):
 *   node scripts/session.mjs --start <id>     a loop starts: it takes the clone
 *   node scripts/session.mjs --beat <id>      a loop wakes: is the clone still its own?
 *   node scripts/session.mjs --release <id>   a loop ends: it gives the clone up
 *
 * <id> is the session's id as the adapter knows it (letters, digits, ".", "_", ":", "-"; at most
 * 128). Output — one line, then exits:
 *   --start    NEW                       nobody held the clone; now this session does
 *              MINE                      this session held it already (refreshed)
 *              TOOK_OVER <id> <secs>     another session held it, last seen <secs> ago; it is now
 *                                        superseded, and this session holds the clone
 *   --beat     MINE                      still this session's (refreshed); also when nobody holds
 *                                        it and this session was never superseded
 *              SUPERSEDED <id|none>      another session took the clone over (<id>, or none when
 *                                        that one has released it since): stop
 *   --release  RELEASED | NOT_OWNER      NOT_OWNER changes nothing
 *
 * Why newest wins: a file cannot tell whether the session it names is still alive, and a restart
 * after a closed terminal must not be refused. Claims belong to the clone, not the session, so the
 * new session simply carries on with them. The old session learns it at its next beat, and an
 * adapter whose tool has a pre-tool hook can refuse a superseded session's commands at once.
 *
 * State: .agent-loop/session in the working directory, JSON
 *   { "owner": { "id": "<id>", "at": "<ISO time of its last start or beat>" } | null,
 *     "superseded": ["<id>", …] }   (newest last, at most 20)
 * A missing or unreadable file is an empty one. Written atomically (temp file, then rename).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import path from 'path'

const USAGE = 'session.mjs --start <id> | --beat <id> | --release <id>'
const KEEP = 20

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

const modes = ['--start', '--beat', '--release'].filter((m) => process.argv.includes(m))
if (modes.length !== 1) usageError(modes.length ? 'one of --start, --beat, --release' : undefined)
const mode = modes[0]
const id = process.argv[process.argv.indexOf(mode) + 1]
if (id === undefined || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) usageError(`${mode}: expected a session id, got "${id ?? ''}"`)

const dir = path.join(process.cwd(), '.agent-loop')
const file = path.join(dir, 'session')

let state
try {
  state = JSON.parse(readFileSync(file, 'utf8'))
} catch {
  state = {}
}
const owner = state.owner && typeof state.owner.id === 'string' ? state.owner : null
const superseded = Array.isArray(state.superseded) ? state.superseded.filter((s) => typeof s === 'string') : []
const now = new Date()

function save(next) {
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next) + '\n')
  renameSync(tmp, file)
}
const without = (list, x) => list.filter((s) => s !== x)
const keep = (list) => list.slice(-KEEP)
const mine = () => ({ id, at: now.toISOString() })

let line
if (mode === '--start') {
  if (owner && owner.id !== id) {
    const age = Math.max(0, Math.round((now - new Date(owner.at)) / 1000)) || 0
    save({ owner: mine(), superseded: keep([...without(without(superseded, owner.id), id), owner.id]) })
    line = `TOOK_OVER ${owner.id} ${age}`
  } else {
    save({ owner: mine(), superseded: without(superseded, id) })
    line = owner ? 'MINE' : 'NEW'
  }
} else if (mode === '--beat') {
  if (owner?.id === id || (!owner && !superseded.includes(id))) {
    save({ owner: mine(), superseded })
    line = 'MINE'
  } else {
    // Another session holds the clone, or took it and released it since. Record this one as
    // superseded (a start already did, unless the file was replaced) so a hook can refuse it.
    if (!superseded.includes(id)) save({ owner, superseded: keep([...superseded, id]) })
    line = `SUPERSEDED ${owner?.id ?? 'none'}`
  }
} else if (owner?.id === id) {
  save({ owner: null, superseded })
  line = 'RELEASED'
} else {
  line = 'NOT_OWNER'
}
process.stdout.write(line + '\n')
