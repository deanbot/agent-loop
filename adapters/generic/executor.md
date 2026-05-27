# Agent loop — generic executor prompt

Paste this into your project's AGENTS.md, or instruct your agent to follow it.

---

Read the project's AGENTS.md `## Agent loop` section. Extract:
- `repo` — GitHub repo (owner/repo)
- `in-progress-label` — label for claiming issues (default: `in-progress`)
- `quality-gates` — commands to run at each checkpoint
- `trusted-authors` — explicit GitHub login allowlist (e.g. `[alice, bob]`). If set, only these logins are processed; `allow-author-associations` is ignored. See README Security section.
- `allow-author-associations` — fallback when `trusted-authors` is absent. List of `authorAssociation` values (default: `[OWNER, MEMBER, COLLABORATOR]`). See README Security section.

**No interactive prompts.** Post questions as `gh pr comment <N> --body "[executor] Question: <question>"`.

## Detect input type

If given a PR number: orient on it (read PR description + full comment thread), enter poll loop.
If given an issue number: check for existing open PR (`gh pr list --repo <repo> --state open --json number,body`). If found, orient and poll. If not found, claim the issue and implement.
If given nothing: run pick-next query, treat result as issue number.

## Implement flow (no existing PR)

Before claiming, fetch author info: `gh issue view <N> --repo <repo> --json author,authorAssociation --jq '{login: .author.login, assoc: .authorAssociation}'`

**Author check — apply in order:**
1. If `trusted-authors` set: skip unless `login` in list → post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: @<login> is not in \`trusted-authors\`. Add login to AGENTS.md to allow. See README Security section."` — do not claim — pick next.
2. Else: skip unless `assoc` in `allow-author-associations` (default: `[OWNER, MEMBER, COLLABORATOR]`) → post `gh issue comment <N> --repo <repo> --body "[executor] Skipped: author @<login> (association: <assoc>) is not in \`allow-author-associations\`. See README Security section."` — do not claim — pick next.

Claim before branching: `gh issue edit <N> --add-label <in-progress-label> --repo <repo>`

1. `gh issue view <N> --repo <repo>`
2. Follow the project's AGENTS.md conventions for branching, work tracking, and commit structure. If not specified, use sensible defaults.
3. Implement the work. Run quality-gates from AGENTS.md config.
4. `gh pr create --repo <repo>` — follow the project's PR conventions; end body with `Closes #<N>`.

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
- Unresolvable: remove label, post `gh pr comment <PR> --body "[executor] BLOCKED: <reason>"`, pick next
- Operator input needed: post `gh pr comment <PR> --body "[executor] Question: <question>"`; wait, poll again; after 10 consecutive NONE with no unprefixed reply: remove label, post `[executor] BLOCKED: no response — moving on`, pick next

## Pick next

`gh issue list --state open --repo <repo> --json number,title,labels --jq 'sort_by(.number) | map(select(.labels | map(.name) | index("<in-progress-label>") | not)) | first'`

If result: restart with that issue number. If none: stop.
