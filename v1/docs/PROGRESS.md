# Task progress (v4 release authority)

Status source of truth: `docs/developer/v1-release-v4/REMAINING-TASKS.csv` (v4 release package, baseline `2eb91c9`). This file is generated from that list; do not hand-edit a second status. The frozen v3 task graph in `docs/developer/v1-flash-v3/TASKS.csv` and the `handoff/` snapshots are history only.

Status values: `required` -> `in_progress` -> `implemented` -> `verified`. `implemented` means the code and local tests exist but the v4 `validation` file/command set has not yet been fully reconciled.

Goal: the **dsh-notifier 1.0.0 release-ready artifact** (see 02-RELEASE-DEFINITION.md).

| id | title | status |
|---|---|---|
| G00 | 恢复唯一入口、保护当前工作树、同步新任务状态 | verified |
| N01 | 补齐R03授权：Task.sessionId、owner路由、执行时重验 | verified |
| N02 | 秘密解码后按descriptor严格验证 | verified |
| N03 | 消除onFatal早到被ready覆盖与迟到句柄泄漏 | verified |
| N04 | 修正登录能力并建立capability方法证据映射 | verified |
| R07 | 控制卡片token合同 | verified |
| R09 | Telegram群callback拒绝与接收ACK | verified |
| R14 | 交互TTL与Host截止时间 | verified |
| R10 | 默认manager接入配对与本人撤销 | implemented |
| R11 | Host事件到对话回程与待办投递 | implemented |
| R12 | 媒体引用安全准入到Host AttachmentRef | implemented |
| R13 | 控制发送幂等及逐段效果证据 | implemented |
| T17 | Feishu | implemented |
| T18 | WeChat | required |
| T19 | QQ | required |
| T20 | DingTalk | required |
| T21 | WxPusher | implemented |
| T26 | DSH integration | required |
| T27 | RPC | required |
| T28 | CLI | required |
| UX00 | Design contract fixtures | required |
| T30 | UI foundation | required |
| UX01 | R1 visual prototype review | required |
| T31 | Overview notifications UI | required |
| T32 | Private chat UI | required |
| T33 | Pending settings UI | required |
| UX02 | R2 full UX review | required |
| UX03 | Fix reviewed UX defects | required |
| UX04 | R3 visual and accessibility review | required |
| UX05 | UX quality gate | required |
| G01 | 固定1.0.0候选版本与可复现依赖 | required |
| T34 | Full journeys | required |
| T35 | Coverage fault injection | required |
| T36 | Performance soak | required |
| T37 | Packaging | required |
| G02 | 发行CI与缺项必须失败的严格门槛 | required |
| T38 | Docs release gates | required |
| T39 | Final verification | required |
| G03 | 组装可交付发行目录与SHA256清单 | required |
| G04 | 最终文档同步与单ZIP发行交付 | required |

Original 51-task coverage mapping: `docs/developer/v1-release-v4/ORIGINAL-TASK-COVERAGE.csv`.
