# agent-loop — Claude Code adapter

Status: **implemented** (spec v0.2). First-class adapter: plugin format, `ScheduleWakeup` loops,
a merge-guard hook, a setup skill.

## Layout

The **plugin root is the repository root** (`source: "./"` in the marketplace manifest), so the
core `scripts/` and `spec/` ship inside the installed plugin and skills reach them as
`${CLAUDE_PLUGIN_ROOT}/scripts/…`. Claude Code copies only the plugin directory into
`~/.claude/plugins/cache/agent-loop/agent-loop/<version>/`, so nothing may live above it.

```
.claude-plugin/plugin.json          manifest; points skills and hooks into adapters/claude-code
.claude-plugin/marketplace.json     marketplace entry (source "./")
adapters/claude-code/
  skills/setup/                     /agent-loop:setup <role>      per-clone setup
  skills/start-executor/            /agent-loop:start-executor    SKILL.md + reference/
  skills/start-reviewer/            /agent-loop:start-reviewer    SKILL.md + reference/
  skills/start-qa/                  /agent-loop:start-qa          SKILL.md + reference/
  hooks/hooks.json, guard.mjs       PreToolUse: deny `gh pr merge` in clones with .agent-loop/role
  setup-project.sh                  what the setup skill runs
  install.sh                        marketplace add + plugin install
```

Each skill is a short `SKILL.md` (what to read, the loop, the invariants) plus `reference/` files
the agent reads when the situation arises (implementing an issue, handling a signal, running a
review). `SKILL.md` content stays in context for the session and is re-attached after compaction;
the reference files are re-read when needed.

## Install

```bash
claude plugin marketplace add agent-loop deanbot/agent-loop
claude plugin install agent-loop@agent-loop
```

Update with `claude plugin update agent-loop@agent-loop` (the version tracks the commit SHA, no
bump needed), then restart running loop sessions.

## Per project

1. Add the `## Agent loop` block to the project's `AGENTS.md` (keys in `spec/SPEC.md`).
2. One clone per role, for example `proj` (yours), `proj-exec`, `proj-review`. Inside each, in
   Claude Code: `/agent-loop:setup operator|executor|reviewer|qa`. It creates the labels, ignores
   `.agent-loop/` and `.claude/settings.local.json`, writes the role marker, adds the role's Bash
   allow rules to `.claude/settings.local.json`, and enables `.githooks` if the project has one.
3. Start the loops, one per session, each in its clone:
   `/agent-loop:start-executor [issue-or-PR]`, `/agent-loop:start-reviewer`, and with
   `qa-gate: on` `/agent-loop:start-qa`.
4. Say `stop` in a loop's session to end it. Merge PRs yourself when the executor reports
   `MERGE_READY`.

## Loop model

Each cycle runs the signal script once, handles the signals, prints a status line and calls
`ScheduleWakeup({ delaySeconds, noop, prompt, reason })`; the wakeup re-enters the loop. Delays:
executor 60s; reviewer and QA 300s after posting, 120s otherwise. `stop: true` ends a loop.
`gh` 2.43 or newer is required (`gh api --slurp`). The
loop also works when started as `/loop /agent-loop:start-reviewer` (Esc cancels a pending wakeup).
Claude Code fires one fallback wakeup about 20 minutes after an iteration that forgot to
reschedule, then ends the loop. Loops are session-scoped: they do not survive closing the
terminal or `--resume`; re-run the skill.

## Permissions

Skills declare `allowed-tools` for `gh`, the plugin scripts and (reviewer) read-only `git`; that
grant covers the invoking turn. Unattended wakeups rely on the rules `setup-project.sh` writes to
`.claude/settings.local.json`. Skill text gives Bash as one plain command per call — `$(…)`, `;`
and pipes are not statically matchable and would prompt every cycle. `find` is not
prefix-approvable either, which is one reason the stop-sentinel mechanism was dropped in favour
of `ScheduleWakeup({ stop: true })`.

## Guard hook

`hooks/guard.mjs` runs on every `PreToolUse` for Bash. When the working directory holds
`.agent-loop/role` it denies, anywhere in the command text, `gh pr merge`, the REST and GraphQL
merge routes, and `git push` to `main`/`master`, with a reason the agent reads. The operator's
clone has no marker, so nothing changes there. It is a safety net behind the prompt rule, not a
security boundary: the same action through another program (a script, `sh -c`, the API from node)
is not caught. A comment body that quotes the literal phrase `gh pr merge` is refused too; reword.

## Known limitations

- Single account: no formal reviews; the comment-prefix protocol is the review channel.
- Prompt injection: issue and PR text reaches the model. Run on private repos with
  `trusted-authors` set (see the root README's Security section).
- Reviewer's "has this been answered" judgement is model-dependent; the thread is always re-read
  before posting, which narrows but does not close the race with a concurrent executor push.
