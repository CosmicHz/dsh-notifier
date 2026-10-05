# Integration guide

> Status: **design target, not implemented**. Interfaces below are frozen by the
> contract in `docs/developer/v1-flash-v3/` (03, 05, 18) but have no runtime yet.

How a DSH host and downstream consumers integrate `dsh-notifier` v1.

## Plugin

- Package `name=dsh-notifier`, entry `src/plugin-entry.mjs`, exporting
  `name` / `inject` / `apply` for DSH `0.1.7-rc.2` (`@deepseek-ai/cordis ^4.0.1`).
- Exposes the public service via `ctx.provide('notifierV1', facade)` and disposes it
  on unload. The facade is `{apiVersion:1, notify(input), getCapabilities()}`; it
  never exposes credentials or IM/network entry points.
- Host tools: `notify`, `notify_test`, `ask_user`. Tool call context (not the model)
  supplies `sessionId` / `agentId` / `workspaceId`; `notify_test` requires a
  local-management context.
- Public event `dsh-notifier-v1/receipt` carries Receipt metadata only.

## RPC

- Transport: DSH Connection admission envelope, route `/dsh-notifier-v1`.
- Success value: `{data, storeRevision, surfaceVersion}`; failure:
  `{code, message, details}`. Error codes are the fixed set in 03-SERVICES-RPC.md.
- All write methods require a `requestId` UUID and are idempotent per the 02/03 key
  rule. Read methods are paginated `{limit, cursor}` → `{items, nextCursor, total}`.
- `surface.wait` is the single long-poll used by the UI to refresh projections.
- Native/local methods are local-owner only. `backup.create`, `import.preview`,
  `import.apply` are **local-only** and never registered on the host Native channel.

## Local CLI

`dsh-notifier <command>` talks to the loopback management port
(`127.0.0.1`, `<stateDir>/runtime-control.json`, Bearer token, 1 MiB limit). It never
writes the active store directly.

Commands: `status`, `diagnostics`, `accounts`, `destinations`, `connections create`,
`login`, `principals`, `pairing`, `bindings set`, `interactions`, `tasks`, `sessions`,
`routes`, `notify test`, `settings`, `backup create|restore`, `import preview|apply`,
`unlock`.

Write payloads come only from `--json-file PATH` so secrets never appear in argv.
Sensitive one-time output (pairing code, QR) prints to an interactive TTY only.

## Client bundle

Host module id `dsh-notifier`, panel key `dsh-notifier-v1`, locale namespace
`dsh-notifier.v1`. `dist/client.js` is a single-file bundle using the host React
instance; a byte-identical copy sits at the package root `client.js` for host asset
discovery. The client only calls RPC — it never writes the store or calls an SDK.

## Not in scope

Real devices, real accounts, publishing npm, merging `main`, or installing a real DSH
profile. Verification is local protocol simulation + real local backend E2E.