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
> ~60s after posting findings or a question, ~300s after LGTM, ~120s otherwise, then
> re-invoke this skill.
> For autonomous operation, see the agent-loop repo's `adapters/kiro/README.md`.

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-reviewer. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)
- `qa-gate` — `on` or `off` (default `off`). With `off` (the default) there is no QA agent: you verify the acceptance criteria yourself (below). With `on`, wait for `[qa] PASS` before reviewing code.
- `needs-operator-label` — label on a PR while it waits on the operator (default: `needs-operator`)
- `gate` — optional: the command that stands in for CI on a PR that has none (below, "Gate")
- `reviewers` — how many reviewer loops run (default: `1`); above 1, see "Several reviewers"

**First line you print, on every start** (including one that resumes work or stops at a check), before any other output: `Reviewer · <model> · <effort>`, as far as you know them, so a loop that came up on the wrong model is seen at once. If the `## Agent loop` block has `models:` (comma-separated `role=model[/effort]`, e.g. `models: executor=opus, reviewer=opus/high`) with a `reviewer` entry, and that entry differs from this session (its model word is not in your model's name, or it names an effort and yours differs), add `⚠ AGENTS.md expects <entry> for the reviewer; this session runs <model>.` and carry on: a mismatch never stops the loop. No `models:`, no `reviewer` entry, or an entry that matches → print nothing more.

Never merge, never push. You post `[reviewer]` comments, and add or remove `<needs-operator-label>` for your own questions; add it when your LGTM leaves the PR ready to merge and remove it when your findings revoke that (below); nothing else.

Immediately before every post, re-fetch the thread (`gh pr view <n> --comments --repo <repo>`) and the inline threads (`gh api repos/<repo>/pulls/<n>/comments`) and fold in anything new: `pr-watch.mjs` treats an `[executor]` comment older than your newest `[reviewer]` post as already read.

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

Run `node scripts/pr-watch.mjs --repo <repo> --needs-operator-label <needs-operator-label> $ARGUMENTS` from the repo root (plus `--reviewer <clone>` with several reviewers, below) and handle each signal below.

**Several reviewers** (only with `reviewers` above 1 in the block; one reviewer ignores this): pass `--reviewer <clone>` (the base name of your working directory) to every `pr-watch.mjs` run; it then reports only PRs you hold or nobody holds and keeps its state per reviewer. Before work that ends in a post on a PR (not while it still waits for `[qa] PASS`), claim it, one command each: (1) `node scripts/pr-watch.mjs --repo <repo> --reviewer <clone> --check-claim <n>` → `MINE` go on, `THEIRS <clone>` drop it; (2) `OPEN` → `gh pr comment <n> --repo <repo> --body "[reviewer] Reviewing (<clone>)"` and note the id after `#issuecomment-` in the printed URL; (3) check again: `MINE` go on, anything else → `gh api -X DELETE "repos/<repo>/issues/comments/<id>"` and drop it. The holder keeps the PR's rechecks and follow-ups; a holder silent for 30 minutes after a push loses it to the next claim (spec: "Claim comments").

**After handling any signal (including NONE), wait before the next cycle:**
- After posting findings, a clarification or a question: wait ~60 seconds (the
  executor's fix or the operator's reply usually arrives within minutes)
- After posting LGTM: wait ~300 seconds (the operator merges next; nothing is urgent)
- Otherwise (NONE, MERGE_CONFLICT, nothing posted): wait ~120 seconds

Then re-invoke this skill to start the next cycle.

## Signal handling

**`NONE`**
No activity. Wait ~120 seconds before next cycle.

**`CLOSED:<n>`**
The operator merged or closed the PR; nothing to post. Note it and forget the PR.

**`MERGE_CONFLICT:<n>`**
Do not review the diff. The PR carries `<needs-operator-label>` (it was ready and `main` moved under it; reported whoever owns the PR) → `gh pr edit <n> --repo <repo> --remove-label <needs-operator-label>` unless a question is still open, and, unless your newest `[reviewer]` comment already says so, post `gh pr comment <n> --repo <repo> --body "[reviewer] Merge conflicts — PR #<n> now conflicts with main, so it is not ready to merge; <label state>. Whoever owns it: bring main in, resolve, push."`, where `<label state>` is `<needs-operator-label> is off`, or `<needs-operator-label> stays on for the open question` when one kept it (the signal repeats while the label stays on, so post once). No label and a head new since your last `[reviewer]` post (new commits on a conflicting branch): `gh pr comment <n> --repo <repo> --body "[reviewer] Merge conflicts — rebase on main before review."`. No label and a head you already posted on (the executor took the label off meanwhile): post nothing.
Wait ~120 seconds before next cycle.

**`REVIEW:<n>`**
**Acceptance criteria first.** With `qa-gate: off`: read the linked issue (`Closes #M` in this PR's body; `gh issue view <M> --repo <repo> --comments`) and, for each acceptance criterion, find the test that asserts it and confirm CI runs that test (a test outside the CI gate's scope is a dead test, not evidence), or, for a criterion only a human can check, exact steps in the PR body. The executor's PR-body table is a pointer, not proof: open the cited tests. Missing evidence is your first finding; post `[reviewer] LGTM` when every criterion a test can prove has one. Criteria checked by hand never hold it back: list them in the LGTM under "Before you merge" with their steps, and the operator confirms by a comment or by merging. The exception is a PR that must record the operator's results, such as measurements: that criterion is missing until they are in the PR. Back code findings with evidence you produced (run the project's tests on a probe, try adversarial input); drop anything you cannot demonstrate. Do not relay CI status or echo operator comments — the executor receives both directly.

**Gate.** With `gate` in the block and no CI on the PR (no checks reported, or every check `skipping`), run the gate before an LGTM: `git fetch origin pull/<n>/head`, `git switch --detach FETCH_HEAD`, a clean `git status --porcelain`, then `<gate>`, then `git switch main`. A failure is a finding. A pass goes into the LGTM as its own line, `Gate on <short sha>: <the gate's last line>`, and replaces "CI green" in the threshold below: `MERGE_READY` (`pr-poll --require-gate`) needs that line on the head, and the label goes on right after the LGTM. A check from the project's local runner (`local-ci.mjs`; `local-ci` unless the project named another context), pending included, is CI: skip the gate, and name the check in the LGTM line (`CI green (local-ci)`) in place of a quote. The runner posts it shortly after a push, so read `gh pr checks` again just before you would run the gate.

**QA gate check** (only with `qa-gate: on`) — before fetching the diff, check whether `[qa] PASS` has been posted after the last commit:
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
- A decision you cannot review without (never a criterion the operator checks by hand) → a standalone question, nothing else in it: `gh pr comment <n> --repo <repo> --body "[reviewer] Question: <decision, one line>` + two or three lines of context + `Reply with: <the replies that resolve it>"`, then `gh pr edit <n> --repo <repo> --add-label <needs-operator-label>`. A question withholds `MERGE_READY` like a finding. When the operator replies (REVIEW_COMMENTS), remove the label and post your next verdict.
- No findings → `gh pr comment <n> --body "[reviewer] LGTM"`
- **Label a ready PR with your LGTM**, whoever owns it. The executor's poll adds `<needs-operator-label>` on `MERGE_READY`, but a stopped executor polls nothing, and a PR the operator or a monitor opened, or a parked one, has no executor. So with every LGTM, check the threshold yourself: your LGTM is on the head commit, CI green (every check `pass` or `skipping`, or none), `[qa] PASS` after the last commit when `qa-gate: on`, no unanswered inline thread. All hold → after the LGTM, `gh pr view <n> --repo <repo> --json headRefOid,mergeable`; still the sha you reviewed and `mergeable` not `CONFLICTING` (`UNKNOWN` is fine) → `gh pr edit <n> --repo <repo> --add-label <needs-operator-label>` (a no-op when it is on); the head moved → skip the label, the new head is unreviewed; `CONFLICTING` → skip it and post `[reviewer] Merge conflicts — PR #<n> conflicts with main, so it is not ready to merge. Whoever owns it: bring main in, resolve, push.` (a PR with no executor would otherwise sit unlabelled with nobody told). CI pending → end the LGTM with "CI is pending, so this PR does not have the `<needs-operator-label>` label yet: a running executor adds it when CI is green; with none, merge it once CI is green." Anything else missing → one line naming it. When you later post findings on a PR that carries the label, remove it unless a question is still open. The executor still removes the label when it pushes.

Wait ~60 seconds after findings or a question, ~300 seconds after LGTM.

**`REVIEW_COMMENTS:<n>`**
Fetch:
- `gh pr view <n> --comments --repo <repo>`
- `gh pr checks <n> --repo <repo> --json name,state,bucket`

Read context: operator comments and `[executor]` responses. Ignore `[reviewer]` own posts. Then:

- **If new comments include `[qa] PASS` and no `[reviewer]` post exists after the last commit:** QA gate just cleared — fetch `gh pr diff <n> --repo <repo>` and do a full code review (same as REVIEW above, [qa] PASS already confirmed). Wait as after REVIEW.
- **If new comments include only `[qa] BLOCKED` with no executor responses:** A.C. gate not cleared — post nothing; wait ~120s.
- **Otherwise** (executor/operator responses to existing findings):
  - CI still failing with unfinished "Human setup required" steps: re-surface steps, add any code findings
  - Questions answered satisfactorily and CI passing → `gh pr comment <n> --body "[reviewer] LGTM"` (with `gate` and no CI on the PR, run the gate first and put its `Gate on <short sha>:` line in this LGTM, as under "Gate"; an LGTM without it holds `MERGE_READY` back)
  - Answers raise new issues → `gh pr comment <n> --body "[reviewer] <findings>"`
  - Answers need clarification → `gh pr comment <n> --body "[reviewer] <clarification>"`
  - The operator answered your `[reviewer] Question` → `gh pr edit <n> --repo <repo> --remove-label <needs-operator-label>`, then post your next verdict (`LGTM` or findings).
  - Wait ~60 seconds after findings, a clarification or a question; ~300 seconds after LGTM.

## Multiple signals

Signals are space-separated on one line. Handle each in order. Use the shortest wait of all signals handled when deciding the delay before the next cycle.
