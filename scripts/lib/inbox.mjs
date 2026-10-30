// The inbox folder: message files, one JSON file per message (spec: "Inbox folder"). A message is
// an A2A 1.0 Message as it stands (role ROLE_USER or ROLE_AGENT, parts without a kind field), with
// agent-loop's own from, to and sentAt in its metadata.
//
// A message file is named `<messageId>.json`. A reader takes only regular files whose name is a
// message id plus `.json`: dotfiles, temporary names (`.<id>.<pid>.tmp`, see sendMessage),
// directories and symlinks are never messages. sendMessage writes the temporary name first and
// renames it, so a reader never sees half a message.
import { readdirSync, lstatSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, realpathSync } from 'fs'
import { randomUUID, createHash } from 'crypto'
import { homedir } from 'os'
import path from 'path'

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/
const MAX_BYTES = 1024 * 1024
export const ROLES = ['ROLE_USER', 'ROLE_AGENT']
// A2A 1.0's Part: exactly one content field, the rest optional.
const CONTENT = ['text', 'raw', 'url', 'data']

// agent-loop's keys in the Message's metadata.
export const META = ['from', 'to', 'sentAt']

const str = (v) => typeof v === 'string' && v !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// What is wrong with a parsed message named `<id>.json`, or null when nothing is.
export function problem(msg, id) {
  if (!isObject(msg)) return 'not a JSON object'
  if (msg.messageId !== id) return `messageId is not the file name (${id})`
  if (!ROLES.includes(msg.role)) return `role must be ${ROLES.join(' or ')}`
  if (!str(msg.contextId)) return 'contextId must be a non-empty string'
  if (msg.taskId !== undefined && !str(msg.taskId)) return 'taskId must be a non-empty string when present'
  // A2A 1.0's Message has no such fields: a file that has them is not a valid Message.
  for (const key of META) if (key in msg) return `${key} belongs in metadata, not at the top level`
  if (!isObject(msg.metadata)) return 'metadata must be an object'
  for (const key of META) if (!str(msg.metadata[key])) return `metadata.${key} must be a non-empty string`
  if (Number.isNaN(Date.parse(msg.metadata.sentAt))) return 'metadata.sentAt must be a date'
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return 'parts must be a non-empty array'
  for (const p of msg.parts) {
    if (!isObject(p)) return 'every part must be an object'
    if (CONTENT.filter((k) => p[k] !== undefined).length !== 1) return `every part needs exactly one of ${CONTENT.join(', ')}`
    for (const k of ['text', 'raw', 'url', 'filename', 'mediaType']) if (p[k] !== undefined && typeof p[k] !== 'string') return `a part's ${k} must be a string`
    if (p.metadata !== undefined && !isObject(p.metadata)) return "a part's metadata must be an object"
  }
  return null
}

// Every message file in `dir`, oldest first (metadata.sentAt, then id; invalid ones last, by id):
// [{ id, error }], error null for a valid message. A missing folder has none.
export function listMessages(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const found = []
  for (const name of names) {
    const m = FILE.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    let st
    try {
      st = lstatSync(file)
    } catch {
      continue // removed since the listing
    }
    if (!st.isFile()) continue
    const id = m[1]
    let error = null
    let at = Infinity
    if (st.size > MAX_BYTES) error = `larger than ${MAX_BYTES} bytes`
    else {
      try {
        const msg = JSON.parse(readFileSync(file, 'utf8'))
        error = problem(msg, id)
        if (!error) at = Date.parse(msg.metadata.sentAt)
      } catch (e) {
        if (e.code === 'ENOENT') continue
        error = `unreadable: ${e.message}`
      }
    }
    found.push({ id, error, at })
  }
  // Two unreadable ones give Infinity - Infinity, NaN, which falls through to the id like a tie.
  found.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return found.map(({ id, error }) => ({ id, error }))
}

// A folder given as `~`, or starting with `~` and a slash (quoted, so the shell left it alone), is
// the home folder or under it.
export function expandHome(p) {
  return p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
}

// The real path of `p`, which need not exist yet: its nearest existing ancestor resolved, plus the rest.
export function realish(p) {
  let head = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      return path.join(realpathSync(head), ...rest)
    } catch {
      const up = path.dirname(head)
      if (up === head) return path.resolve(p)
      rest.unshift(path.basename(head))
      head = up
    }
  }
}

const within = (p, folder) => {
  const rel = path.relative(folder, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// What is wrong with a mailbox (an inbox read as direction, an outbox for replies) for the clone at
// `clone`, or null when nothing is (spec: "Inbox folder", Trust). PR code runs in the clone, so
// neither folder may be in it; and each is its own folder, so a mount carries one direction. A path
// that exists as something other than a folder (a symlink is followed), or lies under a file, can
// never hold messages.
export function mailboxProblem(inbox, outbox, clone) {
  if (!path.isAbsolute(inbox) || !path.isAbsolute(outbox)) return 'both folders must be absolute or start with ~'
  const [i, o, c] = [realish(inbox), realish(outbox), realish(clone)]
  if (within(i, c)) return 'the inbox is inside the clone, where PR code runs'
  if (within(o, c)) return 'the outbox is inside the clone, where PR code runs'
  if (within(i, o) || within(o, i)) return 'the inbox and the outbox must be separate folders, neither inside the other'
  for (const [name, p] of [['inbox', inbox], ['outbox', outbox]]) {
    const k = kind(p)
    if (k === 'other') return `the ${name} is not a folder`
    if (k === 'blocked') return `the ${name} is under a file, so it can never be created`
  }
  return null
}

// 'folder', 'missing' (nothing there yet, a dangling symlink included), 'blocked' (a file where a
// parent folder should be: it can never be made) or 'other', following symlinks. A path that can't
// be looked at for another reason counts as a folder: reading it fails loudly.
function kind(p) {
  try {
    return statSync(p).isDirectory() ? 'folder' : 'other'
  } catch (e) {
    return e.code === 'ENOENT' ? 'missing' : e.code === 'ENOTDIR' ? 'blocked' : 'folder'
  }
}

// The warning for an acceptable mailbox, or null: an inbox that does not exist yet reads as empty
// (a mount may appear later, so it is no refusal), which a mistyped path would look like forever.
// A missing outbox is fine: sending creates it.
export function mailboxWarning(inbox) {
  return kind(inbox) === 'missing' ? 'the inbox does not exist yet; nothing arrives until it is created' : null
}

// The record of what inbox.mjs has reported for `dir`: one file per folder, in the state folder the
// signal scripts share, named by the SHA-256 of the folder's real path (its resolved path while it
// does not exist yet: nothing is recorded for it then).
export function recordFile(dir) {
  let real = path.resolve(dir)
  try {
    real = realpathSync(real)
  } catch {
    // no folder yet
  }
  return path.join(homedir(), '.agent-loop', 'state', `inbox-${createHash('sha256').update(real).digest('hex').slice(0, 16)}.json`)
}

// The ids the record holds; a missing or unreadable record holds none.
export function readReported(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return new Set(Array.isArray(state.reported) ? state.reported : [])
  } catch {
    return new Set()
  }
}

// The message files in `dir` that inbox.mjs has not reported yet (what its next run would print),
// read without writing anything: a waiter's check.
export function unreported(dir) {
  const reported = readReported(recordFile(dir))
  return listMessages(dir).filter((m) => !reported.has(m.id))
}

// One message file in `dir`, parsed: { msg } for a valid message, { error } otherwise (a file
// that is missing, not a regular file, too large or not a valid message).
export function readMessage(dir, id) {
  if (!ID.test(id)) return { error: 'not a message id' }
  const file = path.join(dir, `${id}.json`)
  try {
    const st = lstatSync(file)
    if (!st.isFile()) return { error: 'not a regular file' }
    if (st.size > MAX_BYTES) return { error: `larger than ${MAX_BYTES} bytes` }
    const msg = JSON.parse(readFileSync(file, 'utf8'))
    const error = problem(msg, id)
    return error ? { error } : { msg }
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'no such message' : `unreadable: ${e.message}` }
  }
}

// Write one message into `dir` (created if missing) and return its id. Fields as in the spec,
// without messageId and sentAt, which this fills in; from, to and sentAt go in metadata.
export function sendMessage(dir, { role, contextId, taskId, from, to, text }) {
  const messageId = randomUUID()
  const msg = {
    messageId,
    role,
    contextId,
    ...(taskId ? { taskId } : {}),
    parts: [{ text }],
    metadata: { from, to, sentAt: new Date().toISOString() },
  }
  const error = problem(msg, messageId)
  if (error) throw new Error(error)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${messageId}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(msg, null, 2) + '\n', { flag: 'wx' })
  try {
    renameSync(tmp, path.join(dir, `${messageId}.json`))
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    throw e
  }
  return messageId
}
