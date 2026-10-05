# Changelog

All notable changes to `dsh-notifier` v1. Chronological, newest first.

## [1.0.0-dev.0] — 2026-10-05 (unreleased)

### Added

- T00 bootstrap: independent `v1/` package (`dsh-notifier`, ESM, Node >= 22) with
  `check`/`test`/`build` scripts, the frozen design/task contract under
  `docs/developer/v1-flash-v3/`, root + `v1/AGENTS.md` rules, the neat-freak skill
  and the pre-push documentation gate.
- Phase 1 foundation (T01/T02/T03/T04/T08/T09/B00/T25): JSON schema and validation,
  atomic single-file store with runtime lock and backup/restore, secret envelopes
  and redaction, SSRF-safe HTTP/WebSocket network layer, strict HostPort contract,
  static 29-channel descriptors with field copy, and a metadata-only activity log
  with diagnostics export and 5MB×3 log rotation. Covered by `npm run test:unit`.
- Phase 2 core entities (T05/T06/T07): account/destination CRUD with secret envelopes
  and atomic `connections.create` (no orphan accounts), principal/pairing identity with
  one-time hashed codes, 5-minute expiry, lockout and atomic redemption, and
  route/settings resolution (`session → agent → workspace → global → settings`) with an
  independent quiet flag and a separate `settings.revision`. A shared
  `commit(store, expected, mutator)` helper makes service wrappers resolve with their
  domain view. Covered by `npm run test:unit`.
- Phase 3 outbound providers (T13/T14/T12/T22/T23/T24/T29): the provider registry
  enumerates all 29 descriptors and wires 23 outbound adapters while raising typed
  `UNSUPPORTED` for channels without an implementation; a declarative spec compiler
  produces 16 channels from data-only definitions; five code adapters (bark, pushplus,
  serverchan, webhook, wecom-app) and two local adapters (bell, desktop) implement the
  remaining outbound surface. Notifications add segmentation, level-scoped retry and
  accepted/confirmed/uncertain evidence layering; messages add inbound normalization,
  scoped reply resolution and Host-store media admission; the importer adds the
  `channel:<type>:outbound` best-effort path with idempotent fingerprints and
  all-or-nothing apply. Covered by `npm run test:unit`, `npm run test:protocol` and
  `npm run test:integration`.
- Phase 4 inbound, effects, interactions (B01/B02/B03/B04/T10/T11): effect inbox with
  idempotency keys (actor + method + requestId), reply identity with hashed token refs,
  control reply correlation, runtime login and read projection, callbacks and host facts,
  interaction lifecycle (pending → approved/expired/cancelled) with 15-minute TTL and
  atomic updates, and conversation service with command authorization, session scope
  filtering, and control/notification separation. Covered by `npm run test:unit` and
  `npm run test:integration`.
- Phase 5 runtime and Telegram (T15/T16): runtime manager with event bus, reconciliation
  on restart, stale-epoch rejection, duplicate replay protection, and bounded event buffer;
  Telegram provider with outbound sendMessage, control reply via inline keyboard, inbound
  long-poll with cursor persistence, photo media resolution, transient failure reconnect,
  and stale-epoch loop termination. Covered by `npm run test:protocol`,
  `npm run test:unit`, and `npm run test:integration`.

### Fixed

- R08: inbound secret decoding now follows typed JSON encoding per spec/15. Descriptor-
  driven secret resolver implements literal JSON decoding and env resolution. Fixes issue
  where literal JSON-encoded tokens would carry quotes into URLs.
- R01: documentation and evidence consistency. Re-validated Phase 4 and Phase 5 tasks
  (B01-B04, T10-T11, T15-T16) at commit 3308719 after R08 fix. Updated HANDOFF.md and
  PROGRESS.md to reflect verified status. Added sourceId, commit hash, and validation
  timestamps to evidence files. All 262 unit tests, 59 protocol tests, and 13 integration
  tests pass.

> Only the Phase 1 foundation, Phase 2 core entity services, Phase 3 outbound providers,
> Phase 4 inbound/effects/interactions, and Phase 5 runtime + Telegram exist so far;
> T17-T21 (remaining inbound providers), T26-T28 (DSH integration, RPC, CLI), and all
> UI phases are still unimplemented plans, not working behavior.