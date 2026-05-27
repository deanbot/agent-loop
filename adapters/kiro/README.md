# agent-loop — Kiro adapter

Status: **implemented** (spec v0.1, single-account mode)

Kiro is an AI-powered IDE from Amazon. It reads AGENTS.md natively and supports
[SKILL.md](https://kiro.dev/docs/skills/) files for reusable agent instructions.

## What's included

- `skills/start-executor/SKILL.md` — executor prompt in Kiro's skill format
- `skills/start-reviewer/SKILL.md` — reviewer prompt in Kiro's skill format

## What's different from Claude Code

**No native scheduling.** Kiro's automation primitives (Agent Hooks) are event-driven —
they fire on file save/create/delete or manual trigger, not on a time interval. There is
no equivalent to Claude Code's `ScheduleWakeup`.

**Loop management is manual or cron-based.** After each poll cycle, wait the specified
delay then re-invoke the skill. Two options:

### Option A — Manual re-trigger (simplest)

Run the executor or reviewer skill in Kiro chat. After it handles signals and reports
waiting, wait the appropriate interval and re-run the skill with the PR or issue number:

```
# In Kiro chat
/start-executor 42        # polls once, reports signal
# wait 60 seconds
/start-executor 42        # polls again
```

### Option B — External cron (signal logging)

Use a cron job to run `node scripts/pr-poll.mjs` on a schedule and log its output.
The script emits signals (e.g. `NEW_COMMENT`, `MERGE_READY`) but does not handle them —
signal handling still requires an LLM session. Use this to keep a signal log you can
inspect, or to trigger a Kiro chat session manually when signals appear.

```bash
# crontab -e
* * * * * cd /path/to/repo && node scripts/pr-poll.mjs --repo owner/repo --pr 42 >> ~/.agent-loop/executor.log 2>&1
```

For fully autonomous operation, re-invoke the Kiro skill in a new chat session each
cycle (Option A, scripted via Kiro's CLI if available).

## Install

1. Copy `skills/` into your project's `.kiro/skills/` directory:

   ```bash
   cp -r adapters/kiro/skills/. .kiro/skills/
   ```

   Or install globally (`~/.kiro/skills/`) to use across all projects.

2. Ensure `gh` CLI and `node` are available in your shell.

3. Add the `## Agent loop` config block to your project's AGENTS.md:

   ```markdown
   ## Agent loop
   repo: owner/repo
   in-progress-label: in-progress
   quality-gates: npm test && npm run lint
   ```

4. Create the `in-progress` label (one-time):

   ```bash
   gh label create in-progress --color "0075ca" --description "Executor claimed" --repo owner/repo
   ```

5. Copy `scripts/` from this repo into your project:

   ```bash
   cp -r scripts/ /path/to/your/project/scripts/
   ```

## Usage

In Kiro chat, invoke the skills:

```
/start-executor          # pick next open issue
/start-executor 7        # implement issue #7
/start-executor 42       # resume PR #42

/start-reviewer          # review all open PRs
/start-reviewer --skip 5,8   # skip PRs 5 and 8
```

After each cycle, re-invoke with the PR number to continue polling.

## Adapter contract compliance

| Requirement | Status |
|---|---|
| All executor signals from `pr-poll.mjs` implemented | ✅ |
| All reviewer signals from `pr-watch.mjs` implemented | ✅ |
| Prefix convention (`[executor]`, `[reviewer]`) | ✅ |
| Loop invariant (wait between polls) | ✅ — manual or cron |
| MERGE_READY threshold (LGTM + CI passing) | ✅ |
| Spec version | v0.1 |

## Known limitations

- No native loop scheduling — requires manual re-trigger or external cron
- Kiro's CLI re-trigger mechanism (if any) is not yet documented; the above cron approach
  runs the scripts directly outside the IDE
