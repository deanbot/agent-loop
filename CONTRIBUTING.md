# Contributing to agent-loop

## Running the tests

The contract tests need Node.js and git, nothing else: no build step, no `node_modules`.

```bash
node scripts/test/run.mjs
```

They run every script against a fake `gh`, so they need no GitHub access. CI runs them on every
pull request that changes more than Markdown, on Node 22 and 24.

## Trying a plugin change without installing it

In a scratch git repository, load the plugin from your checkout:

```bash
claude --plugin-dir /path/to/agent-loop -p "/agent-loop:start-reviewer"
```

With no `## Agent loop` block in that repository's `AGENTS.md`, the skill should refuse to start.
`claude plugin validate .`, from the root of your checkout, checks the manifests.

[`AGENTS.md`](AGENTS.md) is the architecture record and holds the rules for changes here (Workflow,
Commit policy).

## Issues and pull requests

- **Issues are welcome**, bugs and ideas alike. Use the issue template: Context, What "done" looks
  like, Notes / Open questions.
- **Pull requests are read.** Code from outside contributors runs only in CI, after a maintainer
  approves the run. A change may be merged as it is, or redone on a maintainer's branch with credit
  in that PR.
- **Security problems are reported privately**, through "Report a vulnerability" on this
  repository's Security tab, not in an issue or a pull request.
