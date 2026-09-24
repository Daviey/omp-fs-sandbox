# /goal — autonomous task loop

A slash command that turns omp into a self-driving worker: `/goal` starts a
loop that keeps scanning the goal file for open tasks and working them,
until nothing is left or you stop it.

## Usage

```
/goal          start the loop (scans TASKS.md, GOAL.md, or TODO.md in cwd)
/goal stop     halt the loop (agent finishes its current turn, then stops)
```

Goal file format — checkbox tasks, top-first:

```markdown
# Project goal
- [ ] implement the parser module
- [ ] write tests for the parser
- [x] set up the skeleton        (done — skipped)
Notes and context are ignored; only "- [ ]" / "- [x]" lines count.
```

## Loop contract

1. `/goal` reads the first open task and kicks the agent with a standing
   instruction: do the top task, mark `- [x]`, find the next, repeat.
2. After every agent turn, the loop hook checks the goal file:
   - open tasks remain → re-arm the agent with the next top task
   - none remain → "all tasks complete", loop exits
3. Stop conditions (all built in):
   - `/goal stop` — manual halt
   - goal file deleted → stop
   - `OMP_GOAL_MAX` iterations (default 50) — hard burn cap
   - `OMP_GOAL_STALLED` (default 3) consecutive turns with no checkbox
     movement — stops on a blocked/unachievable task instead of spinning

## Config

| Env var          | Default | Meaning                                   |
|------------------|---------|-------------------------------------------|
| `OMP_GOAL`       | —       | `0` disables the hook entirely            |
| `OMP_GOAL_MAX`   | `50`    | hard cap on loop iterations per session   |
| `OMP_GOAL_STALLED` | `3`   | no-progress turns before auto-stop        |

## Design notes

- **File is the state.** TASKS.md/GOAL.md is durable; edit it live and the
  loop picks up changes on the next turn. The conversation is disposable —
  compaction or /handoff mid-loop is safe.
- **In-process.** Unlike a shell while-loop, this drives the same session:
  one TUI, full context accumulation, Ctrl-C stops everything.
- **Not a jail bypass.** The loop only reads the goal file and injects
  messages; filesystem policy (fs-sandbox/omp-box) applies to the agent
  exactly as before.
- **Scope-seeking**: the prompt tells the agent to keep looking for work in
  the goal file — write new `- [ ]` lines into it (by hand or by asking the
  agent) and the loop keeps going. Deleting the file is the kill switch.

## Install

Ships in the same plugin as fs-sandbox (hooks/pre/goal-loop.ts). After
`omp plugin install github:Daviey/omp-fs-sandbox` or a local link, `/goal`
is available in every interactive session.
