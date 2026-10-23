// The inbox folder: message files, one JSON file per message (spec: "Inbox folder"). A message
// mirrors A2A 1.0's Message (role ROLE_USER or ROLE_AGENT, parts without a kind field).
//
// A message file is named `<messageId>.json`. A reader takes only regular files whose name is a
// message id plus `.json`: dotfiles, temporary names (`.<id>.<pid>.tmp`, see sendMessage),
// directories and symlinks are never messages. sendMessage writes the temporary name first and
// renames it, so a reader never sees half a message.
import { readdirSync, lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/
const MAX_BYTES = 1024 * 1024
export const ROLES = ['ROLE_USER', 'ROLE_AGENT']
// A2A 1.0's Part: exactly one content field, the rest optional.
const CONTENT = ['text', 'raw', 'url', 'data']

const str = (v) => typeof v === 'string' && v !== ''

// What is wrong with a parsed message named `<id>.json`, or null when nothing is.
export function problem(msg, id) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return 'not a JSON object'
  if (msg.messageId !== id) return `messageId is not the file name (${id})`
  if (!ROLES.includes(msg.role)) return `role must be ${ROLES.join(' or ')}`
  for (const key of ['contextId', 'from', 'to', 'sentAt']) if (!str(msg[key])) return `${key} must be a non-empty string`
  if (msg.taskId !== undefined && !str(msg.taskId)) return 'taskId must be a non-empty string when present'
  if (Number.isNaN(Date.parse(msg.sentAt))) return 'sentAt must be a date'
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return 'parts must be a non-empty array'
  for (const p of msg.parts) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return 'every part must be an object'
    if (CONTENT.filter((k) => p[k] !== undefined).length !== 1) return `every part needs exactly one of ${CONTENT.join(', ')}`
    for (const k of ['text', 'raw', 'url', 'filename', 'mediaType']) if (p[k] !== undefined && typeof p[k] !== 'string') return `a part's ${k} must be a string`
    if (p.metadata !== undefined && (p.metadata === null || typeof p.metadata !== 'object' || Array.isArray(p.metadata))) return "a part's metadata must be an object"
  }
  return null
}

// Every message file in `dir`, oldest first (sentAt, then id; unreadable ones last, by id):
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
        if (!error) at = Date.parse(msg.sentAt)
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

// Write one message into `dir` (created if missing) and return its id. Fields as in the spec,
// without messageId and sentAt, which this fills in.
export function sendMessage(dir, { role, contextId, taskId, from, to, text }) {
  const messageId = randomUUID()
  const msg = { messageId, role, contextId, ...(taskId ? { taskId } : {}), parts: [{ text }], from, to, sentAt: new Date().toISOString() }
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
