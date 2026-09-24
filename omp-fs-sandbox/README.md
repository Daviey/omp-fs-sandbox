# omp-fs-sandbox

Filesystem sandbox plugin for [omp](https://github.com/oh-my-pi/oh-my-pi): confines the
`write`, `edit`, and `ast_edit` tools to the session cwd plus an allowlist of path
prefixes, with an interactive ask-permission flow that persists approvals.

## What it does

A `tool_call` hook judges every filesystem target of a guarded tool call:

- `write` → `path` field
- `edit` → `[PATH#TAG]` / `[PATH]` section headers and `MV DEST` lines in the payload
- `ast_edit` → `paths` array

Targets are lexically normalized against the session cwd (`..`, `.`, `~` resolved).
Internal URLs (`xd://`, `memory://`, `local://`, `skill://`, …) are skipped; archive/db
member forms (`foo.zip:inner`, `db.sqlite:table`) are judged on the part before the `:`.

## Decision table

| Target                                            | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| Resolves to cwd or under cwd                      | Allow                                                     |
| Under an allowlist prefix (`~/.config/omp-sandbox/allowlist`) | Allow                                          |
| Approved earlier this session                     | Allow                                                     |
| Outside, UI session                               | Confirm dialog → approve: allow for session + best-effort append to allowlist; deny: block |
| Outside, headless (print/subagent)                | Block with an actionable reason naming the path and the allowlist file |

Any internal error in the hook **allows** the call (fail-open): this is a guardrail,
not a safety jail.

## Install

```sh
omp plugin link /home/dave/dev/omp-plugins/omp-fs-sandbox
omp plugin list   # should show omp-fs-sandbox
```

## Allowlist

`~/.config/omp-sandbox/allowlist` — one absolute path prefix per line, `#` comments,
blank lines ignored, `~` expanded. Re-read on every guarded call, so host-side edits
apply immediately. If the file is missing, only the session cwd is allowed. The plugin
ships a default file containing `/tmp`; add paths like:

```
/tmp
/home/dave/dev/some-shared-tree
```

## Escape hatch

Set `OMP_FS_SANDBOX=0` to disable the hook entirely (trusted sessions).

## Known bypasses

The hook sees only the three write-class tools above, so these escape it:

- **bash file writes** — `sed`, `tee`, redirections, `cp`, `rm`
- **`lsp` `rename_file`** — moves files outside the guarded set
- **eval-kernel writes** — the `write()` helper in the persistent Python/JS kernel
- **`conflict://` and other internal-URL writes** — skipped by design

Pair with the **omp-box firejail wrapper**, which enforces the same policy at the OS
level and catches all of the above. For bash-command ask-permission in plain omp, set
in `~/.omp/agent/config.yml`:

```yaml
tools:
  approval:
    bash: prompt
```

See the omp approval-mode docs (`tools.approval.<tool>` overrides are honored in every
mode, including yolo).
