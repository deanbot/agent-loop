# Agent loop — generic executor prompt

Paste this into your project's AGENTS.md, or instruct your agent to follow it.

---

Read the project's AGENTS.md `## Agent loop` section. Extract:
- `repo` — GitHub repo (owner/repo)
- `in-progress-label` — label for claiming issues (default: `in-progress`)
- `quality-gates` — commands to run at each checkpoint
- `spec-path` — where to save spec files during implementation (default: `docs/specs/`)

**No interactive prompts.** Post questions as `gh pr comment <N> --body "[executor] Question: <question>"`.

## Detect input type

If given a PR number: orient on it (read PR description + full comment thread), enter poll loop.
If given an issue number: check for existing open PR (`gh pr list --repo <repo> --state open --json number,body`). If found, orient and poll. If not found, claim the issue and implement.
If given nothing: run pick-next query, treat result as issue number.

## Implement flow (no existing PR)

1. `gh issue view <N> --repo <repo>`
2. Branch off origin/main: `<issue-number>-<slug>`
3. First commit: save issue body to `<spec-path>/<issue-number>-<slug>.md`
4. Per checkbox: implement → run quality-gates → mark `[x]` → commit + push
5. Final commit: delete spec file
6. `gh pr create --repo <repo>` — title mirrors issue exactly, body: Context / Deliverable (all `[x]`) / Acceptance criteria, ends with `Closes #<N>`

Claim before branching: `gh issue edit <N> --add-label <in-progress-label> --repo <repo>`

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
