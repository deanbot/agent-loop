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

Follow the QA prompt in `adapters/generic/qa.md` from the agent-loop repo.

One cycle = one invocation. Between cycles: wait ~120s (NONE/MERGE_CONFLICT) or ~300s (after verdict).
