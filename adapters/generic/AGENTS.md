# Agent loop — generic adapter template

Copy the block below into your project's AGENTS.md to adopt agent-loop with any AI tool.

---

## Agent loop

repo: owner/repo
in-progress-label: in-progress
quality-gates: npm test && npm run lint

### Executor

Implement issues and address review findings. Read the executor prompt in
`adapters/generic/executor.md` from the agent-loop repo, or paste it here directly.

Entry points:
- No args: pick next open issue without `in-progress` label
- Issue number: implement that issue
- PR number: orient on existing PR and enter polling loop

### Reviewer

Monitor open PRs and post code-quality findings. Read the reviewer prompt in
`adapters/generic/reviewer.md` from the agent-loop repo, or paste it here directly.

The reviewer should be run in a separate session. It polls continuously (operator
re-triggers each cycle, or schedule via external cron).

### QA

Evaluate whether acceptance criteria are met before merge. Read the QA prompt in
`adapters/generic/qa.md` from the agent-loop repo, or paste it here directly.

The QA agent should be run in a separate session. It runs before the reviewer in the
agent sequencing — see `spec/SPEC.md` for the full flow.

### Scheduling note

This generic adapter has no native scheduling. Between poll cycles:
- Executor: wait ~60 seconds before next `pr-poll.mjs` call (use sleep or manual re-trigger)
- Reviewer: wait ~120s after NONE or MERGE_CONFLICT, ~300s after posting findings
- QA: wait ~120s after NONE or MERGE_CONFLICT, ~300s after posting a verdict

### Protocol reference

Signal types, prefix convention, state machine, merge policy: `spec/SPEC.md` in the
agent-loop repo.
