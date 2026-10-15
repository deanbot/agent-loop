#!/usr/bin/env bash
# Install the agent-loop plugin for Claude Code (user scope). Run once per machine.
# Per-project setup (labels, permissions, role marker) is `/agent-loop:setup <role>` inside
# each clone, or adapters/claude-code/setup-project.sh.
set -euo pipefail

echo "Installing agent-loop for Claude Code..."
claude plugin marketplace add agent-loop deanbot/agent-loop 2>/dev/null || claude plugin marketplace update agent-loop
claude plugin install agent-loop@agent-loop 2>/dev/null || claude plugin update agent-loop@agent-loop
echo
echo "Installed. In each project clone that hosts a role, run inside Claude Code:"
echo "  /agent-loop:setup executor     (the clone the executor works in)"
echo "  /agent-loop:setup reviewer     (the clone the reviewer works in)"
echo "  /agent-loop:setup operator     (your own clone; no role marker)"
echo
echo "Then add the '## Agent loop' block to the project's AGENTS.md if setup says it is missing."
