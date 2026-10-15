#!/usr/bin/env bash
# Set up the current project checkout for agent-loop (Claude Code adapter).
#
#   setup-project.sh [--role executor|reviewer|qa|operator] [--repo owner/repo] [--plugin-root <dir>]
#
# Idempotent. Run it once in every clone that hosts a role:
#   - creates the in-progress / blocked labels if missing
#   - ignores .agent-loop/ and .claude/settings.local.json (via .git/info/exclude when .gitignore lacks them)
#   - writes the role marker .agent-loop/role (removed for --role operator)
#   - adds the role's permission allow rules to .claude/settings.local.json (agent roles only;
#     --plugin-root names the installed plugin so its scripts are allowed wherever they live)
#   - enables .githooks if the project ships one
#   - checks AGENTS.md for the "## Agent loop" block and prints the template if missing
set -euo pipefail

ROLE=operator
REPO=""
PLUGIN_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --plugin-root) PLUGIN_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
case "$ROLE" in executor|reviewer|qa|operator) ;; *) echo "role must be executor, reviewer, qa or operator" >&2; exit 1 ;; esac

for tool in gh node git; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "run this inside a git checkout" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"

# --- config from AGENTS.md -------------------------------------------------------------------
agent_loop_value() {  # key → value from the "## Agent loop" block (first match), or empty
  [ -f AGENTS.md ] || return 0
  awk -v key="$1" '
    /^## Agent loop/ { inblock=1; next }
    inblock && /^## / { inblock=0 }
    inblock && $1 == key":" { sub(/^[^:]*:[ \t]*/, ""); print; exit }
  ' AGENTS.md
}
[ -n "$REPO" ] || REPO="$(agent_loop_value repo)"
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
[ -n "$REPO" ] || { echo "cannot determine repo: pass --repo owner/repo" >&2; exit 1; }
IN_PROGRESS="$(agent_loop_value in-progress-label)"; IN_PROGRESS="${IN_PROGRESS:-in-progress}"
BLOCKED="$(agent_loop_value blocked-label)"; BLOCKED="${BLOCKED:-is-blocked}"
NEEDS_OP="$(agent_loop_value needs-operator-label)"; NEEDS_OP="${NEEDS_OP:-needs-operator}"
MERGE_READY="$(agent_loop_value merge-ready-label)"; MERGE_READY="${MERGE_READY:-merge-ready}"

echo "agent-loop setup: repo=$REPO role=$ROLE"

# --- labels -----------------------------------------------------------------------------------
existing_labels="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
ensure_label() {  # name color description
  if printf '%s\n' "$existing_labels" | grep -qxF -- "$1"; then
    echo "  label exists: $1"
  else
    gh label create "$1" --repo "$REPO" --color "$2" --description "$3" >/dev/null
    echo "  label created: $1"
  fi
}
ensure_label "$IN_PROGRESS" 0075ca "Executor claimed"
ensure_label "$BLOCKED" b60205 "Blocked; the operator unblocks"
ensure_label "$NEEDS_OP" fbca04 "An agent has a question for the operator"
ensure_label "$MERGE_READY" 0e8a16 "Reviewed and green; the operator merges"

# --- ignores ----------------------------------------------------------------------------------
# Never dirty an agent clone's working tree: what .gitignore lacks goes into the clone-local
# .git/info/exclude, and the project owner is told what to commit.
EXCLUDE="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"; touch "$EXCLUDE"
suggest=()
for line in ".agent-loop/" ".claude/settings.local.json"; do
  if [ -f .gitignore ] && grep -qxF -- "$line" .gitignore; then
    echo "  .gitignore has: $line"
  elif grep -qxF -- "$line" "$EXCLUDE"; then
    echo "  .git/info/exclude has: $line (add it to .gitignore in the project)"
    suggest+=("$line")
  else
    printf '%s\n' "$line" >> "$EXCLUDE"
    echo "  .git/info/exclude added: $line (add it to .gitignore in the project)"
    suggest+=("$line")
  fi
done

# --- role marker ------------------------------------------------------------------------------
mkdir -p .agent-loop
if [ "$ROLE" = operator ]; then
  rm -f .agent-loop/role
  echo "  role marker: none (operator clone — gh pr merge allowed here)"
else
  printf '%s\n' "$ROLE" > .agent-loop/role
  echo "  role marker: .agent-loop/role = $ROLE (gh pr merge and git push to main are refused in this clone)"
fi

# --- permissions ------------------------------------------------------------------------------
# Agent roles only: the operator's clone keeps its normal prompts (and has no merge guard).
# Rules are literal text matches against the command Claude writes. The plugin scripts run as
# node <plugin root>/scripts/<name>.mjs; the installed root is the versioned cache directory, so
# the rule covers that with a wildcard, plus the exact root the setup skill saw (--plugin-root),
# which differs for a --plugin-dir development run.
if [ "$ROLE" = operator ]; then
  echo "  permissions: none written for the operator clone"
else
  PLUGIN_CACHE="$HOME/.claude/plugins/cache/agent-loop/agent-loop"
  mkdir -p .claude
  node - "$ROLE" "$PLUGIN_CACHE" "$PLUGIN_ROOT" <<'NODE'
const fs = require('fs')
const [role, cache, pluginRoot] = process.argv.slice(2)
const file = '.claude/settings.local.json'
const common = ['Bash(gh *)', `Bash(node ${cache}/*)`]
if (pluginRoot && !pluginRoot.startsWith(cache)) common.push(`Bash(node ${pluginRoot.replace(/\/$/, '')}/scripts/*)`)
const git = (...sub) => sub.map((s) => `Bash(git ${s} *)`)
const byRole = {
  executor: git('status', 'log', 'diff', 'show', 'fetch', 'pull', 'checkout', 'switch', 'branch', 'add', 'commit', 'push', 'rebase', 'stash'),
  reviewer: git('status', 'log', 'diff', 'show', 'fetch', 'checkout', 'switch', 'branch'),
  qa: [],
}
let settings = {}
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
settings.permissions ??= {}
settings.permissions.allow ??= []
const added = []
for (const rule of [...common, ...byRole[role]]) {
  if (!settings.permissions.allow.includes(rule)) { settings.permissions.allow.push(rule); added.push(rule) }
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
console.log(added.length ? `  permissions: added ${added.length} rule(s) to ${file}` : `  permissions: ${file} already up to date`)
NODE
fi

# --- project hooks ----------------------------------------------------------------------------
if [ -d .githooks ]; then
  git config core.hooksPath .githooks
  echo "  git hooks: core.hooksPath = .githooks"
fi

# --- AGENTS.md block --------------------------------------------------------------------------
if [ -f AGENTS.md ] && grep -q '^## Agent loop' AGENTS.md; then
  echo "  AGENTS.md: '## Agent loop' block present"
else
  cat <<TEMPLATE

  AGENTS.md has no '## Agent loop' block. Add one (keys are 'key: value' lines):

  ## Agent loop
  repo: $REPO
  in-progress-label: $IN_PROGRESS
  blocked-label: $BLOCKED
  quality-gates: <command that must pass before a PR>
  qa-gate: off
  trusted-authors: [<your GitHub login>]
TEMPLATE
fi

if [ ${#suggest[@]} -gt 0 ]; then
  echo
  echo "  Commit these lines to the project's .gitignore so every clone ignores them:"
  for line in "${suggest[@]}"; do echo "    $line"; done
fi

cat <<NEXT

Done. Next:
  executor clone:  /agent-loop:start-executor [issue-or-PR]
  reviewer clone:  /agent-loop:start-reviewer
  qa clone:        /agent-loop:start-qa            (only with qa-gate: on)
Say "stop" in a loop's session to end it. Your inbox:
  gh pr list --repo $REPO --label $NEEDS_OP      (questions waiting on you; also gh issue list)
  gh pr list --repo $REPO --label $MERGE_READY   (reviewed and green; you merge)
NEXT
