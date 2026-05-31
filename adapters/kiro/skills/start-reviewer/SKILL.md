---
name: start-reviewer
description: >
  Agentic reviewer loop. Monitors all open PRs in the repo, posts findings when new
  commits arrive, follows up on executor responses. Reads repo from the project's
  AGENTS.md "## Agent loop" section.
license: MIT
category: productivity
complexity: intermediate
---

> **Single-account mode.** One GitHub account runs executor and reviewer. All review signals
> arrive as PR comments. `[reviewer]` prefix on all posts from this agent.

> **Scheduling note:** Kiro has no native loop primitive. After each poll cycle, wait
> ~120s (NONE/MERGE_CONFLICT) or ~300s (after posting findings) then re-invoke this skill.
> For autonomous operation, see the agent-loop repo's `adapters/kiro/README.md`.

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-reviewer. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)

$ARGUMENTS may be `--skip <n,n,...>` to ignore specific PR numbers.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Sentinel path: `.agent-loop/<slug>-reviewer-stop` (project-local; gitignored).

**Stop-sentinel check — run before calling pr-watch.mjs or re-invoking:**

Run as two separate bash commands (never combined into one multi-line block):

1. `find .agent-loop -maxdepth 1 -name '<slug>-reviewer-stop' -mmin -10 -type f 2>/dev/null`
   — non-empty: FRESH sentinel (written within last 10 minutes)
2. `find .agent-loop -maxdepth 1 -name '<slug>-reviewer-stop' -type f 2>/dev/null`
   — non-empty: STALE sentinel (file older than 10 min); empty: NO sentinel

If FRESH: `rm .agent-loop/<slug>-reviewer-stop` — notify "Reviewer loop stopped (sentinel cleared)." — exit without running pr-watch.mjs or re-invoking. If using external cron, also pause or cancel it.

If STALE: `rm .agent-loop/<slug>-reviewer-stop` — proceed normally (leftover from a prior session).

If NO sentinel: proceed normally.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the cycle:
1. `mkdir -p .agent-loop && touch .agent-loop/<slug>-reviewer-stop`
2. Notify: "Stop sentinel written. Loop will exit on next invocation if it fires within 10 minutes. If using external cron, also pause it."
3. Exit without re-invoking this skill.

Run `node scripts/pr-watch.mjs --repo <repo> $ARGUMENTS` from the repo root and handle each signal below.

**After handling any signal (including NONE), wait before the next cycle:**
- After NONE or MERGE_CONFLICT: wait ~120 seconds
- After posting findings or LGTM: wait ~300 seconds (give executor time to respond)

Then re-invoke this skill to start the next cycle.

## Signal handling

**`NONE`**
No activity. Wait ~120 seconds before next cycle.

**`MERGE_CONFLICT:<n>`**
Post: `gh pr comment <n> --body "[reviewer] Merge conflicts — rebase on main before review."`
Wait ~120 seconds before next cycle.

**`REVIEW:<n>`**
**QA gate check first** — before fetching the diff, check whether `[qa] PASS` has been posted after the last commit:
- `gh api "repos/<repo>/pulls/<n>/commits" --jq '.[-1].commit.committer.date'` → last commit date
- `gh api "repos/<repo>/issues/<n>/comments"` → scan for `[qa] PASS` with `created_at` after that date
- If no `[qa] PASS` found: **post nothing** — wait ~120s. Reviewer will be re-triggered via REVIEW_COMMENTS when QA posts its verdict.
- If `[qa] PASS` found: proceed.

Fetch in parallel:
- `gh pr diff <n> --repo <repo>`
- `gh pr view <n> --comments --repo <repo>`
- `gh pr checks <n> --repo <repo> --json name,state,bucket`

Read the comment thread first. Filter out findings already answered by `[executor]` comments since the last `[reviewer]` post — only raise unanswered scope.

If any check has bucket `fail`: fetch PR description (`gh pr view <n> --repo <repo> --json body`). If body has a "Human setup required" section, prepend a CI failure note with those exact steps as an action block. Otherwise prepend a generic CI failure note.

Review the diff scoped to unanswered issues. Post:
- Actionable findings → `gh pr comment <n> --body "[reviewer] <findings>"`
- Questions only → `gh pr comment <n> --body "[reviewer] <questions>"`
- No findings → `gh pr comment <n> --body "[reviewer] LGTM"`

Wait ~300 seconds before next cycle.

**`REVIEW_COMMENTS:<n>`**
Fetch:
- `gh pr view <n> --comments --repo <repo>`
- `gh pr checks <n> --repo <repo> --json name,state,bucket`

Read context: operator comments and `[executor]` responses. Ignore `[reviewer]` own posts. Then:

- **If new comments include `[qa] PASS` and no `[reviewer]` post exists after the last commit:** QA gate just cleared — fetch `gh pr diff <n> --repo <repo>` and do a full code review (same as REVIEW above, [qa] PASS already confirmed). Wait ~300s.
- **If new comments include only `[qa] BLOCKED` with no executor responses:** A.C. gate not cleared — post nothing; wait ~120s.
- **Otherwise** (executor/operator responses to existing findings):
  - CI still failing with unfinished "Human setup required" steps: re-surface steps, add any code findings
  - Questions answered satisfactorily and CI passing → `gh pr comment <n> --body "[reviewer] LGTM"`
  - Answers raise new issues → `gh pr comment <n> --body "[reviewer] <findings>"`
  - Answers need clarification → `gh pr comment <n> --body "[reviewer] <clarification>"`
  - Wait ~300 seconds before next cycle.

## Multiple signals

Signals are space-separated on one line. Handle each in order. Use the longest wait of all signals handled when deciding the delay before the next cycle.
