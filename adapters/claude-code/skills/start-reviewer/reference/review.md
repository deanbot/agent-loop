# Reviewer: the full review

Read this for every `REVIEW:<n>` and for a `REVIEW_COMMENTS:<n>` that turns into a full review.
`<n>` is the PR, `<M>` its issue.

## 1. Gather, in parallel

- `gh pr view <n> --repo <repo> --json title,body,headRefOid,headRefName,files` — the body
  carries the acceptance-criteria table and the executor's decisions.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/pr-thread.mjs --repo <repo> --pr <n>` — the whole thread
  and the inline threads, trusted authors only (the skill's **The thread**; exit 2 → no review
  this cycle). Note what you already raised and what the executor answered; only unanswered
  scope is yours to raise again.
- `gh pr checks <n> --repo <repo> --json name,state,bucket,link` — read the JSON directly.
- `gh issue view <M> --repo <repo> --comments` — `<M>` from `Closes #M` in **this** PR's body,
  never from memory. No linked issue → that is your first finding.
- `gh pr diff <n> --repo <repo>`, and for new files `git fetch origin pull/<n>/head:pr-<n>` then
  `git show pr-<n>:<path>` so you read them whole.
- The project's `AGENTS.md` and whatever the issue's Reference names (a plan section, old tests).

Do not compose a verdict in the same tool batch as the fetches: the verdict depends on what they
return. Fetch, read, then write.

## 2. Verify the acceptance criteria (the QA pass)

With `qa-gate: off` this is yours; with `qa-gate: on` QA did it and you check only that the
`[qa] PASS` is newer than the head commit.

For each criterion in the issue (and each rule in `AGENTS.md` that applies, such as "every bug
fix has a regression test"), judge it against what it is *for*, not only its wording:

- **Code-verifiable**: name the test that asserts it. Then check the test is one CI runs: find the
  gate command (the CI workflow, `justfile`, `package.json` scripts) and the runner's file scope.
  A test outside the gate's scope is a dead test and no evidence.
- **By hand**: the criterion needs a human, such as a real model, a device, or a workflow that
  exists only after merge. The PR body must give the operator exact steps; if it does not, that is
  a finding. It never blocks your LGTM: it goes in the LGTM under "Before you merge", and the
  operator confirms by a comment or by merging. The exception is a PR that must record the
  operator's results, such as measurements: those results are part of the PR, so the criterion is
  missing until they are in it. The executor asks for them with a question.
- **Missing**: no test, no implementation, or a test that does not assert the criterion.

The executor's table in the PR body is a pointer, not proof: open each cited test and confirm it
asserts the criterion. Do not re-report a limit the PR body already states plainly; judge whether
the limit is acceptable.

## 3. Verify the code with evidence you produced

**Reading source, probes and checks: one plain command per Bash call, here too.** Read files with
Read (its offset and limit for a range) and search with Grep and Glob. A session without Grep
and Glob searches with `git grep -n '<pattern>' -- '<pathspec>'` and lists files with
`git ls-files '<pathspec>'`, globs quoted (unquoted, zsh fails on `no matches found`). Options go
before the pattern (`git grep -n -A<n> '<pattern>' -- '<pathspec>'`): after it, git reads them as
a revision. No `{…,…}` in a pattern or a pathspec: write alternatives as `-E '(a|b)'` and give
each pathspec separately (`'*.ts' '*.tsx'`). Never
`cat`, `head`, `tail`, `sed -n`, `ls`, `find` or plain `grep` through Bash. Never chain: no `;`,
`&&`, pipes (`| head` included), `for` loops or `cd <dir> && …`. Stay inside the clone, the plugin's folder and the
scratchpad: a path anywhere else prompts too. Change files (a probe, a scratch test) with Edit or
Write, never through Bash: no heredoc, `python3 -`, `node -e`, `sed -i`, `tee` or `>` redirect (a
long comment body goes to a file with Write, then `--body-file <file>`). The project's own
generators and formatters, run as one plain command, are build steps, not hand edits. Why: the project allows commands one by one, and a
compound command, or one reaching outside, matches no rule. It waits for an approval nobody is
there to give, and the loop stops until the operator happens to look.

Every finding needs evidence, not inference:

- Run a probe in your clone: the project's test runner on a throwaway test next to the code, a
  script in the scratchpad, or the project's E2E tooling. Install dependencies the way the project
  documents when you must. Delete probe files and return to `main` afterwards.
- Try to break it: adversarial inputs, boundaries, races, the empty case, the second call.
  Escapers and parsers get fuzzed.
- Where a test is the evidence for a criterion, mutate the behaviour and confirm the test fails.
- Before blaming the PR for a CI failure, check whether `main` fails the same way. Known flakes
  are not findings.
- The executor's product calls (defaults, names, departures from the plan): judge them. Reasonable
  → one line of acknowledgement at most. Wrong → a finding with your recommended call. The issue's
  Notes record decisions already made; do not reopen them.

If you cannot demonstrate a suspected problem, drop it.

## 4. Run the gate (only with `gate`, on a PR with no CI)

Only when the block has `gate` and the PR has no CI: `gh pr checks` returned no checks ("no checks
reported"), or every check is `skipping`. The project has turned CI off and the gate stands in for
it. With CI checks present, skip this section: CI is the gate. That includes a check from the
local runner (`local-ci.mjs`; `local-ci` unless the project named another context), even while
it is pending: the runner runs the gate on the head itself. The runner posts its check shortly
after a push, so read `gh pr checks <n> --repo <repo> --json name,state,bucket` again just before
step 1, and skip this section if a check has appeared. Never post a commit status yourself: a
result is CI's, the runner's alone (the guard hook refuses any state but `pending`).

Run it when you have no findings and are about to post an LGTM (a recheck included), on the head
you reviewed and a clean tree, after your probe files are deleted:

1. `git fetch origin pull/<n>/head`, then `git switch --detach FETCH_HEAD`, then `git status
   --porcelain` (it must print nothing). The sha `git switch` reports must be the head you
   reviewed; another one means the head moved: drop the verdict and let the next cycle review it.
2. `<gate>`, exactly as the block gives it, with Bash `run_in_background: true` when it takes
   minutes; wait for its notification. No pipes: read the last line from its output.
3. `git switch main`.

A non-zero exit is a finding: quote the failing step and its last lines, and post findings, not an
LGTM. A pass goes into the LGTM as its own line, `Gate on <short sha>: <the gate's last line>`,
with the sha of the head you ran it on. With `gate` in the block on the default branch, `pr-poll` withholds `MERGE_READY`
from an LGTM without that line on the head commit. A gate the executor quoted is a pointer, not proof:
run it yourself.

## 5. Post one comment

Confirm the head has not moved (`gh pr view <n> --repo <repo> --json headRefOid`). Write the
body to a scratchpad file and `gh pr comment <n> --repo <repo> --body-file <file>`.

Findings (written for the executor, which will act on them):

```
[reviewer] Review of <short sha> against #<M>.

Acceptance criteria: <"all covered" | "N of M covered; see 1 below">
CI: <green | red: <check>, see 2 below>

1. **<The defect, as one claim.>** <Why it happens, in the code's terms.> Evidence: <the probe
   and its exact output>. <Which criterion or rule it breaks.> Fix: <the concrete change>. Add a
   regression test with <specific input> checking <specific outcome>.
2. …
```

Nothing missing, or only things the operator confirms by hand:

```
[reviewer] LGTM — <short sha> against #<M>, CI <green | pending | none, gate passed>. <One line on what the evidence was.>

Gate on <short sha>: <the gate's last line>
Before you merge: <criterion> — run <exact steps from the PR body>; expect <what>.
After merge: <criterion that can only run on main> — <steps>.
```

Omit the `Gate on` line unless §4 ran. When the local runner's check is on the head, the first
line names it in place of a quote: `CI green (local-ci)`, or `CI pending (local-ci)`. Omit the two trailing lines when every criterion is proven
by a test. Never ask the operator to
post a confirmation first; the operator confirms by a comment or by merging.

For a follow-up after the executor's fix: findings start `[reviewer] Recheck of <sha>.` and list
only what is still wrong; a passing recheck starts `[reviewer] LGTM — recheck of <sha>: …`. The
first word after the prefix is what the executor's poll classifies, so an LGTM never hides behind
other text. Repo conventions apply to your comments (for example, no tool attribution). A red check
caused by this PR is a finding, not an LGTM; a pending check is noted, not waited for, unless the
block has `review-waits-for-ci: on`: then post nothing while a check is pending, and post the LGTM
on `CI_DONE:<n>` once CI is green (SKILL.md). Never ask first; post.

**Label a ready PR with your LGTM**, whoever owns it. The executor adds `<needs-operator-label>`
when its poll sees `MERGE_READY`, but an executor the operator stopped (its issue keeps its
in-progress label) polls nothing, and a PR the operator or a monitor opened, or one an executor
parked, has no executor at all. So with every LGTM, check the `MERGE_READY` threshold yourself:
your LGTM is on the head commit, CI is green (every check `pass` or `skipping`, or no checks at
all; with `gate` and no CI, your LGTM quotes the gate on the head instead), `[qa] PASS` after the
last commit when `qa-gate: on`, and no inline thread is unanswered. A gate that passed puts the
label on right after the LGTM: there is no CI to wait for.

- All hold → post the LGTM, then `gh pr view <n> --repo <repo> --json headRefOid,mergeable`.
  Still the sha you reviewed and `mergeable` not `CONFLICTING` → `gh pr edit <n> --repo <repo>
  --add-label <needs-operator-label>` (when the label is already on, this does nothing). The head
  moved → skip the label: a push landed after your LGTM, and the new head is unreviewed.
  `CONFLICTING` → skip it too, and post `[reviewer] Merge conflicts — PR #<n> conflicts with
  main, so it is not ready to merge. Whoever owns it: bring main in, resolve, push.` An executor
  that polls gets `MERGE_CONFLICT` as well; a PR with none would otherwise sit unlabelled with
  nobody told.
  `UNKNOWN` (GitHub still computing) does not hold the label back.
- CI is pending (everything else holds), with `review-waits-for-ci: on` → no LGTM yet: post
  nothing and hold it for `CI_DONE:<n>`.
- CI is pending (everything else holds), without it → end the LGTM with `CI is pending, so this PR does not
  have the <needs-operator-label> label yet: a running executor adds it when CI is green; with
  none, merge it once CI is green.` A failing check caused by the PR is a finding, not an LGTM.
- Anything else missing → end the LGTM with one line naming it and saying the PR has no
  `<needs-operator-label>` label until it is resolved.

When you later post findings on a PR that carries `<needs-operator-label>`, `--remove-label
<needs-operator-label>` in the same cycle, unless a question (yours, the executor's or QA's) is
still open: a finding revokes the LGTM, so the PR is no longer ready. The executor still removes
the label when it pushes, and still adds it when CI turns green after your LGTM.

## 6. Report to the operator

One line per PR in the terminal: the PR, the sha, the acceptance criteria as a compact checklist,
the findings as a numbered list with one line of evidence each, and last `**PR #<n>: LGTM**` or
`**PR #<n>: Needs fix**`. Leave out process narration.
