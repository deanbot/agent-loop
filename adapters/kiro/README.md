# agent-loop — Kiro adapter (stub)

Status: **not implemented**

## What's needed

- Kiro skill/rule format research
- Scheduling model (Kiro equivalent of ScheduleWakeup, or external cron approach)
- Executor and reviewer prompts adapted for Kiro idioms
- Install mechanism

## Known unknowns

- Does Kiro have a native plugin or skill format?
- Does Kiro have a loop/scheduling primitive?
- Does Kiro read AGENTS.md? (If yes, the generic adapter works as a fallback today.)

## Contribution

If you know Kiro's skill format, implement the adapter contract from `spec/SPEC.md` and open a PR.
