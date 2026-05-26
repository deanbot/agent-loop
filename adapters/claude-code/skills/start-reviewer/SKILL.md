---
name: start-reviewer
description: >
  Agentic reviewer loop. Monitors all open PRs in the repo, posts findings when new
  commits arrive, follows up on executor responses. Reads repo from the project's
  AGENTS.md "## Agent loop" section. Runs indefinitely until stopped.
---

> **Single-account mode.** One GitHub account runs executor and reviewer. All review signals
> arrive as PR comments. `[reviewer]` prefix on all posts from this agent.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)

$ARGUMENTS may be `--skip <n,n,...>` to ignore specific PR numbers.

/loop run `node ~/.claude/plugins/marketplaces/agent-loop/scripts/pr-watch.mjs --repo <repo> $ARGUMENTS` and handle each signal.

**After handling any signal (including NONE), call ScheduleWakeup before the next pr-watch.mjs call — 300s after posting findings or LGTM (give executor time to respond), 120s after MERGE_CONFLICT or NONE.**

- MERGE_CONFLICT:<n>: post `gh pr comment <n> --body "[reviewer] Merge conflicts — rebase on main before review."`; ScheduleWakeup(120s)

- REVIEW:<n>: fetch `gh pr diff <n> --repo <repo>` AND `gh pr view <n> --repo <repo> --json body,title` AND `gh pr view <n> --comments --repo <repo>` in parallel, then check CI with `gh pr checks <n> --repo <repo> --json name,state,bucket`. Read the PR body first — it contains the deliverable checklist; verify the diff covers every item before reviewing code correctness:
  - read existing comment thread first — filter out findings already answered by `[executor]` comments since last `[reviewer]` post; only raise unanswered issues
  - if any check has bucket `fail`: fetch PR description (`gh pr view <n> --repo <repo> --json body`); if body has "Human setup required" section, prepend CI failure note with those steps as action block; otherwise prepend generic CI failure note
  - review diff scoped to unanswered issues and post:
    - actionable findings → `gh pr comment <n> --body "[reviewer] <findings>"`
    - questions only → `gh pr comment <n> --body "[reviewer] <questions>"`
    - no findings → `gh pr comment <n> --body "[reviewer] LGTM"`
  - ScheduleWakeup(300s)

- REVIEW_COMMENTS:<n>: fetch `gh pr view <n> --comments --repo <repo>` AND check CI with `gh pr checks <n> --repo <repo> --json name,state,bucket`, read context (operator and `[executor]` responses — ignore `[reviewer]` own posts), then post follow-up:
  - CI still failing with unfinished "Human setup required" steps: re-surface steps, then add code findings
  - questions answered satisfactorily and CI passing → `gh pr comment <n> --body "[reviewer] LGTM"`
  - answers raise new issues → `gh pr comment <n> --body "[reviewer] <findings>"`
  - answers need clarification → `gh pr comment <n> --body "[reviewer] <clarification>"`
  - ScheduleWakeup(300s)

- NONE: ScheduleWakeup(120s)
