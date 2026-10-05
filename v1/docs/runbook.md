# Runbook

> Status: **design target, not implemented**. The Phase 2 entity services
> (accounts/destinations/connections/principals/pairing/routes/settings) and the Phase 3
> outbound layer (provider registry, adapters, notifications, importer) are available as
> tested library code, but the CLI and runtime below do not run yet. Commands reflect the
> frozen contract (05-HOST-CLI.md, 02-DATA.md).

Operations, recovery and troubleshooting for `dsh-notifier` v1.

## State location

Selected in this order: `config.stateDir` (absolute path) → `$DSH_HOME/dsh-notifier-v1`
→ `~/.dsh/dsh-notifier-v1`. The state directory holds `state.json`, read-only
backups, `runtime.lock` and `runtime-control.json` (loopback port + token, `0600`).

## Common operations

```sh
dsh-notifier status                 # runtime + health summary (redacted)
dsh-notifier diagnostics            # JSON metadata export, no secrets
dsh-notifier accounts list
dsh-notifier accounts update --json-file ./patch.json
dsh-notifier connections create --json-file ./new-connection.json
dsh-notifier pairing issue --json-file ./pair.json   # plaintext code: TTY only
dsh-notifier notify test --json-file ./test.json
dsh-notifier backup create          # prints the backup path, never its contents
```

Write payloads are JSON files so secrets never enter shell history. `--json-file -`
reads stdin.

## Backup and restore

- Automatic backups are capped at 10; a normal backup is taken from a committed
  snapshot in the store queue.
- `backup restore` and `unlock` run **offline**: they require that the runtime is not
  running and take exclusive maintenance ownership first.
- A corrupt `state.json` is preserved as an `.invalid` copy and never used as a valid
  restore source. Restore validates the new schema before atomically replacing.
- `runtime-control.json` is never included in a backup.

## Lock recovery

`unlock` only removes a lock whose recorded host matches and whose `pid` is truly gone
(`kill(pid, 0) === ESRCH`). `EPERM` or a live process is refused. Never delete a lock
by hand while a runtime may be running.

## Import

```sh
dsh-notifier import preview --file ./old-store.json
dsh-notifier import apply --file ./old-store.json
```

Only `channel:<type>:outbound` keys for the 28 canonical outbound ids are read. Other
formats, identity, pairing, pending items, cursors, tokens and routes are skipped.
No supported records → `imported=0` with `reason=NO_SUPPORTED_RECORDS`; the user
simply configures fresh. Imports never overwrite existing accounts.

## Troubleshooting

| Symptom | Meaning / action |
|---|---|
| `STORAGE_UNAVAILABLE` | Settings were not saved. If durability is uncertain the message says the write result needs checking, not that nothing changed. |
| `CONFLICT` | Another writer changed the record; keep the user's input and show the latest. Never auto-overwrite. |
| `UNAVAILABLE` / degraded health | Missing host capability (tools/events/webServer). Diagnostics show the missing capability; there is no mock host. |
| `UNCERTAIN` | An external operation's result cannot be confirmed. Ask the user to check the target app/task first; never auto-retry approvals or unknown sends. |
| Stale UI banner | Disconnected; old data is shown with a timestamp. Reconnect removes it. |

## Evidence and gates

Release evidence is written to `evidence/results.json` (git SHA, Node/OS, commands,
exit codes, timings, report paths). No evidence means not verified. Release gate
order: `check → test → coverage → build → e2e → soak → verify:pack → verify:release`.