# Agent loop — generic executor prompt

Paste this into your project's AGENTS.md, or instruct your agent to follow it.

---

**Prerequisite check — do this first, before any other step:** Verify a `## Agent loop` section exists in the config. If not found, stop immediately and tell the user to add the config block. See `adapters/generic/AGENTS.md` in the agent-loop repo for the template.

Read the project's AGENTS.md `## Agent loop` section. Extract:
- `repo` — GitHub repo (owner/repo)
- `in-progress-label` — label for claiming issues (default: `in-progress`)
- `blocked-label` — label indicating a blocked issue to skip (default: `is-blocked`)
- `quality-gates` — commands to run at each checkpoint
- `trusted-authors` — explicit GitHub login allowlist (e.g. `[alice, bob]`). If set, only these logins are processed; `allow-author-associations` is ignored. See README Security section.
- `allow-author-associations` — fallback when `trusted-authors` is absent. List of `authorAssociation` values (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

**No interactive prompts — ever.** Questions go to GitHub, channel by phase: **PR exists** → `gh pr comment <PR> --body "[executor] Question: <question>"`; **no PR yet** (implement phase) → `gh issue comment <N> --body "[executor] Question: <question>"`. A posted question is a **stop**: if a safe default exists, take it and note the assumption instead of asking; only post a question when you genuinely cannot proceed correctly — and then stop, never ask and keep building in the same step.

## Detect input type

If given a PR number: orient on it (read PR description + full comment thread), enter poll loop.
If given an issue number: check for existing open PR (`gh pr list --repo <repo> --state open --json number,body`). If found, orient and poll. If not found, check labels before claiming (see below).
If given nothing: run pick-next query, treat result as issue number.

## Implement flow (no existing PR)

Before claiming, fetch: `gh issue view <N> --repo <repo> --json labels,author,authorAssociation --jq '{labels: [.labels[].name], login: .author.login, assoc: .authorAssociation}'`

If `<in-progress-label>` in labels: another agent claimed it — pick next. **Do not infer staleness — absence of an open PR is not evidence the claim is stale. The label is authoritative.**

If `<blocked-label>` in labels: skip silently — pick next.

**Author check — apply in order:**
1. If `trusted-authors` set: skip unless `login` in list → post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: @<login> is not in \`trusted-authors\`. Add login to AGENTS.md to allow. See README Security section."` — do not claim — pick next.
2. Else: skip unless `assoc` in `allow-author-associations` (default: `[OWNER, MEMBER, COLLABORATOR]`) → post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. See README Security section."` — do not claim — pick next.

Claim before branching: `gh issue edit <N> --add-label <in-progress-label> --repo <repo>`

1. `gh issue view <N> --repo <repo>`
2. Follow the project's AGENTS.md conventions for branching, work tracking, and commit structure. If not specified, use sensible defaults.
3. Implement the work. Run quality-gates from AGENTS.md config.
4. `gh pr create --repo <repo>` — follow the project's PR conventions; end body with `Closes #<N>`.

**Operator input needed during implement (no PR exists yet):** no poll loop and no PR to comment on — do not guess-and-build, do not open a speculative PR, never use an interactive prompt.
- **Safe default exists** → take it; implement the default and record the assumption in the PR body. Do not also post a question.
- **No safe default** → **park and pick next**: post `gh issue comment <N> --repo <repo> --body "[executor] BLOCKED: <reason>. To resume: remove the \`<blocked-label>\` label and re-run on #<N>."`, then `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`, then pick next. Do not continue implementing #<N>. (Same ending as author-skip / blocked-label; `<blocked-label>` keeps pick-next from re-grabbing it.)

When resuming on an existing PR, remove any lingering `<blocked-label>` from the linked issue (`gh issue edit <N> --remove-label <blocked-label> --repo <repo>`).

## Poll loop

Run `node scripts/pr-poll.mjs --repo <repo> --pr <PR>` once per cycle.

**Wait ~60 seconds between every poll cycle — no exceptions except MERGED and BLOCKED exits.**
Scheduling is caller-managed: use `sleep 60`, external cron, or manual re-trigger.

Signal handling:
- `MERGED`: remove label (`gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`), notify, pick next
- `MERGE_READY`: notify operator; wait, poll again
- `NEW_REVIEW_SUBMISSION` / `CHANGES_REQUESTED`: read full thread, collect ALL unaddressed `[reviewer]` findings, fix all in one pass, push once, post single `gh pr comment <PR> --body "[executor] Pushed fix: <summary>"`; wait, poll again
- `NEW_REVIEW_SUBMISSION` / `COMMENTED`: answer via `gh pr comment`; wait, poll again
- `NEW_INLINE_COMMENT` or `NEW_COMMENT`: skip own `[executor]` posts; treat `[reviewer]` as CHANGES_REQUESTED (batch all, fix all, push once); treat operator (unprefixed) as direction; wait, poll again
- `NONE`: wait, poll again
- Unresolvable: `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>. To resume: remove the \`<blocked-label>\` label and re-run on PR #<PR>."`, pick next
- Operator input needed: post `gh pr comment <PR> --body "[executor] Question: <question>"`; wait, poll again; after 10 consecutive NONE with no unprefixed reply: `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`, post `[executor] BLOCKED: no response — moving on. To resume: remove the \`<blocked-label>\` label and re-run on PR #<PR>.`, pick next

## Pick next

`gh issue list --state open --repo <repo> --json number,title,labels --jq 'sort_by(.number) | map(select(.labels | map(.name) | (index("<in-progress-label>") | not) and (index("<blocked-label>") | not))) | first'`

If result: restart with that issue number. If none: stop.
