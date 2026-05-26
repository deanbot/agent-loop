# Kiro adapter

## Context

Kiro is a JetBrains AI coding tool used in enterprise environments where Claude Code is unavailable. It likely reads AGENTS.md (making the generic adapter a functional fallback today) but may have a native skill or plugin format that enables better integration — particularly for loop scheduling, which the generic adapter leaves to external cron or manual re-trigger.

## Unknowns to resolve first

- Does Kiro have a native skill/plugin/rule format?
- Does Kiro have a loop or scheduling primitive (equivalent to Claude Code's ScheduleWakeup)?
- Does Kiro read AGENTS.md natively?

## Deliverable (once unknowns resolved)

- [x] Research Kiro's skill/plugin/rule format
- [x] Create `adapters/kiro/` with full executor and reviewer prompts in Kiro's idiom
- [ ] Implement scheduling using Kiro's native mechanism (or document cron fallback if none exists)
- [ ] Add install instructions to `adapters/kiro/README.md`
- [ ] Update root `README.md` adoption table

## Acceptance criteria

- Kiro adapter implements the full adapter contract from `spec/SPEC.md`
- Loop invariant (wait between polls) is implemented using Kiro's native mechanism or clearly documented as a manual step
- Generic adapter is no longer the only fallback for Kiro users
