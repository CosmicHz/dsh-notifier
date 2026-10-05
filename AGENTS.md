# 仓库规则（根 AGENTS.md）

本仓库包含 dsh-notifier 产品的既有实现与 **v1 独立重写**。v1 任务规则见 [v1/AGENTS.md](v1/AGENTS.md)，冻结的 v3 设计/任务合同在 [docs/developer/v1-flash-v3/](docs/developer/v1-flash-v3/)。

## v1 任务入口（强制）

- **唯一权威入口（v4 发行包）**：先读 [docs/developer/v1-release-v4/00-START-HERE.md](docs/developer/v1-release-v4/00-START-HERE.md)、`01-CURRENT-REVIEW.md`、`02-RELEASE-DEFINITION.md`、`04-LATEST-CONTRACT-FIXES.md`，再按 [docs/developer/v1-release-v4/REMAINING-TASKS.csv](docs/developer/v1-release-v4/REMAINING-TASKS.csv) 行序逐项实施。目标是 **dsh-notifier 1.0.0 发行就绪产物**，不是库函数集合或原型。
- v4 覆盖 v3：04 的明确修正覆盖旧冲突（N01–N04、capability 事实）；旧 `TASKS.csv` 状态、旧 handoff、24404fb 快照不再作为执行顺序或权威状态。
- 规格归属（v3 冻结合同，不重写）：02 持久数据、03 RPC、04 Provider、05 Host/CLI、11 用户流程、12+`spec/DESIGN-TOKENS.json` 视觉、15+`spec/EDITOR-FIELDS.json` 表单、19 UI 接线、20 冻结宿主映射；14 仅索引；archive 只作历史证据。
- 产品产物全部在 [v1/](v1/)，目标 `name=dsh-notifier`、`version=1.0.0`。不改旧根 `src/`、旧 `package.json`。
- 内部架构/权限/布局/失败处理已定稿，不重选型；不导入 legacy/reference 运行时代码，不做向后兼容。
- 逐项验收：每项产物按 REMAINING-TASKS.csv 的 `validation`/`done_when` 实际执行，禁止 TODO 成功、空测试 PASS、只改文档冒充代码完成；不得把合同要求的 capability 改 false 逃避既定功能。
- 真机/真实账号不在本轮验收；必须完成本地模拟协议、真实本地业务后端 E2E、三轮 UX 自审、覆盖与 120min soak、打包检查。

## 推送前文档同步门槛（强制）

**每次 push 之前必须完整执行 `.agents/skills/neat-freak/SKILL.md`，并满足 `22-DOC-SYNC-AND-PUSH.md`。**

- 顺序：fetch origin dev → 以其 SHA 为 base → 审查完整 diff → neat-freak 尺寸体检 + 机械枚举全部 docs 与记忆 → 同步中英 README/API/架构/运行手册/CHANGELOG/HANDOFF/PROGRESS → 写 `v1/docs/DOC-SYNC.json` → 相关本地检查 → 提交代码与文档 → 工作树干净 → 执行 pre-push gate → 获授权后普通 push dev → 核对远端 SHA。
- 门槛脚本：`v1/scripts/prepush_docs_gate.py`，由 `v1/scripts/hooks/pre-push` 调用。本仓库本地安装路径见 [v1/README.md](v1/README.md)。禁止 `--no-verify`、临时关 hook 或用空报告绕过。
- 代码/接口/配置/命令/用户行为变更与文档同步必须进入同一次待推送提交；缺同步记录、旧 `sourceDigest`、文档仍矛盾或门槛失败时禁止 push。
- v4 不新增推送/发布授权：已获 `dev` 普通 fast-forward 推送授权的继续有效。禁止 force push / 推 main / 打 tag / Release / npm publish。

## 通用规则

- 仅 `dev` 分支开发；提交 author/committer 用仓库所有者 `CosmicHz <xhz352010@163.com>`，只设仓库局部配置。
- 凭据、真实状态、聊天内容、`node_modules/`、生成测试日志不得提交；证据只提交脱敏摘要与必要设计素材。
- 根 AGENTS.md 是规则手册，不追加历史流水账；机制写 `docs/`，历史写 `CHANGELOG.md`。<=300 行。