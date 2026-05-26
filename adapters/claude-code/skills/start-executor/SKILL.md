---
name: start-executor
description: >
  Agentic executor loop. Picks an issue (or resumes a PR), implements it, then polls for
  review signals until merged. Reads repo, label, quality-gates, and spec-path from the
  project's AGENTS.md "## Agent loop" section. Loops to next issue automatically.
---

> **Single-account mode.** One GitHub account runs executor and reviewer. Review signals
> arrive as PR comments prefixed `[reviewer]`. Operator comments are unprefixed.

> **Prerequisite:** `in-progress` label must exist in the repo (one-time setup):
> `gh label create in-progress --color "0075ca" --description "Executor claimed" --repo <repo>`

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)
- `in-progress-label` — label name for claiming issues (default: `in-progress`)
- `quality-gates` — commands to run at each checkpoint
- `spec-path` — where to save spec files during implementation (default: `docs/specs/`)
- `allow-author-associations` — list of GitHub `authorAssociation` values whose issues may be processed (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

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
      - If `<in-progress-label>` now present in labels: another agent claimed it; go to step 8.
      - **Author association check:** if `assoc` is not in `allow-author-associations`: post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. To allow, add \`allow-author-associations: [OWNER, MEMBER, COLLABORATOR, <assoc>]\` to AGENTS.md. See README Security section."` — do not claim label — go to step 8.
      - Otherwise claim — `gh issue edit <N> --add-label <in-progress-label> --repo <repo>` — then full implement flow (steps 1–6).

## Full implement flow (issue input, no existing PR)

1. Fetch issue: `gh issue view <N> --repo <repo>`
2. Branch off origin/main: `<issue-number>-<kebab-slug>`
3. First commit: save issue body to `<spec-path>/<issue-number>-<slug>.md`
4. Implement one checkbox at a time:
   - Implement the slice
   - Run quality-gates from AGENTS.md config
   - Mark `[ ]` → `[x]` in spec file
   - Commit implementation + spec edit together, push
5. Final commit: delete spec file
6. Open PR: `gh pr create --repo <repo>` — title mirrors issue title exactly, body follows Context/Deliverable/Acceptance criteria format, ends with `Closes #<N>`

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

Run `node ~/.claude/plugins/marketplaces/agent-loop/scripts/pr-poll.mjs --repo <repo> --pr <PR>` **once per poll cycle**.

**Loop invariant: every path through the signal handlers below ends with `ScheduleWakeup(60s)` then polls again — no exceptions. MERGED and BLOCKED are the only exits.**

**Never merge.** Merging is always the operator's action. Do not offer to merge, do not ask interactively, do not call `gh pr merge` under any circumstances.

**No interactive prompts.** Never present menus, checkboxes, or structured choices to the user. All questions go to the PR as `gh pr comment` and wait for an unprefixed reply. This agent must be able to run fully headless.

**Before posting any comment:** re-fetch the full PR thread (`gh pr view <PR> --comments --repo <repo>`). Incorporate any `[reviewer]` or operator (unprefixed) observations not yet addressed into your response. Never post a partial reply — one comment only, after all observations are considered.

Signal handling:
- if MERGED: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, notify user, pick next item (step 8)
- if MERGE_READY: display the waiting status block with "✅ Approved — operator merges when ready"; ScheduleWakeup(60s), poll again
- if NEW_REVIEW_SUBMISSION with CHANGES_REQUESTED: read full thread, collect ALL unaddressed `[reviewer]` findings, address every one in code, push once, post single `gh pr comment <PR> --body "[executor] Pushed fix: <summary>"` — no partial comments mid-batch; ScheduleWakeup(60s), poll again
- if NEW_REVIEW_SUBMISSION with COMMENTED: answer via `gh pr comment`; ScheduleWakeup(60s), poll again
- if NEW_INLINE_COMMENT or NEW_COMMENT: skip own `[executor]` posts; operator (unprefixed) — fix or answer; `[reviewer]` — treat as CHANGES_REQUESTED (batch all, fix all, push once, one summary comment); ScheduleWakeup(60s), poll again
- if NONE: ScheduleWakeup(60s), poll again
- if unresolvable: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>"`, pick next item (step 8)
- if operator input needed: post `gh pr comment <PR> --body "[executor] Question: <question>"`; ScheduleWakeup(60s), poll again; if 10 consecutive NONEs with no unprefixed reply: `gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, post `[executor] BLOCKED: no response — moving on`, pick next item (step 8)

## Pick next item (step 8)

`gh issue list --state open --repo <repo> --json number,title,labels --jq 'sort_by(.number) | map(select(.labels | map(.name) | index("<in-progress-label>") | not)) | first'`

If result found: restart from detect input type with that issue number. If none: STOP and notify user.
