# Agent loop — generic adapter template

Copy the block below into your project's AGENTS.md to adopt agent-loop with any AI tool.

---

## Agent loop

repo: owner/repo
in-progress-label: in-progress
blocked-label: is-blocked
quality-gates: npm test && npm run lint
qa-gate: off
trusted-authors: [your-login]

### Executor

Implements issues and addresses findings. Prompt: `adapters/generic/executor.md` in the
agent-loop repo (read it, or paste it here). Entry points: no args (pick the next open issue
whose dependencies are closed), an issue number, or a PR number (resume polling).

### Reviewer

Verifies each PR against its issue's acceptance criteria and reviews the code; posts
`[reviewer]` findings or `LGTM`. Prompt: `adapters/generic/reviewer.md`. Runs in its own clone
and session; the operator re-triggers each cycle or schedules it with cron.

### QA (optional, `qa-gate: on`)

Maps acceptance criteria to evidence CI ran and posts `[qa] PASS` or `BLOCKED` before the
reviewer looks at code. Prompt: `adapters/generic/qa.md`. Its own clone and session.

### Scheduling

No native scheduling here. Between cycles: executor ~60s; reviewer and QA ~120s after `NONE` or
`MERGE_CONFLICT`, ~300s after posting. Stop a loop by writing `.agent-loop/<role>-stop` in its
clone; each cycle checks for that file first and exits when it exists.

### Protocol reference

Signal types, prefix convention, merge policy: `spec/SPEC.md` in the agent-loop repo.
