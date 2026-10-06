# Changelog

All notable changes to `dsh-notifier` v1. Chronological, newest first.

## [1.0.0-dev.0] — 2026-10-05 (unreleased)

### Added

- G00 (v4 release authority): the authoritative entry moved to
  `docs/developer/v1-release-v4/` (`00-START-HERE.md` + `REMAINING-TASKS.csv`, baseline
  `2eb91c9`). The root and `v1/AGENTS.md`, `handoff/00-START-HERE.md`, `v1/HANDOFF.md` and
  `v1/docs/PROGRESS.md` were repointed, the pre-push doc inventory now also covers the v4
  directory, and the goal is the **dsh-notifier 1.0.0 release-ready artifact** rather than
  a library. v4 adds fixes N01-N04 to the open R07/R09-R14 set.
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
- Phase 5 inbound channel T21 WxPusher (`src/providers/wxpusher/index.mjs`): outbound JSON
  send with typed error mapping (`code !== 1000` → `API_ERROR`) and TIMEOUT/CANCELLED
  propagation, plus a Host-mounted callback (W06) whose auth is the unguessable account
  route, a strict uid shape check, and the conversation layer's pairing/whitelist. The
  callback body never names its own account and the appToken comes only from the account
  secret resolver. Covered by `npm run test:protocol`.
- Phase 5 inbound channel T17 Feishu (`src/providers/feishu/index.mjs`): outbound custom-bot
  webhook with an interactive card and the official HMAC timestamp/sign; inbound is the
  Lark SDK WebSocket long connection, loaded lazily (typed `UNSUPPORTED` when absent) and
  isolated with a per-client bounded HttpInstance plus a start/handshake deadline. Text
  events and card actions normalize to envelopes; non-text messages are acknowledged then
  dropped (never injected into the Host). Covered by `npm run test:protocol`.

### Fixed

- R07 (v4): the control-card `{label, token}` contract is enforced end-to-end. Telegram
  maps it to `callback_data` under a 64-byte UTF-8 cap, and a button with an empty
  label/token now fails closed (`ENCODE_ERROR`) instead of being silently dropped - there
  is no `value`/`id` bypass left on the control path. Covered by
  `test/protocol/telegram.test.mjs`. Also removed a 50 ms login-expiry race in
  `test/unit/runtime-login.test.mjs` (fixed `now()` of 150 vs `expiresAt: 200`).
- N04 (v4): capability truth. `login` is a scan flow and is now declared only by
  Feishu and WeChat iLink; the manual-credential channels (telegram/qq-bot/dingtalk/
  wxpusher) report `login:false` so no UI offers a QR scan they cannot serve. The
  registry gained a `CAPABILITY_METHODS` map plus `capabilityGaps()`, and
  `assertRegistryConsistent()` now fails when a declared capability has no backing
  method unless it is an explicit `PENDING_CAPABILITY_GAPS` entry (today only
  `feishu:login`, closed by T17); the final gate (G03) fails while any pending remains.
  New `v1/docs/SUPPORT-MATRIX.json` enumerates all 29 channels × capabilities
  (declared / method / status / protocol test). Covered by `test/unit/registry.test.mjs`.
- N03 (v4): connection state is monotonic. `runtime/manager.mjs` promotes a
  connection to `ready` only while it is still the current connection, was not aborted,
  and did not already report a fatal during `start` — a synchronous `onFatal` can no
  longer be overwritten back to `ready`. A `start` that resolves after its connection was
  superseded releases the late handle (no leaked provider loop), and a non-current
  connection can no longer degrade the replacement's health. Covered by
  `test/integration/runtime.test.mjs`.
- N02 (v4): `resolveSecret` now validates the decoded value against the field
  descriptor (`validateFieldValue`) before returning it — a JSON object that decodes for
  a string field is rejected instead of becoming `"[object Object]"`. Provider inbound
  secrets resolve through the declared descriptor and are never coerced with `String()`;
  account writes reject a literal whose decoded type does not match the field; the
  importer stores literals JSON-encoded (02-DATA). Covered by `test/unit/secrets.test.mjs`.
- N01 (v4): closed the rest of R03. `/tasks` authorizes a TaskView by its
  `sessionId` (never its own id, which may collide with a session id); the owner rule
  is "authorized for every session" with an explicit binding that must still point at a
  usable session; and `/use`, `/stop` and `converse` re-read the current Principal (and
  Account) before any Host effect, so a revocation or disable while queued can no longer
  reach the Host. `runtime/manager.mjs` now injects the current Host session set so an
  owner with no declared scope resolves a single active session. Covered by
  `test/unit/conversation-r03.test.mjs` and `test/integration/authorization-race.test.mjs`.
- R08: inbound secret decoding now follows typed JSON encoding per spec/15. Descriptor-
  driven secret resolver implements literal JSON decoding and env resolution. Fixes issue
  where literal JSON-encoded tokens would carry quotes into URLs.
- R01: documentation and evidence consistency. Re-validated Phase 4 and Phase 5 tasks
  (B01-B04, T10-T11, T15-T16) at commit 3308719 after R08 fix. Updated HANDOFF.md and
  PROGRESS.md to reflect verified status. Added sourceId, commit hash, and validation
  timestamps to evidence files. All 262 unit tests, 59 protocol tests, and 13 integration
  tests pass.
- R02: pre-push hook path resolution and validation. Hook now uses `git rev-parse
  --show-toplevel` to reliably locate repository root regardless of invocation context.
  Added installation instructions to README.md. Verified hook correctly rejects pushes
  with missing DOC-SYNC.json, stale sourceDigest, and incorrect base commits.
- R03: conversation session authorization. Fixed `/sessions` and `/tasks` to filter by
  principal sessionIds (owner sees all, members see only authorized sessions). Fixed
  `/stop` to check canConverse and session authorization before terminating. Unified
  authorization logic via `isSessionAuthorized()` helper. All 340 tests pass.
- R04: controlEnabled admission. `runtime/manager.mjs` now gates the inbound control
  transport on `account.enabled && account.controlEnabled`: `applyAccount` records the
  connection `stopped` without calling `provider.start`, and `ingest` rejects with
  `FORBIDDEN` after the stale-epoch check (D04 precedence preserved). Notification
  delivery stays independent of `controlEnabled`. The R04 acceptance test was moved
  into `test/unit/` so the runner actually executes it, and a D04-precedence case was
  added.
- R05: Telegram reliable offset. `providers/telegram/index.mjs` advances the cursor
  only when every update in the batch was accepted or explicitly `DUPLICATE`; a
  non-stale rejection now aborts the batch and surfaces as fatal (the manager degrades
  instead of faking `ready`), while a superseded `STALE_EPOCH` ends the loop quietly. A
  failed `cursorStore.commit` throws `UNAVAILABLE` so the next `getUpdates` can never use
  an uncommitted offset. The unparseable-update advance is documented.
- R06: Telegram background exit and health. `providers/telegram/index.mjs` fails fast on
  missing config at `start()` and routes a fatal background exit through `onFatal`
  (never `.catch(() => null)`). `runtime/manager.mjs` now wires `onFatal` into
  `provider.start`, so a real background auth exit projects `connection.state='degraded'`
  + `health.degraded` (ignored for a superseded epoch).
- R07: control-card actions follow the frozen `{label,token}` contract end to end
  (service normalization, provider encoding, fixtures); a token over 64 UTF-8 bytes is a
  typed `ENCODE_ERROR` instead of a silently dropped button.
- R09: Telegram callback classification comes from the real chat type (a group press is
  never treated as a private control message), and a callback is acknowledged only after
  the durable receipt; the ACK never means the approval succeeded.
- R10: `/pair` redemption is injected by the composition root (`runtime/manager.mjs`) so
  the default manager + conversation + pairing assembly can pair, and `/unpair` revokes
  only the caller's binding, reply refs and live interaction targets.
- R11: Host events become durable state plus one control reply
  (`src/runtime/host-return.mjs`): `turn.output`/`turn.completed`/`turn.failed` answer the
  originating chat (with an explicit "no body" notice when nothing was cached, never a
  fake recovery), `interaction.opened` opens an interaction and delivers its card to the
  still-authorized targets, and `session.closed` cancels the session's pending work.
- R12: the conversation path routes inbound attachments through `MediaService` — bounded,
  cancellable, never relaxed to private networks — before `Host.saveAttachment`, so only a
  secret-free `AttachmentRef` reaches `Host.submit`; attachment-only messages are allowed
  and a download failure never falls back to the raw token URL.
- R13: one logical control send is idempotent by `requestId` with per-segment effect
  evidence; a platform 200 is recorded as `accepted`, never `confirmed`.
- R14: an expired Host interaction deadline is refused instead of extended, and a future
  deadline is capped at `min(host, now+15min)`.

> Only the Phase 1 foundation, Phase 2 core entity services, Phase 3 outbound providers,
> Phase 4 inbound/effects/interactions, and Phase 5 runtime + Telegram + Feishu + WxPusher
> exist so far; T18-T20 (remaining inbound providers), T26-T28 (DSH integration, RPC, CLI), and all
> UI phases are still unimplemented plans, not working behavior.