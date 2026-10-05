# dsh-notifier v1 发行版接手规则 · v4

- 用户只转发本ZIP；解压后直接执行，不要求用户复制提示词、补传旧包或选择内部设计。
- 目标是**可安装、可交付的dsh-notifier 1.0.0发行产物**，不是库函数集合、原型或“剩余以后做”。当前审查基线dev@2eb91c9284484fac11ed5dc8652f95dd56f74a1d。
- 首读00-START-HERE、01-CURRENT-REVIEW、02-RELEASE-DEFINITION、04-LATEST-CONTRACT-FIXES，逐项执行REMAINING-TASKS.csv；这些取代旧handoff、24404fb快照、旧任务状态与旧提示词的执行顺序。
- 只在dev增量实现v1，不重写已完成模块、不导入旧runtime、不做v0兼容；无损旧数据迁移不是发行条件。保留旧main，不合并不相关历史，不force。
- 保留用户未提交工作：先git status/分支/远端，禁止reset --hard/clean/整目录覆盖。远端比本包新时读取新增diff并更新STATE，不能把新代码降回本包基线。
- 本包附完整基线源码source-baseline.zip和完整contract；仅作为只读参考/无网络时还原到新目录的快照，不覆盖活跃仓库。无需用户另发任何规划文件。
- 单一任务状态源为REMAINING-TASKS.csv；原51任务覆盖见ORIGINAL-TASK-COVERAGE.csv。代码存在或旧测试通过不等于发行验收；已完成项不重复实现，但最终全产品门槛仍覆盖。
- 前端按contract/11、12、15、19、design与机器tokens/fields实现宿主风格；禁止换模板、削减异常态、拿demo toast当成功。
- 28通知出站、6入站控制回程、29渠道及五页Native必须齐全；行为能力按真实方法与协议证据，不通过把capability改false逃避既定功能。
- 每个修复/新任务完成代码、针对性本地行为验证和源版本证据后才verified；跨层测试不mock应用服务，只模拟外部Host/provider。不做真机/真实账号。
- 本轮规划作者仅静态检查，未运行软件；实施agent之后仍必须完成既定本地测试、三轮UX修正、覆盖、120min soak、安装包检查。不要求获奖承诺，不得伪造视觉/真实平台证据。
- **每一次已授权push前完整执行.agents/skills/neat-freak/SKILL.md并同步所有受影响文档**；不是只在阶段末做。README中英/API/架构/runbook/CHANGELOG/HANDOFF/进度/证据必须对应本次代码。
- pre-push使用仓库根解析后的v1/scripts/prepush_docs_gate.py，保留既有hook；缺报告、旧base/digest、未同步文档或未关闭冲突必须拒绝。禁--no-verify与临时关门槛。
- 本包不新增push/公开发布授权；已获dev普通push授权的继续有效。不自动改main、打tag、Release或npm publish。先完成所有可审阅发行产物与发布元数据，是否公开发布不阻断开发完成。
- author/committer沿用THEWOLFWALKER <3622976831@qq.com>，只改局部git配置；秘密/用户数据/依赖目录/敏感日志不进提交与发行包。
- 不以行数设目标，不用重复代码/空文件/重复测试凑量。以功能、文件、合同与发行证据矩阵验收。
- 外部实际协议矛盾只记录具体BLOCKERS并继续独立任务；不要因为旧文档入口歧义停住，也不要问用户已定的设计问题。
