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
After 3 cycles in a row with nothing new (the one-shot run prints `IDLE <count>`, from
`--idle-after 3`), the reviewer, QA and the executor's PR wait move to the idle wait, `--max 3300`
and a 3600-second fallback (the most `ScheduleWakeup` accepts), so an empty cycle comes about once
an hour; news still wakes the session within 30 seconds, and the first cycle with something new
goes back to the normal wait. The executor keeps its `--max 600` wait while its own question is
open.
The skill never reads the waiter's output (the notification carries only an output-file path,
outside the project), and a session that dies before handling a wake loses nothing: the state was
never written. A waiter that finds another alive exits with code 3, which the notification shows
("failed with exit code 3"); that wake only re-schedules the fallback, and only that one: the
next wake of any other kind (the surviving waiter's own exit included) runs a full cycle that
starts a waiter of its own, since a waiter that has notified its exit is gone. Any other failed waiter
(a usage error, a broken install) makes the next cycle end with a 300-second `ScheduleWakeup`
instead of a waiter, so a persistent failure cannot spin the session.

**Mailbox.** Started with `--inbox <folder> --outbox <folder>` (`/agent-loop:start-reviewer
--inbox … --outbox …`, and the same for start-qa and start-executor; spec: "Inbox folder"), a loop
checks the pair (`inbox.mjs --check`: both outside the clone, neither inside the other, neither a
file nor under one), warns once with `⚠ Inbox <folder>: does not exist yet; …` when the inbox isn't there yet
(a mistyped path would read as an empty inbox for good) and keeps the mailbox, and warns and runs
without one otherwise. Each cycle of the reviewer, QA and the executor's PR loop then runs
`inbox.mjs --dir <inbox>` before its signal script, reads each new message with `--show`, acts
on it within the role's rules and replies once into the outbox (`--send --reply-to`, which copies the addressing from the message,
so none of its values reaches the shell); the waiter takes
`--inbox <inbox>`, so a message ends the same wait within 30 seconds, and a cycle that handled
one is never idle. The executor reads messages only in its PR loop, not while it implements or
waits on a pick. The folders' mounts and any sandbox write access to the outbox are the
deployment's to set up; setup writes nothing for them. Without the arguments nothing changes. The folders never come
from the `## Agent loop` block or other checked-in config: a loop that restarts on a PR's head
would read that PR's copy.

Required setup: every command naming a mailbox folder (`--check`, `--dir`, `--show`,
`--send --reply-to … --inbox`, the waiter's `--inbox`) reaches outside the working directories,
and Claude Code asks before each one. Each loop clone's `.claude/settings.local.json` (never the
checked-in `.claude/settings.json`, which a PR can change) makes the outbox a working directory,
writable by design since it is the session's own outgoing folder, and the inbox readable but not
writable, with three lines naming the same absolute folder as `--inbox` (a home-relative start
argument written out in full):

```json
{
  "permissions": {
    "additionalDirectories": ["/srv/agent-mail/<clone>/outbox", "/srv/agent-mail/<clone>/inbox"],
    "deny": ["Edit(//srv/agent-mail/<clone>/inbox/**)"]
  },
  "sandbox": {
    "enabled": true,
    "excludedCommands": ["node <plugin root>/scripts/inbox.mjs *"],
    "filesystem": { "denyWrite": ["/srv/agent-mail/<clone>/inbox"] }
  }
}
```

(`enabled` and the `inbox.mjs` exemption are the sandbox's own setup, below, next to whatever else
the deployment exempts; settings files merge their arrays.)

A working directory clears the check, but on its own it would make the inbox writable, and an
inbox the session's environment can't write is what keeps PR code from writing direction to its
own reviewer. The sandbox's `denyWrite` takes that back for every process the session starts (the
gate, probes, PR code), enforced by the OS; the `Edit` deny takes it back for Claude's own file
tools. A `Read(…)` allow rule does not clear the check for a path passed to a script. Commands
that name no folder (the start recording the pair, later calls taking no path) were not chosen:
they pass only because the check can't see the path, and the start still prompts.

**The sandbox is required for a read-only inbox.** `denyWrite` acts only with the sandbox on
(`"sandbox": { "enabled": true, … }`; it is off by default). With it off, the inbox is protected
only from Claude's own file tools: any command, PR code included, can write a message into it. A
sandbox-on run on macOS (Claude Code 2.1) showed:

- `denyWrite` wins over the inbox's `additionalDirectories` entry. Writes into the inbox failed
  with `Operation not permitted`, never a prompt, from a Bash command, from `node` in-process, from
  a child shell, from a grandchild (a script that starts its own shell), from `git init` as a
  child and as a top-level command, and from `inbox.mjs --send` started as a child. The Write tool
  was refused by the `Edit` deny. A folder in neither list was refused too, and the outbox took
  writes from the process and its children.
- `inbox.mjs --send` into the outbox works sandboxed. `inbox.mjs --dir` does not: its record lives
  in the state folder outside the clone, and the write fails with `EPERM`. Exempt it by name, as
  the root README does for the other scripts: `"excludedCommands": ["node
  <plugin root>/scripts/inbox.mjs *", …]`. An exemption covers only the session's own top-level
  command; the same script started by a gate or PR code stays sandboxed (it failed with `EPERM`
  above). Not chosen: the state folder in `sandbox.filesystem.allowWrite`, which would let PR code
  rewrite the inbox's record of what was reported, hiding a message, or another script's state.
- An exempt command runs outside the sandbox and can write anywhere, the inbox included:
  `gh repo clone … <inbox>/x` did, under `"gh *"`. A command that a gate or PR code starts is
  its own child and stays sandboxed, even when it matches an exemption (the child `inbox.mjs`
  above). `git -C <inbox> …` does not match a `git fetch *` exemption, and failed.

**Not tested: git hooks and config in the clone.** An exempt git command runs what the clone's
`.git` tells it to: a hook in `.git/hooks` (`post-merge` on `git pull`, `pre-push` on `git push`)
or a program set in `.git/config` (`core.fsmonitor`, say). If PR code can write there, an exempt
`git pull`, `git push` or `pull.mjs` later runs what it planted outside the sandbox, and that can
write into the inbox. Whether a sandboxed process can write `<clone>/.git/hooks` and
`<clone>/.git/config` was not part of the run above, so treat the inbox as writable by PR code
until it has been shown otherwise (#101).

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
so the new session's waiters exit 3 until it ends (at most 25 minutes, 55 if it was idle); after a takeover that
wake re-schedules in 300 seconds instead of 1800.

## Permissions

Skills declare `allowed-tools` for `gh`, the plugin scripts and (reviewer) read-only `git`; that
grant covers the invoking turn. Unattended wakeups rely on the rules `setup-project.sh` writes to
`.claude/settings.local.json`, which include the block's `gate` command (`Bash(<gate>)` and
`Bash(<gate> *)`) for the executor and the reviewer, and its `pre-gate` command the same way for
the executor, so re-run setup after adding `gate` or `pre-gate`. Every
loop role also gets `Bash(git grep *)` and `Bash(git ls-files *)`: the skills search and list
files with those where a session has no Grep and Glob tools. Skill text gives Bash as one plain command per call — `$(…)`, `;`
and pipes are not statically matchable and would prompt every cycle. Claude Code's safety check
also prompts on a `--jq` filter ending in `]]` and on braces in a command, whatever the allow
rules, so the skills emit one array per row (`.[] | [ … ]`) and keep braces out of `git grep`
patterns; files are changed with Edit and Write, since a heredoc or `sed -i` matches no rule. `find` is not
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
- Mailbox: without the outbox and the three inbox lines in the clone's settings (see "Mailbox"
  above), every mailbox command prompts, and every cycle of a loop started with `--inbox` stalls
  until someone approves it. The inbox is read-only only with the sandbox on; with it off, any
  command, PR code included, can write into it. Sandboxed, `scripts/inbox.mjs` must be exempt by
  name, or its record write fails. Hooks or config that PR code plants in the clone's `.git` may
  run under an exempt git command, outside the sandbox: untested (#101). Seen on macOS only; the Linux sandbox is a different
  implementation and has not been run.
