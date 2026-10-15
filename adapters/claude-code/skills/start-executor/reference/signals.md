# Executor: signal handling

`pr-poll.mjs` prints signal lines followed by content blocks indented two spaces. Your own
`[executor]` posts are already filtered out. Handle every signal in a cycle before the single
`ScheduleWakeup` call.

## MERGED

`gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, then `git checkout main`,
`git pull`. Tell the operator in one line. Pick next (SKILL.md); if there is a next issue, go
straight into implementing it. No wakeup is scheduled for the merged PR.

## CI_FAILING

Emitted once per head commit, with the failing check names and links. `gh run view <id>
--log-failed --repo <repo>` (the run id is in the link) and read the actual failure.

- A real failure in your change: fix it at the root, run `quality-gates`, push once, post
  `[executor] Pushed fix: <what failed, what changed>`.
- A failure `main` has too, or a documented flake: say so in one `[executor]` comment with the
  evidence (the run on `main`, or the flake's known signature) and re-run (`gh run rerun <id>
  --failed --repo <repo>`). Never call a real failure a flake.
- The project's PR body or docs name a human setup step (a secret, an external service): post
  the exact step for the operator and keep polling.

## NEW_INLINE_COMMENT

Each block carries `id`, `path`, `line` and the body. Unanswered top-level threads keep
re-surfacing every poll until a reply exists, so always reply:

`gh api repos/<repo>/pulls/<PR>/comments -X POST -f body="[executor] <reply>" -f
in_reply_to_id=<id>`

Verify the finding first (reproduce it, or show why it does not apply). Fix it if it stands, in
the same batch as everything else this cycle, then reply with what changed and the commit.

## NEW_REVIEW_SUBMISSION

Formal reviews are rare in single-account mode. `CHANGES_REQUESTED` → treat the body as findings.
`COMMENTED` → answer in a `[executor]` comment. `APPROVED` → nothing to do.

## NEW_COMMENT

Read the full thread, not just the new blocks.

- **`[reviewer]` findings** (anything but `LGTM`): collect every unaddressed one. Reproduce each
  before fixing; if a suggested fix is unsafe or incomplete, do better and say why. Fix all in one
  pass with a regression test per finding, run `quality-gates`, push once, post one `[executor]
  Pushed fix in <sha>: <what changed per finding>`. Never post partial progress mid-batch.
- **`[reviewer]` "awaiting operator confirmation of …"**: nothing for you unless the reviewer
  also asked you for something.
- **`[qa] BLOCKED`** (only with `qa-gate: on`): each ❌ or ⚠️ row is a finding: add the test or
  the implementation, or write the operator's steps into the PR body. Push once, post one
  `[executor] Pushed fix: addressed QA findings — …`.
- **Operator (unprefixed)**: direction or a question. Check whether the current code already does
  it; if so, reply confirming where. Otherwise do it, push, reply. If the operator's comment
  confirms an "operator confirms" criterion, note it in the PR body's table.
- **A live `[reviewer]`/`[qa]` verdict that re-surfaces** after you already pushed a fix: the
  script surfaces verdicts newer than the last commit until an `[executor]` comment follows them.
  If your fix comment is missing, post it; if the verdict is wrong, say why in one comment.

After posting, the PR body may be stale: update it (`gh pr edit <PR> --repo <repo> --body-file
<file>`) before the reply, not after.

## MERGE_READY

`[reviewer] LGTM` is newer than the last commit, CI is green, no inline thread is unanswered
(and with `qa-gate: on`, `[qa] PASS` is newer than the last commit). Print the status block with
"✅ Ready — operator merges when ready", then wait as usual. Do not merge, do not offer to, do
not ask. If the operator comments after this, handle it; a new push resets the verdicts.

## NONE

Nothing new. Wait with `noop: true`.

## Questions and blocks in the loop

- Post `[executor] Question: <question>` only when no safe default exists, then keep polling.
  Count `NONE` cycles since the question; at 10 with no unprefixed reply, park:
  `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`
  and `gh pr comment <PR> --repo <repo> --body "[executor] BLOCKED: no response — moving on. To
  resume: remove the \`<blocked-label>\` label and re-run start-executor on PR #<PR>."`, then pick
  next.
- Unresolvable (a finding you cannot satisfy without a decision, a dependency that is not yours):
  park the same way with the reason, then pick next.
- Resuming a parked PR (operator removed the label and re-ran you on the PR): remove any lingering
  `<blocked-label>`, orient, continue.
