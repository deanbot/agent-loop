#!/usr/bin/env node
// PreToolUse guard for agent clones: merging is the operator's action, never an agent's.
//
// Fires only where a role marker exists (`.agent-loop/role`, written by setup-project.sh into
// executor / reviewer / QA clones). The operator's own clone has no marker, so nothing changes
// there. Denies `gh pr merge` and the REST merge route; everything else passes.
//
// Input: the PreToolUse JSON on stdin ({ cwd, tool_name, tool_input: { command } }).
// Output: a permissionDecision JSON on stdout to deny; silence (exit 0) to allow.
import { readFileSync, existsSync } from 'fs'
import path from 'path'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  process.exit(0)
}
const cwd = input.cwd ?? process.cwd()
const marker = path.join(cwd, '.agent-loop', 'role')
if (!existsSync(marker)) process.exit(0)

const command = String(input.tool_input?.command ?? '')
const mergeCli = /(^|[;&|(]\s*|\n\s*)gh\s+pr\s+merge\b/
const mergeApi = /gh\s+api\b[^\n;&|]*\/pulls\/\d+\/merge\b/
if (!mergeCli.test(command) && !mergeApi.test(command)) process.exit(0)

const role = readFileSync(marker, 'utf8').trim() || 'agent'
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `agent-loop: this clone is the ${role} clone (.agent-loop/role). Merging is the operator's action; never run gh pr merge here. Report MERGE_READY and keep polling.`,
    },
  })
)
process.exit(0)
