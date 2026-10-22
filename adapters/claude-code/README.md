# agent-loop — Claude Code adapter

Status: **implemented** (spec v0.2). First-class adapter: plugin format, event-driven loops
(background waiter + fallback `ScheduleWakeup`), a merge-guard hook, a setup skill.

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
  hooks/hooks.json, guard.mjs       PreToolUse: deny `gh pr merge` (and a non-pending commit status) in clones with .agent-loop/role,
                                    and every command from a session another one took over
  hooks/restart-line.mjs            PostToolUse(Failure): show the operator pull.mjs's RESTART line in an executor clone
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
2. One clone per role, for example `proj` (yours), `proj-exec`, `proj-review`, anywhere on disk
   (the folder name must be unique per repo and stable: claims and reviewer state use it, and
   renaming a clone that holds a claim orphans the claim). Inside each, in
   Claude Code: `/agent-loop:setup operator|executor|reviewer|qa`. It creates the labels, ignores
   `.agent-loop/` and `.claude/settings.local.json`, writes the role marker, adds the role's Bash
   allow rules to `.claude/settings.local.json`, and enables `.githooks` if the project has one.
   Then it installs [second-read](https://github.com/deanbot/second-read)'s git hooks when
   second-read is installed, and warns, without failing, about each of its guards that's missing.
3. Start the loops, one per session, each in its clone:
   `/agent-loop:start-executor [issue-or-PR]`, `/agent-loop:start-reviewer`, and with
   `qa-gate: on` `/agent-loop:start-qa`. Several executors can run separate tracks with
   `/agent-loop:start-executor --milestone "<title>"`: each picks only from its milestone, waits
   while nothing in it is startable, and moves to the next open milestone when it is empty. Two
   executors that pick the same issue at once settle it with a claim comment (spec: "Claim
   comments").
4. Say `stop` in a loop's session to end it. Merge PRs yourself when the executor reports
   `MERGE_READY`.

## Loop model

Each cycle runs the role's signal script once, handles the signals, prints a status line, then
starts a **waiter** — the same script with `--wait 30 --max 1500`, under Bash
`run_in_background` — and schedules a fallback `ScheduleWakeup({ delaySeconds: 1800, … })`. The
waiter polls GitHub every 30 seconds without recording anything and exits as soon as a one-shot
run would have news (spec: "Waiting for events"). Claude Code re-invokes the session when a
background command exits, and that wake runs an ordinary cycle, so a handoff waits about 30
seconds and an idle role takes one model turn per 25 minutes instead of one every minute or two.
The skill never reads the waiter's output (the notification carries only an output-file path,
outside the project), and a session that dies before handling a wake loses nothing: the state was
never written. A waiter that finds another alive exits with code 3, which the notification shows
("failed with exit code 3"); that wake only re-schedules the fallback. Any other failed waiter
(a usage error, a broken install) makes the next cycle end with a 300-second `ScheduleWakeup`
instead of a waiter, so a persistent failure cannot spin the session.

The fallback fires only if no waiter woke the session; a new `ScheduleWakeup` replaces the
pending one, so it never stacks. "stop" ends the waiter with `TaskStop` (which wakes nothing) and
the loop with `ScheduleWakeup({ stop: true })`. Verified in smoke sessions, bare and under
`/loop`: a background exit re-invokes an idle session within seconds, a second `ScheduleWakeup`
replaces the first, a background command outlives the 600-second foreground limit, and `TaskStop`
produces no notification.

`gh` 2.43 or newer is required (`gh api --slurp`). The
loop also works when started as `/loop /agent-loop:start-reviewer` (Esc cancels a pending wakeup).
Claude Code fires one fallback wakeup about 20 minutes after an iteration that forgot to
reschedule, then ends the loop. Loops are session-scoped: they do not survive closing the
terminal or `--resume`; re-run the skill.

**One session per clone.** Every start runs `scripts/session.mjs --start ${CLAUDE_SESSION_ID}`,
every wake `--beat`, and a stop `--release` (spec: "Two sessions in one clone"). The newest start
wins: a restart never has to wait for, or find, the old session. The old one is recorded in
`.agent-loop/session` as superseded, and the guard hook refuses its next Bash, Edit, Write or
NotebookEdit call with a reason that tells it to stop; its next wake also prints `SUPERSEDED`. It
stops without unclaiming or posting, since the claims belong to the clone. The hook's
`session_id` and the skill's `${CLAUDE_SESSION_ID}` were checked to be the same string, subagents
included. One leftover: the old session's background waiter may still hold the PR's waiter lock,
so the new session's waiters exit 3 until it ends (at most 25 minutes); after a takeover that
wake re-schedules in 300 seconds instead of 1800.

## Permissions

Skills declare `allowed-tools` for `gh`, the plugin scripts and (reviewer) read-only `git`; that
grant covers the invoking turn. Unattended wakeups rely on the rules `setup-project.sh` writes to
`.claude/settings.local.json`, which include the block's `gate` command (`Bash(<gate>)` and
`Bash(<gate> *)`) for the executor and the reviewer, so re-run setup after adding `gate`. Skill text gives Bash as one plain command per call — `$(…)`, `;`
and pipes are not statically matchable and would prompt every cycle. `find` is not
prefix-approvable either, which is one reason the stop-sentinel mechanism was dropped in favour
of `ScheduleWakeup({ stop: true })`.

## Guard hook

`hooks/guard.mjs` runs on every `PreToolUse` for Bash, Edit, Write and NotebookEdit. When the
working directory holds `.agent-loop/role` it denies, anywhere in the Bash command text, `gh pr
merge`, the REST and GraphQL merge routes, `git push` to `main`/`master`, and a commit status
posted with any state but `pending` (a status is CI to `pr-poll`, and every role posts as the local
runner's login, so an agent's `success` would fake a pass), with a reason the agent reads. It also denies every one of those tools to a session `.agent-loop/session` lists as
superseded (a plain `node …/scripts/session.mjs` call excepted), so an old loop session stops at
its next step instead of moving the checkout under the new one. The operator's
clone has no marker, so nothing changes there. It is a safety net behind the prompt rule, not a
security boundary: the same action through another program (a script, `sh -c`, the API from node)
is not caught. A comment body that quotes the literal phrase `gh pr merge` is refused too; reword.

## RESTART-line hook

`hooks/restart-line.mjs` runs after every Bash call (`PostToolUse`, and `PostToolUseFailure` for
a failed pull, which exits 2 and still prints the line). In a clone whose `.agent-loop/role` says
`executor`, after a `pull.mjs --start …` call, it returns the `RESTART: …` line from the output as
a `systemMessage`, so the operator sees it even when the terminal collapses the tool's output or
the session skips writing it. Anything else, it prints nothing. It only reads its input and never
blocks a call. The executor still writes the line in its own text; the hook is the copy that
doesn't depend on the model.

## Known limitations

- Single account: no formal reviews; the comment-prefix protocol is the review channel.
- Prompt injection: issue and PR text reaches the model. Run on private repos with
  `trusted-authors` set (see the root README's Security section).
- Reviewer's "has this been answered" judgement is model-dependent; the thread is always re-read
  before posting, which narrows but does not close the race with a concurrent executor push.
