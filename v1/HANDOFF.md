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
- **Phase 2 onward: planned.** Next is T05 Accounts/Destinations/Connections →
  T06 Identity/Pairing → T07 Routes/Settings. See
  [docs/PROGRESS.md](docs/PROGRESS.md) for the live status table.

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