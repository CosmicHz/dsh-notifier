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

> Only the Phase 1 foundation, Phase 2 core entity services and Phase 3 outbound
> providers exist so far; the plugin, RPC, CLI, inbound runtime and UI are still
> unimplemented plans, not working behavior.