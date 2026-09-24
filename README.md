# omp-fs-sandbox

Filesystem sandbox for [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi coding agent): a policy
hook (ask-permission + allowlist) and a firejail jail wrapper, sharing one allowlist.

## Filesystem sandbox for omp — two layers, one allowlist

Confinement of an agent that can run arbitrary bash needs both a **policy layer**
(friendly, interactive, catches the common tools) and a **jail layer** (kernel-level,
catches everything the policy layer can't see). Both read the same allowlist:
`~/.config/omp-sandbox/allowlist` — one absolute path prefix per line, `#` comments,
`~` expanded. The session cwd is always allowed.

| Layer | What | Catches | Misses |
|---|---|---|---|
| the `omp-fs-sandbox` hook (this repo) | `tool_call` hook on `write`/`edit`/`ast_edit` | write-class tools; asks via UI confirm and persists approvals | bash writes (`sed`/`tee`/`>`), `lsp rename_file`, eval-kernel `write()` |
| [`bin/omp-box`](bin/omp-box) wrapper | firejail mount-namespace jail: `$HOME` read-only, RW holes for cwd, `~/.omp`, `~/.cache`, allowlist | everything — bash included; agent cannot self-modify the allowlist (`~/.config` is RO in the jail) | network egress, GUI apps (out of scope; `--noprofile`) |

Run **both**: the hook gives the model an actionable error and you a confirm dialog;
`omp-box` is the backstop that makes bypass attempts die with `EROFS`.

### Quick start

```bash
# 1. Policy layer (one-time; applies to every omp session)
omp plugin install github:Daviey/omp-fs-sandbox

# 2. Jail layer (per session, from the project dir)
cd ~/dev/some-project
omp-box                      # or: omp-box -- <omp args>

# 3. Escalation when the agent legitimately needs a new path:
omp-box allow /absolute/path # host-side only; takes effect next omp-box launch
# or, in an interactive (non-jailed) session, just approve the fs-sandbox
# confirm dialog — it appends to the same allowlist.
```

Escape hatch for trusted sessions: `OMP_FS_SANDBOX=0 omp ...` disables the hook
(the jail must simply not be used).

Details, decision tables, and the honest threat model (`~/.ssh` stays readable —
[PLUGIN-README.md](PLUGIN-README.md).

### ZFS pairing

ZFS doesn't give per-process confinement — it gives cheap blast-radius control:

- `zfs create <pool>/<fs>/dev/<proj>` per project so one jailed session's RW set ==
  one dataset; `zfs snapshot <pool>/<fs>/dev/<proj>@pre-omp` before risky sessions,
  `zfs rollback` to undo.
- If all your projects share a single dataset, snapshot granularity is coarse
  until you split them out.
