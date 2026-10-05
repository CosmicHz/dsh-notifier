# Handoff — dsh-notifier v1 recovery

Point-in-time snapshot for the next agent. Read this first, then
[REVIEW.md](REVIEW.md) (the original static review of baseline `24404fb`) and the
live repo docs (`v1/HANDOFF.md`, `v1/docs/PROGRESS.md`).

## Where things stand

- Repo: `https://github.com/THEWOLFWALKER/dsh-notifier`, branch **dev**.
- Reviewed baseline: `24404fbc940624e01004c95bad28d9bf4c26375e`.
- Recovery items R01–R14 are tracked in `v1/REVIEW.md` and summarised in
  `v1/docs/PROGRESS.md` (Recovery pass table) and `v1/HANDOFF.md`.

### Done and committed

| item | commit |
|---|---|
| R08 typed secret decoding | `3308719` |
| R01 docs / evidence consistency | `fb264a4` |
| R02 effective pre-push gate path | `263671e` |
| R03 session authorization | `8bbac37` |
| R04 `controlEnabled` admission | (this handoff's commit) |
| R05 Telegram reliable offset | (this handoff's commit) |
| R06 background exit → `degraded` | (this handoff's commit) |

R04/R05/R06 were adversarially re-verified before shipping; the fixes are in
`v1/src/runtime/manager.mjs` and `v1/src/providers/telegram/index.mjs`, with new
passing tests under `v1/test/unit/` and `v1/test/integration/`. See `v1/CHANGELOG.md`.

Current suite: **356 tests pass**, `npm run check` passes (72 source files).

### Remaining recovery items (not started)

R07 (control-card `{label,token}` contract), R09 (Telegram callback group type +
ACK), R10 (`/pair` injection + `/unpair`), R11 (Host event return path), R12 (media
into the Host via `MediaService`), R13 (control-send idempotency + segmentation),
R14 (interaction TTL). Details and file locations are in `v1/REVIEW.md`.

### After recovery

Continue the original task graph: T17 Feishu, T18 WeChat, T19 QQ, T20 DingTalk,
T21 WxPusher, T26 DSH integration, T27 RPC, T28 CLI, then the UI/UX and quality
phases. See `v1/docs/PROGRESS.md` and `docs/developer/v1-flash-v3/TASKS.csv`.

## How to start

1. `git clone` the repo, `git checkout dev`, read `v1/HANDOFF.md` and
   `v1/REVIEW.md`.
2. Follow `v1/AGENTS.md` and the root `AGENTS.md`: incremental edits to `v1/` only,
   no rewrite, no legacy import, no real devices.
3. **Before any push**, run the full neat-freak sync
   (`.agents/skills/neat-freak/SKILL.md`) and the pre-push gate
   (`v1/scripts/prepush_docs_gate.py`); regenerate `v1/docs/DOC-SYNC.json`.
4. This handoff does **not** grant push authorization.

## Boundaries (unchanged)

No backward compatibility, no real devices/accounts, no `main`/tag/npm publish, no
bypassing the pre-push gate. Keep the frozen architecture, permissions and host
visual style; do not re-select them.
