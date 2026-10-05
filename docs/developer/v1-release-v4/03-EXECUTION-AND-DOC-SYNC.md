# 实施与每次push前同步

读取REMAINING-TASKS.csv行序，单任务开始标in_progress；实现/针对性验证/证据齐全才verified。已有回归不机械重做，每次源改变按影响重跑；最终全部门槛必须针对同一个发行sourceDigest。指令“检查中途状态”不意味着只修文档；接手agent应持续完成发行目标。

历史通过与新发现并存时，保留证据原文，补复核结论，不能删除旧记录掩盖。N01–N04是本次静态发现，未运行复现；实施时先建立精确失败例。实现存在不等于最终可安装。

每次已授权push固定：fetch dev→确定base→审查完整diff→运行neat-freak（尺寸、枚举、读受影响文档、合并冲突）→更新所有受影响中英README/AGENTS/API/架构/runbook/CHANGELOG/HANDOFF/机器进度→DOC-SYNC.json→相关检查→提交→有效pre-push→普通fast-forward→核对远端SHA。门槛失败就修，不skip。

G00安装本包入口时，将仓库v1/scripts/prepush_docs_gate.py的文档inventory范围扩展为新的docs/developer/v1-release-v4活跃markdown与csv/json机器清单，保留v1产品文档；旧freeze contract/reference/archive按目录说明不用改，不把整个活跃任务目录not-applicable。不要每次为通过gate拷贝历史目录所有叙述。

handoff/原REVIEW/STATUS等可留历史但首页显式“已被v4替代，非当前状态”；原冻结TASKS进度不再手改。v1/docs/PROGRESS由当前任务表生成，并保留原51任务覆盖说明。AGENTS控制在300行内，不写逐提交流水账。没有独立记忆系统就not-applicable，不修改全局个人规则。

结束报告：实际完成的任务/版本/tgz与ZIP路径/验证证据/外部未实测事实。除实际外部阻断，不以“代码量太大”“时间不够”“已做基础库”停止。真正访问/依赖冲突记BLOCKERS并继续独立工作；公开发布需已有明确授权，发行产物本地制作不需另问。
