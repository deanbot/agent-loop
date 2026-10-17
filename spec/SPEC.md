# agent-loop Protocol Specification

Version: 0.2 (single-account mode; QA optional)

This spec defines the protocol that makes adapters interoperable. An adapter that correctly
implements this spec will work with any other adapter on the same PR thread.

Changes from 0.1: the QA role is optional (`qa-gate`), the reviewer verifies acceptance criteria
when QA is off, the executor receives `CI_FAILING`, every script filters its own prefix, a role's
verdict is its newest comment (a later finding revokes an earlier approval), CI is gated in one
place (the executor's poll), and the stop mechanism is adapter-specific.

---

## Roles

**Operator** — human product owner. Unprefixed comments. Final authority on merge; the only one
who merges.

**Executor** — AI agent that implements issues and addresses findings. Posts `[executor]`.

**Reviewer** — AI agent that monitors PRs, verifies acceptance criteria against evidence, reviews
code with evidence it produced, and posts findings or `LGTM`. Posts `[reviewer]`.

**QA** (optional) — AI agent that maps each acceptance criterion to evidence CI ran and posts
`PASS` or `BLOCKED`. Posts `[qa]`. Adversarial by design. Enabled per project with `qa-gate: on`;
without it the reviewer performs this pass itself.

All roles communicate through GitHub PR comment threads. Each role runs in its own clone of the
repository so branches, dependencies, local state and stop requests never collide.

---

## Project configuration

A project adopts agent-loop with a `## Agent loop` block in its `AGENTS.md`. Lines are
`key: value`. Agents read the whole `AGENTS.md`; the block is the loop's configuration, the rest
is the project's conventions, which the agents follow.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `repo` | yes | — | `owner/repo` |
| `in-progress-label` | no | `in-progress` | label an executor adds when it claims an issue |
| `blocked-label` | no | `is-blocked` | label that parks an issue; the operator removes it to resume |
| `quality-gates` | no | — | command that must pass before a PR is opened or a fix is pushed |
| `gate` | no | — | the command that stands in for CI when a PR has none (no checks reported, or every check skipped), for a project that can turn CI off: the executor runs it before each push and the reviewer on the head before an LGTM, each quoting its last line, and `MERGE_READY` then requires the reviewer's quote (Merge policy). It may be the same command as `quality-gates` |
| `qa-gate` | no | `off` | `on` runs the QA role: reviewer waits for `[qa] PASS`, `MERGE_READY` requires it |
| `needs-operator-label` | no | `needs-operator` | label on a PR (or issue) while it waits on the operator: an open question, or `MERGE_READY` |
| `trusted-authors` | recommended | — | GitHub logins whose issues the executor may process |
| `allow-author-associations` | no | `[OWNER, MEMBER, COLLABORATOR]` | fallback author filter when `trusted-authors` is absent |
| `models` | no | — | expected model per role, `role=model[/effort]` comma-separated (`executor=opus, reviewer=opus/high`); every start prints the role, model and effort first; a role with an entry that differs says so on a second line and runs anyway, and a role without an entry prints nothing more |
| `reviewers` | no | `1` | how many reviewer loops run; above 1 they claim PRs ("Claim comments") and keep state per reviewer. Raise it only once every executor runs a `pr-poll.mjs` that ignores claim comments |

Every start of a loop, including one that resumes held work, prints its role, model and effort
(`Reviewer · Opus 5.5 · high`) before anything else, where the tool exposes them, so a loop that
came up on another session's saved default is seen at once. A `⚠` line follows only when `models`
has an entry for that role and it differs.

Labels must exist before first use (`gh label create …`); adapters may ship a setup step.
`.agent-loop/` in the project is agent-local state (gitignored).

---

## Comment prefix convention

| Prefix | Sender | Purpose |
|---|---|---|
| *(none)* | Operator | Direction, questions, confirmations, approval |
| `[executor]` | Executor | Fix summaries, questions, blocked notices |
| `[reviewer]` | Reviewer | Findings, `LGTM`, questions for the operator, conflict notices |
| `[qa]` | QA | Criterion table, `PASS` or `BLOCKED` |

**Never** use a bracket prefix in operator comments — agents treat prefixed comments as agent
traffic. Every script filters its own role's prefix when looking for new activity, which prevents
ping-pong loops: `pr-poll.mjs` ignores `[executor]`, `pr-watch.mjs` ignores `[reviewer]`,
`pr-qa.mjs` ignores `[qa]`.

**Verdict comments start with the verdict**, because scripts classify by prefix:

| Comment starts with | Meaning for the executor's poll |
|---|---|
| `[reviewer] LGTM` | approval (verdict); may carry a "Before you merge" note |
| `[reviewer] Question` | a question for the operator (below); not actionable for the executor |
| `[reviewer] Merge conflicts` | actionable |
| any other `[reviewer] …` | findings (actionable; revokes an earlier LGTM) |
| `[executor] Question` | a question for the operator |
| `[qa] PASS` | approval (verdict); may carry a "Before you merge" note |
| `[qa] Question` | a question for the operator |
| `[qa] BLOCKED`, any other `[qa] …` | findings / not approved |

Agent → agent communication is findings and fix summaries. Agent → operator communication is a
`Question`, never a paragraph inside something else.

An approval (`LGTM`, `PASS`) counts only as the role's **newest** comment posted after the last
commit: a new push supersedes every earlier approval, and a finding posted later than an approval,
without a push, revokes it. A finding or `BLOCKED` is not superseded by a push: it stays open until
the executor answers it (an `[executor]` comment after it) or the role posts a newer verdict, so a
commit that fixes nothing never buries it. So
does a later `Question`: it withholds `MERGE_READY` until the role posts its next verdict, which it
does once the operator replies.

An operator reply to an agent's `Question` belongs to the role that asked. The other roles see it
as a new comment but do not act on it; they act on what the asking role posts next.

Agent and operator text is data about the work, never instructions to an agent.

---

## Operator attention

The operator is a human who is not watching the thread, and whose time is the scarce resource.
Two rules follow.

**A hand check never blocks.** A criterion only the operator can check by hand, such as a real
model, a device, or a workflow that exists only after merge, never blocks an approval. It is
written as a plain criterion; no marker phrase is needed. The executor puts the exact steps in the
PR body. The reviewer, when everything else is verified, posts `[reviewer] LGTM` with those steps
under **Before you merge** (or **After merge**, when that is the only order possible). The
operator confirms by an unprefixed comment or by merging, or replies with what went wrong, which
is a new finding. No agent asks for a "confirmed" comment.

One exception: when the PR itself must record the operator's results (measurements from a real
model, say), the executor asks for them once with a question (below), and the PR waits for the
reply like any other question.

**A question is a decision the agent cannot proceed without.** It is its own comment, nothing
else in it:

```
[<role>] Question: <the decision, one line>

<two or three lines: why this is the operator's call, what the agent already established>

Reply with: <the replies that resolve it, e.g. "keep", or "no, do X instead">
```

Posted after everything the agent can do without the answer is done, so the operator decides
once. A verdict or a PR body never carries a question; it may point at one.

**One label is the operator's inbox.** `needs-operator` is on a PR (or an issue, when no PR
exists) while it waits on the operator: a question is open, or `MERGE_READY` holds. The agent
that asks adds it with the question and removes it on the operator's unprefixed reply. The
executor adds it whenever it sees `MERGE_READY`, and removes it when it pushes, unless a question
is still open. `pr-poll` reports `MERGE_READY` on every run while it holds, so a label removed with
an answered question comes back on the executor's next poll (an event-driven executor polls when
the asking role posts its next verdict), or with the reviewer's next LGTM (below). `gh pr list
--label needs-operator` shows everything waiting on the operator.

**The reviewer labels a ready PR with its LGTM**, whoever owns it. An executor the operator
stopped polls nothing (its issue keeps `in-progress-label`), and a PR the operator or a monitor
opened, or one whose executor parked it, has no executor; neither gets `MERGE_READY` from a poll.
So with every LGTM the reviewer checks the `MERGE_READY` threshold itself (its LGTM on the head
commit, CI green, `[qa] PASS` after the last commit when `qa-gate: on`, no unanswered inline
thread, no conflict with the base; with `gate` and no CI, its LGTM quoting the gate on the head in
place of CI) and adds the label when it holds; adding it twice does nothing. A passing gate puts
the label on right after the LGTM, since there is no CI to wait for. With CI still pending the
executor's poll remains the path, and the LGTM says in one line that a stopped or absent executor
leaves the PR unlabelled until the operator merges it. When the reviewer later posts findings on a
labelled PR, it removes the label unless a question is still open. The executor still removes the
label when it pushes, and adds it when CI turns green after the LGTM.

**The agent's own terminal** says the same in its status line, and an adapter with a notification
primitive sends one when a question is posted.

---

## Agent sequencing

`qa-gate: off` (default, two roles):

```
Executor opens PR  →  Reviewer verifies A.C. + reviews code  →  [reviewer] LGTM
                          ↑ findings / fixes loop ↓
                                                           →  MERGE_READY → operator merges
```

`qa-gate: on` (three roles):

```
Executor opens PR  →  QA evaluates A.C.  → [qa] PASS  →  Reviewer reviews code  →  [reviewer] LGTM
                                                                                  →  MERGE_READY → operator merges
```

Every verdict is tied to a commit: a new push supersedes earlier `LGTM` and `PASS`, and the
agents re-evaluate after every push.

---

## Reviewer signals (`pr-watch.mjs`)

Script runs once, emits one line, exits. Persists state between runs. (`--wait` turns it into a
waiter: see "Waiting for events" below.)

| Signal | Meaning |
|---|---|
| `NONE <timestamp>` | No PRs changed since last run |
| `REVIEW:<n>` | PR #n has new commits (or no `[reviewer]` post yet) and is mergeable |
| `MERGE_CONFLICT:<n>` | PR #n has new commits but conflicts with base; or (standing) it carries `needs-operator-label` and conflicts with base, whatever its head, repeated every run while both hold |
| `REVIEW_COMMENTS:<n>` | PR #n has new non-reviewer comments (timeline or inline) since last check |
| `CLOSED:<n>` | PR #n, which the script was tracking, is no longer open (merged or closed); emitted once |

Multiple signals space-separated on one line. `REVIEW:<n>` subsumes `REVIEW_COMMENTS:<n>` for the
same PR. On first encounter of a PR with a `CHANGES_REQUESTED` formal review the signal is
suppressed. Comment cursors advance when the SHA changes and when `REVIEW_COMMENTS` is emitted.
An `[executor]` comment older than the reviewer's newest `[reviewer]` post counts as already
read, even when it landed after the last run: the reviewer re-reads the thread and the inline
threads immediately before every post (below). Inline comments compare by time; one at the same
second as the post is news. Operator and `[qa]` comments stay news whenever unseen, so one that
lands between that re-read and the post is still reported.

### Reviewer handling per signal

- `CLOSED:<n>` — the operator merged or closed the PR; nothing to post. Say so in the status line
  and forget the PR, whatever was outstanding on it.
- `MERGE_CONFLICT:<n>` — no review. On a PR carrying `needs-operator-label` (it was ready and the
  base moved under it), remove the label unless a question is still open, and post once
  `[reviewer] Merge conflicts — PR #<n> now conflicts with main, so it is not ready to merge; …`
  for whoever owns it, saying whether the label is off or stays on for an open question.
  `pr-watch` reports this standing conflict whether or not an executor holds the PR (it takes
  `--needs-operator-label <name>`, default `needs-operator`): with no executor nobody runs
  `pr-poll` on it, and an executor that polls sees the conflict as well. With no label and a head
  new since the reviewer's last post (new commits on a conflicting branch), post `[reviewer] Merge
  conflicts — rebase on main before review.`; with no label on a head it already posted on (the
  executor took the label off meanwhile), post nothing. An LGTM on a PR found `CONFLICTING` skips
  the label and posts the "whoever owns it" line, so a PR with no executor is not left silent.
- `REVIEW:<n>` — with `qa-gate: on`, require a `[qa] PASS` newer than the head commit first; none
  → post nothing. Then the full review: gather the PR, its linked issue, the whole thread and the
  inline threads, CI state and the diff; **verify each acceptance criterion** (a named test that CI
  runs, or exact hand-check steps in the PR body; the executor's table is a pointer, not proof);
  verify code findings with evidence the reviewer produced (probes, adversarial inputs); post one
  comment: numbered findings, or `[reviewer] LGTM` (with a "Before you merge" note for anything
  only the operator can check by hand), or a standalone `[reviewer] Question` when a decision is
  needed first. The reviewer does not wait for CI: nothing re-triggers it when a check finishes,
  and the executor's poll gates `MERGE_READY` on CI. A red check caused by the PR is a
  finding; a pending check is noted in the LGTM line. With `gate` set and no CI on the PR, the
  reviewer runs the gate on the head (a clean checkout of it) before an LGTM: a failure is a
  finding, and a pass goes into the LGTM as the line `Gate on <short sha>: <the gate's last
  line>`.
- `REVIEW_COMMENTS:<n>` — read the thread. A `[qa] PASS` with no `[reviewer]` post since the head
  commit → full review. Only `[qa] BLOCKED` with no executor response → post nothing. Otherwise
  follow up on the executor's or operator's replies: `LGTM`, a further finding, or a clarification,
  and only if it says something new.
- Immediately before posting, re-read the thread and confirm the head has not moved.
- The reviewer does not relay CI status or echo operator comments; the executor receives both
  directly.

`[reviewer] LGTM` means: every criterion that a test can prove has one, and no findings. Criteria
the operator checks by hand are listed in the LGTM under "Before you merge" with their steps; the
operator confirms by a comment or by merging. It is the reviewer's newest comment until a new push,
a later finding or a later question.

---

## QA signals (`pr-qa.mjs`) — only with `qa-gate: on`

| Signal | Meaning |
|---|---|
| `NONE <timestamp>` | No PRs changed since last run |
| `QA_READY:<n>` | PR #n has new commits or a new operator comment; needs evaluation |
| `MERGE_CONFLICT:<n>` | PR #n has new commits but conflicts with base |
| `CLOSED:<n>` | PR #n, which the script was tracking, is no longer open; emitted once |

### QA handling per signal

- `CLOSED:<n>` — nothing to post; note it and forget the PR.
- `MERGE_CONFLICT:<n>` — post `[qa] Merge conflicts — rebase on main before QA.`
- `QA_READY:<n>` — gather the PR body, diff, thread, the linked issue (from **this** PR's body)
  and project conventions; synthesize criteria; map each to a test that CI runs (evidence is the
  test's existence in the gate's scope, not the colour of the current run — QA does not wait for or
  block on CI, since nothing would re-trigger it when a check finishes) or an operator
  confirmation; post one verdict:

```
[qa] PASS                                   [qa] BLOCKED

| Criterion | Evidence | Status |            | Criterion | Evidence | Status |
|---|---|---|                               |---|---|---|
| <c> | <test file::test> | ✅ |            | <c> | none found | ❌ Missing |
| <c> | by hand, before merge: <steps> | ☑ |

**Before you merge:** <steps>                **To unblock:** …
```

No criteria found → `[qa] BLOCKED: no acceptance criteria found …`. Never pass silently.
A criterion the operator checks by hand never blocks: it is listed in the PASS under "Before you
merge" with its steps, and the operator confirms by a comment or by merging.

---

## Executor signals (`pr-poll.mjs`)

Script runs once per poll cycle for one PR, emits signals and content blocks, exits. Usage:
`pr-poll.mjs --repo owner/repo --pr <n> [--require-qa] [--require-gate]`. Adapters pass
`--require-qa` when `qa-gate: on`, and `--require-gate` when the block has `gate`.

| Signal | Meaning |
|---|---|
| `NONE <timestamp>` | No new activity |
| `NEW_COMMENT` | New PR-level comment(s), not the executor's own |
| `NEW_REVIEW_SUBMISSION` | New formal review (APPROVED / CHANGES_REQUESTED / COMMENTED) |
| `NEW_INLINE_COMMENT` | New or still-unanswered line-level comment(s), not the executor's own |
| `CI_FAILING` | A check failed or was cancelled on the current head; emitted once per distinct failure set (a re-run that fails again is reported again) |
| `MERGE_CONFLICT` | the PR conflicts with its base (GitHub reports it unmergeable); repeated on every run while it holds, whether or not the head moved |
| `MERGE_READY` | the reviewer's newest comment after the head commit is an LGTM, CI green, no unanswered inline threads, not in conflict (and QA's newest is a PASS with `--require-qa`; and with `--require-gate` and no CI, the LGTM quotes the gate on the head) |
| `MERGED` | PR is merged |

Content blocks follow signal lines, indented two spaces. `CI_FAILING` blocks carry the check name,
state and link. Live negative verdicts (`[qa] BLOCKED` or a `[reviewer]` finding with no
`[executor]` comment and no newer verdict from its role after it, however many commits followed)
are re-surfaced as `NEW_COMMENT` every poll until the executor responds, so a verdict posted before
the executor's first poll is never lost, even when a commit that fixes nothing lands in between.
`[reviewer] Question …` is not a finding and is not re-surfaced. If the CI checks cannot be read
(auth, network, an old `gh`), `MERGE_READY` is withheld and the error is passed through on
stderr; "no checks reported" counts as no CI. Scripts page through the API (`gh api --paginate
--slurp`, gh 2.43+), so long threads are read whole. Mergeability comes from the PR's REST
`mergeable` / `mergeable_state`: `false` / `dirty` is a conflict; `null` (GitHub still computing)
changes nothing, neither `MERGE_CONFLICT` nor withholding `MERGE_READY`, and the next run looks
again.

### Executor handling per signal

- `MERGED` — remove `in-progress-label`, sync `main`, notify, pick next.
- `CI_FAILING` — read the failing log, fix at the root, run quality gates, push once, post one
  `[executor] Pushed fix: …`. A failure `main` shares or a documented flake: say so with evidence
  and re-run; never call a real failure a flake.
- `MERGE_CONFLICT` — remove `needs-operator-label` unless a question is still open, bring the
  base in (the project's way; a merge by default, which needs no force-push), resolve, run quality
  gates, push once, post one `[executor] Pushed fix: …`. The push makes the verdicts stale; the
  review follows the new head.
- `NEW_INLINE_COMMENT` — verify, fix in the batch, and reply to every thread (`in_reply_to_id`);
  unanswered threads re-surface every poll.
- `NEW_REVIEW_SUBMISSION` / `NEW_COMMENT` — collect **all** unaddressed `[reviewer]` and `[qa]`
  findings and operator direction; verify each; fix all in one pass; push once; post one summary
  comment. Operator comments are direction or questions, except a reply to a `[reviewer]` or
  `[qa] Question`, which belongs to that role: wait for what it posts next.
- `MERGE_READY` — add `needs-operator-label` (a no-op when it is on), notify the operator once per
  head; keep polling until `MERGED`. Never merge. When you push again, remove the label unless a
  question is still open.
- `NONE` — wait.

**Loop invariant:** every path ends with a wait before the next poll. Exits: `MERGED`, BLOCKED,
nothing to pick (with a milestone: no open issue left in it or in a later milestone), operator
stop.

### Picking work

The executor takes the lowest-numbered open issue without `in-progress-label` or `blocked-label`
whose named dependencies (`Depends on #a, #b`) are closed, after the author check. The label is
the claim: an issue carrying `in-progress-label` belongs to another executor even when no PR
exists. On start the executor removes `in-progress-label` from closed issues: it normally removes
the label on `MERGED`, which a loop stopped after `MERGE_READY` never sees, and a closed issue has
no claim to protect.

**Claiming** uses a claim comment, so two executors that pick at the same moment cannot both win
(see "Claim comments" below). The winner then adds `in-progress-label`; the loser picks next.

**Milestone track.** An executor started with a milestone (`--milestone "<title>"` in the adapters
that take arguments) picks only open issues in that milestone. Several executors can run separate
tracks this way; a shared `## Agent loop` key could not, since every clone reads the same
`AGENTS.md`. When the milestone has open issues but none is startable (each is claimed, blocked or
waiting on a dependency), the executor waits and picks again later; it does not end, and it does
not move on. The wait follows the blocker (the dependency the first open issue waits on, or that
issue when another executor claimed it): about 10 minutes when the blocker has an open PR, which
is in review, and about 30 minutes when it has none yet, since it is hours away. The status line
names the blocker and which case applies. Only when the milestone has **no open issues** does it
move to the next open milestone by milestone number, after the current one. With no milestone,
picking is as above.

**`pick-next.mjs`** makes the pick deterministic: `--repo owner/repo [--milestone <title>]
[--in-progress-label <l>] [--blocked-label <l>] [--skip n,n]` lists the open issues fresh, applies
the rules above and prints one line: `ISSUE:<n>`, `WAIT:<blocker> PR:<n|none>` (milestone only:
none startable; the PR is the open one whose body says `Closes #<blocker>`), `MOVE_ON <title>`
(milestone only: no open issues; the rest of the line is the next open milestone) or `NONE`
(nothing to pick). `--skip` names issues the executor turned down this session (author check,
lost claim; `none` is an empty list). A milestone whose only open issues are skipped is not empty:
the pick is `WAIT` on the lowest of them, so an executor that lost a claim keeps its track until
the winner's issue merges. Dependencies are the `#n` list right after "Depends on" (`#a, #b`,
`#a, #b, and #c`, `**Depends on:** #a`, `_Depends on_ #a`). Adapters run it for every pick, a wake after a wait included, so an issue filed while
the executor waited is never missed by reasoning from a list it remembers. A failed `gh` call
exits 2 with one `pick-next: …` line on stderr and nothing on stdout; the executor retries later
and never picks by hand. A dependency's state is read from the REST issues endpoint, so a merged
PR named as a dependency counts as closed.

### Claim comments

A role that must own an item alone (an executor and its issue) claims it with a comment, not a
label alone: two agents can both read "no label" and both add it.

1. Post the claim comment, `[<role>] <claim text naming the clone>`, and note its id. The clone is
   the working directory's base name (`loom-exec`, `loom-exec2`).
2. List the item's claim comments and keep the **live** ones (a per-role rule, below).
3. The live claim with the lowest comment id wins. Comment ids only grow, so every agent agrees.
4. The winner sets the role's durable marker, if any. A loser deletes its own claim comment and
   moves on, and never touches the marker: a label is not per agent, so a loser removing it would
   strip the winner's claim.

Executor: `[executor] Claimed by <clone>` on the issue; the marker is `in-progress-label`. A claim
is live when it was posted no more than 10 minutes before the executor's own (GitHub's
`created_at` on both, never the local clock). An older claim that still holds already carries the
label, which the executor checks first; an older one that does not is from a claim since released
(merged, parked, stopped) or a claimer that crashed before labelling.

Reviewer (only with `reviewers` above 1): `[reviewer] Reviewing (<clone>)` on the PR, posted
before the first work that ends in a post on it; there is no separate marker, the claim persists.
Every reviewer posts as one account, so a post cannot be traced to a clone, and liveness comes from
the PR's activity. Walk the claims in id order: the first holds; a later claim by another clone
takes over only if the holder was **stale** at that moment, and a takeover is permanent (later
posts by the new holder never revive the old claim). A holder is stale when no non-claim
`[reviewer]` comment has appeared for 30 minutes since the later of the head commit and its claim.
A holder that is stale now holds nothing: the PR is open to the next claim. `pr-watch.mjs
--reviewer <clone>` computes this (and `--check-claim <n>` prints `MINE`, `THEIRS <clone>` or
`OPEN`), reports only PRs the reviewer holds or nobody holds, and drops another's PR from its state
without a `CLOSED`. The holder handles rechecks and follow-ups, so findings and rechecks come from
one voice. Claim comments are never a review: `pr-poll.mjs` and `pr-watch.mjs` ignore them. Commit
times are when a commit was made, not pushed, so a late push of old commits can make a working
holder look stale; the cost is a second reviewer taking over.

### Executor question / blocked protocol

A posted question is a **stop**: either a safe default exists (take it, record the assumption in
the PR body, do not ask) or it does not (ask, and stop on that channel). Channel by phase: PR
exists → PR comment; no PR yet → issue comment. Never an interactive prompt. The question has the
shape and the label of "Operator attention" above.

Every block parks the issue: remove `in-progress-label`, add `blocked-label`, post `[executor]
BLOCKED: <reason>. To resume: remove the label and re-run on <PR or issue>.`, pick next. A question
in the poll loop with no unprefixed reply for about 10 minutes parks the same way (ten one-minute
polls, or a cycle with no news after a `--wait --max 600` waiter).
Resume: the operator removes `blocked-label` and re-runs the executor on the PR or issue; the
executor removes any lingering `blocked-label` on resume.

---

## Waiting for events (`--wait`)

All three scripts take `--wait [secs]` (poll interval, default 30) and `--max <secs>` (default
1500), which turn the script into a **waiter**. Without `--wait` nothing changes.

A waiter never writes state. Every interval it evaluates what a one-shot run would print; as soon
as that is news it prints `PENDING` and exits 0, and the agent then runs the script one-shot, once,
as in every other cycle. When `--max` passes first it prints `NONE <timestamp>` and exits 0. The
signal format and the state contract are unchanged, and nothing is lost if the agent dies between
the waiter's exit and its next run.

- **News** is a non-`NONE` output that either would change the script's state (an event to
  consume: a comment, a commit, a CI failure, a close) or differs from the **baseline**, what the
  script reports while nothing happens. Each one-shot run records the baseline next to its state.
  Standing signals (`MERGE_READY`, a re-surfaced live verdict or unanswered inline thread,
  `REVIEW:<n>` for a PR with no reviewer post) are in the baseline, so they wake the agent when
  they appear or change, not on every poll.
- **One waiter per state file** (so per PR for `pr-poll`). A second waiter while the first is alive
  prints `WATCHER_RUNNING <pid>` and exits 3. A stopped waiter prints nothing.
- A failed poll (network, rate limit, auth) is reported on stderr and retried on the next
  interval.

Adapters whose harness wakes the agent when a background process exits start a waiter at the end
of each cycle and keep a timer only as a fallback. Adapters driven by cron or by hand keep
one-shot runs, or chain the two:

```
node pr-watch.mjs --repo R --wait && node pr-watch.mjs --repo R
```

---

## Merge policy (single-account mode)

GitHub blocks self-approval; formal `APPROVED` is not achievable. `MERGE_READY` is emitted when:

1. the reviewer's newest comment after the last commit is `[reviewer] LGTM`
2. with `qa-gate: on`: QA's newest comment after the last commit is `[qa] PASS`
3. no unanswered top-level inline comments
4. no failing, cancelled, pending or unreadable CI checks (no checks at all is fine)
5. the PR does not conflict with its base (not yet computed counts as no conflict)
6. with `gate` (`--require-gate`) and no CI (no checks reported, or every check `skipping`): the
   LGTM of item 1 has a line `Gate on <sha>: …` whose `<sha>` (7 or more hex digits) starts the
   head commit's sha. With CI checks present, CI is the gate and no quote is needed

A "Before you merge" note in the LGTM or PASS does not hold `MERGE_READY` back: it tells the
operator what to run before clicking merge.

**Merging is the operator's action, never an agent's.** Adapters add a structural guard where the
tool allows (see each adapter's README); the guard is a safety net behind the prompt rule, not a
security boundary.

### Multi-account upgrade path

With a second account for the reviewer, `MERGE_READY` can additionally require
`reviewDecision === 'APPROVED'`. Not implemented in any adapter.

---

## Stopping a loop

Stop is adapter-specific. An adapter whose tool has a cancel primitive for scheduled work uses
it; an adapter driven by external re-triggers may use a sentinel file under `.agent-loop/`. Either
way: the operator says "stop", the agent unclaims an issue it was still implementing (a PR is its
own claim), and no further poll runs. See each adapter's README for its mechanism.

---

## Collision avoidance

**Reviewer re-raises answered findings.** Mitigation: the reviewer reads the whole thread
alongside the diff and raises only unanswered scope; it re-reads immediately before posting and
drops the comment if the head moved. Because of that re-read, an `[executor]` comment older than
the reviewer's own newest post is not reported again (`pr-watch.mjs`).

**Executor tight-poll loop.** Mitigation: the loop invariant (a wait after every cycle); a
waiter's baseline keeps standing signals from waking the agent on every poll.

**Two executors on one issue.** Mitigation: the `in-progress-label` claim, re-fetched immediately
before claiming; the label is authoritative. Two executors that pick at the same moment both see
no label, so the claim itself is a claim comment, earliest live one wins ("Claim comments").

**Roles in one checkout.** Mitigation: one clone per role (`.agent-loop/role` marks it); agents
refuse to run in a clone marked for another role. A clone may live anywhere; its folder's base
name is the `<clone>` in claims and per-reviewer state, so it must be unique per repo and stable
(renaming a clone that holds a claim orphans the claim).

**Two sessions in one clone.** A loop restarted in a fresh session while the old one still runs
(left in the background, say) signs claims as the same clone, and the two move the checkout
under each other. Mitigation: `scripts/session.mjs`, where the adapter has a session id. A start
(`--start <id>`) takes the clone, and the **newest start wins**: a file cannot tell whether the
session it names is alive, and a restart after a closed terminal must not be refused. Claims
belong to the clone, so the new session carries them on. The old session is recorded as
superseded; its next wake (`--beat <id>` → `SUPERSEDED <id>`) stops it, without unclaiming or
posting, and an adapter with a pre-tool hook refuses its commands at once. A stop releases the
clone (`--release <id>`). The file is `.agent-loop/session`: `{ "owner": { "id", "at" } | null,
"superseded": [ids, newest last, at most 20] }`. A session the file never named, such as the
operator looking around in the clone, is not affected.

---

## State persistence

| Script | Default state path |
|---|---|
| `pr-watch.mjs` | `~/.agent-loop/state/<owner>-<repo>-pr-state.json`; with `--reviewer <clone>`, `<owner>-<repo>-pr-state-<clone>.json` |
| `pr-poll.mjs` | `~/.agent-loop/state/<owner>-<repo>-pr-poll-<pr>.json` (one per PR) |
| `pr-qa.mjs` | `~/.agent-loop/state/<owner>-<repo>-pr-qa-state.json` |

Per-repo paths prevent collisions when running agent-loop on several repos, and per-PR paths for
`pr-poll` let two executors run on one repo without writing the same file. A PR with no `pr-poll`
file yet takes its entry from the shared `<owner>-<repo>-pr-poll-state.json` that 0.2 scripts
before per-PR files kept; that file is only read, never written. Once every executor runs a
version with per-PR files, delete the shared file: while it exists, deleting a PR's file restores
that PR's old cursors instead of re-seeding. Next to each state file,
`<state>-wait.json` holds the baseline a one-shot run records for waiters and `<state>-wait.lock`
the running waiter's pid. `.agent-loop/session` in the clone (`session.mjs`, "Two sessions in one
clone") is the one piece of script state kept in the clone rather than under `~/.agent-loop/`. State is safe to delete: the next run
re-seeds cursors and treats current activity as baseline (live verdicts and unanswered inline
threads are still surfaced).

---

## Spec versioning

0.2 — QA optional, `CI_FAILING`, `CLOSED`, own-prefix filtering everywhere, newest-comment
verdicts, CI gated in the executor's poll only, adapter-specific stop. Later in 0.2, with no
change to signal format: the `Question` kind, the `needs-operator-label` key, hand checks that
never block, the retired `[reviewer] Verified` kind (tolerated by `pr-poll`), and `--wait` waiters
(their own output, `PENDING` / `NONE` / `WATCHER_RUNNING <pid>`, never a signal line). Later in
0.2, additive (a new signal, no change to existing signal lines): `pr-poll`'s `MERGE_CONFLICT`
(and `MERGE_READY` now also requires no conflict), and `pr-watch`'s standing `MERGE_CONFLICT:<n>`
on a labelled PR (the existing signal line, on a new occasion). A reviewer prompt that predates
the standing case handles it the old way, posting "rebase on main" every cycle while the label
stays on, so the reviewer restarts with the script that emits it. Breaking changes to signal
format or prefix convention increment the version. Adapters note which version they implement.
`scripts/test/run.mjs` holds the contract tests for the scripts. `pick-next.mjs` (later in 0.2) is
a helper, not a signal source: its output is the executor's pick, not a signal line. Later in 0.2,
additive: the `gate` key and `pr-poll --require-gate` (`MERGE_READY` on a PR with no CI needs the
reviewer's gate quote; without the flag nothing changes), and `session.mjs`, a helper like
`pick-next.mjs`.
