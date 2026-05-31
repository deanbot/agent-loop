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
echo "Then use: /agent-loop:start-executor  /agent-loop:start-reviewer  /agent-loop:start-qa"
echo ""
echo "One-time permission prompt: on first run Claude Code will ask to approve the sentinel"
echo "check. Select 'Yes, and don't ask again for: [ -f \"\$SENTINEL\" ]' to allowlist all"
echo "three agents (executor, reviewer, QA) in one step."
