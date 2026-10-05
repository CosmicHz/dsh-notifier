# 执行与完成规则

每轮只选 TASKS.csv 首个依赖已verified的planned任务；开始置in_progress，结束写 evidence/<task>.json {task,commit,files,commands:[{command,exitCode,report}],tests,remaining:[]} 后置verified。存在git且可创建本地提交时记录本地SHA；无git或无法提交时以本任务源文件SHA256清单作为sourceId，标verified不需等待人工提交。不能伪造git SHA。产物证据排除自身，最终检查使用同一sourceId。

每任务先读取指定规格和reference path；new_files是该任务必须交付文件，不是禁止修正依赖模块的白名单；只改该任务必要文件/依赖与测试，不顺手重写别的模块。规范归属唯一见00，不读archive作为执行要求；任何实际冲突记录具体条款，不自行降标。

BLOCKERS.md 每条为 {task,expected,actual,evidence,failedTest,nextIndependentTask}。允许的blocker仅：宿主实际接口与固定快照不符、平台协议证据冲突、工具/网络不可用导致无法验证；不允许以“实现太复杂/代码太长/时间不够”删功能。遇此类问题执行不依赖项，最后准确报告未完成。禁止把blocker变成fake成功。

在仓库根创建v1/，不改旧src；旧测试失败不是本任务。旧参考中的兼容/真机任务不属于本次范围；仍遵循执行环境实际更高优先级规则。检查当前用户改动，已有v1成果按规格补齐，不rm -rf重建。

阶段完成需该阶段所有任务verified且无对应blocker。最终仅T39通过才可报告“完整实现”，此前报告任务号与未完成项。不得自动npm publish/merge main/触发真实通知或给真实账号安装。

运行环境缺构建依赖时安装精确devDependencies；包下载失败记录错误，不擅自改版本。开发依赖缺失不允许删除构建或E2E要求。

自动脚本不能要求用户真实凭据；fixture使用synthetic-*，网络守卫默认拒绝非loopback测试请求。provider官方事实已经在reference中，不需要联网猜接口；确需新的协议证据才只读查询官方资料，记录出处。

T39最终还要求UX00–UX05 verified；没有图像查看工具时视觉验收未完成，不能自动按通过处理。

所有运行和视觉验收是Flash实施后的任务；当前用户要求本轮仅静态设计核对，不要求规划作者运行这些产品检查。禁止把规划静态核对结果填到实现evidence。
