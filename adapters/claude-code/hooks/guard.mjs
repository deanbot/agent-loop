#!/usr/bin/env node
// PreToolUse guard for agent clones: merging and pushing to the default branch are the operator's
// actions, never an agent's.
//
// Fires in every session where the plugin is enabled, but acts only where a role marker exists
// (`.agent-loop/role`, written by setup-project.sh into executor / reviewer / QA clones). The
// operator's own clone has no marker, so nothing changes there. Denies, anywhere in the command
// text (so wrappers, env assignments and `&&` chains do not slip past):
//   - gh pr merge …
//   - gh api … /pulls/<n>/merge  and  gh api graphql … mergePullRequest
//   - git push … <main|master>  (as a bare refspec or the destination of src:dst)
// It is a safety net behind the prompt rule, not a security boundary: a command that invokes the
// same program another way (a script, `sh -c`, the API from node) is not caught.
//
// It also refuses every Bash, Edit, Write and NotebookEdit call from a session that another one
// took over in this clone (`.agent-loop/session`, written by scripts/session.mjs: the newest loop
// start wins). Two sessions in one clone sign claims as the same clone and move the checkout
// under each other; the old one stops at its next tool call instead of its next wake. Calls to
// session.mjs itself pass, since the script keeps its own rules. A session the file never named
// (the operator looking around in the clone) is not affected.
//
// Input: the PreToolUse JSON on stdin ({ cwd, session_id, tool_name, tool_input: { command } }).
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
const role = () => readFileSync(marker, 'utf8').trim() || 'agent'
const command = String(input.tool_input?.command ?? '')

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  )
  process.exit(0)
}

let session = null
try {
  session = JSON.parse(readFileSync(path.join(cwd, '.agent-loop', 'session'), 'utf8'))
} catch {}
const sid = input.session_id
if (sid && Array.isArray(session?.superseded) && session.superseded.includes(sid) && session.owner?.id !== sid) {
  // Only a plain `node …/scripts/session.mjs …`: nothing chained onto it slips past.
  const runsSessionScript = input.tool_name === 'Bash' && /^\s*node\s+\S*scripts\/session\.mjs(\s+[^\n;&|`$()<>]*)?$/.test(command)
  if (!runsSessionScript) {
    const by = session.owner?.id ? `session ${session.owner.id}` : 'another session'
    deny(
      `agent-loop: ${by} took over this ${role()} clone (.agent-loop/session); this session (${sid}) is superseded and must not touch the clone. Stop now: TaskStop your waiter, ScheduleWakeup({ stop: true }), and say "stopped: ${by} took over this clone". Do not unclaim, release or post anything: the claims belong to the clone, and the new session carries them on.`
    )
  }
}

if (input.tool_name && input.tool_name !== 'Bash') process.exit(0)

function pushesToDefaultBranch(cmd) {
  // Every `git push` occurrence: look at its tokens up to the next shell operator.
  const re = /\bgit\s+push\b([^\n;&|]*)/g
  let m
  while ((m = re.exec(cmd))) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean)
    for (const t of tokens) {
      if (t.startsWith('-')) continue
      const dest = t.includes(':') ? t.split(':').pop() : t
      if (/^(\+?refs\/heads\/)?(main|master)$/.test(dest)) return true
    }
  }
  return false
}

const reasons = []
if (/\bgh\s+pr\s+merge\b/.test(command)) reasons.push('`gh pr merge`')
if (/\bgh\s+api\b[^\n;&|]*\/pulls\/\d+\/merge\b/.test(command)) reasons.push('the pulls/<n>/merge API route')
if (/\bgh\s+api\b[^\n;&|]*\bmergePullRequest\b/.test(command)) reasons.push('the mergePullRequest GraphQL mutation')
if (pushesToDefaultBranch(command)) reasons.push('`git push` to main/master')
if (reasons.length === 0) process.exit(0)

deny(
  `agent-loop: this is the ${role()} clone (.agent-loop/role). ${reasons.join(' and ')} is the operator's action; never run it here. Report MERGE_READY and keep polling.`
)
