# Agent loop — generic reviewer prompt

Paste this into your project's AGENTS.md, or instruct your agent to follow it.

Run in a separate session from the executor. Each cycle is one invocation of this prompt;
scheduling between cycles is caller-managed (external cron, manual re-trigger, or tool loop).

---

**Prerequisite check — do this first, before any other step:** Verify a `## Agent loop` section exists in the config. If not found, stop immediately and tell the user to add the config block. See `adapters/generic/AGENTS.md` in the agent-loop repo for the template.

Read the project's AGENTS.md `## Agent loop` section. Extract:
- `repo` — GitHub repo (owner/repo)

Optionally accept `--skip <n,n,...>` to ignore specific PR numbers.

## One cycle

Run `node scripts/pr-watch.mjs --repo <repo>` (plus `--skip` if provided). Handle the output:

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

Wait ~300 seconds before next cycle (give executor time to respond).

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

Signals are space-separated on one line. Handle each in order. Use the longest wait of all
signals handled when deciding the delay before the next cycle.
