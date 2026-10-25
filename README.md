# agent-loop

A tool-agnostic agentic development loop. One operator. One GitHub account. Two AI agents by
default — an **executor** that takes issues to PRs, and a **reviewer** that verifies acceptance
criteria and reviews the code — communicating through a GitHub PR comment protocol. A third,
optional **QA** agent separates the acceptance-criteria pass from the code review for projects
that want it.

## What this is

Standard GitHub PR review requires multiple accounts (GitHub blocks self-approval). agent-loop
works around this with a comment-prefix protocol: `[executor]`, `[reviewer]` and `[qa]` prefixes
let agents coordinate on the same PR thread without formal review signals. The operator merges;
agents never do.

This is a **solo developer / single-account** workflow. Not a replacement for team code review.

## Security

**Do not run this on a public repo.**

The executor reads GitHub issue and PR content and feeds it to an LLM running with your
credentials — GitHub token, API keys, everything in your shell environment. Any untrusted user
who can get their text in front of the executor can attempt prompt injection: instruct the LLM to
post env vars as a PR comment, write secrets to a file, or take other unintended actions. On a
public repo, anyone can comment on an open PR, and the executor treats unprefixed comments as
operator direction.

### Trusted author check

Before processing any issue, the executor checks the author against your configured allowlist.

**`trusted-authors` (recommended)** — exact GitHub login allowlist. Only named users' issues are
processed.

```markdown
## Agent loop
repo: owner/repo
trusted-authors: [your-login]
```

**`allow-author-associations`** — fallback when `trusted-authors` is not set. Filters by GitHub's
`authorAssociation` field. Default: `[OWNER, MEMBER, COLLABORATOR]`. Values: `OWNER`, `MEMBER`,
`COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`.

**These checks are not a complete defense.** A trusted author can quote attacker-controlled text
(error messages, bug repros) containing injection payloads. The only complete protection is a
private repo with trusted collaborators.

### What agents post

The agents post a lot of prose on your behalf: PR bodies, comments, issues, commit messages. A
rule in your `AGENTS.md` against posting details about your machine, your accounts or what you
told the agent holds most of the time, not every time, and a post is hard to take back.
[second-read](https://github.com/deanbot/second-read) is the guard for this: git hooks and a `gh`
shim, or an adapter for your agent tool, that check each post before it goes out. agent-loop only
checks for it: `/agent-loop:setup` installs second-read's git hooks when second-read is installed
(setting `core.hooksPath` switches them off), and warns about each guard that's missing. The loop's
posts keep short, fixed shapes, so there is less to check.

### Sandboxed sessions

A sandbox can let named commands out (in Claude Code, `sandbox.excludedCommands`), and `gh` needs
the network. The skills run `gh` and `git push|fetch|pull` as commands on their own, with `--repo
owner/repo` instead of `cd … && gh …`, so an entry for them matches. These scripts call `gh`, so
exempt them the same way: `scripts/pick-next.mjs`, `scripts/pr-poll.mjs`, `scripts/pr-watch.mjs`,
`scripts/pr-qa.mjs` (through `scripts/lib/wait.mjs`) and `adapters/claude-code/setup-project.sh`.
`scripts/pull.mjs` runs `git pull`, so it needs the same exemption: without it every loop pull
fails, and the loop says so in a `⚠` line each time.

---

## What this is not

- Not a team review tool — no formal `APPROVED` / `CHANGES_REQUESTED` review signals
- Not Claude-specific — the core protocol works with any agent that can run bash and read AGENTS.md
- Not GitHub-specific by design, though current scripts target the GitHub API

## How it works

Three scripts emit signals. Agents handle signals and post prefixed comments. Loop.

```
pr-poll.mjs   (executor)  →  NEW_COMMENT, NEW_INLINE_COMMENT, NEW_REVIEW_SUBMISSION, CI_FAILING, MERGE_CONFLICT, MERGE_READY, MERGED, NONE
pr-watch.mjs  (reviewer)  →  REVIEW:<n>, REVIEW_COMMENTS:<n>, MERGE_CONFLICT:<n>, CLOSED:<n>, NONE
pr-qa.mjs     (QA)        →  QA_READY:<n>, MERGE_CONFLICT:<n>, CLOSED:<n>, NONE
```

A fourth, `pick-next.mjs`, chooses the executor's next issue (`RESUME:<n> PR:<p>` for a PR it
parked and the operator unblocked, `ISSUE:<n>`, `WAIT:<blocker> PR:<n|none>`, `MOVE_ON
<milestone>`, `NONE`), so a pick always starts from a fresh listing. A
fifth, `session.mjs`, keeps one loop session per clone: the newest start wins, and an old session
left running stops. `pull.mjs` is every pull of `main` in a loop: it names the rules files the
pull changed, so a running loop reads their diff. `local-ci.mjs` is no agent's: a local CI
runner for a project with a `gate` (below).

`MERGE_READY` = `[reviewer] LGTM` after the last commit + CI green + no conflict with `main` (+
`[qa] PASS` with `qa-gate: on`). A project that can turn CI off names a `gate` command: on a PR
with no CI, the reviewer runs it on the head and quotes its last line in the LGTM, and
`MERGE_READY` needs that quote. The operator merges. A PR that falls into conflict after its
LGTM (another PR merged) gets `MERGE_CONFLICT` instead, and the executor resolves it. With no
executor polling it, the reviewer's watch reports the conflict on a PR labelled `needs-operator`,
and the reviewer takes the label off and says so on the PR.

Each script runs once and exits. With `--wait` it becomes a waiter that polls in place and exits once
a run would have news, so an agent can sleep until something happens instead of polling on a timer.

Full protocol: [`spec/SPEC.md`](spec/SPEC.md). Contract tests: `node scripts/test/run.mjs`.

## Two roles or three?

The reviewer verifies acceptance criteria *and* reviews code: it names the test that proves each
criterion (and checks CI runs it), and backs every finding with evidence it produced. That is the
default and what most projects need. `qa-gate: on` adds a QA agent that does the acceptance pass
first and separately, and makes the reviewer and the merge threshold wait for its `[qa] PASS`. Use
it when you want an adversarial second reader on acceptance criteria and can afford a third
session and a longer comment thread per PR.

## Adoption

### Path A — Claude Code plugin (first-class)

```bash
claude plugin marketplace add agent-loop deanbot/agent-loop
claude plugin install agent-loop@agent-loop
```

Add to your project's `AGENTS.md` (all keys in `spec/SPEC.md`):

```markdown
## Agent loop
repo: owner/repo
in-progress-label: in-progress
blocked-label: is-blocked
quality-gates: npm test && npm run lint
qa-gate: off
trusted-authors: [your-login]
models: executor=opus, reviewer=opus/high
```

`models` is optional: each loop's first line on every start names its model and effort, and a
second `⚠` line says so when they differ from that role's entry here (a role without an entry
gets no `⚠` line). It never stops a loop. `gate: <command>` is optional too, for a project that
can turn CI off: on a PR with no CI, the executor runs it before each push and the reviewer on the
head before an LGTM (spec: `gate`).
**Local CI.** With a `gate`, you can run it once per head instead, outside the agents. Give it a
clone of its own (no setup, no role) and leave this running in a terminal or as a login item:

```bash
node <plugin root>/scripts/local-ci.mjs --repo owner/repo --gate "<your gate>" --wait
```

It runs the gate on each open PR from a `trusted-authors` login (never a fork), oldest first, one
at a time, and posts the result as a commit status named `local-ci`. `gh pr checks` lists it, so
the PR has CI: the agents skip the gate, `MERGE_READY` waits for it, and a failure reaches the
executor as `CI_FAILING`. Logs go to `~/.agent-loop/local-ci/`. While it is down, new heads get no
status and the reviewer's quoted run is the merge signal as before (spec: "Local CI runner").

Make one clone per role (for example `proj`, `proj-exec`, `proj-review`) and run
`/agent-loop:setup <operator|executor|reviewer|qa>` inside each. A clone can live anywhere (next to
your checkout or in a separate tree such as `~/agents/<owner>/<clone>`); its folder name is how
claims and reviewer state name it, so keep that name unique per repo and don't rename a clone
while it holds a claim. It creates the labels, ignores
`.agent-loop/` and `.claude/settings.local.json`, writes the clone's role marker (which makes the
plugin's hook refuse `gh pr merge` and pushes to `main` there), and adds the role's permission
rules. Needs `gh` 2.43+ and Node 18+.

Run, one session per clone: `/agent-loop:start-executor [issue-or-PR]`,
`/agent-loop:start-reviewer`, and with `qa-gate: on` `/agent-loop:start-qa`. Say `stop` to end a
loop. Your inbox is one label: `gh pr list --label needs-operator` shows every PR waiting on you,
either a question (a standalone comment ending in "Reply with:") or a PR reviewed and green.
Anything you check by hand is listed in the LGTM under "Before you merge"; you confirm by a
comment or by merging. Add `--inbox <folder> --outbox <folder>` to a start (both outside the
clone) to give that loop a mailbox: direction arrives as message files, and replies go out the
same way (spec: "Inbox folder").
Details: [`adapters/claude-code/README.md`](adapters/claude-code/README.md).

> **Updating:** `claude plugin update agent-loop@agent-loop`, then restart loop sessions. A
> restart is a new session in the clone, not `/clear`; after each merge the executor prints the
> exact restart line, its start arguments included. Rules merged into `AGENTS.md` (or a file the
> block lists under `rules:`) need no restart: every loop pull shows the loop their diff.

### Path B — Generic (any tool)

Copy the template from [`adapters/generic/AGENTS.md`](adapters/generic/AGENTS.md) into your
project's `AGENTS.md`. Copy `scripts/` into your repo. Any agent that reads AGENTS.md and can run
bash follows the prompts in `adapters/generic/`. Loop scheduling is manual or external cron.

### Path C — Kiro

```bash
cp -r adapters/kiro/skills/. .kiro/skills/
```

Add the `## Agent loop` block, copy `scripts/`, create the labels. Scheduling is manual re-trigger
or external cron. See [`adapters/kiro/README.md`](adapters/kiro/README.md).

## Structure

```
scripts/              Tool-agnostic Node.js — the signal sources, and their contract tests
spec/                 Protocol definition — the contract between adapters
.claude-plugin/       Claude Code plugin + marketplace manifests (plugin root = repo root)
adapters/
  claude-code/        First-class: skills, event-driven loops, merge-guard hook, setup
  generic/            AGENTS.md template and prompts, no scheduling assumptions
  kiro/               SKILL.md format, manual/cron scheduling
  gemini/             Stub
```

## Multi-tool design

Adapters own everything tool-specific — full prompts, install mechanism, scheduling model, stop
mechanism. The core (scripts + spec) has no tool assumptions. Adding a new tool means adding an
adapter; nothing in core changes.

See [`AGENTS.md`](AGENTS.md) for architecture principles and the adapter contract.

## Contributing

Issues, pull requests, running the tests and reporting a security problem:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
