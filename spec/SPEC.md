# agent-loop Protocol Specification

Version: 0.1 (single-account mode)

This spec defines the protocol that makes adapters interoperable. An adapter that correctly implements this spec will work with any other adapter on the same PR thread.

---

## Roles

**Operator** — human product owner. Unprefixed comments. Final authority on merge.

**Executor** — AI agent that implements issues and addresses review findings. Posts `[executor]` prefixed comments.

**Reviewer** — AI agent that monitors PRs and posts findings. Posts `[reviewer]` prefixed comments.

All three communicate through GitHub PR comment threads.

---

## Comment prefix convention

| Prefix | Sender | Purpose |
|---|---|---|
| *(none)* | Operator | Direction, questions, approval |
| `[executor]` | Executor agent | Fix summaries, questions, blocked notices |
| `[reviewer]` | Reviewer agent | Findings, LGTM, conflict notices |

**Never** use a bracket prefix in operator comments — agents treat prefixed comments as bot traffic and may ignore them.

Scripts filter `[reviewer]` comments when checking for new activity (prevents ping-pong loops). All other prefixed comments are treated as meaningful signals.

---

## Reviewer signals (`pr-watch.mjs`)

Script runs once, emits one line, exits. Persists state between runs.

| Signal | Meaning |
|---|---|
| `NONE <timestamp>` | No PRs changed since last run |
| `REVIEW:<n>` | PR #n has new commits and is mergeable |
| `MERGE_CONFLICT:<n>` | PR #n has new commits but branch conflicts with base |
| `REVIEW_COMMENTS:<n>` | PR #n has new non-reviewer comments since last check |

Multiple signals space-separated on one line. `REVIEW:<n>` takes precedence over `REVIEW_COMMENTS:<n>` for the same PR — `REVIEW` subsumes comments (reviewer reads thread during review anyway).

**On first encounter of a PR** with `CHANGES_REQUESTED` review status: signal is suppressed (PR already has a blocking review; wait for new commits).

**Comment cursor:** advanced when SHA changes (reviewer reads thread during REVIEW) and when REVIEW_COMMENTS is emitted. This prevents pre-REVIEW comments from re-firing as REVIEW_COMMENTS on the next cycle.

### Reviewer handling per signal

- `MERGE_CONFLICT:<n>` — post `[reviewer] Merge conflicts — rebase on main before review.` Do not review diff.
- `REVIEW:<n>` — fetch diff AND comment thread in parallel. Read thread first: filter out findings already answered by `[executor]` comments since the last `[reviewer]` post. Review only unanswered scope. Post findings as `[reviewer] <findings>`, or `[reviewer] LGTM` if clean.
- `REVIEW_COMMENTS:<n>` — read thread. Ignore `[reviewer]` own posts. Assess whether `[executor]` responses satisfy open findings. Post LGTM, follow-up, or new findings as appropriate.

---

## Executor signals (`pr-poll.mjs`)

Script runs once per poll cycle for a specific PR, emits signals, exits.

| Signal | Meaning |
|---|---|
| `NONE <timestamp>` | No new activity since last poll |
| `NEW_COMMENT` | New PR-level discussion comment(s) |
| `NEW_REVIEW_SUBMISSION` | New formal review (state: APPROVED / CHANGES_REQUESTED / COMMENTED) |
| `NEW_INLINE_COMMENT` | New line-level diff comment(s) |
| `MERGE_READY` | `[reviewer] LGTM` comment present + all CI checks passed or no checks |
| `MERGED` | PR is merged |

Content blocks follow signal lines, indented two spaces to prevent keyword confusion.

### Executor handling per signal

- `MERGED` — remove `in-progress` label from issue, notify operator, pick next work
- `MERGE_READY` — notify operator; continue polling until MERGED or operator confirms merge
- `NEW_REVIEW_SUBMISSION` with `CHANGES_REQUESTED` — read full thread, collect ALL unaddressed `[reviewer]` findings, address every one in a single code pass, push once, post one `[executor] Pushed fix: <summary>`. Never post partial fix comments mid-batch.
- `NEW_REVIEW_SUBMISSION` with `COMMENTED` — answer questions via `[executor]` comment
- `NEW_INLINE_COMMENT` or `NEW_COMMENT` — skip own `[executor]` posts; treat `[reviewer]` comments as CHANGES_REQUESTED (batch, fix all, push once); treat operator (unprefixed) as direction or questions
- `NONE` — wait, then poll again

**Loop invariant:** every path through signal handling ends with a wait before the next poll. No exceptions except MERGED and BLOCKED exits. Scheduling mechanism is adapter-specific.

### Executor question / blocked protocol

- **Question**: post `[executor] Question: <question>`, continue polling. If 10 consecutive NONE signals pass with no unprefixed operator reply: post `[executor] BLOCKED: no response — moving on`, remove `in-progress` label, pick next work.
- **Blocked**: post `[executor] BLOCKED: <reason>`, remove `in-progress` label, pick next work. Operator resumes by responding on GitHub thread and re-running the executor command with the PR number.

---

## Merge policy (single-account mode)

GitHub blocks self-approval when reviewer and executor share one account. Formal `APPROVED` review is not achievable.

**MERGE_READY threshold:**
1. At least one `[reviewer] LGTM` PR comment
2. No failing or pending CI checks (or no checks)

`pr-poll.mjs` emits `MERGE_READY` when both conditions are met. The executor notifies the operator. **Merge requires explicit operator confirmation** — it is never automatic.

### Multi-account upgrade path

With a second GitHub account for the reviewer: `MERGE_READY` can additionally require a formal `APPROVED` review submission from the reviewer account. Change `pr-poll.mjs` to check `reviewDecision === 'APPROVED'` alongside the LGTM comment check.

---

## Collision avoidance

Reviewer and executor post to the same thread concurrently. Two failure modes:

**Reviewer re-raises answered findings.** Executor answers a finding between reviewer poll cycles. Reviewer's next REVIEW sees the same diff and re-raises it without reading the new answer.

Mitigation: reviewer always fetches `gh pr view <n> --comments` alongside diff on REVIEW. Filters findings already answered by `[executor]` comments since the last `[reviewer]` post.

**Executor tight-poll loop.** Executor calls poll script back-to-back with no wait, burning context and blocking incoming messages.

Mitigation: loop invariant (every iteration ends with a wait). See adapter-specific scheduling.

---

## State persistence

Scripts persist state between runs to prevent replaying historical signals.

| Script | Default state path |
|---|---|
| `pr-watch.mjs` | `~/.agent-loop/state/<owner>-<repo>-pr-state.json` |
| `pr-poll.mjs` | `~/.agent-loop/state/<owner>-<repo>-pr-poll-state.json` |

Per-repo paths prevent collisions when running agent-loop on multiple repos simultaneously.

State is safe to delete — next run re-seeds cursors and treats all current activity as baseline.

---

## In-progress label

Executors claim issues with an `in-progress` label to prevent two executors from picking the same issue. Label must exist before first use:

```bash
gh label create in-progress --color "0075ca" --description "Executor claimed" --repo owner/repo
```

Executors add the label on issue claim, remove it on MERGED or BLOCKED.

---

## Spec versioning

This is version 0.1 — single-account mode only. Breaking changes to signal format or prefix convention increment the version. Adapters should note which spec version they implement.
