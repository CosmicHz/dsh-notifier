> **SUPERSEDED by v4 (2026-10-05).** This handoff and every snapshot in this directory
> are frozen history, **not** current state. The authoritative entry is now
> [`docs/developer/v1-release-v4/00-START-HERE.md`](../docs/developer/v1-release-v4/00-START-HERE.md)
> with the task list `docs/developer/v1-release-v4/REMAINING-TASKS.csv`; the goal is the
> dsh-notifier 1.0.0 release-ready artifact. Do not use this file for execution order.

# Handoff — dsh-notifier v1 (historical snapshot)

Read this file first. It is the single source of truth for the next agent; the other
files in this directory are supporting snapshots (see the warning at the bottom).

## TL;DR

- Repo `https://github.com/THEWOLFWALKER/dsh-notifier`, branch **dev**.
- `dev` is an **orphan branch** (no common ancestor with `main`). `main` is the old
  353-commit product; it is **not** a merge target and the v1 work does not touch the
  old root `src/`. Everything for v1 lives under `v1/` plus this `handoff/` dir.
- The v1 rewrite is **a library, not yet a runnable app**: `v1/package.json` declares
  `main=src/plugin-entry.mjs` and a `dist/client.js` bundle, and **neither exists yet**.
  No plugin entry, RPC server, CLI or UI is implemented.

## State of the code (as of commit `3d7f6e7`)

Implemented and tested (`v1/docs/PROGRESS.md`): **T00–T16, T22–T25, T29, B00–B04**
(schema, store, secrets, network, Host port, descriptors, accounts/identity/routes,
provider registry + adapters, notifications, messages/media, import, effects, control
reply, login, callbacks, interactions, conversation, runtime, Telegram) plus recovery
items **R01, R02, R03, R04, R05, R06, R08**.

Current suite: **356 tests pass**, `npm run check` passes (72 source files).

Still to do, in order:

1. **Recovery items** `R07, R09, R10, R11, R12, R13, R14` — see `REVIEW.md` for the
   exact file/line for each.
2. **Original task graph**: `T17` Feishu, `T18` WeChat, `T19` QQ, `T20` DingTalk,
   `T21` WxPusher, `T26` DSH integration, `T27` RPC, `T28` CLI.
3. **UI/UX + quality phases**: `UX00, T30–T33, UX01–UX05, T34–T39`.

## How to start

1. `git clone` the repo, `git checkout dev`.
2. Read `v1/AGENTS.md` and the root `AGENTS.md` (rules), then
   `docs/developer/v1-flash-v3/00-START.md`, `01-DECISIONS.md`, `18-WIRING.md`,
   `TASKS.csv`, and `REVIEW.md` (this dir).
3. Work incrementally on `v1/` only: no rewrite from T00, no legacy import, no
   backward compatibility, no real devices/accounts.
4. Per task: write the failing case first, fix, run the task's `command`, record
   `v1/evidence/<task>.json`.
5. **Before any push**: run the full neat-freak sync
   (`.agents/skills/neat-freak/SKILL.md`) and the pre-push gate
   (`v1/scripts/prepush_docs_gate.py`), regenerate `v1/docs/DOC-SYNC.json`.
   This handoff does **not** grant push authorization.

## Warning about the supporting snapshots in this directory

`REVIEW.md`, `RECOVERY-TASKS.csv`, `STATUS.json` and `NEXT-AGENT-PROMPT.txt` are the
**original static-review package** produced at baseline `24404fb`. They are frozen at
that point in time and are now partly stale:

- `STATUS.json` says all 14 recovery items are `required-not-run` and every task
  evidence commit/sourceId is null — that was true at `24404fb`, **not now**.
- `RECOVERY-TASKS.csv` likewise still marks R01–R14 `required-not-run`.
- `NEXT-AGENT-PROMPT.txt` is the pre-recovery instruction ("base is `24404fb`, fix all
  of R01–R14"); the first half is already done.

**Trust `v1/docs/PROGRESS.md`, `v1/HANDOFF.md` and `v1/CHANGELOG.md` for live status**,
and this file for orientation. Use `REVIEW.md` only for the per-item *problem
description* of the still-open recovery items.

## Boundaries (unchanged)

No `main`/tag/npm publish, no force push, no bypassing the pre-push gate, no real
devices. Keep the frozen architecture, permission model and host visual style.
