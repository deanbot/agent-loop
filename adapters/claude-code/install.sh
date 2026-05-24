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
echo "  spec-path: docs/specs/"
echo ""
echo "Then use: /agent-loop:start-executor  /agent-loop:start-reviewer"
