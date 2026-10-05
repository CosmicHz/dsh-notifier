# HANDOFF

Last updated: 2026-10-05.

For a one-file orientation (branch topology, what exists, what is stale in the
supporting review snapshots) see [../handoff/00-START-HERE.md](../handoff/00-START-HERE.md).
This file is the live repo status; `handoff/` holds frozen point-in-time snapshots.

## What this is

`dsh-notifier` v1 is an **independent rewrite** implemented under `v1/`. The frozen
design and task contract (not software) lives in
[docs/developer/v1-flash-v3/](../docs/developer/v1-flash-v3/). Read
[00-START.md](../docs/developer/v1-flash-v3/00-START.md), `01-DECISIONS.md` and
`18-WIRING.md` first, then execute `TASKS.csv` in row order.

`v1/` is the only product directory. Do not modify the legacy root `src/`; v1 does
not import it and does not keep v0 compatibility.

## Current state

- **Phase 1 (Bootstrap & foundation): verified.** T00 bootstrap plus T01 schema,
  T02 store/lock, T03 backup, T04 secrets/redaction, T08 network, T09 Host ports,
  B00 static descriptors and T25 activity/diagnostics are implemented and pass
  `npm run test:unit`.
- **Phase 2 (Core entities & routing): verified.** T05 accounts/destinations/connections,
  T06 principals/pairing and T07 routes/settings are implemented with `evidence/T05.json`
  … `T07.json`; the unit suite now covers A01–A05, P01–P04 and route/settings resolution.
- **Phase 3 (Outbound providers): verified.** T13 provider registry (29 frozen
  descriptors, 23 wired outbound adapters, typed `UNSUPPORTED` for the rest),
  T14 notifications (segmentation, level-scoped retry, accepted/confirmed/uncertain
  evidence layering), T12 messages (inbound normalization, scoped reply resolution,
  media admission into the Host store), T22 the five code adapters, T23 the 16
  declarative spec adapters, T24 the local `bell`/`desktop` adapters and T29 the
  best-effort importer are implemented with `evidence/T12.json` … `T29.json`.
  Covered by `npm run test:unit`, `npm run test:protocol` and
  `npm run test:integration`.
- **Phase 4 (Inbound, effects, interactions): verified.** B01 effect inbox / reply
  identity, B02 control reply, B03 login & read projection, B04 callbacks & host facts,
  T10 interactions, T11 conversation are implemented and verified on 2026-10-05 at
  commit 3308719. All unit tests (262) and integration tests (13) pass.
- **Phase 5 (Runtime & Telegram): verified.** T15 runtime and T16 Telegram are
  implemented and verified on 2026-10-05 at commit 3308719. Protocol tests (59),
  unit tests (262), and integration tests (13) all pass. Source hash:
  d113f406455d5be3a6c506a999124ef291c3720429df1468875ed0cde97f8ced.
- **Phase 5 inbound channels: Telegram + Feishu + WxPusher done, the rest planned.** T16
  Telegram, T17 Feishu and T21 WxPusher pass `npm run test:protocol` (Feishu: custom-bot
  webhook card + HMAC sign and an SDK-isolated WebSocket inbound; WxPusher: outbound JSON
  send + Host-mounted callback). T18 WeChat, T19 QQ, T20 DingTalk, T26 DSH integration,
  T27 RPC, T28 CLI and all UI/UX phases remain planned. See
  [docs/PROGRESS.md](docs/PROGRESS.md) for the live status table.

### Recovery pass (R01–R14, `REVIEW.md`)

A static review of baseline `24404fb` opened 14 recovery items. Current progress:

| item | scope | status |
|---|---|---|
| R01 | docs / evidence / source-version consistency | **done** (commit `fb264a4`) |
| R02 | effective pre-push gate path + neat-freak | **done** (commit `263671e`) |
| R03 | member list / stop / binding authorization | **done** (commit `8bbac37`) |
| R08 | typed secret decoding (literal JSON / env) | **done** (commit `3308719`) |
| R04 | `controlEnabled` admission | **done**, tests green, in this commit |
| R05 | Telegram reliable offset | **done**, tests green, in this commit |
| R06 | background exit → real `degraded` health | **done**, tests green, in this commit |
| R07 | control-card `{label,token}` contract | **done**, tests green, in this push |
| R09 | Telegram callback group type + ACK | **done**, tests green, in this push |
| R10 | `/pair` dependency injection + `/unpair` | **done**, tests green, in this push |
| R11 | Host event return path (`turn.*`, `interaction.opened`) | **done**, tests green, in this push |
| R12 | media safely into the Host (`MediaService` → `AttachmentRef`) | **done**, tests green, in this push |
| R13 | control-send idempotency + segmentation | **done**, tests green, in this push |
| R14 | interaction TTL (never extend a past deadline) | **done**, tests green, in this push |

R04/R05/R06 details this pass (all covered by `npm run test:unit` +
`npm run test:integration`):

- **R04** — `runtime/manager.mjs` gates the inbound control transport on
  `account.enabled && account.controlEnabled` in both `applyAccount` (never calls
  `provider.start`) and `ingest` (returns `FORBIDDEN` *after* the stale-epoch check,
  so D04 precedence holds). Notification delivery is untouched. The acceptance test
  was relocated from `test/r04-…` into `test/unit/` — the runner only walks
  `test/{unit,integration,protocol}`, so it had never executed and its second case
  failed on a hard-coded epoch.
- **R05** — `providers/telegram/index.mjs` advances the cursor only when every update
  in the batch was accepted or `DUPLICATE`. A non-stale rejection now aborts the batch
  **and surfaces as fatal** (the connection degrades instead of pretending to be
  `ready`); a superseded `STALE_EPOCH` still ends the loop quietly. A failed
  `cursorStore.commit` throws `UNAVAILABLE` so the watermark never moves without a
  durable commit.
- **R06** — provider `start()` fails fast on missing config/network; a fatal background
  exit goes through `onFatal` (no `.catch(() => null)`). `runtime/manager.mjs` now
  **wires `onFatal` into `provider.start`** and projects a real background exit to
  `connection.state='degraded'` + `health.degraded` (ignored for a superseded epoch).

Current suite: **396 tests pass** (86 of them protocol), `npm run check` passes (75
source files). Recovery items R07, R09–R12 (and the previously landed R01–R06, R08) are
all closed; see the table above and `CHANGELOG.md` for scope and verification bounds.

## How to continue

1. Read the frozen contract docs listed in `TASKS.csv` `read_first` for the task.
2. Implement exactly the task's `new_files`; run its `command`; check `acceptance`.
3. Record `evidence/<task>.json` and flip the row in `docs/PROGRESS.md` to
   `verified`.
4. At each phase boundary, run the neat-freak sync and (only if authorized) the
   pre-push gate.

## Boundaries

- Real devices / real accounts are out of scope. Do not attempt to install a real
  DSH profile, publish npm, merge `main`, or push without explicit authorization.
- Do not fabricate host/platform/visual evidence. External protocol conflicts go to
  `v1/docs/BLOCKERS.md` with source location, request/response evidence and the
  failing test.

## Installed gate paths

The pre-push hook is installed at `.git/hooks/pre-push` (copy from
`v1/scripts/hooks/pre-push`). It executes `v1/scripts/prepush_docs_gate.py` using
`git rev-parse --show-toplevel` to locate the repository root, ensuring correct path
resolution regardless of Git's invocation context. The hook rejects pushes with missing,
stale, or inconsistent `v1/docs/DOC-SYNC.json`. See
[README.md](README.md#push-documentation-gate) for installation instructions and
validation behavior.