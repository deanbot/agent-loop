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
> For autonomous operation, use external cron (see `adapters/kiro/README.md`).

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-reviewer. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)

$ARGUMENTS may be `--skip <n,n,...>` to ignore specific PR numbers.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Sentinel path: `~/.agent-loop/state/<slug>-reviewer-stop`.

**Stop-sentinel check — run before calling pr-watch.mjs or re-invoking:**

```bash
SENTINEL=~/.agent-loop/state/<slug>-reviewer-stop
if [ -f "$SENTINEL" ]; then
  AGE=$(( $(date +%s) - $(cat "$SENTINEL") ))
  if [ "$AGE" -lt 600 ]; then
    rm "$SENTINEL"
    # exit: notify user, do NOT re-invoke this skill
  else
    rm "$SENTINEL"   # stale sentinel from a prior session — discard and proceed
  fi
fi
```

If the sentinel was fresh (age < 600s): notify the user "Reviewer loop stopped (sentinel cleared)." and exit without running pr-watch.mjs or re-invoking. If using an external cron, also pause or cancel it.

If the sentinel was stale (age ≥ 600s): delete it and proceed normally. Handles the case where a stop was issued but the cron continued past the window and a fresh run started — leftover file should not block the new run.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the cycle:
1. `mkdir -p ~/.agent-loop/state && date +%s > ~/.agent-loop/state/<slug>-reviewer-stop`
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

Read context: operator comments and `[executor]` responses. Ignore `[reviewer]` own posts.

- CI still failing with unfinished "Human setup required" steps: re-surface steps, add any code findings
- Questions answered satisfactorily and CI passing → `gh pr comment <n> --body "[reviewer] LGTM"`
- Answers raise new issues → `gh pr comment <n> --body "[reviewer] <findings>"`
- Answers need clarification → `gh pr comment <n> --body "[reviewer] <clarification>"`

Wait ~300 seconds before next cycle.

## Multiple signals

Signals are space-separated on one line. Handle each in order. Use the longest wait of all signals handled when deciding the delay before the next cycle.
