# agent-loop — Agent Instructions

## What this repo is

Infrastructure for a single-account agentic SDLC loop. Scripts emit signals. Adapters define how
agents handle those signals. The spec defines the protocol that makes adapters interoperable.

Work here is meta-infrastructure — changes affect every project that adopts agent-loop. Treat
breakage as high severity. This repo is not itself a consumer: it has no `## Agent loop` block,
and the loop skills refuse to run here. Never start a loop from this repo.

## Architecture

Three layers. Boundaries are strict.

### Core (tool-agnostic)

`scripts/` and `spec/` only. No tool names, no tool-specific API calls, no scheduling primitives
(ScheduleWakeup, sleep, cron). If it can't run in a shell with Node.js, it doesn't belong here.

- `scripts/pr-watch.mjs` — reviewer signal source. `--repo owner/repo [--skip n,n] [--reviewer
  <clone>] [--needs-operator-label <name>]`. One line, exits. With `--reviewer` (several
  reviewers) it honours review claims and keeps state per reviewer; `--check-claim <n>` prints who
  holds a PR. A PR labelled needs-operator that falls into conflict is reported as a standing
  `MERGE_CONFLICT:<n>`.
- `scripts/pr-poll.mjs` — executor signal source. `--repo owner/repo --pr <n> [--require-qa]
  [--require-gate]`. Signals then content blocks, exits. `--require-gate` (the block names a
  `gate`): on a PR with no CI, `MERGE_READY` needs the LGTM's `Gate on <sha>:` line on the head.
- `scripts/pr-qa.mjs` — QA signal source. `--repo owner/repo [--skip n,n]`. One line, exits.
- `scripts/pick-next.mjs` — the executor's issue pick. `--repo owner/repo [--milestone <title>]
  [--in-progress-label <l>] [--blocked-label <l>] [--skip n,n]`. Prints `ISSUE:<n>`,
  `WAIT:<blocker> PR:<n|none>`, `MOVE_ON <title>` or `NONE`, exits. No state and no `--wait`: it
  lists fresh every call, so an issue filed while the executor waited is seen.
- `scripts/session.mjs` — one loop session per clone. `--start <id>` (`NEW`, `MINE`, `TOOK_OVER
  <id> <secs>`), `--beat <id>` (`MINE`, `SUPERSEDED <id|none>`), `--release <id>`. The newest
  start wins; the old session is recorded as superseded in `.agent-loop/session` and stops (the
  Claude Code guard hook refuses its tool calls). Run in the clone's root.
- `scripts/local-ci.mjs` — a local CI runner, no agent's. `--repo owner/repo --gate "<command>"
  [--context local-ci] [--trusted-authors a,b] [--log-url <base>] [--wait [secs]]`, from the
  root of a clone of its own (it refuses one with a role marker). Runs the gate once per trusted,
  same-repository PR head, one at a time, and posts the result as a commit status, which
  `gh pr checks` and `pr-poll.mjs` read as CI. One runner per repo and context (pid lock).
- `scripts/lib/wait.mjs` — shared driver. Every signal script also takes `--wait [secs] [--max secs]`: a
  waiter that writes no state and exits (`PENDING`) once a one-shot run would have news (spec:
  "Waiting for events").
- `scripts/test/run.mjs` — contract tests for all of them against a fake `gh`
  (`scripts/test/fake-gh.mjs`), and for the Claude Code guard hook's session check. Run `node
  scripts/test/run.mjs` before any script change lands.
- `spec/SPEC.md` — the protocol contract: roles, config keys, signals, merge policy, collision
  avoidance, state. Version 0.2.

### Adapters (tool-specific, full ownership)

Each adapter in `adapters/<tool>/` owns: full prompt files (not wrappers around shared prompts),
install mechanism, scheduling model, stop mechanism, plugin/skill/extension format.

**Adapters do not share prompt files.** Two adapters implementing the same role write two
separate prompt files. This prevents annotation drift and lets adapters diverge as tools diverge.

**Claude Code plugin layout.** The plugin root is the repository root (`source: "./"` in
`.claude-plugin/marketplace.json`; `.claude-plugin/plugin.json` points `skills` and `hooks` into
`adapters/claude-code/`). Claude Code copies only the plugin directory into its cache, so this is
what lets the skills reach `${CLAUDE_PLUGIN_ROOT}/scripts/` and `${CLAUDE_PLUGIN_ROOT}/spec/`.
Never reference `~/.claude/plugins/marketplaces/…` from a skill: that path is the marketplace
clone, not the installed plugin.

### Adapter contract

An adapter is valid if:

1. Executor prompt implements all signals from `pr-poll.mjs` output, including `CI_FAILING` and
   `MERGE_CONFLICT`
2. Reviewer prompt implements all signals from `pr-watch.mjs` output, and verifies acceptance
   criteria itself when `qa-gate` is off
3. QA prompt implements all signals from `pr-qa.mjs` output and refuses to run unless `qa-gate: on`
4. All roles respect the prefix convention: `[executor]`, `[reviewer]`, `[qa]`, never bare
5. Loop invariant: every iteration ends with a wait before the next poll (mechanism is
   adapter-specific), and the operator can stop a loop
6. `MERGE_READY` threshold: `[reviewer] LGTM` + CI passing + no conflict with the base, plus
   `[qa] PASS` when `qa-gate: on`, plus, when the block has `gate` and the PR has no CI, the
   LGTM's `Gate on <sha>:` line on the head (the reviewer runs the gate before every LGTM then).
   Agents never merge, and never post a commit status but `pending` (a status is CI, and the
   local runner posts as the same login); adapters enforce both structurally where the tool allows
7. Executor prompt includes the pre-PR self-check: each criterion mapped to a test CI runs, or
   given the exact steps the operator runs by hand. A hand check never blocks an approval; the
   operator confirms by a comment or by merging
8. Prompts give shell commands as single plain commands (no `$(…)`, `;`, pipes) so permission
   allowlists can match them

## Known design constraints

**Single-account limitation.** GitHub blocks self-approval. Formal review submissions from a
reviewer agent are impossible when reviewer and executor share one account. The comment-prefix
protocol is the workaround. A second account unlocks formal signals — documented in the spec, not
implemented.

**Scheduling is adapter-specific.** Claude Code: every cycle runs the role's script once and ends by
starting a `--wait` waiter under Bash `run_in_background` (its exit re-invokes the session) plus a
fallback `ScheduleWakeup({ delaySeconds: 1800, … })`; "stop" is `TaskStop` on the waiter and
`ScheduleWakeup({ stop: true })`; the skill works whether started bare or under `/loop`. Generic/Kiro: external cron, `sleep`, or manual re-trigger,
with a sentinel file under `.agent-loop/` as the stop signal.

**Permissions are the recurring failure.** An unattended loop dies on a permission prompt. The
Claude Code adapter uses skill `allowed-tools` for the invoking turn and writes per-role allow
rules into the clone's `.claude/settings.local.json` (`setup-project.sh`). `find` and other exec
wrappers are never prefix-approvable, and compound commands never match — keep skill bash flat.

**Reviewer "has this been answered" judgment is LLM-dependent.** Mitigation: the reviewer always
reads the full thread alongside the diff, re-reads immediately before posting, and drops its
comment if the head moved.

**Two sessions in one clone.** A file cannot tell a live session from a dead one, so the newest
start wins (`scripts/session.mjs`): a restart is never refused, and the old session stops at its
next tool call (the Claude Code guard hook) or its next wake. It stops without unclaiming, since
claims belong to the clone.

**Race condition.** Reviewer fetches diff → executor pushes → reviewer posts stale comment.
Narrowed by the re-read-before-posting rule; no structural fix without real-time locking.

## State files

**Per-clone state** lives in `.agent-loop/` within the project directory (gitignored):
`role` (executor | reviewer | qa; written by setup; read by the merge-guard hook and the skills'
wrong-clone check), `session` (which loop session holds the clone and which ones it superseded;
written by `scripts/session.mjs`, read by the Claude Code guard hook) and, for adapters that need
one, stop sentinels.

**Script state** persists to `~/.agent-loop/state/` with per-repo paths: `<slug>-pr-state.json`
(reviewer), `<slug>-pr-poll-<pr>.json` (executor, one per PR, so two executors never share a file;
the older shared `<slug>-pr-poll-state.json` is read once per PR as a migration source; delete it
once every executor runs per-PR files, or deleting a PR's file restores that PR's old cursors),
`<slug>-pr-qa-state.json` (QA). Safe to delete. `local-ci.mjs` keeps no state (the commit
statuses are its record): only its pid lock, `<slug>-local-ci-<context>.lock`, and its run logs
under `~/.agent-loop/local-ci/<slug>/`.

## One clone per role

A project that runs agent-loop has one clone per role: the operator's own, `proj-exec`,
`proj-review`, optionally `proj-qa`. Each clone gets `/agent-loop:setup <role>`. This keeps
branches, installed dependencies, `.claude/settings.local.json`, the role marker and stop requests
isolated, and lets the reviewer run probes against the PR branch without disturbing the executor.

A clone may live anywhere: siblings of the operator's checkout, or a separate tree such as
`~/agents/<owner>/<clone>`. Nothing in the scripts depends on the location. The clone's folder
name does matter: it is `<clone>` in executor claims (`[executor] Claimed by <clone>`), reviewer
claims and per-reviewer state files. Keep it unique per repo and stable; renaming a clone while it
holds a claim orphans the claim (release or finish the work first).

## How to add an adapter

1. Create `adapters/<toolname>/`
2. Write full executor, reviewer and QA prompts — do not reference other adapters' prompts
3. Implement the adapter contract above
4. Add an install mechanism and a README noting what is missing vs. a full implementation
5. Update the root README adoption table

## Roadmap (design decisions, not filed issues)

- **Event-driven waits**: done with `--wait` and background Bash (#25). `Monitor` (30-minute
  maximum, re-armed) is the alternative carrier if background exits stop re-invoking sessions.
- **Conditional requests**: `If-None-Match` on the waiter's polls (a 304 is free against the rate
  limit). Not started; at 30s polls three roles stay well under 5,000 requests an hour.
- **Kiro adapter**: ported from the Claude Code prompts, manual scheduling; not exercised.
- **Gemini adapter**: stub until explored.
- **Multi-account upgrade path**: what changes with a second GitHub account (formal review
  signals, branch protection). Documented in spec, not implemented.

## Development workflow

Use git worktrees for parallel features: `git worktree add .worktrees/<feature> -b <branch>`;
worktrees live in `.worktrees/` (gitignored). No build step, no `node_modules`.

Test a plugin change without installing it: `claude --plugin-dir /path/to/agent-loop -p
"/agent-loop:start-reviewer"` in a scratch git repo (it should refuse without a `## Agent loop`
block). `claude plugin validate .` checks the manifests (by hand: CI doesn't install Claude Code).

**CI** (`.github/workflows/ci.yml`) runs `node scripts/test/run.mjs` on every pull request and
every push to `main`, on Node 22 and 24, with a read-only token and actions pinned to commit shas
(the contract tests check both). The check to require in a ruleset is `contract-tests`: it passes
when the tests pass on both versions, or when the change touches only Markdown files (the tests
are skipped then).

- **Switch it off:** `gh variable set AGENT_LOOP_CI --body off --repo deanbot/agent-loop`. No job
  runs, and the one check that reports is `contract-tests (off)`, so a required `contract-tests`
  keeps PRs waiting rather than passing them untested.
- **Switch it back on:** `gh variable delete AGENT_LOOP_CI --repo deanbot/agent-loop` (unset, or
  any value but `off`, means on). A PR opened while it was off gets the check at its next push (or
  close and reopen it).
- **While it's off**, `contract-tests` can come from `scripts/local-ci.mjs --gate "node
  scripts/test/run.mjs" --context contract-tests`: a commit status satisfies a required check of
  the same name unless the ruleset pins that check to the GitHub Actions app. It runs only trusted,
  same-repository PRs, so a fork's PR waits for CI or a maintainer's bypass. Never run it under
  that name while CI is on: the two would report the same check.

## Issue format convention

Issues in this repo use three sections: **Context**, **What "done" looks like** (verifiable
statements), **Notes / Open questions**. Read all three plus any project convention files before
implementing. Verify each "done" item before opening a PR and summarize the verification in the PR
description.

## Commit policy

Direct commits to `main` for docs, spec and adapter stubs. Script changes go through a PR —
scripts affect all adopters — and `node scripts/test/run.mjs` must pass; CI runs it on the PR
(the `contract-tests` check). After a PR merges, run
`claude plugin update agent-loop@agent-loop` so the installed plugin follows `main`.

Every PR body carries a **restart note**: which roles need a fresh session to pick the change up
(a running loop keeps the skill text it started with), and whether `/agent-loop:setup <role>` must
be re-run in existing clones. Setup must be re-run whenever `setup-project.sh` changes (allow
rules, labels, ignores), because its output lives in each clone and an update does not touch it.
Say "none" when nothing needs it; never leave the note out.

## Source of truth

This file is the canonical architecture record for agent-loop. Update it when design decisions
change. Do not let implementation drift from what's written here without updating this file first.
