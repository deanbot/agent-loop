# agent-loop — Agent Instructions

## What this repo is

Infrastructure for a single-account agentic SDLC loop. Scripts emit signals. Adapters define how agents handle those signals. The spec defines the protocol that makes adapters interoperable.

Work here is meta-infrastructure — changes affect every project that adopts agent-loop. Treat breakage as high severity.

## Architecture

Three layers. Boundaries are strict.

### Core (tool-agnostic)

`scripts/` and `spec/` only. No tool names, no tool-specific API calls, no scheduling primitives (ScheduleWakeup, sleep, cron). If it can't run in a shell with Node.js, it doesn't belong here.

- `scripts/pr-watch.mjs` — reviewer signal source. Requires `--repo owner/repo`. Emits one line then exits.
- `scripts/pr-poll.mjs` — executor signal source. Requires `--repo owner/repo` and `--pr <number>`. Emits signals then exits.
- `spec/SPEC.md` — the protocol contract. Signal types, prefix convention, state machine, merge policy, collision avoidance rules.

### Adapters (tool-specific, full ownership)

Each adapter in `adapters/<tool>/` owns:
- Full prompt files (not wrappers around shared prompts)
- Install mechanism
- Scheduling model
- Plugin/skill/extension format

**Adapters do not share prompt files.** Two adapters implementing the same executor behavior write two separate prompt files. This prevents annotation drift ("\\[Claude only\\]") and lets adapters diverge freely as tools diverge.

### Adapter contract

An adapter is valid if:
1. Executor prompt implements all signals from `pr-poll.mjs` output
2. Reviewer prompt implements all signals from `pr-watch.mjs` output
3. QA prompt implements all signals from `pr-qa.mjs` output
4. All three respect the prefix convention: post `[executor]`, `[reviewer]`, or `[qa]` comments, never bare agent comments
5. Loop invariant: every iteration ends with a wait before the next poll (scheduling mechanism is adapter-specific)
6. MERGE_READY threshold: `[reviewer] LGTM` + `[qa] PASS` + CI passing (no formal APPROVED required — single-account mode)
7. Executor prompt includes pre-PR self-check: verify each A.C. criterion against the diff, note observation-verifiable items explicitly

## Known design constraints

**Single-account limitation.** GitHub blocks self-approval. Formal `APPROVED` / `CHANGES_REQUESTED` review submissions from a reviewer agent are impossible when reviewer and executor share one account. The comment-prefix protocol is the workaround. A second GitHub account unlocks formal review signals — this is documented in spec but not yet implemented in any adapter.

**ScheduleWakeup is Claude-specific.** The loop invariant (wait between polls) is implemented differently per adapter:
- Claude Code: `ScheduleWakeup(60s)` tool call
- Generic: external cron, `sleep`, or operator manual re-trigger

**Reviewer "has this been answered" judgment is LLM-dependent.** The reviewer must parse comment thread history to avoid re-raising findings the executor already addressed. This is inherently soft — no script can make it reliable. Mitigation: the reviewer always reads the full thread alongside the diff, not just the diff.

**Race condition.** Reviewer fetches diff → executor pushes fix → reviewer posts stale comment. Partially mitigated by "read thread before posting" instruction. No structural fix without real-time locking.

## State files

**Stop sentinels** live in `.agent-loop/` within the project directory (gitignored). Sentinels are project-local — a stop written in one clone does not affect loops running in other clones of the same repo.

**Script state files** persist to `~/.agent-loop/state/` with per-repo paths to prevent collisions when running agent-loop on multiple repos simultaneously. Three state files per repo: `<slug>-pr-state.json` (reviewer), `<slug>-pr-poll-state.json` (executor), `<slug>-pr-qa-state.json` (QA).

## How to add an adapter

1. Create `adapters/<toolname>/`
2. Write full executor, reviewer, and QA prompts — do not reference other adapters' prompts
3. Implement the adapter contract (all signals, prefix convention, loop invariant, merge threshold)
4. Add an `install.sh` or equivalent
5. Add a stub `README.md` noting which features are missing vs. a full implementation
6. Update root `README.md` adoption table

## Roadmap (design decisions, not filed issues)

- **Scripts parameterization**: `--repo` flag replaces hardcoded repo names. State file paths per-repo. Done in initial scripts; adopting projects should use these parameterized versions.
- **Adopting project migration**: delete embedded commands from the project, install claude-code adapter, add `## Agent loop` config block to project AGENTS.md.
- **Consolidate start-issue + start-executor**: single entry point with three modes — no args (pick next issue), issue number, PR number.
- **Kiro adapter**: unknown scheduling model; stub until explored.
- **Gemini adapter**: Gemini CLI extension format; stub until explored.
- **Multi-account upgrade path**: document what changes when a second GitHub account is available (formal review signals, branch protection rules).

## Development workflow

Use git worktrees to work on multiple features simultaneously without managing separate clones.

```bash
# start a new feature
git worktree add .worktrees/<feature> -b <branch-name>

# list active worktrees
git worktree list

# clean up when done
git worktree remove .worktrees/<feature>
```

Worktrees live in `.worktrees/` (gitignored) — contained inside the repo, not cluttering the parent directory. Each worktree is an independent checkout sharing one `.git` — branches and history stay in sync automatically. No stashing, no context-switching friction. This repo has no build artifacts or `node_modules`, so worktrees require no extra setup steps.

Cannot check out the same branch in two worktrees simultaneously — git enforces this.

## Issue format convention

Issues in this repo use three standard sections:

- **Context** — why the issue exists; what's broken or missing
- **What "done" looks like** — verifiable statements an agent or human can check against the PR; prose, bullets, or checklist, any format
- **Notes / Open questions** — non-blocking context, design debates, unknowns

When implementing an issue, read all three sections plus the PR description and any project convention files before starting. Before opening a PR, verify each item in "What done looks like" is satisfied and summarize the verification in the PR description.

If no "What done looks like" section exists, flag it in a PR comment rather than assuming done.

## Commit policy

Direct commits to `main` for docs, spec, and adapter stubs. Script changes go through a PR — scripts affect all adopters.

## Source of truth

This file is the canonical architecture record for agent-loop. Update it when design decisions change. Do not let implementation drift from what's written here without updating this file first.
