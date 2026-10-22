# Executor: signal handling

`pr-poll.mjs` prints signal lines followed by content blocks indented two spaces. Your own
`[executor]` posts are already filtered out. Handle every signal in a cycle before starting the
waiter and the single `ScheduleWakeup` call.

"Run `quality-gates`" below includes the gate when the block has `gate` and the PR has no CI
checks: run it before the push and quote its last line in the push comment
([implement.md](implement.md) §3). The local runner's check is CI.

## MERGED

`gh issue edit <N> --remove-label <in-progress-label> --repo <repo>`, then `git checkout main`,
then the pull, with the restart line: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pull.mjs --start
"/agent-loop:start-executor"`, plus `--milestone "<milestone>"` when you have one (the current
track, after any `MOVE_ON`). A `RULES_CHANGED:` line → run the `git diff …` command under it and
follow what changed (SKILL.md, "Rules that hold"). Then, before the next pick, write as your own
text a one-line note to the operator, and the `RESTART: …` line exactly as the script gave it, on
its own line. The script's output is not enough: a terminal can collapse or cut a tool's output,
and a session summary doesn't carry it, so the operator may never see the line unless you write
it. A failed pull (exit 2) prints the `RESTART:` line too: write it, after the `⚠ main not
pulled` line. Pick next (SKILL.md); if there is a next issue, go straight into implementing it.
No waiter or wakeup for the merged PR.

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
- A failing check from the local runner (`local-ci.mjs`; `local-ci` unless the project named
  another context) is a commit status, not a run: no `gh run` id, and its description is the
  gate's last line. Its log is on the runner's machine, so run `<gate>` on your committed, clean
  tree to read the failure, then handle it as above. To re-run a flake, post `pending` under its
  name: `gh api -X POST repos/<repo>/statuses/<head sha> -f state=pending -f context=<check name>
  -f description=re-run`. The runner runs every pending head it finds. Post `pending` only, never
  another state: a result is CI's, the runner's alone (the guard hook refuses any other).

## MERGE_CONFLICT

The PR's branch conflicts with `main`, usually because another PR merged after this one's LGTM. It
is reported on every poll while the conflict holds, and it withholds `MERGE_READY`, so the PR is
not ready whatever the verdicts say.

1. `gh pr edit <PR> --repo <repo> --remove-label <needs-operator-label>` unless a question is still
   open: the operator cannot merge a conflicting PR.
2. `git fetch origin`, then bring `main` in the way the project's conventions say. With no
   convention, `git merge --no-edit origin/main`: a merge needs no force-push. A rebase needs
   `git push --force-with-lease`, and only on this PR's branch.
3. Resolve each conflict by reading both sides: keep what `main` added and what this PR adds.
   When a resolution needs a decision you cannot make (the two changes contradict each other),
   it is a question for the operator (SKILL.md, "Asking the operator"), not a guess.
4. `git add` the resolved files and commit the merge with `git commit --no-edit` (or `-m
   "<message>"`), never a bare `git commit`, which opens an editor and stalls the loop. Run
   `quality-gates`, push once (with any other fix from this cycle), and post `[executor] Pushed
   fix: resolved conflicts with main in <files>; <anything notable>`.

The push makes every verdict stale. The reviewer's watch sees the new head and reviews it, and
`MERGE_READY` comes back with its next LGTM. When GitHub has not yet computed whether the PR
merges cleanly, the poll reports nothing about it and looks again next cycle.

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
- **`[reviewer] Question …`**: a question for the operator. Nothing for you.
- **`[qa] BLOCKED`** (only with `qa-gate: on`): each ❌ or ⚠️ row is a finding: add the test or
  the implementation, or write the operator's steps into the PR body. Push once, post one
  `[executor] Pushed fix: addressed QA findings — …`.
- **Operator (unprefixed)**: direction, or the answer to a question. If it answers your
  `[executor] Question`, act on it and `gh pr edit <PR> --repo <repo> --remove-label
  <needs-operator-label>`. If it answers a `[reviewer]` or `[qa] Question`, it belongs to that
  role: do nothing with it, and act on the finding or verdict that role posts next. Otherwise it
  is direction: check whether the current code already does it; if so, reply confirming where; if
  not, do it, push, reply.
- **A live `[reviewer]`/`[qa]` verdict that re-surfaces** after you already pushed a fix: the
  script surfaces a finding or `BLOCKED` until an `[executor]` comment or a newer verdict from
  its role follows it, whatever commits came in between.
  If your fix comment is missing, post it; if the verdict is wrong, say why in one comment.

After posting, the PR body may be stale: update it (`gh pr edit <PR> --repo <repo> --body-file
<file>`) before the reply, not after.

## MERGE_READY

`[reviewer] LGTM` is newer than the last commit, CI is green, no inline thread is unanswered,
the PR does not conflict with `main` (and with `qa-gate: on`, `[qa] PASS` is newer than the last
commit; with `gate` and no CI, the LGTM quotes the gate on the head). Every cycle it holds:
`gh pr edit <PR> --repo <repo> --add-label <needs-operator-label>` (a no-op when it is on). Print
the status block with "✅ Ready — operator merges when ready", then wait as usual. Do not merge,
do not offer to, do not ask. If the operator comments after this, handle it. When you push again,
`--remove-label <needs-operator-label>` in the same cycle unless a question is still open, since
the verdicts are stale until the agents re-approve.

## NONE

Nothing new. Wait with `noop: true`.

## Questions and blocks in the loop

- Ask only when no safe default exists, in the shape of "Asking the operator" (SKILL.md): the
  standalone comment, the `<needs-operator-label>`, the push notification. Then keep polling,
  with `--max 600` waiters while the question is open. When a cycle's poll is `NONE` and the
  question has had no unprefixed reply for 10 minutes, park (the question is still open, so
  `<needs-operator-label>` stays on until you resume):
  `gh issue edit <N> --remove-label <in-progress-label> --add-label <blocked-label> --repo <repo>`
  and `gh pr comment <PR> --repo <repo> --body "[executor] BLOCKED: no response — moving on. To
  resume: remove the \`<blocked-label>\` label and re-run start-executor on PR #<PR>."`, then pick
  next.
- Unresolvable (a finding you cannot satisfy without a decision, a dependency that is not yours):
  park the same way with the reason, then pick next.
- Resuming a parked PR (operator removed the label and re-ran you on the PR): remove any lingering
  `<blocked-label>` and `<needs-operator-label>` from the issue and the PR, orient, continue.
