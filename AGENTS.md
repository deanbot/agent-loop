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

- `scripts/pr-watch.mjs` — reviewer signal source. `--repo owner/repo [--skip n,n]`. One line, exits.
- `scripts/pr-poll.mjs` — executor signal source. `--repo owner/repo --pr <n> [--require-qa]`.
  Signals then content blocks, exits.
- `scripts/pr-qa.mjs` — QA signal source. `--repo owner/repo [--skip n,n]`. One line, exits.
- `scripts/lib/wait.mjs` — shared driver. Every script also takes `--wait [secs] [--max secs]`: a
  waiter that writes no state and exits (`PENDING`) once a one-shot run would have news (spec:
  "Waiting for events").
- `scripts/test/run.mjs` — contract tests for all three against a fake `gh`
  (`scripts/test/fake-gh.mjs`). Run `node scripts/test/run.mjs` before any script change lands.
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

1. Executor prompt implements all signals from `pr-poll.mjs` output, including `CI_FAILING`
2. Reviewer prompt implements all signals from `pr-watch.mjs` output, and verifies acceptance
   criteria itself when `qa-gate` is off
3. QA prompt implements all signals from `pr-qa.mjs` output and refuses to run unless `qa-gate: on`
4. All roles respect the prefix convention: `[executor]`, `[reviewer]`, `[qa]`, never bare
5. Loop invariant: every iteration ends with a wait before the next poll (mechanism is
   adapter-specific), and the operator can stop a loop
6. `MERGE_READY` threshold: `[reviewer] LGTM` + CI passing, plus `[qa] PASS` when `qa-gate: on`.
   Agents never merge; adapters enforce it structurally where the tool allows
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

**Race condition.** Reviewer fetches diff → executor pushes → reviewer posts stale comment.
Narrowed by the re-read-before-posting rule; no structural fix without real-time locking.

## State files

**Per-clone state** lives in `.agent-loop/` within the project directory (gitignored):
`role` (executor | reviewer | qa; written by setup; read by the merge-guard hook and the skills'
wrong-clone check) and, for adapters that need one, stop sentinels.

**Script state** persists to `~/.agent-loop/state/` with per-repo paths: `<slug>-pr-state.json`
(reviewer), `<slug>-pr-poll-state.json` (executor), `<slug>-pr-qa-state.json` (QA). Safe to delete.

## One clone per role

A project that runs agent-loop has one clone per role: the operator's own, `proj-exec`,
`proj-review`, optionally `proj-qa`. Each clone gets `/agent-loop:setup <role>`. This keeps
branches, installed dependencies, `.claude/settings.local.json`, the role marker and stop requests
isolated, and lets the reviewer run probes against the PR branch without disturbing the executor.

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
block). `claude plugin validate .` checks the manifests.

## Issue format convention

Issues in this repo use three sections: **Context**, **What "done" looks like** (verifiable
statements), **Notes / Open questions**. Read all three plus any project convention files before
implementing. Verify each "done" item before opening a PR and summarize the verification in the PR
description.

## Commit policy

Direct commits to `main` for docs, spec and adapter stubs. Script changes go through a PR —
scripts affect all adopters — and `node scripts/test/run.mjs` must pass. After a PR merges, run
`claude plugin update agent-loop@agent-loop` so the installed plugin follows `main`.

## Source of truth

This file is the canonical architecture record for agent-loop. Update it when design decisions
change. Do not let implementation drift from what's written here without updating this file first.
