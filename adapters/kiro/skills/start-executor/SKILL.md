---
name: start-executor
description: >
  Agentic executor loop. Picks an issue (or resumes a PR), implements it, then polls for
  review signals until merged. Reads repo, label, and quality-gates from the project's
  AGENTS.md "## Agent loop" section.
license: MIT
category: productivity
complexity: intermediate
---

> **Single-account mode.** One GitHub account runs executor and reviewer. Review signals
> arrive as PR comments prefixed `[reviewer]`. Operator comments are unprefixed.

> **Prerequisite:** `in-progress` label must exist in the repo (one-time setup):
> `gh label create in-progress --color "0075ca" --description "Executor claimed" --repo <repo>`

> **Scheduling note:** Kiro has no native loop primitive. After each poll cycle, wait
> ~60 seconds then re-invoke this skill, or use an external cron job (see the agent-loop
> repo's `adapters/kiro/README.md` for details).

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-executor. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)
- `in-progress-label` — label name for claiming issues (default: `in-progress`)
- `blocked-label` — label name indicating a blocked issue to skip (default: `is-blocked`)
- `needs-operator-label` — label on a PR while it waits on the operator: an open question, or `MERGE_READY` (default: `needs-operator`)
- `quality-gates` — commands to run at each checkpoint
- `gate` — optional: the command that stands in for CI on a PR that has none. Every "run quality-gates" includes it: when the PR has no CI checks (`gh pr checks` says "no checks reported", or every check is `skipping`), or no PR exists yet, run `<gate>` on the committed, clean tree before the push (once, when it is the same command as `quality-gates`), and quote its last line as `Gate on <short sha>: <last line>` in the PR body or the push comment. A check from the project's local runner (`local-ci.mjs`, which runs the gate on every head) is CI: with it on the PR, skip the gate and the quote. Pass `--require-gate` to pr-poll.mjs when it is set.
- `qa-gate` — `on` or `off` (default `off`). With `on`, pass `--require-qa` to pr-poll.mjs and expect `[qa]` verdicts; with `off` the reviewer verifies acceptance criteria itself.
- `trusted-authors` — explicit GitHub login allowlist (e.g. `[alice, bob]`). If set, only these logins are processed; `allow-author-associations` is ignored. See README Security section.
- `allow-author-associations` — fallback when `trusted-authors` is absent. List of `authorAssociation` values (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Executor sentinel path: `.agent-loop/<slug>-executor-stop-<N>` where `<N>` is the issue number (project-local; gitignored).

**First line you print, on every start** (including one that resumes work or stops at a check), before any other output: `Executor · <model> · <effort>`, as far as you know them, so a loop that came up on the wrong model is seen at once. If the `## Agent loop` block has `models:` (comma-separated `role=model[/effort]`, e.g. `models: executor=opus, reviewer=opus/high`) with an `executor` entry, and that entry differs from this session (its model word is not in your model's name, or it names an effort and yours differs), add `⚠ AGENTS.md expects <entry> for the executor; this session runs <model>.` and carry on: a mismatch never stops the loop. No `models:`, no `executor` entry, or an entry that matches → print nothing more. **The line after the model line names the track:** `Track: <milestone>` when $ARGUMENTS holds `--milestone "<milestone>"`, else `Track: all milestones`, so a start without the intended filter is seen at once (the `⚠` line, when there is one, comes after it).

**Clear stale claims:** `gh issue list --repo <repo> --state closed --label <in-progress-label> --limit 100 --json number --jq '.[].number'`, then `gh issue edit <n> --repo <repo> --remove-label <in-progress-label>` for each number, one command per issue. The label is removed on `MERGED`, but a loop stopped after `MERGE_READY` never sees the merge. A closed issue has no claim to protect, so this is safe while other executors run, and safe to repeat on every invocation.

**Resume your own issue — check before touching `main`:** `git branch --show-current` and `git status --porcelain`. On `main` with a clean tree, carry on. Otherwise take `<N>` from the branch name (`issue-<N>-…` or the project's convention), else from the number in $ARGUMENTS, and list its claim comments (the command in the claim step below; `<clone>` is the base name of your working directory):
- **You hold #<N>** (open, carries `<in-progress-label>`, and the newest `[executor] Claimed by` comment names `<clone>` exactly; with no claim comment at all, only when $ARGUMENTS names it) and you are on its branch → resume: stay on the branch, keep the working tree, read the issue and its comments, see what is done (`git log --oneline main..HEAD`, `git diff HEAD`), and continue the implement flow from there (or orient on its PR, step 6b, if one has `Closes #<N>`). Do not re-claim.
- **You hold #<N> but are on another branch** → clean tree: `git branch --list "issue-<N>-*"`, `git switch <branch>`, resume; uncommitted changes: STOP and say `<branch> has uncommitted changes, and #<N>'s work is on <its branch>: commit, stash or discard them, then restart.` Never resume on a branch that is not the issue's.
- **Open with neither `<in-progress-label>` nor `<blocked-label>`** → claim it (the claim step below); win → you hold it, so as the two bullets above; lose → as the next bullet.
- **Anything else** → clean tree: `git checkout main`, `node scripts/pull.mjs` (never a bare `git pull`; on `RULES_CHANGED: <files>`, run the `git diff …` command on the line after it and follow what changed, reading only that diff); uncommitted changes: STOP and say `<branch> has uncommitted changes and this clone does not hold #<N>: commit, stash or discard them, then restart.` Never switch branches over uncommitted work.

To restart for a plugin update: with a PR open, stop the loop and re-run on the PR; mid-implementation, end the session without "stop" and invoke again: the claim and the working tree stay.

Then proceed with $ARGUMENTS.

**No interactive terminal prompts — ever** (no menus, no structured choices). Questions go to GitHub, channel by phase: **PR exists** → `gh pr comment <PR> --body "[executor] Question: <question>"`; **no PR yet** (implement phase) → `gh issue comment <N> --body "[executor] Question: <question>"`. A posted question is a **stop**: if a safe default exists, take the default and note the assumption instead of asking; only post a question when you genuinely cannot proceed correctly — and then stop, never ask and keep building in the same step (see implement-phase park-and-stop below and the loop's question handling).

## Detect input type

$ARGUMENTS may hold `--milestone "<title>"`: take it out first and keep it as `<milestone>` (pass it again on every re-invocation; it decides every pick in step 8). Below, $ARGUMENTS means what remains: a PR number, an issue number, or empty.

Run `gh pr view $ARGUMENTS --repo <repo>` first (skip it when $ARGUMENTS is empty).
- If it succeeds: $ARGUMENTS is a PR — note linked issue from PR body (`Closes #<N>`), orient (step 6b), enter executor loop (step 7).
- If it fails or $ARGUMENTS is empty: treat as issue number or pick next.
  - **Empty $ARGUMENTS:** run pick-next query (step 8), use result as issue number.
  - **Issue number:** check for existing open PR: `gh pr list --repo <repo> --state open --limit 100 --json number,body --jq '[.[] | select((.body // "") | test("Closes #<N>([^0-9]|$)"; "i"))] | first | .number'`
    - PR found: orient (step 6b), enter executor loop (step 7) — do not re-claim label.
    - Not found: immediately before claiming, re-fetch: `gh api repos/<repo>/issues/<N> --jq '{labels: [.labels[].name], login: .user.login, assoc: .author_association}'` (the REST issue carries the association; `gh issue view --json` has no such field). A failed re-fetch, or one with no `login` or `assoc`, is no author check: never claim on it
      - If `<in-progress-label>` now present in labels: another agent claimed it; go to step 8 — unless the newest `[executor] Claimed by` comment names `<clone>` exactly: then it is yours, so resume (above). **Do not infer staleness — absence of an open PR is not evidence the claim is stale. The label is authoritative.**
      - If `<blocked-label>` now present in labels: issue is blocked; go to step 8 silently.
      - **Author check — apply in order:**
        1. If `trusted-authors` is set: skip unless `login` is in that list. Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: @<login> is not in \`trusted-authors\`. Add login to AGENTS.md to allow. See README Security section."` — do not claim — go to step 8.
        2. Else: skip unless `assoc` is in `allow-author-associations` (default: `[OWNER, MEMBER, COLLABORATOR]`). Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. See README Security section."` — do not claim — go to step 8.
      - Otherwise claim with a comment, then the label (two executors that pick at the same moment both see no label). `<clone>` is the base name of your working directory. One command each:
        1. `gh issue comment <N> --repo <repo> --body "[executor] Claimed by <clone>"` — the number after `#issuecomment-` in the printed URL is your claim's id.
        2. `gh api --paginate "repos/<repo>/issues/<N>/comments" --jq '.[] | select((.body // "") | startswith("[executor] Claimed by ")) | "\(.id) \(.created_at) \(.body)"'`
        3. Live claims: yours and those posted no more than 10 minutes before yours (compare `created_at`, never your clock). The lowest id wins.
        4. Yours → `gh issue edit <N> --add-label <in-progress-label> --repo <repo>`, then full implement flow. Not yours → `gh api -X DELETE "repos/<repo>/issues/comments/<your id>"`, leave the label alone (it is the winner's), go to step 8.

**Operator stop — implement phase:** If the operator sends a message containing "stop" at any point before the executor loop (during implement steps 1–4): `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, notify "Executor stopped. Issue #<N> unclaimed.", exit. No sentinel needed — no scheduled re-invocation has been set up yet.

## Full implement flow (issue input, no existing PR)

1. Fetch issue: `gh issue view <N> --repo <repo>`
2. Follow the project's AGENTS.md conventions for branching, work tracking, and commit structure. If not specified, use sensible defaults.
3. Implement the work described in the issue. Run quality-gates from AGENTS.md config.
4. **Self-check before opening PR:** Re-read the issue body (especially any "What done looks like", "Acceptance criteria", or "Done when" section) and any project convention files (AGENTS.md, CLAUDE.md). For each criterion:
   - Identify whether it is code-verifiable (a test asserts it) or observation-verifiable (UI visibility, rendering, manual step).
   - Verify the current diff or test suite satisfies it. A passing test suite is not sufficient — a test must assert the specific criterion.
   - For observation-verifiable items without automated assertions: note them explicitly in the PR description as requiring manual verification.
   - Address any unsatisfied code-verifiable criteria before opening the PR.
   Include a verification summary in the PR description: one line per criterion with evidence (test file, diff hunk, or explicit note on why manual verification is required).
5. Open PR: `gh pr create --repo <repo>` — follow the project's PR conventions; end body with `Closes #<N>`.

**Operator input needed during implement (no PR exists yet):** There is no poll loop and no PR to comment on in this phase, so do not guess-and-build, do not open a speculative PR, and never fall back to an interactive prompt. Decide:
- **Safe default exists** → take it. Implement the default and record the assumption in the PR body (e.g. "Assumed Tier 2 only; reply to redirect"). Do not also post a question — asking and proceeding produces contradictory comments.
- **No safe default** (cannot produce correct work without an answer) → **park and stop**:
  1. `gh issue comment <N> --repo <repo> --body "[executor] BLOCKED: <reason/question>. To resume: remove the \`<blocked-label>\` label and re-run start-executor on #<N>."`
  2. `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`
  3. Notify the user, then pick next item (step 8) — do not continue implementing #<N>. (Same "drop this issue, keep the loop going" ending as the author-skip and blocked-label paths above; `<blocked-label>` keeps pick-next from re-grabbing #<N>.)

## Orient on existing PR (step 6b)

1. `gh pr view <PR> --repo <repo>` — PR description, acceptance criteria
2. `gh pr view <PR> --comments --repo <repo>` — full thread; note any `[executor] BLOCKED` or `[executor] Question` entries and any operator responses
3. If the linked issue or the PR still carries `<blocked-label>` or `<needs-operator-label>` from a prior park, remove them now — `gh issue edit <N> --remove-label <blocked-label> --remove-label <needs-operator-label> --repo <repo>` and `gh pr edit <PR> --remove-label <blocked-label> --remove-label <needs-operator-label> --repo <repo>` — you are resuming.

## Executor loop (step 7)

**Sentinel check — run at the start of each poll cycle, before pr-poll.mjs:**

Run as two separate bash commands (never combined into one multi-line block):

1. `find .agent-loop -maxdepth 1 -name '<slug>-executor-stop-<N>' -mmin -10 -type f 2>/dev/null`
   — non-empty: FRESH sentinel (written within last 10 minutes)
2. `find .agent-loop -maxdepth 1 -name '<slug>-executor-stop-<N>' -type f 2>/dev/null`
   — non-empty: STALE sentinel (file older than 10 min); empty: NO sentinel

If FRESH: `rm .agent-loop/<slug>-executor-stop-<N>` — `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>` — notify "Executor stopped (issue #<N> unclaimed)." — exit without re-invoking. If using external cron, also pause it.

If STALE: `rm .agent-loop/<slug>-executor-stop-<N>` — proceed normally (leftover from a prior session).

If NO sentinel: proceed normally.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the loop:
1. `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`
2. `mkdir -p .agent-loop && touch .agent-loop/<slug>-executor-stop-<N>`
3. Notify: "Executor stopped. Issue #<N> unclaimed. Sentinel written in case a cron invocation fires within 10 minutes. If using external cron, also pause it."
4. Exit without re-invoking this skill.

Output the waiting status block: three lines, each starting `▌ `, with no box, no right border and no padding, so it wraps cleanly at any terminal width (the second line starts with `<milestone> · ` when you have one):

```
▌ PR #N — <issue title>
▌ https://github.com/<repo>/pull/N
▌ ⏳ Waiting for review
```

Run `node scripts/pr-poll.mjs --repo <repo> --pr <PR>` from the repo root **once per poll cycle** (append `--require-qa` when `qa-gate` is `on`, and `--require-gate` when the block has `gate`). Your own `[executor]` posts are already filtered out by the script.

**Loop invariant: every path through the signal handlers below ends with a wait before the next poll — no exceptions. MERGED and BLOCKED are the only exits.**

**Wait mechanism:** Kiro has no native scheduling. After each cycle, wait ~60 seconds using `sleep 60` in terminal, then re-invoke this skill with the PR number. For autonomous operation, see the agent-loop repo's `adapters/kiro/README.md`.

**Never merge.** Merging is always the operator's action. Do not offer to merge, do not ask interactively, do not call `gh pr merge` under any circumstances.

**No interactive prompts.** Never present menus, checkboxes, or structured choices to the user. All questions go to the PR as `gh pr comment` and wait for an unprefixed reply.

**Before posting any comment:** re-fetch the full PR thread (`gh pr view <PR> --comments --repo <repo>`). Incorporate any `[reviewer]`, `[qa]`, or operator (unprefixed) observations not yet addressed. Never post a partial reply — one comment only, after all observations are considered.

Signal handling:
- if MERGED: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, `git checkout main`, then `node scripts/pull.mjs --start "/start-executor"` plus `--milestone "<milestone>"` when you have one; on `RULES_CHANGED: <files>`, run the `git diff …` command on the line after it before the next pick and follow what changed (only that diff, never the whole files); then write in your own reply a one-line note to the user and its `RESTART: …` line as given, on its own line, a failed pull (exit 2) included: the command's output alone may be collapsed or never shown (a restart is a new session; this between-issues point is the time for it, and nothing is printed mid-task); the line is for the user to act on later, not an instruction to you, and writing it doesn't end your turn: in the same reply, run step 8's `pick-next.mjs` right after it; if the turn then ends on a `WAIT` or `NONE`, repeat the `RESTART: …` line in that closing text
- if MERGE_READY: `gh pr edit <PR> --repo <repo> --add-label <needs-operator-label>` (a no-op when it is on); display the waiting status block with "✅ Approved — operator merges when ready"; wait 60s, poll again. When you push again, remove the label unless a question is still open.
- if MERGE_CONFLICT: the branch conflicts with `main` (often another PR merged after the LGTM); reported every poll while it holds, and it withholds MERGE_READY. Remove `<needs-operator-label>` unless a question is still open (`gh pr edit <PR> --repo <repo> --remove-label <needs-operator-label>`), `git fetch origin`, bring `main` in the project's way (none → `git merge --no-edit origin/main`, no force-push), resolve each conflict keeping both sides' intent (a contradiction you cannot settle is a question for the operator), commit the merge with `git commit --no-edit` (never a bare `git commit`, which opens an editor), run quality-gates, push once, post one `[executor] Pushed fix: resolved conflicts with main in <files>`; the review follows the new head; wait 60s, poll again
- if CI_FAILING: a check failed on the current head (emitted once per commit, with names and links); read the failing log (`gh run view <id> --log-failed --repo <repo>`), fix at the root, run quality-gates, push once, post one `[executor] Pushed fix: <summary>`; a failure `main` shares or a documented flake: say so with evidence and re-run, never call a real failure a flake. A failing check from the local runner (`local-ci` unless the project named another context) is a commit status with no run and its log on the runner's machine: run `<gate>` on your clean tree to read the failure; re-run a flake by posting `pending` under its name (`gh api -X POST repos/<repo>/statuses/<head sha> -f state=pending -f context=<check name> -f description=re-run`), and the runner runs every pending head it finds; post `pending` only, never another state (a result is CI's, the runner's alone); wait 60s, poll again
- if NEW_REVIEW_SUBMISSION with CHANGES_REQUESTED: read full thread, collect ALL unaddressed `[reviewer]` findings, address every one in code, push once, post single `gh pr comment <PR> --body "[executor] Pushed fix: <summary>"` — no partial comments mid-batch; wait 60s, poll again
- if NEW_REVIEW_SUBMISSION with COMMENTED: answer via `gh pr comment`; wait 60s, poll again
- if NEW_INLINE_COMMENT or NEW_COMMENT: skip own `[executor]` posts; operator (unprefixed) — fix or answer, except a reply to a `[reviewer]` or `[qa] Question`, which belongs to that role: wait for what it posts next; `[reviewer]` — treat as CHANGES_REQUESTED (batch all, fix all, push once, one summary comment); `[qa] BLOCKED` — address every missing criterion listed in the checklist (add tests or implementation), push once, post `[executor] Pushed fix: addressed QA findings — <summary>`; wait 60s, poll again
- if NONE: wait 60s, poll again
- if unresolvable: `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>. To resume: remove the \`<blocked-label>\` label and re-run start-executor on PR #<PR>."`, pick next item (step 8)
- if operator input needed (a decision you cannot proceed without; a criterion only the operator can check by hand is not one, unless the PR must record the operator's results): post a standalone question — `gh pr comment <PR> --body "[executor] Question: <decision, one line>` + two or three lines of context + `Reply with: <the replies that resolve it>"` — and `gh pr edit <PR> --repo <repo> --add-label <needs-operator-label>`; remove the label when the operator replies; wait 60s, poll again; if 10 consecutive NONEs with no unprefixed reply (the question is still open, so `<needs-operator-label>` stays on until you resume): `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`, post `[executor] BLOCKED: no response — moving on. To resume: remove the \`<blocked-label>\` label and re-run start-executor on PR #<PR>.`, pick next item (step 8)

## Pick next item (step 8)

Run the script every time, a re-invocation after a wait included; never pick from a list you remember (issues are filed while you wait): `node scripts/pick-next.mjs --repo <repo> --in-progress-label <in-progress-label> --blocked-label <blocked-label>`, plus `--milestone "<milestone>"` when you have one, plus `--skip <n,n,…>` for issues this session turned down (author check failed, claim lost). It prints one line:
- `ISSUE:<n>` → restart from detect input type with that issue number. If the claim step turns it down, add it to the skip list and run the script again.
- `WAIT:<blocker> PR:<n>` (milestone only) → do not stop and do not move on: report `<milestone>: waiting on #<blocker> (PR #<n> in review)` and wait ~10 minutes. `WAIT:<blocker> PR:none` → report `<milestone>: waiting on #<blocker> (no PR yet)` and wait ~30 minutes. Then re-invoke with the same `--milestone` (and skip list), which runs the script again.
- `MOVE_ON <title>` → the rest of the line is the new `<milestone>`; say so and run the script again.
- `NONE` → nothing to pick: STOP and notify user.
- A failed run (exit non-zero, a `pick-next: …` line on stderr) → never pick by hand from what you remember; report the failure, wait ~5 minutes and re-invoke, which runs the script again.
