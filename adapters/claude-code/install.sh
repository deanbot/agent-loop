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

# Add sentinel allowlist to project settings.local.json
SETTINGS=".claude/settings.local.json"
SENTINEL_PATTERNS='["Bash(SENTINEL=.agent-loop/*)", "Bash(mkdir -p .agent-loop*)"]'

if [ -f "$SETTINGS" ]; then
  python3 - <<EOF
import json, sys
with open("$SETTINGS") as f:
    d = json.load(f)
d.setdefault("permissions", {}).setdefault("allow", [])
new = json.loads('$SENTINEL_PATTERNS')
for p in new:
    if p not in d["permissions"]["allow"]:
        d["permissions"]["allow"].append(p)
with open("$SETTINGS", "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
print("Added sentinel allowlist to $SETTINGS")
EOF
else
  mkdir -p .claude
  python3 -c "
import json
d = {'permissions': {'allow': $SENTINEL_PATTERNS}}
with open('$SETTINGS', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
print('Created $SETTINGS with sentinel allowlist')
"
fi

echo ""
echo "Then use: /agent-loop:start-executor  /agent-loop:start-reviewer  /agent-loop:start-qa"
