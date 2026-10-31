#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook: shows the operator the lines a loop prints for them, as a
// systemMessage, so they reach the terminal whether or not the session writes them into its own
// text (a terminal can collapse a tool's output, and a session can skip the step that repeats it).
//
// Two sources, told apart by the role marker (`.agent-loop/role`):
//   - `scripts/pull.mjs --start`, run after a merge, in an executor clone: its `RESTART: …` line (#105).
//   - `scripts/start-check.mjs`, run at every start, in an executor, reviewer or QA clone or one with
//     no marker yet: its `⚠ ` lines, all of them, in order (#128).
// The filter is here rather than in an `if` on the hook entry, so it doesn't depend on how a
// permission-rule glob matches, and one entry serves both: every hook entry costs a process per
// Bash call.
//
// Input: the hook JSON on stdin ({ cwd, hook_event_name, tool_name, tool_input: { command },
// tool_response: { stdout } } after a success; { …, error } after a failure: a failed pull exits
// 2 and still prints the line).
// Output: { systemMessage: "<the lines>" } on stdout, or silence. Always exits 0.
import { readFileSync } from 'fs'
import path from 'path'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  process.exit(0)
}
if (input?.tool_name !== 'Bash') process.exit(0)
const command = String(input.tool_input?.command ?? '')
// The script path may be quoted (a plugin root with a space in it).
const runs = (script) => new RegExp(`(^|[\\s"'/])${script.replace('.', '\\.')}(["'\\s]|$)`).test(command)
const restart = runs('pull.mjs') && /\s--start(\s|=|$)/.test(command)
const start = runs('start-check.mjs')
if (!restart && !start) process.exit(0)

let role = null
try {
  role = readFileSync(path.join(input.cwd ?? process.cwd(), '.agent-loop', 'role'), 'utf8').trim()
} catch {}
// A start runs in a clone with no marker yet too (setup not run), and its lines have no other way out.
if (restart ? role !== 'executor' : role !== null && !['executor', 'reviewer', 'qa'].includes(role)) process.exit(0)

const response = input.tool_response
const output = [
  typeof response === 'string' ? response : response?.stdout,
  input.error,
].filter((s) => typeof s === 'string').join('\n')
const lines = output.split(/\r?\n/).filter((l) => l.startsWith(restart ? 'RESTART: ' : '⚠ ')).map((l) => l.trimEnd())
const shown = restart ? lines.slice(0, 1) : lines
if (shown.length > 0) process.stdout.write(JSON.stringify({ systemMessage: shown.join('\n') }))
process.exit(0)
