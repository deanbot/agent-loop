---
name: setup
description: >
  Set up the current project clone for agent-loop: labels, .gitignore entries, the role marker,
  permission allow rules, project git hooks and second-read's guards. Run once per clone, naming
  the role the clone hosts (executor, reviewer, qa, or operator for your own clone).
argument-hint: "<executor|reviewer|qa|operator> [--repo owner/repo]"
disable-model-invocation: true
allowed-tools:
  - Bash(bash ${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/setup-project.sh *)
---

Run the setup script for this clone. The first argument is the role (`executor`, `reviewer`,
`qa` or `operator`; default `operator` when absent). Anything after it, such as
`--repo owner/repo`, is passed through unchanged:

```
bash ${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/setup-project.sh --role <role> --plugin-root ${CLAUDE_PLUGIN_ROOT} <remaining arguments>
```

Arguments given: `$ARGUMENTS`. The script determines the repo from the `## Agent loop` block in
`AGENTS.md`, then from the clone's `origin`; when it cannot, it exits and asks for `--repo`. Do
not guess a repo yourself: the script creates labels on it.

Then report what the script printed, in a few lines: the repo and role, what it created or found
in place, whether second-read's guards are in place (quote each `⚠ second-read` line and its next
command as printed; they're warnings, not failures), and whether `AGENTS.md` already has the
`## Agent loop` block. If the block is missing,
show the template the script printed and say the project owner adds it (this skill never edits
`AGENTS.md`). End with the next command for this clone's role.

What the script does, for reference: creates the `in-progress` and `is-blocked` labels if missing;
ignores `.agent-loop/` and `.claude/settings.local.json` (clone-local `.git/info/exclude` when `.gitignore` lacks them, so the working tree stays clean); writes `.agent-loop/role`
(or removes it for `operator`), which is what makes the plugin's guard hook refuse `gh pr merge` and
`git push` to main in agent clones; adds the role's Bash allow rules to `.claude/settings.local.json` so the loop
runs without permission prompts (agent roles only; the operator clone gets none); runs `git config core.hooksPath .githooks` when the project ships
hooks; then, since that switches second-read's git hooks off, runs `second-read hooks install` when
second-read is installed, and warns about each of its guards that's missing (the git hooks; the
`gh` shim or second-read's Claude Code adapter). Full adapter notes: `${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/README.md`.
