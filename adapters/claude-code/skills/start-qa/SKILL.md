---
name: start-qa
description: >
  Agentic QA loop. Monitors open PRs for new commits, evaluates acceptance criteria
  from the linked issue and project conventions, posts [qa] PASS or [qa] BLOCKED with
  a per-criterion evidence checklist. Runs independently of the reviewer loop.
  Reads repo from the project's AGENTS.md "## Agent loop" section.
---

> **Single-account mode.** One GitHub account runs executor, reviewer, and QA. QA posts
> `[qa]` prefixed comments only. Never posts `[reviewer]` or `[executor]` comments.

> **Adversarial by design.** QA's job is to find what's missing, not validate what's there.
> It does not share the reviewer's incentive to finish. A passing test suite is not
> sufficient evidence unless the test asserts the specific criterion.

**Prerequisite check — do this first, before any other step:** Read `AGENTS.md` in the current working directory and verify a `## Agent loop` section exists. If not found, stop immediately — do not proceed. Tell the user:
> This project has no `## Agent loop` config in AGENTS.md. Add one before running start-qa. See `adapters/generic/AGENTS.md` in the agent-loop repo for the config template.

Read the project's AGENTS.md `## Agent loop` section first. Extract:
- `repo` — the GitHub repo (owner/repo)

$ARGUMENTS may be `--skip <n,n,...>` to ignore specific PR numbers.

Derive `<slug>` from `repo` by replacing `/` with `-` (e.g. `deanbot/agent-loop` → `deanbot-agent-loop`). Sentinel path: `.agent-loop/<slug>-qa-stop` (project-local; gitignored).

**Stop-sentinel check — run before calling pr-qa.mjs or ScheduleWakeup:**

Run as two separate bash commands (never combined into one multi-line block):

1. `find .agent-loop -maxdepth 1 -name '<slug>-qa-stop' -mmin -10 -type f 2>/dev/null`
   — non-empty: FRESH sentinel (written within last 10 minutes)
2. `find .agent-loop -maxdepth 1 -name '<slug>-qa-stop' -type f 2>/dev/null`
   — non-empty: STALE sentinel (file older than 10 min); empty: NO sentinel

If FRESH: `rm .agent-loop/<slug>-qa-stop` — notify "QA loop stopped (sentinel cleared)." — exit without ScheduleWakeup or running pr-qa.mjs.

If STALE: `rm .agent-loop/<slug>-qa-stop` — proceed normally (leftover from a prior session).

If NO sentinel: proceed normally.

**Operator stop request:**

If the operator sends a message containing "stop" at any point during the loop:
1. `mkdir -p .agent-loop && touch .agent-loop/<slug>-qa-stop`
2. Notify: "Stop sentinel written. QA loop will exit on next wakeup if it fires within 10 minutes."
3. Exit without calling ScheduleWakeup.

Run `node ~/.claude/plugins/marketplaces/agent-loop/scripts/pr-qa.mjs --repo <repo> $ARGUMENTS` and handle each signal.

`QA_READY` fires on two triggers: new commits (SHA change) and new operator (unprefixed) comments. The second trigger handles the case where an operator posts a manual-verification confirmation without a code push — QA re-evaluates to pick up the confirmation.

**After handling any signal (including NONE), call ScheduleWakeup before the next pr-qa.mjs call — 300s after posting a verdict (give executor time to push a fix), 120s after MERGE_CONFLICT or NONE.**

## Signal handling

- **MERGE_CONFLICT:<n>**: post `gh pr comment <n> --body "[qa] Merge conflicts — rebase on main before QA."` ScheduleWakeup(120s).

- **QA_READY:<n>**: check CI first (Step 0 below), then gather context, evaluate A.C., post verdict. ScheduleWakeup depends on CI result (see Step 0).

- **NONE**: no actionable signals. ScheduleWakeup(120s).

## QA_READY evaluation

**Step 0 — CI gate:**

```bash
CHECKS=$(gh pr checks <n> --repo <repo> --json name,state,bucket 2>/dev/null)
```

If the command fails or returns empty / `[]`: no CI configured — skip to Step 1.

Otherwise parse:

```bash
PENDING=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "pending")] | length')
FAILING=$(echo "$CHECKS" | jq '[.[] | select(.bucket == "fail")] | length')
```

- If `PENDING > 0`: post `[qa] Waiting: CI still running — <N> check(s) pending. Will re-evaluate when checks complete.` ScheduleWakeup(120s). **Stop — do not proceed to Step 1.**
- If `FAILING > 0`: extract failing names (`jq -r '[.[] | select(.bucket == "fail") | .name] | join(", ")'`) and post `[qa] BLOCKED: CI failing — <names>. Fix CI before A.C. evaluation.` ScheduleWakeup(120s). **Stop — do not proceed to Step 1.**
- Otherwise (all pass or skipping): proceed to Step 1. ScheduleWakeup(300s) after posting verdict.

**Step 1 — gather context in parallel:**

```bash
gh pr view <n> --repo <repo> --json body,title,number   # PR description + checklist
gh pr diff <n> --repo <repo>                            # full diff
gh pr view <n> --comments --repo <repo>                 # comment thread
gh issue view <issue-n> --repo <repo>                   # linked issue (extract from PR body: Closes #<N>)
```

Also read project convention files locally (if they exist): `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/CONTRIBUTING.md`. These may define testing expectations, required patterns, or quality standards that count as acceptance criteria even if not stated in the issue.

**Step 2 — extract linked issue number:**

Parse PR body for `Closes #<N>` (case-insensitive). If no linked issue found: post `[qa] BLOCKED: PR body does not reference a linked issue (expected "Closes #N"). Cannot evaluate A.C. without issue context.` ScheduleWakeup(300s).

**Step 3 — synthesize requirements:**

Read everything gathered — issue body (especially any "What done looks like", "Acceptance criteria", or "Done when" section), PR description checklist, and project convention files. Do not anchor to a specific header format. Use LLM judgment: given all available context, what must be true for this PR to be considered done?

Produce a list of requirements. Each requirement is one verifiable claim. If a project convention file says "all new features must have tests", that is a requirement. If the issue says "items are visible in the UI", that is a requirement.

**Step 4 — classify each requirement:**

- **Code-verifiable**: a test in the diff or existing test suite asserts this directly.
- **Observation-verifiable**: only a human or browser can confirm (UI visibility, rendering, end-to-end flow without automation).

**Step 5 — map each requirement to evidence:**

**Core rule: a test cited as evidence must be executed by a verified gate (CI or explicit operator run).** A test file that exists in the diff but is never run by the CI quality gate is not evidence — it is a dead test.

For each requirement, search the diff for:
- New test files or test additions that assert the criterion
- Code changes that directly implement the criterion
- Explicit "human tested" note in PR description or comments from the operator

**Dead-test check — apply before accepting any test file as evidence:**
1. Identify the CI quality gate command: read `.github/workflows/*.yml` and `package.json` → `scripts.test`. E.g., `npm test` → `vitest`.
2. Identify that runner's file scope: check `vitest.config.*` include/exclude globs; for Playwright check `playwright.config.*` `testDir`.
3. Confirm the cited test file falls inside the gate's scope. If the file is a Playwright spec but CI only runs Vitest, or vice versa: **the test is not executed — do not count it as evidence.** Mark the criterion ❌ with note: "test exists (`<file>`) but not executed by CI gate (`<command>`). Not verified evidence."

For observation-verifiable items: check whether there is a Playwright/Cypress/E2E assertion on the specific element or behavior — **and** verify that E2E suite is actually executed by CI or an explicit documented operator run. A Playwright test that CI never runs is not evidence even for observation-verifiable criteria.

**Step 6 — post verdict:**

If no requirements found: post `[qa] BLOCKED: no acceptance criteria found in issue body, PR description, or project convention files. Add "What done looks like" criteria to the issue before merging.` Do not pass silently.

If all requirements have evidence: post:

```
[qa] PASS

| Criterion | Evidence | Status |
|---|---|---|
| <criterion> | <test file:line or diff hunk> | ✅ |
```

If any requirement lacks evidence: post:

```
[qa] BLOCKED

| Criterion | Evidence | Status |
|---|---|---|
| <verified criterion> | <test file:line or diff hunk> | ✅ |
| <missing criterion> | none found | ❌ Missing |
| <ui criterion> | no E2E assertion on <element> | ⚠️ Observation-required |

**To unblock:**
- <missing>: add a test that asserts <specific behavior>
- <observation-required>: add a Playwright assertion on <element> **that is executed by CI**, or post an unprefixed operator comment confirming manual verification
```

**Observation-required items block merge** the same as missing items. Post `[qa] PASS` only when every criterion has code-verifiable evidence OR an explicit unprefixed operator comment confirming manual verification.

**Before posting verdict:** re-fetch `gh pr view <n> --comments --repo <repo>` to check for operator comments that arrived during evaluation. If an operator (unprefixed) comment explicitly confirms a specific criterion as manually verified, treat that criterion as satisfied.

**No interactive prompts.** Never ask questions interactively. Post questions as `gh pr comment <n> --body "[qa] Question: <question>"` and continue polling.
