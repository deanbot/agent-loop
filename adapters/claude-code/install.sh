#!/usr/bin/env bash
set -e

echo "Installing agent-loop for Claude Code..."
claude plugin marketplace add agent-loop deanbot/agent-loop
claude plugin install agent-loop@agent-loop
echo ""
echo "Done. Add to your project's AGENTS.md:"
echo ""
echo "  ## Agent loop"
echo "  repo: owner/repo"
echo "  in-progress-label: in-progress"
echo "  quality-gates: npm test && npm run lint"
echo ""
echo "Then add .agent-loop/ to your project's .gitignore:"
echo ""
echo "  echo '.agent-loop/' >> .gitignore"
echo ""

# Add agent-loop allowlist to project settings.local.json.
# Covers: gh CLI, polling scripts, sentinel check/write/cleanup.
SETTINGS=".claude/settings.local.json"
AGENT_LOOP_PATTERNS='[
  "Bash(gh *)",
  "Bash(node ~/.claude/plugins/marketplaces/agent-loop/scripts/*)",
  "Bash(find .agent-loop*)",
  "Bash(rm .agent-loop/*)",
  "Bash(mkdir -p .agent-loop*)"
]'

python3 - <<'PYEOF'
import json, os, sys

settings = ".claude/settings.local.json"
patterns = [
    "Bash(gh *)",
    "Bash(node ~/.claude/plugins/marketplaces/agent-loop/scripts/*)",
    "Bash(find .agent-loop*)",
    "Bash(rm .agent-loop/*)",
    "Bash(mkdir -p .agent-loop*)",
]

os.makedirs(".claude", exist_ok=True)

d = {}
if os.path.exists(settings):
    with open(settings) as f:
        d = json.load(f)

allow = d.setdefault("permissions", {}).setdefault("allow", [])
added = []
for p in patterns:
    if p not in allow:
        allow.append(p)
        added.append(p)

with open(settings, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")

if added:
    print(f"Added {len(added)} agent-loop permission(s) to {settings}")
else:
    print(f"{settings} already up to date")
PYEOF

echo ""
echo "Then use: /agent-loop:start-executor  /agent-loop:start-reviewer  /agent-loop:start-qa"
