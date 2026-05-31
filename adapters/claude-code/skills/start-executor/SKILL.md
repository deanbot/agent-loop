---
name: start-executor
description: >
  Agentic executor loop. Picks an issue (or resumes a PR), implements it, then polls for
  review signals until merged. Reads repo, label, and quality-gates from the project's
  AGENTS.md "## Agent loop" section. Loops to next issue automatically.
---

> **Single-account mode.** One GitHub account runs executor and reviewer. Review signals
> arrive as PR comments prefixed `[reviewer]`. Operator comments are unprefixed.

> **Prerequisite:** `in-progress` label must exist in the repo (one-time setup):
> `gh label create in-progress --color "0075ca" --description "Executor claimed" --repo <repo>`

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-executor. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)
- `in-progress-label` — label name for claiming issues (default: `in-progress`)
- `blocked-label` — label name indicating a blocked issue to skip (default: `is-blocked`)
- `quality-gates` — commands to run at each checkpoint
- `trusted-authors` — explicit GitHub login allowlist (e.g. `[alice, bob]`). If set, only these logins are processed; `allow-author-associations` is ignored. See README Security section.
- `allow-author-associations` — fallback when `trusted-authors` is absent. List of `authorAssociation` values (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Executor sentinel path: `.agent-loop/<slug>-executor-stop-<N>` where `<N>` is the issue number (project-local; gitignored).

Then proceed with $ARGUMENTS.

**No interactive terminal prompts.** Post questions as `gh pr comment <N> --body "[executor] Question: <question>"` and continue polling.

## Detect input type

Run `gh pr view $ARGUMENTS --repo <repo>` first.
- If it succeeds: $ARGUMENTS is a PR — note linked issue from PR body (`Closes #<N>`), orient (step 6b), enter executor loop (step 7).
- If it fails or $ARGUMENTS is empty: treat as issue number or pick next.
  - **Empty $ARGUMENTS:** run pick-next query (step 8), use result as issue number.
  - **Issue number:** check for existing open PR: `gh pr list --repo <repo> --state open --json number,body --jq '[.[] | select(.body | test("Closes #<N>([^0-9]|$)"; "i"))] | first | .number'`
    - PR found: orient (step 6b), enter executor loop (step 7) — do not re-claim label.
    - Not found: immediately before claiming, re-fetch: `gh issue view <N> --repo <repo> --json labels,author,authorAssociation --jq '{labels: [.labels[].name], login: .author.login, assoc: .authorAssociation}'`
      - If `<in-progress-label>` now present in labels: another agent claimed it; go to step 8. **Do not infer staleness — absence of an open PR is not evidence the claim is stale. The label is authoritative.**
      - If `<blocked-label>` now present in labels: issue is blocked; go to step 8 silently.
      - **Author check:** apply in order:
        1. If `trusted-authors` is set: skip unless `login` is in that list. Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: @<login> is not in \`trusted-authors\`. Add login to AGENTS.md to allow. See README Security section."` — do not claim — go to step 8.
        2. Else if `allow-author-associations` is set (or using default): skip unless `assoc` is in that list. Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. See README Security section."` — do not claim — go to step 8.
      - Otherwise claim — `gh issue edit <N> --add-label <in-progress-label> --repo <repo>` — then full implement flow (steps 1–6).

**Operator stop — implement phase:** If the operator sends a message containing "stop" at any point before the executor loop (during implement steps 1–4): `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, notify "Executor stopped. Issue #<N> unclaimed.", exit. No sentinel needed — no ScheduleWakeup has been called yet.

## Full implement flow (issue input, no existing PR)

1. Fetch issue: `gh issue view <N> --repo <repo>`
2. Follow the project's AGENTS.md conventions for branching, work tracking, and commit structure. If the project specifies these, follow them exactly. If not, use sensible defaults.
3. Implement the work described in the issue. Run quality-gates from AGENTS.md config.
4. **Self-check before opening PR:** Re-read the issue body (especially any "What done looks like", "Acceptance criteria", or "Done when" section) and any project convention files (AGENTS.md, CLAUDE.md). For each criterion:
   - Identify whether it is code-verifiable (a test asserts it) or observation-verifiable (UI visibility, rendering, manual step).
   - Verify the current diff or test suite satisfies it. A passing test suite is not sufficient — a test must assert the specific criterion.
   - For observation-verifiable items without automated assertions: note them explicitly in the PR description as requiring manual verification.
   - Address any unsatisfied code-verifiable criteria before opening the PR.
   Include a verification summary in the PR description: one line per criterion with evidence (test file, diff hunk, or explicit note on why manual verification is required).
5. Open PR: `gh pr create --repo <repo>` — follow the project's PR conventions; end body with `Closes #<N>`.

## Orient on existing PR (step 6b)

1. `gh pr view <PR> --repo <repo>` — PR description, acceptance criteria
2. `gh pr view <PR> --comments --repo <repo>` — full thread; note any `[executor] BLOCKED` or `[executor] Question` entries and any operator responses

## Executor loop (step 7)

**Sentinel check — run at the start of each poll cycle, before pr-poll.mjs:**

Run as two separate bash commands (never combined into one multi-line block):

1. `find .agent-loop -maxdepth 1 -name '<slug>-executor-stop-<N>' -mmin -10 -type f 2>/dev/null`
   — non-empty: FRESH sentinel (written within last 10 minutes)
2. `find .agent-loop -maxdepth 1 -name '<slug>-executor-stop-<N>' -type f 2>/dev/null`
   — non-empty: STALE sentinel (file older than 10 min); empty: NO sentinel

If FRESH: `rm .agent-loop/<slug>-executor-stop-<N>` — `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>` — notify "Executor stopped (issue #<N> unclaimed)." — exit without ScheduleWakeup.

If STALE: `rm .agent-loop/<slug>-executor-stop-<N>` — proceed normally (leftover from a prior session).

If NO sentinel: proceed normally.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the loop:
1. `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`
2. `mkdir -p .agent-loop && touch .agent-loop/<slug>-executor-stop-<N>`
3. Notify: "Executor stopped. Issue #<N> unclaimed. Sentinel written in case a wakeup fires within 10 minutes."
4. Exit without calling ScheduleWakeup.

Output the waiting status block:

```
┌─────────────────────────────────────┐
│  PR #N — <issue title>              │
│  https://github.com/…/pull/N        │
│                                     │
│  ⏳ Waiting for review              │
└─────────────────────────────────────┘
```

Run `node ~/.claude/plugins/marketplaces/agent-loop/scripts/pr-poll.mjs --repo <repo> --pr <PR>` **once per poll cycle**.

**Loop invariant: every path through the signal handlers below ends with `ScheduleWakeup(60s)` then polls again — no exceptions. MERGED and BLOCKED are the only exits.**

**Never use `sleep` for waits.** `sleep N && command` is blocked by the harness. To wait for a deployment or external condition: ScheduleWakeup with appropriate delay, then verify on the next cycle. To run a check in the background: use `run_in_background: true` on the Bash call.

**Never merge.** Merging is always the operator's action. Do not offer to merge, do not ask interactively, do not call `gh pr merge` under any circumstances.

**No interactive prompts.** Never present menus, checkboxes, or structured choices to the user. All questions go to the PR as `gh pr comment` and wait for an unprefixed reply. This agent must be able to run fully headless.

**Before posting any comment:** re-fetch the full PR thread (`gh pr view <PR> --comments --repo <repo>`). Incorporate any `[reviewer]`, `[qa]`, or operator (unprefixed) observations not yet addressed into your response. Never post a partial reply — one comment only, after all observations are considered.

Signal handling:
- if MERGED: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, notify user, pick next item (step 8)
- if MERGE_READY: display the waiting status block with "✅ Approved — operator merges when ready"; ScheduleWakeup(60s), poll again
- if NEW_REVIEW_SUBMISSION with CHANGES_REQUESTED: read full thread, collect ALL unaddressed `[reviewer]` findings, address every one in code, push once, post single `gh pr comment <PR> --body "[executor] Pushed fix: <summary>"` — no partial comments mid-batch; ScheduleWakeup(60s), poll again
- if NEW_REVIEW_SUBMISSION with COMMENTED: answer via `gh pr comment`; ScheduleWakeup(60s), poll again
- if NEW_INLINE_COMMENT or NEW_COMMENT: skip own `[executor]` posts; operator (unprefixed) — check if already addressed in current code first; if already resolved post inline reply confirming it, if not fix it then reply; always reply to each inline comment thread via `gh api repos/<repo>/pulls/<PR>/comments -X POST -f body="[executor] <response>" -f in_reply_to_id=<id>` — no reply = signal loops forever; `[reviewer]` — treat as CHANGES_REQUESTED (batch all, fix all, push once, one summary comment); `[qa] BLOCKED` — address every missing criterion listed in the checklist (add tests or implementation), push once, post `[executor] Pushed fix: addressed QA findings — <summary>`; ScheduleWakeup(60s), poll again
- if NONE: ScheduleWakeup(60s), poll again
- if unresolvable: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>"`, pick next item (step 8)
- if operator input needed: post `gh pr comment <PR> --body "[executor] Question: <question>"`; ScheduleWakeup(60s), poll again; if 10 consecutive NONEs with no unprefixed reply: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `[executor] BLOCKED: no response — moving on`, pick next item (step 8)

## Pick next item (step 8)

`gh issue list --state open --repo <repo> --json number,title,labels --jq 'sort_by(.number) | map(select(.labels | map(.name) | (index("<in-progress-label>") | not) and (index("<blocked-label>") | not))) | first'`

If result found: restart from detect input type with that issue number. If none: STOP and notify user.
