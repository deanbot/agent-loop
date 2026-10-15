# QA: evaluating a PR

## Step 0 — CI gate

`gh pr checks <n> --repo <repo> --json name,state,bucket` as one plain command; read the JSON
(do not pipe to `jq`). With `--json` the command exits 0 while checks are pending or failing; a
non-zero exit with empty output means no checks or no such PR, not a CI state.

- Empty or no checks → continue.
- Any `"bucket": "pending"` → post `[qa] Waiting: CI still running — <N> check(s) pending.` and
  stop here for this PR.
- Any `"bucket": "fail"` → post `[qa] BLOCKED: CI failing — <names>. Fix CI before A.C.
  evaluation.` and stop here.

## Step 1 — gather, in parallel

- `gh pr view <n> --repo <repo> --json body,title,number`
- `gh pr diff <n> --repo <repo>`
- `gh pr view <n> --comments --repo <repo>`
- The project's `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` if present.

Never compose the verdict in the same tool batch as these fetches; it depends on them.

## Step 2 — the linked issue

Parse `Closes #M` (case-insensitive) out of **this** PR's freshly fetched body — never from
memory or another PR. None → post `[qa] BLOCKED: PR body does not reference a linked issue
(expected "Closes #N").` and stop. Otherwise `gh issue view <M> --repo <repo> --comments`.

## Step 3 — synthesize the criteria

From the issue (acceptance criteria, deliverable, done-when sections under any heading), the PR
body, and the project conventions: one list of verifiable claims. A convention such as "every bug
fix has a regression test" is a criterion. The issue's Notes record decisions already made; do not
turn them into criteria.

## Step 4 — classify and map

For each criterion:

- **Code-verifiable** → a test asserts it directly, **and** CI runs that test. Find the gate (CI
  workflow, `justfile`, `package.json` scripts) and the runner's file scope; a test file outside
  the scope is a dead test: ❌ with the note "test exists (`<file>`) but is not run by `<gate>`".
- **Operator confirms** → only a human or a real device can observe it. Satisfied only by an
  unprefixed operator comment on the PR saying it was verified; the PR body must give the exact
  steps. Otherwise ⚠️, and it blocks.
- **Missing** → ❌.

A green suite is not evidence; the specific assertion is.

## Step 5 — post one verdict

No criteria found → `[qa] BLOCKED: no acceptance criteria found in the issue, PR body or project
conventions. Add them to the issue before merging.` Never pass silently.

All criteria evidenced:

```
[qa] PASS

| Criterion | Evidence | Status |
|---|---|---|
| <criterion> | `<test file>::<test>` | ✅ |
| <criterion> | operator confirmed (<comment date>) | ✅ |
```

Anything missing:

```
[qa] BLOCKED

| Criterion | Evidence | Status |
|---|---|---|
| <criterion> | `<test file>::<test>` | ✅ |
| <criterion> | none found | ❌ Missing |
| <criterion> | needs the operator: <steps from PR body> | ⚠️ Operator confirms |

**To unblock:**
- <missing>: add a test asserting <specific behaviour>, run by <gate>
- <operator confirms>: operator posts an unprefixed comment confirming <steps>
```

Write the body to a scratchpad file and `gh pr comment <n> --repo <repo> --body-file <file>`.
