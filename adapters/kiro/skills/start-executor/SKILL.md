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
> ~60 seconds then re-invoke this skill, or use an external cron job (see `adapters/kiro/README.md`).

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)
- `in-progress-label` — label name for claiming issues (default: `in-progress`)
- `quality-gates` — commands to run at each checkpoint
- `trusted-authors` — explicit GitHub login allowlist (e.g. `[alice, bob]`). If set, only these logins are processed; `allow-author-associations` is ignored. See README Security section.
- `allow-author-associations` — fallback when `trusted-authors` is absent. List of `authorAssociation` values (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

Then proceed with $ARGUMENTS.

**No interactive terminal prompts.** Post questions as `gh pr comment <N> --body "[executor] Question: <question>"`.

## Detect input type

Run `gh pr view $ARGUMENTS --repo <repo>` first.
- If it succeeds: $ARGUMENTS is a PR — note linked issue from PR body (`Closes #<N>`), orient (step 6b), enter executor loop (step 7).
- If it fails or $ARGUMENTS is empty: treat as issue number or pick next.
  - **Empty $ARGUMENTS:** run pick-next query (step 8), use result as issue number.
  - **Issue number:** check for existing open PR: `gh pr list --repo <repo> --state open --json number,body --jq '[.[] | select(.body | test("Closes #<N>([^0-9]|$)"; "i"))] | first | .number'`
    - PR found: orient (step 6b), enter executor loop (step 7) — do not re-claim label.
    - Not found: immediately before claiming, re-fetch: `gh issue view <N> --repo <repo> --json labels,author,authorAssociation --jq '{labels: [.labels[].name], login: .author.login, assoc: .authorAssociation}'`
      - If `<in-progress-label>` now present in labels: another agent claimed it; go to step 8.
      - **Author check — apply in order:**
        1. If `trusted-authors` is set: skip unless `login` is in that list. Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: @<login> is not in \`trusted-authors\`. Add login to AGENTS.md to allow. See README Security section."` — do not claim — go to step 8.
        2. Else: skip unless `assoc` is in `allow-author-associations` (default: `[OWNER, MEMBER, COLLABORATOR]`). Post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. See README Security section."` — do not claim — go to step 8.
      - Otherwise claim — `gh issue edit <N> --add-label <in-progress-label> --repo <repo>` — then full implement flow.

## Full implement flow (issue input, no existing PR)

1. Fetch issue: `gh issue view <N> --repo <repo>`
2. Follow the project's AGENTS.md conventions for branching, work tracking, and commit structure. If not specified, use sensible defaults.
3. Implement the work described in the issue. Run quality-gates from AGENTS.md config.
4. Open PR: `gh pr create --repo <repo>` — follow the project's PR conventions; end body with `Closes #<N>`.

## Orient on existing PR (step 6b)

1. `gh pr view <PR> --repo <repo>` — PR description, acceptance criteria
2. `gh pr view <PR> --comments --repo <repo>` — full thread; note any `[executor] BLOCKED` or `[executor] Question` entries and any operator responses

## Executor loop (step 7)

Output the waiting status block:

```
┌─────────────────────────────────────┐
│  PR #N — <issue title>              │
│  https://github.com/…/pull/N        │
│                                     │
│  ⏳ Waiting for review              │
└─────────────────────────────────────┘
```

Run `node scripts/pr-poll.mjs --repo <repo> --pr <PR>` from the repo root **once per poll cycle**.

**Loop invariant: every path through the signal handlers below ends with a wait before the next poll — no exceptions. MERGED and BLOCKED are the only exits.**

**Wait mechanism:** Kiro has no native scheduling. After each cycle, wait ~60 seconds using `sleep 60` in terminal, then re-invoke this skill with the PR number. For autonomous operation, set up external cron (see `adapters/kiro/README.md`).

**Never merge.** Merging is always the operator's action. Do not offer to merge, do not ask interactively, do not call `gh pr merge` under any circumstances.

**No interactive prompts.** Never present menus, checkboxes, or structured choices to the user. All questions go to the PR as `gh pr comment` and wait for an unprefixed reply.

**Before posting any comment:** re-fetch the full PR thread (`gh pr view <PR> --comments --repo <repo>`). Incorporate any `[reviewer]` or operator (unprefixed) observations not yet addressed. Never post a partial reply — one comment only, after all observations are considered.

Signal handling:
- if MERGED: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, notify user, pick next item (step 8)
- if MERGE_READY: display the waiting status block with "✅ Approved — operator merges when ready"; wait 60s, poll again
- if NEW_REVIEW_SUBMISSION with CHANGES_REQUESTED: read full thread, collect ALL unaddressed `[reviewer]` findings, address every one in code, push once, post single `gh pr comment <PR> --body "[executor] Pushed fix: <summary>"` — no partial comments mid-batch; wait 60s, poll again
- if NEW_REVIEW_SUBMISSION with COMMENTED: answer via `gh pr comment`; wait 60s, poll again
- if NEW_INLINE_COMMENT or NEW_COMMENT: skip own `[executor]` posts; operator (unprefixed) — fix or answer; `[reviewer]` — treat as CHANGES_REQUESTED (batch all, fix all, push once, one summary comment); wait 60s, poll again
- if NONE: wait 60s, poll again
- if unresolvable: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>"`, pick next item (step 8)
- if operator input needed: post `gh pr comment <PR> --body "[executor] Question: <question>"`; wait 60s, poll again; if 10 consecutive NONEs with no unprefixed reply: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `[executor] BLOCKED: no response — moving on`, pick next item (step 8)

## Pick next item (step 8)

`gh issue list --state open --repo <repo> --json number,title,labels --jq 'sort_by(.number) | map(select(.labels | map(.name) | index("<in-progress-label>") | not)) | first'`

If result found: restart from detect input type with that issue number. If none: STOP and notify user.
