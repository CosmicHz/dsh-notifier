# Architecture

> Status: **design target, not implemented**. Layers are frozen by
> `docs/developer/v1-flash-v3/18-WIRING.md`, 02 (data) and 03 (services/RPC).

## Layers

```
domain/     schema, errors, limits, capabilities, descriptors, messages
storage/    store (single state.json), lock, backup
security/   secrets, redact, network
providers/  registry, http, specs, <channel>/index.mjs
host/       dsh (Host adapter), port, callbacks, waiters, event-map
services/   accounts, destinations, connections, principals, pairing, routes,
            settings, notifications, interactions, conversation, activity,
            diagnostics, import, effects, inbox, reply-*, control-replies,
            correlations
runtime/    manager, event-bus, arbiter, login-manager, projection, application
rpc/        router, server
cli/        main
ui/         entry, controller, rpc, strings, theme, components, pages, field-copy
```

- `domain/descriptors` are pure functions; `storage`/`security`/`providers`/`host`
  implement ports; `services` depend only on ports. The composition root
  (`src/runtime/application.mjs`, `src/plugin-entry.mjs`) is the only place that
  imports concrete implementations. Nothing imports back into it.

## State

- One `state.json` per `stateDir` (JSON `schemaVersion=1`), backed by a single
  atomic writer. `Store.transact(expectedGlobalRevision, mutator)` clones → validates
  → writes a `0600` temp file → `fsync` → `rename` → directory `fsync`. A mutator
  performs no IO and never re-enters the store. `rename`-time failure never publishes.
- A single runtime owns a `stateDir`; CLI goes through the loopback management port.
  Ownership is enforced by `runtime.lock` (`pid`/`host`/`nonce`).
- Global revision increments once per commit; every record also has its own
  `revision` for optimistic concurrency. Views are produced only by the single
  serializer, which strips secrets.

## Lifecycle

Create descriptors/ports (no IO) → open store → construct services/manager/login/
projection → install host subscriptions into a bounded 256-event buffer → query and
recover interactions → enable the dispatcher → register tools/Native/CLI → reconcile
accounts and enable callbacks/intake. A full buffer stops intake and marks health
`degraded`; it never silently drops events.

Shutdown seals writes/intake → aborts uncommitted requests → waits a bounded 10s for
`started` effects (timeout → `uncertain`) → stops providers/logins → disposes
callbacks/listeners/timers → drains and closes the store → removes its own lock and
`runtime-control.json`. Every disposer is idempotent; partial startup unwinds in
reverse order.

## Delivery and control

- Outbound: route resolution (`session → agent → workspace → global → settings`) →
  per-segment effects → provider send → receipt aggregation
  (`confirmed`/`accepted`/`failed+partial`/`uncertain`/`skipped`). Effects are
  persisted `started` before the external call; a restart never re-runs `started`.
- Inbound: host callback → platform verification → normalize → durable inbox
  dedupe → platform ACK (only after the durable record) → dispatcher → authorization
  against the latest policy → per-session arbiter → host submit → turn events →
  control reply to the original principal.
- Interactions (approvals/questions/actions) use one ledger and one atomic claim
  entry shared by Native and IM; the host is the final authority and
  `ALREADY_HANDLED` is never rewritten as success.

## Projection

`SurfaceVersion = {bootId, sequence}` increments per process on any projection
invalidation. `surface.wait` registers a listener and re-checks the version to avoid
missed wakeups; one long-poll per client, 25s timeout, disconnect aborts.

See 18-WIRING.md for the authoritative wiring, permissions and ten end-to-end chains.