# Task progress

Source of truth: [TASKS.csv](../../docs/developer/v1-flash-v3/TASKS.csv). Ship only
when every row is `verified` and no blocker remains (08-EXECUTION.md).

Status values: `planned` → `in_progress` → `verified` (or `blocked`).

## Phase 1 — Bootstrap & foundation

| id | title | status |
|---|---|---|
| T00 | Bootstrap | **verified** |
| T01 | Schema | **verified** |
| T02 | Store lock | **verified** |
| T03 | Backup | **verified** |
| T04 | Secrets | **verified** |
| T08 | Network | **verified** |
| T09 | Host ports | **verified** |
| B00 | Static descriptors | **verified** |
| T25 | Activity diagnostics | **verified** |

## Phase 2 — Core entities & routing

| id | title | status |
|---|---|---|
| T05 | Accounts | **verified** |
| T06 | Identity | **verified** |
| T07 | Routes | **verified** |

## Phase 3 — Outbound providers

| id | title | status |
|---|---|---|
| T13 | Provider registry | **verified** |
| T14 | Notifications | **verified** |
| T12 | Messages | **verified** |
| T22 | Remaining code adapters | **verified** |
| T23 | Spec adapters | **verified** |
| T24 | Local adapters | **verified** |
| T29 | Importer | **verified** |

## Phase 4 — Inbound, effects, interactions

| id | title | status |
|---|---|---|
| B01 | Effect inbox and reply identity | **verified** |
| B02 | Control reply and correlation | **verified** |
| B03 | Login and read projection | **verified** |
| B04 | Callbacks and host facts | **verified** |
| T10 | Interactions | **verified** |
| T11 | Conversation | **verified** |

## Phase 5 — Runtime, platform providers, integration

| id | title | status |
|---|---|---|
| T15 | Runtime | **verified** |
| T16 | Telegram | **verified** |
| T17 | Feishu | **implemented** |
| T18 | WeChat | planned |
| T19 | QQ | planned |
| T20 | DingTalk | planned |
| T21 | WxPusher | **implemented** |
| T26 | DSH integration | planned |
| T27 | RPC | planned |
| T28 | CLI | planned |

## Phase 6 — UI

| id | title | status |
|---|---|---|
| UX00 | Design contract fixtures | planned |
| T30 | UI foundation | planned |
| UX01 | R1 visual prototype review | planned |
| T31 | Overview notifications UI | planned |
| T32 | Private chat UI | planned |
| T33 | Pending settings UI | planned |
| UX02 | R2 full UX review | planned |
| UX03 | Fix reviewed UX defects | planned |
| UX04 | R3 visual and accessibility review | planned |
| UX05 | UX quality gate | planned |

## Phase 7 — Acceptance

| id | title | status |
|---|---|---|
| T34 | Full journeys | planned |
| T35 | Coverage fault injection | planned |
| T36 | Performance soak | planned |
| T37 | Packaging | planned |
| T38 | Docs release gates | planned |
| T39 | Final verification | planned |

## Recovery pass — R01–R14

Opened by the static review of baseline `24404fb` (`v1/REVIEW.md`). Independent of
the TASKS.csv phases above.

| id | title | status |
|---|---|---|
| R01 | docs / evidence / source-version consistency | **verified** (`fb264a4`) |
| R02 | effective pre-push gate path + neat-freak | **verified** (`263671e`) |
| R03 | member list / stop / binding authorization | **verified** (`8bbac37`) |
| R08 | typed secret decoding | **verified** (`3308719`) |
| R04 | `controlEnabled` admission | **verified** (this commit) |
| R05 | Telegram reliable offset | **verified** (this commit) |
| R06 | background exit → real `degraded` health | **verified** (this commit) |
| R07 | control-card `{label,token}` contract | **implemented** (uncommitted) |
| R09 | Telegram callback group type + ACK | **implemented** (uncommitted) |
| R10 | `/pair` injection + `/unpair` | **implemented** (uncommitted) |
| R11 | Host event return path | **implemented** (uncommitted) |
| R12 | media safely into the Host | **implemented** (uncommitted) |
| R13 | control-send idempotency + segmentation | **implemented** (uncommitted) |
| R14 | interaction TTL | **implemented** (uncommitted) |

## Notes

- Evidence files live in `evidence/<task>.json` and are produced by the task itself.
- Phase boundaries trigger a neat-freak documentation sync even when no push happens.
- **Status values**: `planned` → `in_progress` → `implemented` → `verified`.
- **implemented**: Code committed but not yet re-validated in current session.
- **verified**: Tests run and passed in current session with evidence recorded.
- Tasks B01–B04, T10, T11, T15, T16 have been re-validated on 2026-10-05 at commit
  3308719 with source hash d113f406455d5be3a6c506a999124ef291c3720429df1468875ed0cde97f8ced.
  All unit tests (262), protocol tests (59), and integration tests (13) pass.