# agent-loop

A tool-agnostic agentic development loop. One operator. One GitHub account. Two AI agents — an executor that implements, and a reviewer that reviews — communicating through a GitHub PR comment protocol.

## What this is

Standard GitHub PR review requires multiple accounts (GitHub blocks self-approval). agent-loop works around this with a comment-prefix protocol: `[reviewer]` and `[executor]` prefixes let two AI agents coordinate on the same PR thread without formal review signals.

This is a **solo developer / single-account** workflow. Not a replacement for team code review.

## Security

**Do not run this on a public repo without understanding the risks.**

The executor reads GitHub issue and PR content and feeds it verbatim to an LLM running with your credentials — GitHub token, API keys, everything in your shell environment. Any untrusted user who can get their text in front of the executor can attempt prompt injection: instruct the LLM to post env vars as a PR comment, write secrets to a file, or take other unintended actions.

### Author association check (default-on guardrail)

The executor checks `authorAssociation` before processing any issue. By default, only `OWNER`, `MEMBER`, and `COLLABORATOR` are processed. Issues from other authors are skipped automatically.

To allow broader contributor access, set `allow-author-associations` in your AGENTS.md:

```markdown
## Agent loop
repo: owner/repo
in-progress-label: in-progress
allow-author-associations: [OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR]
```

GitHub's association values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`.

**This check is not a complete defense.** A trusted author can quote attacker-controlled text (error messages, user-submitted bug repros) containing injection payloads. Prompt injection is an unsolved problem in LLM security. The only complete protection is running on private repos with trusted collaborators.

### Unprefixed PR comments

The executor treats any unprefixed PR comment as operator direction. On public repos, any GitHub user can comment on an open PR. Avoid leaving PRs open on public repos for extended periods during autonomous executor runs.

---

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
claude plugin marketplace add agent-loop deanbot/agent-loop
claude plugin install agent-loop@agent-loop
```

Add to your project's `AGENTS.md`:

```markdown
## Agent loop
repo: owner/repo
in-progress-label: in-progress
quality-gates: npm test && npm run lint
```

Use: `/agent-loop:start-executor`, `/agent-loop:start-reviewer`

> **Updating:** `claude plugin update agent-loop@agent-loop` — then restart any active executor/reviewer sessions to pick up the new skill definitions.

### Path B — Generic (any tool)

Copy the template from [`adapters/generic/AGENTS.md`](adapters/generic/AGENTS.md) into your project's `AGENTS.md`. Copy `scripts/` into your repo. Any agent that reads AGENTS.md and can run bash follows the instructions. Loop management (scheduling between polls) is manual or via external cron.

### Path C — Kiro

```bash
cp -r adapters/kiro/skills/. .kiro/skills/
```

Add the `## Agent loop` block to your project's AGENTS.md (same format as Path A). Loop scheduling is manual re-trigger or external cron — Kiro has no native scheduling primitive. See [`adapters/kiro/README.md`](adapters/kiro/README.md) for full install steps.

Use: `/start-executor`, `/start-reviewer` in Kiro chat.

## Structure

```
scripts/              Tool-agnostic Node.js — the signal sources
spec/                 Protocol definition — the contract between adapters
adapters/
  claude-code/        First-class: ScheduleWakeup, /loop, plugin format
  generic/            AGENTS.md template, no scheduling assumptions
  kiro/               SKILL.md format, manual/cron scheduling
  gemini/             Stub
```

## Multi-tool design

Adapters own everything tool-specific — full prompts, install mechanism, scheduling model. The core (scripts + spec) has no tool assumptions. Adding a new tool means adding an adapter; nothing in core changes.

See [`AGENTS.md`](AGENTS.md) for architecture principles and adapter contract.
