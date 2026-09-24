// /goal — autonomous task-pursuit loop for omp.
//
// Usage:
//   /goal              — scan cwd for open tasks (TASKS.md / GOAL.md / TODO.md),
//                        work the top one, then keep scanning until nothing
//                        open remains. /goal stop halts the loop.
//
// Mechanics: /goal kicks the first turn with a standing instruction; a
// turn_end listener re-arms the loop whenever the agent goes idle with work
// still open — an in-process "while true: continue". Stop conditions, all
// checked every iteration:
//   - /goal stop                 (user command; sets in-memory flag)
//   - no open tasks found        (goal complete — loop exits cleanly)
//   - consecutive-no-progress cap (default 3 idles with no checkbox change;
//     prevents infinite spinning on an unachievable task)
//   - OMP_GOAL_MAX total iterations (default 50; hard burn cap)
//   - goal file deleted          (treats as "no goal" — loop exits)
//
// The loop is file-state-driven: TASKS.md/GOAL.md is the durable state, the
// conversation is disposable. No new session is forced (compaction handles
// long runs); a /handoff or resume resets counters naturally.

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const GOAL_FILES = ["TASKS.md", "GOAL.md", "TODO.md"] as const;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_STALLED = 3;

interface GoalState {
  running: boolean;
  iterations: number;
  stalledScans: number;
  lastSnapshot: string; // mtime+top-task at last scan — detects "no progress"
}

const state: GoalState = {
  running: false,
  iterations: 0,
  stalledScans: 0,
  lastSnapshot: "",
};

function goalFile(cwd: string): string | null {
  for (const name of GOAL_FILES) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function openTasks(path: string): string[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const tasks: string[] = [];
    for (const line of lines) {
      const m = /^\s*[-*]\s*\[ \]\s*(.+)/.exec(line);
      if (m) tasks.push(m[1].trim());
    }
    return tasks;
  } catch {
    return [];
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function goalLoop(pi: HookAPI): void {
  if (process.env.OMP_GOAL === "0") return;
  const maxIterations = envInt("OMP_GOAL_MAX", DEFAULT_MAX_ITERATIONS);
  const maxStalled = envInt("OMP_GOAL_STALLED", DEFAULT_MAX_STALLED);

  pi.registerCommand("goal", {
    description: "Start/stop the autonomous task loop (scans TASKS.md/GOAL.md/TODO.md)",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "stop" || sub === "off") {
        state.running = false;
        ctx.ui.notify("goal loop: stopped", "info");
        return;
      }
      if (state.running) {
        ctx.ui.notify("goal loop already running — /goal stop to halt it", "info");
        return;
      }

      const file = goalFile(ctx.cwd);
      if (!file) {
        ctx.ui.notify(
          `goal loop: no TASKS.md / GOAL.md / TODO.md in ${ctx.cwd} — create one with "- [ ] task" lines, then /goal again`,
          "error",
        );
        return;
      }

      const tasks = openTasks(file);
      if (tasks.length === 0) {
        ctx.ui.notify("goal loop: goal file has no open tasks — nothing to do", "info");
        return;
      }

      state.running = true;
      state.iterations = 0;
      state.stalledScans = 0;
      state.lastSnapshot = "";

      ctx.ui.notify(
        `goal loop: armed — ${tasks.length} open task(s) in ${file.split("/").pop()}. /goal stop to halt.`,
        "info",
      );

      // Kick the first turn with the standing instruction.
      pi.sendMessage(
        {
          customType: "goal-loop",
          content:
            `goal loop START — work autonomously through the open tasks in ${file}.\n` +
            `Top open task: ${tasks[0]}\n` +
            `Rules: do the top open task; mark it "- [x]" in the file when done; ` +
            `then look for the next open task and continue. When no open tasks remain, reply exactly NO_OPEN_TASKS and stop.`,
          display: true,
          attribution: "agent",
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!state.running) return;
    try {
      const file = goalFile(ctx.cwd);
      if (!file) {
        state.running = false;
        ctx.ui.notify("goal loop: goal file gone — stopping", "info");
        return;
      }

      const tasks = openTasks(file);
      if (tasks.length === 0) {
        state.running = false;
        ctx.ui.notify("goal loop: all tasks complete — stopping", "info");
        return;
      }

      state.iterations += 1;
      if (state.iterations >= maxIterations) {
        state.running = false;
        ctx.ui.notify(
          `goal loop: iteration cap reached (${maxIterations}) — stopping. Raise OMP_GOAL_MAX to go further.`,
          "info",
        );
        return;
      }

      // Stall detection: file unchanged since last turn means no checkbox moved.
      const snapshot = `${statSync(file).mtimeMs}:${tasks[0]}`;
      if (snapshot === state.lastSnapshot) {
        state.stalledScans += 1;
        if (state.stalledScans >= maxStalled) {
          state.running = false;
          ctx.ui.notify(
            `goal loop: ${maxStalled} idle scans with no progress on "${tasks[0]}" — stopping (task may be blocked). Fix TASKS.md and /goal again.`,
            "info",
          );
          return;
        }
      } else {
        state.stalledScans = 0;
      }
      state.lastSnapshot = snapshot;

      pi.sendMessage(
        {
          customType: "goal-loop",
          content:
            `goal loop: continue autonomously.\n` +
            `Next open task (${tasks.length} left): ${tasks[0]}\n` +
            `Same rules: do it, mark "- [x]", continue to the next. Reply NO_OPEN_TASKS when the file is exhausted.`,
          display: false,
          attribution: "agent",
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // fail-quiet: never brick the session from the loop driver
    }
  });
}
