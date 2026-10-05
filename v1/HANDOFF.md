# HANDOFF

Last updated: 2026-10-05.

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
- **Phase 4 (Inbound, effects, interactions): implemented, requires revalidation.**
  B01 effect inbox / reply identity, B02 control reply, B03 login & read projection,
  B04 callbacks & host facts, T10 interactions, T11 conversation are implemented with
  code committed. Unit and integration tests were reported passing by the previous
  agent but have not been re-run in the current handoff session.
- **Phase 5 (Runtime & Telegram): implemented, requires revalidation.** T15 runtime
  and T16 Telegram are implemented with code committed at 737d09c and 24404fb.
  Protocol tests were reported passing by the previous agent but have not been re-run
  in the current handoff session.
- **Phase 5 (remaining providers) onward: planned.** T17 Feishu, T18 WeChat, T19 QQ,
  T20 DingTalk, T21 WxPusher, T26 DSH integration, T27 RPC, T28 CLI and all UI/UX
  phases remain planned. See [docs/PROGRESS.md](docs/PROGRESS.md) for the live status
  table.

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

See [README.md](README.md#push-documentation-gate); the effective hook is
`v1/scripts/hooks/pre-push` → `v1/scripts/prepush_docs_gate.py`.