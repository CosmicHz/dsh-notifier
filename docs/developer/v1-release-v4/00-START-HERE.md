# 最新且唯一的发行执行入口

用户只负责发送本ZIP。收到后直接读AGENTS并实施，不止于出计划。

仓库：https://github.com/THEWOLFWALKER/dsh-notifier；分支dev；审查基线 `2eb91c9284484fac11ed5dc8652f95dd56f74a1d`，提交主题 `handoff: authoritative entry + missing package files`。此次目标从“继续开发”明确为**完成1.0.0发行就绪产物**。没有自动公开发布。

## 接手动作（G00，固定顺序）

1. 现有仓库检查status与dev远端；不存在则clone dev。dev当前是独立历史，禁止为了与main关联而merge/rebase整条旧历史。
2. 保护未提交修改；若dev更新，静态看本基线之后diff，将已完成修复从待办改为needs-current-evidence，不重做、不回滚。
3. 将本包活跃文档与清单装到`docs/developer/v1-release-v4/`（source-baseline.zip无需提交，保留外部只读）。把根AGENTS/v1 AGENTS的“任务入口”以及handoff/00-START-HERE、v1/HANDOFF改为指向此入口。保留无关安全规则。原handoff只留明确过时提示，不再并列声称权威。
4. 冻结v3产品合同不重写；执行顺序和状态以本包REMAINING-TASKS为唯一源；04列出的明确修正覆盖旧冲突。v1/docs/PROGRESS由新任务表生成，不手改第二份状态。
5. 执行顺序：本轮复核缺口N01–N04 + 未完R项 → 其余平台 → Host/RPC/CLI → 生产UI/UX → 全产品验收 → 1.0.0发行打包与交付。
6. 每项交付实际文件、行为测试与记录；每次push前neat-freak。最终交付02列出的tgz、校验和、发布说明、能力/已知限制、源摘要与验证报告。

本包全部文件可离线读取。source-baseline.zip是所有Git跟踪文件的完整快照；contract含全部协议reference与前端design，未挑选删减。MANIFEST记录外层文件，SOURCE-FILES记录源码快照成员。verify_bundle.py只查文件完整/任务依赖/覆盖，不运行产品。

## 最新状态如何理解

已提交修复R01/02/04/05/06/08与R03的一部分；并非全部退回。N01重开R03未覆盖角落，N02补R08类型校验，N03处理R06早期fatal竞态，N04修正capability事实。R07/09/10/11/12/13/14仍未完成。原T16已有代码，不重新实现，但相关修复和最终渠道验收仍需通过。其余原任务全部映射，没有让实施者自行猜哪些跳过。
