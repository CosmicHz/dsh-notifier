# 唯一完成目标：dsh-notifier 1.0.0发行就绪

不是再做一个plan或原型。最终必须得到经过本地验收的可安装npm tarball；实际npm发布/GitHub Release是外部动作，在已有明确授权范围内另行进行，不能因此停止打包前的工作。

## 产品必须完整

28通知出站、6入站/独立控制回复、29 registry条目；所有功能型capability绑定真实方法；多连接/目的地/身份/配对/权限/路由/quiet；对话、审批、问题、取消与附件引用；重启、故障和重复消息结果诚实；Native五页、CLI、Host工具、公用notifierV1服务全部接通。新API/schema，不做旧API兼容。可选旧数据导入全skip不阻断新配置。

## 安装包必须真实可用

- 将v1/package.json版本定为1.0.0，在改版后重新形成同一源版本证据。根旧package不改；dev独立历史不要求与main合并。
- main/exports/bin/types/client/cordis.patch每个入口文件必须在tgz实际存在；import公开入口成功，CLI --help成功，dist/client.js与包根client.js字节相同；客户端宿主React唯一实例。
- 包内不得引用仓库外的docs/reference/contract/test才能运行；不把源码快照/规划文档/测试fixture/秘密/状态文件打入npm包。
- exact版本lockfile、Node22验证、dev工具构建产物；可选SDK缺失时仅相应扫码/连接明确unsupported，不拖垮普通通知/其他渠道。最终支持矩阵准确记录。
- 干净临时目录安装tgz并做Host fixture挂载/卸载、RPC/CLI与五页实际资源发现；不能只import源码目录。Linux模拟平台命令不冒充macOS/Windows真机。

## 必须通过的本地门槛

原07与13不降级：check、unit/integration/protocol全矩阵、核心行95%/分支90%、build、真实本地后端E2E、三轮UX并修复、40基准截图与12状态、键盘/中英深浅/窄屏、120min soak、pack干净安装、verify:release。不能用测试数量替代缺失用例。R/N修复回归纳入最终套件。
仓库现有incremental check可用于阶段开发；最终release模式必须检查缺方法/缺文件/缺RPC/假capability/缺证据，而不只是现有文件语法正确。外部平台只宣称protocol-fixture-tested；真机不在本轮，不伪造真实Host/平台确认。

## 最终产物（固定路径）

交付目录`release/dsh-notifier-1.0.0/`（工作区生成，二进制产物不必提交git）：
- dsh-notifier-1.0.0.tgz：实际npm pack产物，名称按npm结果确认并核对name/version。
- SHA256SUMS：覆盖tgz、源快照与交付文档（自身除外）。
- SOURCE-MANIFEST.json：仓库URL、dev commit、实际源文件清单/哈希、工具链与lockfile摘要。
- source-v1.zip：实际发行v1源码和必要许可证/文档，排除node_modules、运行数据、秘密与测试临时日志。
- RELEASE-NOTES.zh-CN.md与RELEASE-NOTES.en.md：用户可见功能、安装、破坏性新API、导入限制、已验证边界。
- SUPPORT-MATRIX.json：每渠道通知/控制/登录/附件/按钮方法与协议fixture证据，外部真机状态明确not-run，不写confirmed。
- VALIDATION.json：同一源码摘要下所有门槛命令/退出码/时间/报告哈希，含当前仍适用R/N覆盖。
- KNOWN-LIMITATIONS.md：process-only交互恢复、可选SDK/宿主依赖与外部未实测事实；不能把未实现功能当可接受限制。
- INSTALL.md：从tgz安装到测试/真实用户环境的准确步骤、停止恢复/数据位置/CLI命令；不自动向真实profile安装。
- DELIVERY.json：version、artifact hashes、allRequiredTasksComplete=true、status=release-ready-local-validated、published=false（若未获得并执行公开发布授权）。

最终再打一个`dsh-notifier-1.0.0-release.zip`供用户下载，包含上述文件。交接给下一个agent的本ZIP不是这个产品发行ZIP，严禁混淆。

## 证据防自引用

sourceDigest覆盖v1/src、测试、scripts、package/lock、构建配置及types等功能输入，排除evidence、生成dist、docs纯叙述与发行输出。先固定源码提交，再运行门槛记录sourceDigest；证据文档提交可追加但不得改变该摘要。版本/源码发生变化必须重跑受影响检查和最终gate；不得伪造commit或沿用旧摘要。
