# agent-loop

A tool-agnostic agentic development loop. One operator. One GitHub account. Two AI agents — an executor that implements, and a reviewer that reviews — communicating through a GitHub PR comment protocol.

## What this is

Standard GitHub PR review requires multiple accounts (GitHub blocks self-approval). agent-loop works around this with a comment-prefix protocol: `[reviewer]` and `[executor]` prefixes let two AI agents coordinate on the same PR thread without formal review signals.

This is a **solo developer / single-account** workflow. Not a replacement for team code review.

## What this is not

- Not a team review tool — no formal `APPROVED` / `CHANGES_REQUESTED` review signals
- Not Claude-specific — the core protocol works with any agent that can run bash and read AGENTS.md
- Not GitHub-specific by design, though current scripts target the GitHub API

## How it works

Two scripts emit signals. Agents handle signals. Agents post prefixed comments. Loop.

```
pr-watch.mjs  →  REVIEW:<n>, MERGE_CONFLICT:<n>, REVIEW_COMMENTS:<n>, NONE
pr-poll.mjs   →  NEW_COMMENT, NEW_REVIEW_SUBMISSION, NEW_INLINE_COMMENT, MERGE_READY, MERGED, NONE
```

Full protocol: [`spec/SPEC.md`](spec/SPEC.md)

## Adoption

### Path A — Claude Code plugin (first-class)

```bash
claude plugin marketplace add deanbot/agent-loop && claude plugin install agent-loop@agent-loop
```

Add to your project's `AGENTS.md`:

```markdown
## Agent loop
repo: owner/repo
in-progress-label: in-progress
quality-gates: npm test && npm run lint
```

Use: `/agent-loop:start-executor`, `/agent-loop:start-reviewer`

### Path B — Generic (any tool)

Copy the template from [`adapters/generic/AGENTS.md`](adapters/generic/AGENTS.md) into your project's `AGENTS.md`. Copy `scripts/` into your repo. Any agent that reads AGENTS.md and can run bash follows the instructions. Loop management (scheduling between polls) is manual or via external cron.

## Structure

```
scripts/              Tool-agnostic Node.js — the signal sources
spec/                 Protocol definition — the contract between adapters
adapters/
  claude-code/        First-class: ScheduleWakeup, /loop, plugin format
  generic/            AGENTS.md template, no scheduling assumptions
  kiro/               Stub
  gemini/             Stub
```

## Multi-tool design

Adapters own everything tool-specific — full prompts, install mechanism, scheduling model. The core (scripts + spec) has no tool assumptions. Adding a new tool means adding an adapter; nothing in core changes.

See [`AGENTS.md`](AGENTS.md) for architecture principles and adapter contract.
