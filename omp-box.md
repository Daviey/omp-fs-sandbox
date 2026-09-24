# omp-box — OS-level filesystem jail for omp sessions

`omp-box` wraps a whole `omp` session — agent process, **bash tool, subagents,
everything it spawns** — in a firejail mount-namespace sandbox where the only
writable paths are the workspace and whatever the allowlist grants. Everything
else under `$HOME` is bind-mounted **read-only at kernel mount level**: a stray
`sed -i ~/important.conf`, `rm -rf ~/`, or `tee ~/.ssh/authorized_keys` from
any subshell fails with `EROFS` (read-only filesystem), no matter which tool
produced it. This is the backstop layer under the
[`omp-fs-sandbox`](omp-fs-sandbox/) hook: the hook gives good UX, the jail
gives enforcement.

```bash
omp-box                     # jailed interactive omp, run from the workspace
omp-box -- -p "fix the bug" # `--` separates omp-box args from omp args
omp-box allow /path         # HOST-SIDE: extend the allowlist (the only way)
omp-box allowlist           # print the effective jail configuration
omp-box raw -- CMD args…    # DEBUG ONLY: run CMD in the exact jail omp-box builds
```

`omp-box` must be started from the workspace directory (it refuses to launch
from `$HOME` itself — there would be no workspace confinement). The binary
lives at `bin/omp-box` inside this repo; symlink it into `~/.local/bin` or
alias it.

## The allowlist (shared contract)

`~/.config/omp-sandbox/allowlist` — shared with the `omp-fs-sandbox` hook
layer. One **absolute path prefix** per line; `#` comments and blank lines
ignored; `~` expanded; the session cwd is always allowed. Ships with `/tmp`
because agents legitimately scratch there. `omp-box allowlist` prints exactly
what a launch from the current directory would mount.

omp-box reads the allowlist **at launch time only**. Inside the jail
`~/.config` is read-only, so the agent cannot widen its own jail — extending it
requires a human in a normal terminal:

```bash
omp-box allow /var/lib/mydata     # absolute
omp-box allow ~/notes             # ~ expanded
omp-box allow shared-assets/      # relative → resolved against $PWD
```

Entries are normalized, deduplicated (exact match, with a notice when the new
path is already covered by an existing prefix), and appended only if absent.
Entries that don't exist are kept in the file but skipped at launch with a
stderr warning; an entry covering `$HOME` is refused at launch (it would
defeat the jail). One firejail quirk matters here: firejail mounts an **empty
tmpfs over `/var/tmp`** by default, which silently shadows any bind under it —
omp-box passes `--keep-var-tmp --read-only=/var/tmp` so `/var/tmp` is visible,
denied by default, and allowlist entries punch rw holes through it like any
other path.

## Decision table — what the jail does

| Path | Mode | Notes |
|---|---|---|
| `$PWD` (workspace) | **rw** | The launch directory; whole point of the exercise |
| `~/.omp` | **rw** | Session state, auth, settings — omp cannot run without it |
| `~/.cache` | **rw** | Model/embedding caches — would balloon otherwise |
| `/tmp` | **rw** | Via the default allowlist; **shared with the host** |
| allowlisted paths | **rw** | One `--read-write` bind each, applied over the ro base |
| `/var/tmp` | **ro** | firejail tmpfs disabled (`--keep-var-tmp`), then default-denied |
| everything else under `~` | **ro** | `~/.config`, `~/.ssh`, `~/.gnupg`, dotfiles, other projects |
| the rest of the filesystem | **ro** (binds) | `/etc`, `/usr`, other home dirs if visible, etc. |
| network, X, dbus, `/run` sockets | **unchanged** | `--noprofile`: full env passthrough, no `--net=none` |

`--noprofile` deliberately keeps the session usable: environment variables
pass through, `/run/user/$UID` sockets stay visible (ssh-agent etc.), network
stays up. This is a **filesystem jail only** — see [Known limits](#known-limits).

### Honest threat model on `~/.ssh`

`~/.ssh` is **read-only but readable** inside the jail. That means:

- `git push` over ssh keeps working (agent uses your agent socket / keys to
  authenticate to remotes) ✓ — verified on this host: `ssh -T git@github.com`
  authenticates inside the jail via the gpg-agent ssh socket, and
  `git clone git@github.com:...` succeeds
- **key theft-by-copy is possible**: the agent can `cat ~/.ssh/id_ed25519` and
  exfiltrate it over the still-open network. The jail stops *modification* of
  your home, not *reading* it.

If that matters for your threat model, run `omp-box` from a less-privileged
context (dedicated `git` user, or ssh-agent-only via `SSH_AUTH_SOCK` with keys
on hardware), or add egress control. The default posture is aimed at a
**non-adversarial agent making mistakes**, not at a compromised one.

## The escalation loop

The two layers are designed to run together:

```
jailed agent hits EROFS ──▶ asks the user in chat ("I need to write /X")
                          │
user, in a NORMAL terminal: omp-box allow /X
                          │
agent restarts the session (allowlist is launch-time)
```

Contrast with the [`omp-fs-sandbox`](omp-fs-sandbox/) hook layer:

| | `omp-fs-sandbox` hook | `omp-box` jail |
|---|---|---|
| layer | omp tool-call interception | kernel mount namespace (firejail) |
| catches | `write`/`edit`/`read` tool calls | **everything**: bash `sed`/`tee`/`rm`, subagents, spawned binaries |
| UX | runtime confirm prompt, friendly errors, allowlist update in-session | hard `EROFS` / `Read-only file system` failures |
| allowlist writable | yes (hook may update it, then confirms) | **no** — `~/.config` is ro inside; host-side `omp-box allow` only |
| bypassable | by any shell escape (`bash -c 'echo > ~/f'`) | only by firejail/kernel compromise |

**Run both.** The hook owns the UX: a blocked `write` gets a clear message and
an in-session confirmation instead of a raw syscall error. The jail is the
backstop that catches everything the hook cannot see — most importantly the
bash tool, where `sed -i ~/foo` or a runaway `rm -rf ~/project` never even
reaches omp's tool layer. The hook confirms intent; the jail enforces the
boundary. Neither layer trusts the other's allowlist edits: the hook updates
the shared file for its own runtime checks, while the jail only re-reads it at
launch (restart to apply).

### Session lifetime

A detail discovered the hard way: firejail's parent process waits for the
**last** process in the sandbox namespace, and omp deliberately leaves its
local-embeddings (mnemopi) workers running unref'd after exit. A naive
`firejail … -- omp` therefore hangs the terminal forever after omp exits.
omp-box runs the payload under a tiny supervisor that, once omp exits,
SIGKILLs everything left in the PID namespace and waits for it to drain
before exiting with omp's own exit code. Side effect, by design: **nothing
started inside the jail outlives the session** — background daemons, dev
servers, watchers all die with it. If you want a server to persist, run it
outside the jail (or in a separate `omp-box raw` invocation) and allowlist
its data directory.

## ZFS pairing (this host's layout)

Blast-radius reduction composes with snapshots. Put each project on its own
dataset so a bad session can only damage one:

```bash
zfs create rpool/home/dave/dev/omp-plugins      # one dataset per project
zfs snapshot rpool/home/dave/dev/omp-plugins@pre-omp   # before a risky session
# …incident happens…
zfs rollback rpool/home/dave/dev/omp-plugins@pre-omp   # undo it, minutes not hours
```

The jail's RW set *is* the dataset: workspace rw, everything else ro, so a
runaway write storm is bounded by the dataset — and `zfs rollback` restores it
to the pre-session snapshot regardless of what the agent did inside. Snapshots
are cheap (`zfs list -t snapshot -r rpool/home/dave/dev`), so snapshot
liberally before long autonomous runs (`zfs destroy` the ones that turned out
fine). Note what ZFS does and doesn't give you: **rollback safety, not
per-process confinement** — it protects `$PWD` after the fact; it does
nothing about `~/.ssh` being readable or `~/.config` being writable during the
run. Jail (during) + dataset + snapshots (after) together cover both
directions.

## Known limits

- **firejail is a convenience jail, not a hardened security boundary.** It is
  a setuid-root program with a long CVE history (sandbox escapes via race
  conditions, `--x11` handlers, D-Bus proxies …). Against a **non-adversarial
  agent making mistakes** — wrong path, runaway loop, bad glob — it is exactly
  the right tool. If your threat is an *adversarial* agent or untrusted prompt
  content, do not rely on it alone: pair with egress control (network
  allowlist / `--net=none` for the truly paranoid), run as a dedicated user,
  and keep secrets out of `~`.
- **`/tmp` is shared with the host.** The default allowlist grants rw `/tmp`;
  the jailed agent and host processes see the same files. Scratch there is
  also visible to everything else on the machine — fine for build junk, wrong
  place for anything sensitive. (Remove `/tmp` from the allowlist to deny it;
  omp sessions then need `TMPDIR` pointed somewhere writable.)
- **GUI apps are unaffected/unconfined.** `--noprofile` leaves X/Wayland
  untouched; a jailed process that talks to your compositor can screenshot,
  inject input, or trash your session via the display server. If the workload
  touches GUI, either don't jail it or add `--x11=none` (and accept the
  breakage). The browser tool inside a jailed session drives the host browser
  through that same hole — treat browser actions as outside the jail's
  boundary.
- **Reads are unrestricted.** Read-only ≠ secret: the whole `$HOME` (and
  filesystem) remains readable; combine with egress control if data
  exfiltration is in scope.
- **Allowlist is launch-time.** Growing the jail mid-session requires the
  host-side `omp-box allow` + restart loop by design — a jailed agent can
  never widen its own permissions.
