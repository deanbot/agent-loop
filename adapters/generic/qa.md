# Agent loop — generic QA prompt

Paste this into your project's AGENTS.md, or instruct your agent to follow it.

Run in a separate session from executor and reviewer. Each cycle is one invocation of this prompt;
scheduling between cycles is caller-managed (external cron, manual re-trigger, or tool loop).

---

**Prerequisite check — do this first, before any other step:** Verify a `## Agent loop` section exists in the config. If not found, stop immediately and tell the user to add the config block. See `adapters/generic/AGENTS.md` in the agent-loop repo for the template.

Read the project's AGENTS.md `## Agent loop` section. Extract:
- `repo` — GitHub repo (owner/repo)

Optionally accept `--skip <n,n,...>` to ignore specific PR numbers.

## One cycle

Run `node scripts/pr-qa.mjs --repo <repo>` (plus `--skip` if provided). Handle the output:

**`NONE`**
No activity. Wait ~120 seconds before next cycle.

**`MERGE_CONFLICT:<n>`**
Post: `gh pr comment <n> --body "[qa] Merge conflicts — rebase on main before QA."`
Wait ~120 seconds before next cycle.

**`QA_READY:<n>`**
Fires on two triggers: new commits (SHA change) or new operator (unprefixed) comments.
The second trigger handles operator manual-verification confirmations — no code push needed.

**CI gate — run before fetching any other context:**

```bash
CHECKS=$(gh pr checks <n> --repo <repo> --json name,state,bucket 2>/dev/null)
```

If the command fails or returns empty / `[]`: no CI configured — proceed.

Otherwise:

```bash
PENDING=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "pending")] | length')
FAILING=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "fail")] | length')
```

- `PENDING > 0`: post `[qa] Waiting: CI still running — <N> check(s) pending. Will re-evaluate when checks complete.` Wait ~120s. **Stop.**
- `FAILING > 0`: post `[qa] BLOCKED: CI failing — <names>. Fix CI before A.C. evaluation.` Wait ~120s. **Stop.**
- Otherwise: proceed.

Fetch in parallel:
- `gh pr view <n> --repo <repo> --json body,title,number`
- `gh pr diff <n> --repo <repo>`
- `gh pr view <n> --comments --repo <repo>`

Extract linked issue from PR body (`Closes #<N>`). If not found: post `[qa] BLOCKED: PR body does not reference a linked issue (expected "Closes #N").` Wait ~300 seconds.

Fetch linked issue:
- `gh issue view <N> --repo <repo>`

Read project convention files (if present): `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`.

**Synthesize requirements** from issue body, PR description, and project conventions. Use judgment — do not anchor to a specific header. Include testing requirements from convention files.

**Classify each requirement:**
- Code-verifiable: a test asserts this directly — and that test is executed by the CI quality gate
- Observation-verifiable: only UI/browser/human can confirm

**Map each to evidence** in the diff or test suite. A passing test suite is not sufficient — a test must assert the specific criterion. **A test file that exists in the diff but is not executed by the CI quality gate is not evidence.** Before accepting a test as evidence, verify: read `.github/workflows/*.yml` + `package.json` `scripts.test` to identify the CI gate command and runner scope (e.g., a Playwright spec not run by `npm test`/Vitest is a dead test — mark ❌).

**Before posting:** re-fetch `gh pr view <n> --comments --repo <repo>` to catch any operator (unprefixed) manual-verified notes that arrived during evaluation.

**Post verdict:**

If no requirements found:
```
[qa] BLOCKED: no acceptance criteria found in issue body, PR description, or project convention files.
```

If all requirements have evidence:
```
[qa] PASS

| Criterion | Evidence | Status |
|---|---|---|
| <criterion> | <test:line or diff hunk> | ✅ |
```

If any requirement lacks evidence:
```
[qa] BLOCKED

| Criterion | Evidence | Status |
|---|---|---|
| <verified> | <test:line> | ✅ |
| <missing> | none found | ❌ Missing |
| <ui item> | no E2E assertion on <element> | ⚠️ Observation-required |

**To unblock:**
- <missing>: add a test asserting <specific behavior>
- <observation-required>: add a Playwright/E2E assertion on <element> that is executed by CI, or post an unprefixed operator comment confirming manual verification
```

Wait ~300 seconds after posting a verdict (give executor time to push a fix).

## Scheduling note

This generic adapter has no native scheduling. Between cycles:
- Wait ~120s after NONE or MERGE_CONFLICT
- Wait ~300s after posting a verdict

QA runs before reviewer in the agent sequencing — see `spec/SPEC.md`.
