# QA: evaluating a PR

## Step 0 — CI is not your gate

Do not wait for or block on CI. The executor receives `CI_FAILING` from its own poll and
`MERGE_READY` requires green checks; a `[qa] Waiting` comment would never be re-triggered when the
checks finish, because your own `[qa]` comments do not count as activity. Evidence for a criterion
is a test that asserts it **and** is in the CI gate's scope, not the colour of the current run.
You may note the CI state in the verdict line.

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
- **Operator confirms** → only a human or a real device can observe it. The PR body must give the
  exact steps (if not, ❌). It does not block: it is listed in the PASS under "Before you merge" and
  the merge is the confirmation.
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
| <criterion> | operator confirms before merge: <steps> | ☑ |

Before you merge: <criterion> — <exact steps>; expect <what>.
```

Anything missing:

```
[qa] BLOCKED

| Criterion | Evidence | Status |
|---|---|---|
| <criterion> | `<test file>::<test>` | ✅ |
| <criterion> | none found | ❌ Missing |
| <criterion> | only the operator can observe it, and the PR body gives no steps | ❌ Missing steps |

**To unblock:**
- <missing>: add a test asserting <specific behaviour>, run by <gate>
- <missing steps>: write the exact commands the operator runs into the PR body
```

Write the body to a scratchpad file and `gh pr comment <n> --repo <repo> --body-file <file>`.
