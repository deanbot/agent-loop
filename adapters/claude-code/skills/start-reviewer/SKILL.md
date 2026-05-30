---
name: start-reviewer
description: >
  Agentic reviewer loop. Monitors all open PRs in the repo, posts findings when new
  commits arrive, follows up on executor responses. Reads repo from the project's
  AGENTS.md "## Agent loop" section. Runs indefinitely until stopped.
---

> **Single-account mode.** One GitHub account runs executor and reviewer. All review signals
> arrive as PR comments. `[reviewer]` prefix on all posts from this agent.

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-reviewer. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)

$ARGUMENTS may be `--skip <n,n,...>` to ignore specific PR numbers.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Sentinel path: `~/.agent-loop/state/<slug>-reviewer-stop`.

**Stop-sentinel check — run before calling pr-watch.mjs or ScheduleWakeup:**

```bash
SENTINEL=~/.agent-loop/state/<slug>-reviewer-stop
if [ -f "$SENTINEL" ]; then
  AGE=$(( $(date +%s) - $(cat "$SENTINEL") ))
  if [ "$AGE" -lt 600 ]; then
    rm "$SENTINEL"
    # exit: notify user, do NOT call ScheduleWakeup
  else
    rm "$SENTINEL"   # stale sentinel from a prior session — discard and proceed
  fi
fi
```

If the sentinel was fresh (age < 600s): notify the user "Reviewer loop stopped (sentinel cleared)." and exit without calling ScheduleWakeup or running pr-watch.mjs. Do not process any signals.

If the sentinel was stale (age ≥ 600s): delete it and proceed normally. This handles the case where the user wrote a stop, the queued wakeup drained, and then they restarted the loop fresh — the leftover file should not block the new run.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the loop:
1. `mkdir -p ~/.agent-loop/state && date +%s > ~/.agent-loop/state/<slug>-reviewer-stop`
2. Notify: "Stop sentinel written. Loop will exit on next wakeup if it fires within 10 minutes."
3. Exit without calling ScheduleWakeup.

/loop run `node ~/.claude/plugins/marketplaces/agent-loop/scripts/pr-watch.mjs --repo <repo> $ARGUMENTS` and handle each signal.

**After handling any signal (including NONE), call ScheduleWakeup before the next pr-watch.mjs call — 300s after posting findings or LGTM (give executor time to respond), 120s after MERGE_CONFLICT or NONE.**

- MERGE_CONFLICT:<n>: post `gh pr comment <n> --body "[reviewer] Merge conflicts — rebase on main before review."`; ScheduleWakeup(120s)

- REVIEW:<n>: fetch `gh pr diff <n> --repo <repo>` AND `gh pr view <n> --repo <repo> --json body,title` AND `gh pr view <n> --comments --repo <repo>` AND `gh api "repos/<repo>/pulls/<n>/comments"` in parallel, then check CI with `gh pr checks <n> --repo <repo> --json name,state,bucket`. Read the PR body first — it contains the deliverable checklist; verify the diff covers every item before reviewing code correctness:
  - read existing comment thread first (both timeline comments and inline review comments) — filter out findings already answered by `[executor]` comments since last `[reviewer]` post; only raise unanswered issues
  - if any check has bucket `fail`: fetch PR description (`gh pr view <n> --repo <repo> --json body`); if body has "Human setup required" section, prepend CI failure note with those steps as action block; otherwise prepend generic CI failure note
  - **immediately before posting:** re-fetch `gh pr view <n> --comments --repo <repo>` AND `gh api "repos/<repo>/issues/<n>/comments"` to check for comments that arrived during analysis; if new operator or `[executor]` activity found, incorporate before posting
  - review diff scoped to unanswered issues and post:
    - actionable findings → `gh pr comment <n> --body "[reviewer] <findings>"`
    - questions only → `gh pr comment <n> --body "[reviewer] <questions>"`
    - no findings → `gh pr comment <n> --body "[reviewer] LGTM"`
  - ScheduleWakeup(300s)

- REVIEW_COMMENTS:<n>: fetch `gh pr view <n> --comments --repo <repo>` AND `gh api "repos/<repo>/pulls/<n>/comments"` AND check CI with `gh pr checks <n> --repo <repo> --json name,state,bucket`, read context (both timeline and inline review comments from operator and `[executor]` — ignore `[reviewer]` own posts), then post follow-up:
  - CI still failing with unfinished "Human setup required" steps: re-surface steps, then add code findings
  - questions answered satisfactorily and CI passing → `gh pr comment <n> --body "[reviewer] LGTM"`
  - answers raise new issues → `gh pr comment <n> --body "[reviewer] <findings>"`
  - answers need clarification → `gh pr comment <n> --body "[reviewer] <clarification>"`
  - **immediately before posting:** re-fetch `gh api "repos/<repo>/issues/<n>/comments"` to check for activity during analysis; incorporate any new operator or `[executor]` comments before posting
  - ScheduleWakeup(300s)

- NONE: no actionable signals (does not mean no open PRs — means no new commits, no unreviewed PRs, and no new comments); ScheduleWakeup(120s)
