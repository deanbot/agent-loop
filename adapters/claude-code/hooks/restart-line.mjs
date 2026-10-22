#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook: shows the operator the `RESTART: …` line that
// `scripts/pull.mjs --start` prints after a merge, as a systemMessage, so the line reaches the
// terminal whether or not the session writes it into its own text (a terminal can collapse a
// tool's output, and a session can skip the step that repeats it).
//
// Acts only on a Bash call that runs pull.mjs with --start, in an executor clone (its role marker,
// `.agent-loop/role`, says executor). The filter is here rather than in an `if` on the hook entry,
// so it doesn't depend on how a permission-rule glob matches.
//
// Input: the hook JSON on stdin ({ cwd, hook_event_name, tool_name, tool_input: { command },
// tool_response: { stdout } } after a success; { …, error } after a failure: a failed pull exits
// 2 and still prints the line).
// Output: { systemMessage: "<the RESTART line>" } on stdout, or silence. Always exits 0.
import { readFileSync } from 'fs'
import path from 'path'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  process.exit(0)
}
if (input.tool_name !== 'Bash') process.exit(0)
const command = String(input.tool_input?.command ?? '')
if (!/(^|[\s"'/])pull\.mjs(\s|$)/.test(command) || !/\s--start(\s|=|$)/.test(command)) process.exit(0)

let role = null
try {
  role = readFileSync(path.join(input.cwd ?? process.cwd(), '.agent-loop', 'role'), 'utf8').trim()
} catch {}
if (role !== 'executor') process.exit(0)

const response = input.tool_response
const output = [
  typeof response === 'string' ? response : response?.stdout,
  input.error,
].filter((s) => typeof s === 'string').join('\n')
const line = output.split(/\r?\n/).find((l) => l.startsWith('RESTART: '))
if (line) process.stdout.write(JSON.stringify({ systemMessage: line.trimEnd() }))
process.exit(0)
