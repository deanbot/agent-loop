---
name: start-qa
description: >
  Agentic QA loop. Monitors open PRs for new commits, evaluates acceptance criteria
  from the linked issue and project conventions, posts [qa] PASS or [qa] BLOCKED.
  Reads repo from the project's AGENTS.md "## Agent loop" section.
license: MIT
category: productivity
complexity: intermediate
---

> **Stub.** Kiro has no native scheduling primitive. QA loop management is manual re-trigger
> or external cron. Full QA prompt: `adapters/generic/qa.md` in the agent-loop repo.
> Copy it here and adapt when Kiro's scheduling model is understood.

**First line you print, on every start** (including one that stops at a check), before any other output: `QA · <model> · <effort>`, as far as you know them, so a loop that came up on the wrong model is seen at once. If the `## Agent loop` block has `models:` (comma-separated `role=model[/effort]`, e.g. `models: executor=opus, reviewer=opus/high`) with a `qa` entry, and that entry differs from this session (its model word is not in your model's name, or it names an effort and yours differs), add `⚠ AGENTS.md expects <entry> for the qa; this session runs <model>.` and carry on: a mismatch never stops the loop. No `models:`, no `qa` entry, or an entry that matches → print nothing more.

**Prerequisite:** the project's `## Agent loop` block has `qa-gate: on`; otherwise stop — the project runs without the QA gate and the reviewer does this pass.

Follow the QA prompt in `adapters/generic/qa.md` from the agent-loop repo, including its one-plain-command-per-shell-call rule: read files with Kiro's file-read and search tools, never chain commands, and stay inside the checkout, or the loop stops on an approval nobody is there to give.

One cycle = one invocation. Between cycles: wait ~60s after `[qa] BLOCKED` or a question, ~300s after `[qa] PASS`, ~120s otherwise.
