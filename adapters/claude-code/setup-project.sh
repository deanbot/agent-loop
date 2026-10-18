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
#     --plugin-root names the installed plugin so its scripts are allowed wherever they live;
#     the block's `gate` command for the executor and the reviewer)
#   - enables .githooks if the project ships one
#   - installs second-read's git hooks when second-read is installed, and warns about each of its
#     guards that's missing (the git hooks, the gh shim or Claude Code plugin); never fails on them
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
    -h|--help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0"; exit 0 ;;
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
GATE="$(agent_loop_value gate)"

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
ensure_label "$NEEDS_OP" fbca04 "Waits on the operator: a question, or a PR reviewed and green"

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
  node - "$ROLE" "$PLUGIN_CACHE" "$PLUGIN_ROOT" "$GATE" <<'NODE'
const fs = require('fs')
const [role, cache, pluginRoot, gate] = process.argv.slice(2)
const file = '.claude/settings.local.json'
const common = ['Bash(gh *)', `Bash(node ${cache}/*)`]
if (pluginRoot && !pluginRoot.startsWith(cache)) common.push(`Bash(node ${pluginRoot.replace(/\/$/, '')}/scripts/*)`)
const git = (...sub) => sub.map((s) => `Bash(git ${s} *)`)
const byRole = {
  executor: git('status', 'log', 'diff', 'show', 'fetch', 'pull', 'checkout', 'switch', 'branch', 'add', 'commit', 'push', 'merge', 'rebase', 'stash'),
  reviewer: git('status', 'log', 'diff', 'show', 'fetch', 'checkout', 'switch', 'branch'),
  qa: [],
}
// The block's `gate` (the command that stands in for CI): the executor runs it before a push and the
// reviewer on the head before an LGTM, so an unattended loop must not stop on its prompt.
const gateCmd = (gate ?? '').trim()
if (gateCmd && role !== 'qa') byRole[role].push(`Bash(${gateCmd})`, `Bash(${gateCmd} *)`)
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

# --- second-read ------------------------------------------------------------------------------
# second-read (github.com/deanbot/second-read) checks what agents post for details about the
# person running them. Setting core.hooksPath above switches its git hooks off, so they go back on
# here. Missing guards are a warning, never a failure: a project may not use second-read. Found by
# the markers second-read writes into its hooks and its gh shim, and for its Claude Code plugin by
# `claude plugin list --json`.
if command -v second-read >/dev/null; then
  second-read hooks install >/dev/null || true
fi
if grep -qF '# Added by second-read.' "$(git rev-parse --git-path hooks)/pre-push" 2>/dev/null; then
  echo "  second-read: git hooks in place"
elif command -v second-read >/dev/null; then
  echo "  ⚠ second-read: 'second-read hooks install' didn't install its git hooks (its message is above),"
  echo "    so commits and pushes from this clone go unchecked. Fix that, then run it again."
else
  echo "  ⚠ second-read: no git hooks, so commits and pushes from this clone go unchecked."
  echo "    Install second-read, then install its hooks:"
  echo "    npm install -g second-read"
  echo "    second-read hooks install"
fi
# Either the gh shim or the Claude Code plugin guards gh posts. The plugin's state is enabled,
# disabled, or empty when it isn't listed or the listing can't be read (no claude, an error).
gh_guard=""
gh_head="$(head -c 400 "$(command -v gh)" 2>/dev/null | tr -d '\0' || true)"
case "$gh_head" in
  *'# Added by second-read: the gh shim.'*) echo "  second-read: gh shim in place"; gh_guard=1 ;;
esac
sr_plugin=""
if command -v claude >/dev/null; then
  sr_plugin="$(claude plugin list --json </dev/null 2>/dev/null | node -e '
    let list; try { list = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch { process.exit(0) }
    const p = Array.isArray(list) && list.find(x => x && x.id === "second-read@second-read")
    if (p) console.log(p.enabled === true ? "enabled" : "disabled")
  ')" || sr_plugin=""
fi
if [ "$sr_plugin" = enabled ]; then
  echo "  second-read: Claude Code plugin in place"; gh_guard=1
fi
if [ -z "$gh_guard" ] && [ "$sr_plugin" = disabled ]; then
  echo "  ⚠ second-read: its Claude Code plugin is installed but disabled, so gh posts (PR bodies,"
  echo "    comments, issues) go unchecked. Turn it back on, then start a new session:"
  echo "    claude plugin enable second-read@second-read"
elif [ -z "$gh_guard" ]; then
  echo "  ⚠ second-read: gh posts (PR bodies, comments, issues) go unchecked. Install second-read's"
  echo "    Claude Code plugin, then start a new session:"
  echo "    claude plugin marketplace add deanbot/second-read"
  echo "    claude plugin install second-read@second-read"
  echo "    or put its gh shim ahead of gh on PATH: second-read shim install"
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
  gh pr list --repo $REPO --label $NEEDS_OP      (a question for you, or a PR ready to merge)
  gh issue list --repo $REPO --label $NEEDS_OP   (a question asked before a PR exists)
NEXT
