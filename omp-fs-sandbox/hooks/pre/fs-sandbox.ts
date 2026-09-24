// omp-fs-sandbox — filesystem policy guard for omp write-class tools.
//
// Policy: the `write`, `edit`, and `ast_edit` tools may only touch targets
// inside the session cwd, or under an allowlist prefix. The allowlist lives at
// ~/.config/omp-sandbox/allowlist (one absolute path prefix per line, `#`
// comments, `~` expanded; the session cwd is always allowed). On the first
// violation in a UI session the user is asked to approve; approvals persist
// for the session and are best-effort appended to the allowlist file.
//
// This is a GUARDRAIL, not a security jail. Known bypasses (all caught at the
// OS level by the omp-box firejail wrapper, which this plugin is designed to
// pair with):
//   - bash tool file writes (sed/tee/redirect/cp/rm)
//   - lsp rename_file
//   - eval-kernel writes (write() helper in the persistent kernel)
//   - conflict:// and other internal-URL writes this hook skips
// Handlers are fail-open: any internal error allows the call so a guard bug
// can never brick a session.
//
// Escape hatch: OMP_FS_SANDBOX=0 disables the hook entirely.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync, appendFileSync } from "node:fs";

const GUARDED_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  ast_edit: true,
};

const ALLOWLIST_PATH = join(homedir(), ".config", "omp-sandbox", "allowlist");

/** Narrow an unknown record member to string without `as`-casts. */
function fieldString(obj: Record<string, unknown>, key: string): string {
  if (!(key in obj)) return "";
  const v = Reflect.get(obj, key);
  return typeof v === "string" ? v : "";
}

/** Strip a `[path#TAG]` / `[path]` wrapper if present. */
function stripBrackets(s: string): string {
  const m = /^\[([^\]]+)\]/.exec(s.trim());
  return m ? m[1].trim() : s.trim();
}

/**
 * Reduce a raw target to the filesystem path to judge, or null to skip.
 * Skips internal URLs (anything with `://`) and empty strings; for archive/db
 * member forms (`foo.zip:inner`, `db.sqlite:table`) judges only the part
 * before the first `:` when it looks like a path.
 */
function targetToPath(raw: string): string | null {
  const t = stripBrackets(raw);
  if (!t || t.includes("://")) return null;
  const colon = t.indexOf(":");
  if (colon > 0 && !t.includes(":/")) return t.slice(0, colon);
  return t;
}

/** Lexically resolve a target against cwd (handles ~, ., ..). */
function resolveTarget(target: string, cwd: string): string {
  let p = target;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = join(cwd, p);
  return resolve(p);
}

/** Parse filesystem targets out of an edit tool payload string. */
function editTargets(payload: string): string[] {
  const targets: string[] = [];
  const header = /^\[(.+?)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = header.exec(payload)) !== null) targets.push(m[1]);
  const mv = /^\s*MV\s+(\S+)\s*$/gm;
  while ((m = mv.exec(payload)) !== null) targets.push(m[1]);
  return targets;
}

function readAllowlist(): string[] {
  try {
    const text = readFileSync(ALLOWLIST_PATH, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => resolveTarget(line, homedir()));
  } catch {
    return [];
  }
}

export default function fsSandbox(omp: HookAPI): void {
  if (process.env.OMP_FS_SANDBOX === "0") return;

  // Approved-for-this-session absolute prefixes (survives until process exit).
  const sessionApproved = new Set<string>();

  omp.on("tool_call", async (event, ctx) => {
    try {
      if (!(event.toolName in GUARDED_TOOLS)) return;

      const rawTargets: string[] = [];
      const input = (event.input ?? {}) as Record<string, unknown>;
      if (event.toolName === "write") {
        rawTargets.push(fieldString(input, "path"));
      } else if (event.toolName === "edit") {
        rawTargets.push(...editTargets(fieldString(input, "input")));
      } else {
        const paths = input.paths;
        if (Array.isArray(paths)) {
          for (const p of paths) if (typeof p === "string") rawTargets.push(p);
        }
      }

      const cwd = ctx.cwd;
      const allowPrefixes = readAllowlist();

      for (const raw of rawTargets) {
        const target = targetToPath(raw);
        if (!target) continue;
        const resolved = resolveTarget(target, cwd);

        const inCwd = resolved === cwd || resolved.startsWith(cwd + "/");
        const inAllowlist =
          inCwd ||
          sessionApproved.has(resolved) ||
          allowPrefixes.some(
            (prefix) => resolved === prefix || resolved.startsWith(prefix + "/") || resolved.startsWith(prefix),
          );
        if (inAllowlist) continue;

        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "fs-sandbox",
            `Allow ${event.toolName} to write outside the workspace?\n${resolved}`,
          );
          if (ok) {
            sessionApproved.add(resolved);
            try {
              appendFileSync(ALLOWLIST_PATH, resolved + "\n");
            } catch {
              // Read-only config (e.g. under the omp-box firejail jail): skip.
            }
            continue;
          }
        }

        return {
          block: true,
          reason:
            `fs-sandbox: ${resolved} is outside the workspace sandbox ` +
            `(session cwd: ${cwd}). Keep writes inside the session cwd, or ask ` +
            `the user to approve the write / add the path to ` +
            `~/.config/omp-sandbox/allowlist (e.g. via \`omp-box allow <path>\`).`,
        };
      }
      return;
    } catch {
      return; // fail-open: a guard bug must not brick the session
    }
  });
}
