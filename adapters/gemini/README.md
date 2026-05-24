# agent-loop — Gemini CLI adapter (stub)

Status: **not implemented**

## What's needed

- Gemini CLI extension format research
- Scheduling model for the reviewer loop
- Executor and reviewer prompts adapted for Gemini idioms
- Install mechanism (likely `gemini extensions install`)

## Known unknowns

- Gemini CLI extension schema
- Whether Gemini has a loop/scheduling primitive equivalent to ScheduleWakeup
- Does Gemini read AGENTS.md? (If yes, the generic adapter works as a fallback today.)

## Contribution

If you know the Gemini CLI extension format, implement the adapter contract from `spec/SPEC.md` and open a PR.
