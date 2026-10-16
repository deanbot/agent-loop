# Reviewer: the full review

Read this for every `REVIEW:<n>` and for a `REVIEW_COMMENTS:<n>` that turns into a full review.
`<n>` is the PR, `<M>` its issue.

## 1. Gather, in parallel

- `gh pr view <n> --repo <repo> --json title,body,headRefOid,headRefName,files` — the body
  carries the acceptance-criteria table and the executor's decisions.
- `gh pr view <n> --comments --repo <repo>` and `gh api repos/<repo>/pulls/<n>/comments` — the
  whole thread and the inline threads. Note what you already raised and what the executor
  answered; only unanswered scope is yours to raise again.
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

## 4. Post one comment

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
[reviewer] LGTM — <short sha> against #<M>, CI <green | pending>. <One line on what the evidence was.>

Before you merge: <criterion> — run <exact steps from the PR body>; expect <what>.
After merge: <criterion that can only run on main> — <steps>.
```

Omit the two trailing lines when every criterion is proven by a test. Never ask the operator to
post a confirmation first; the operator confirms by a comment or by merging.

For a follow-up after the executor's fix: findings start `[reviewer] Recheck of <sha>.` and list
only what is still wrong; a passing recheck starts `[reviewer] LGTM — recheck of <sha>: …`. The
first word after the prefix is what the executor's poll classifies, so an LGTM never hides behind
other text. Repo conventions apply to your comments (for example, no tool attribution). A red check
caused by this PR is a finding, not an LGTM; a pending check is noted, not waited for. Never ask
first; post.

**Label a ready PR with your LGTM**, whoever owns it. The executor adds `<needs-operator-label>`
when its poll sees `MERGE_READY`, but an executor the operator stopped (its issue keeps its
in-progress label) polls nothing, and a PR the operator or a monitor opened, or one an executor
parked, has no executor at all. So with every LGTM, check the `MERGE_READY` threshold yourself:
your LGTM is on the head commit, CI is green (every check `pass` or `skipping`, or no checks at
all), `[qa] PASS` after the last commit when `qa-gate: on`, and no inline thread is unanswered.

- All hold → post the LGTM, then `gh pr view <n> --repo <repo> --json headRefOid,mergeable`.
  Still the sha you reviewed and `mergeable` not `CONFLICTING` → `gh pr edit <n> --repo <repo>
  --add-label <needs-operator-label>` (when the label is already on, this does nothing). The head
  moved → skip the label: a push landed after your LGTM, and the new head is unreviewed.
  `CONFLICTING` → skip it too: the executor's poll reports `MERGE_CONFLICT` and resolves it.
  `UNKNOWN` (GitHub still computing) does not hold the label back.
- CI is pending (everything else holds) → end the LGTM with `CI is pending, so this PR does not
  have the <needs-operator-label> label yet: a running executor adds it when CI is green; with
  none, merge it once CI is green.` A failing check caused by the PR is a finding, not an LGTM.
- Anything else missing → end the LGTM with one line naming it and saying the PR has no
  `<needs-operator-label>` label until it is resolved.

When you later post findings on a PR that carries `<needs-operator-label>`, `--remove-label
<needs-operator-label>` in the same cycle, unless a question (yours, the executor's or QA's) is
still open: a finding revokes the LGTM, so the PR is no longer ready. The executor still removes
the label when it pushes, and still adds it when CI turns green after your LGTM.

## 5. Report to the operator

One line per PR in the terminal: the PR, the sha, the acceptance criteria as a compact checklist,
the findings as a numbered list with one line of evidence each, and last `**PR #<n>: LGTM**` or
`**PR #<n>: Needs fix**`. Leave out process narration.
