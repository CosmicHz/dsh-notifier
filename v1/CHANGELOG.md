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

> Only the Phase 1 foundation exists so far; the plugin, RPC, CLI, providers and UI
> are still unimplemented plans, not working behavior.