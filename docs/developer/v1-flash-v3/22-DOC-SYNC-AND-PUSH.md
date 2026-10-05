# 每次推送前的文档同步硬门槛

原版neat-freak已从dev完整复制，来源SHA见`.agents/skills/neat-freak/PROVENANCE.json`。读取SKILL及references，不能只借skill名写一句“同步完成”。用户要求将触发频率提升为**每一次push之前**，阶段结束/交接也执行。

## T00安装

1. 包保存在仓库docs/developer/v1-flash-v3，AGENTS规则落实到v1/AGENTS.md，根AGENTS合并本任务范围说明及本门槛，保留其他项目规则。将neat-freak目录同步到仓库`.agents/skills/neat-freak`；已有原版同内容不覆盖，有本地修改保留并记录差异，不删除。
2. 复制templates/prepush_docs_gate.py到scripts/prepush_docs_gate.py，templates/pre-push到当前有效hooks目录。已有hook就保留原内容，并在其退出前串行调用本门槛，任一失败返回非0；不要改变全局core.hooksPath。创建README记录安装的本地路径。
3. 门槛是辅助防遗漏，不是不可绕过的安全边界；AGENTS禁止绕过。未获得push授权时只做代码/文档/本地提交，不推送。

## 每次推送固定顺序

fetch origin dev → 以其SHA作为base → 审查将推送的完整diff → 按neat-freak尺寸体检、机械枚举全部项目docs和记忆、逐项判断/修改 → 同步中英README、API、架构、操作、CHANGELOG、HANDOFF/PROGRESS → 写DOC-SYNC.json → 相关本地检查 → 提交代码及文档 → 确认工作树干净、执行pre-push gate → 在已获授权时普通push dev → 查询远端SHA确认。
远端推进或候选代码发生变化：重新fetch/安全整合，重新做同步并生成sourceDigest；旧报告不得复用。新分支或没有可读远端base时暂停push并报告，不自行force或推main。

## 报告 `v1/docs/DOC-SYNC.json`

JSON={version:1,base:<完整远端dev SHA>,sourceDigest:<下述摘要>,skillCommit:<PROVENANCE的SHA>,inventory:[{path,disposition:updated|reviewed-no-change|not-applicable,reason}],changedPaths:[全部待推送文件路径],unresolved:[],summary:<非空具体说明>}。
changedPaths包括报告自身，报告自身不进入sourceDigest；sourceDigest由gate `--digest BASE`输出，覆盖BASE..工作树所有非文档变更（路径+内容hash，删除用deleted）。运行前所有文件应已git add（包含新增文件），然后写报告/补add再提交；代码变更后旧digest失效。文档本身不参与digest避免自引用，但gate核对changedPaths和inventory。

inventory逐文件列根AGENTS/README/README.zh-CN/CHANGELOG/HANDOFF（存在者）、v1全部markdown与docs内容文件、本计划活跃规格与实际受影响项目记忆。只读冻结reference、archive、第三方skill原文、生成证据可按目录一条not-applicable，说明“冻结参考/第三方原文/生成产物，不改写”；不能将活跃产品docs整个目录排除。
每个非文档变更至少在summary说明涉及的行为与文档位置；仅内部实现未改变公开行为，也要在CHANGELOG或HANDOFF记修复范围/验证边界。不要求无意义改写API，但必须给reviewed-no-change理由。

固定需要创建的产品文档：v1/README.md、README.zh-CN.md、CHANGELOG.md、HANDOFF.md、docs/integration-guide.md、docs/architecture.md、docs/runbook.md、docs/PROGRESS.md。T00创建结构与“未实现”标记，后续任务随代码填充真实状态，不一次性写成已完成。三类知识受众分开；不改全局个人记忆。

文档门槛不替代07/13的功能/视觉验收，不把受限外部环境改写成已通过。无push场景也在交接时记录neat-freak同步结果，但不伪造远端base或推送成功。
