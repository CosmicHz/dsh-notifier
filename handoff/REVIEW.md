# dev 接手审查 · 24404fb

审查日期2026-10-05。远端基线 `24404fbc940624e01004c95bad28d9bf4c26375e`。只做Git、代码与文档静态阅读，未执行项目脚本、测试、浏览器或真机；下面是可定位的代码/合同缺口，不声称已复现运行结果。没有旧agent的进程日志，不能判断其卡死原因；也无法取得旧工作区未提交内容。

## 提交与真实接手位置

|提交|内容|
|---|---|
|bc4237b|v1计划与脚手架|
|49a6eb7|Phase 1基础实现|
|1db95e8|Phase 1文档同步|
|a840472|Phase 2–3核心实体、出站、导入|
|737d09c|Phase 4入站/effect/交互与T15 runtime|
|24404fb|T16 Telegram及registry/platform接入|

已有代码应保留增量修复，不重建v1。T17–T21另外五个入站渠道、T26实际DSH装配、T27 RPC、T28 CLI、T30–33生产UI与后续质量门槛尚无对应完整实现。前端只有field-copy，设计参考不等于生产界面。当前不是可安装使用的完整v1。

## 先修问题

所有位置均相对仓库根。修复不需要重选架构，按已提交v3规格。

### R01 文档与证据状态失真（接手阻断）
- `v1/HANDOFF.md`仍说Phase4 planned；`v1/docs/PROGRESS.md`Phase4/T15 verified但T16 planned；T16代码和证据已经提交。
- `v1/docs/DOC-SYNC.json`的base是49a6eb7、summary仍为Phase3；最新提交没有产品文档变化。不能据此证明737d09c/24404fb已经执行每次push前同步。
- 共27份任务证据，其中23份commit/sourceId同时为空，含T10/T15/T16。已有“测试通过”只是上个agent提交的声明，本次未复跑，不能认作当前源版本证明。
修复：创建真实进度表，已有代码但本次尚未验证标implemented/revalidation-required；保留旧证据并标历史来源，针对性复验后才verified。更新HANDOFF、PROGRESS、README中英、architecture、integration-guide、runbook、CHANGELOG、DOC-SYNC；不能伪造旧提交当时已执行同步。

### R02 pre-push路径没有接到实际脚本（高）
`v1/scripts/hooks/pre-push:3`执行`python3 scripts/prepush_docs_gate.py`，当前树实际文件是`v1/scripts/prepush_docs_gate.py`，没有根scripts对应文件。Git pre-push默认在仓库根执行，因此按文档安装此hook会找错路径。远端不包含旧agent的.git/config/.git/hooks，不能断言它当时是否安装或如何绕过。
修复：用git rev-parse --show-toplevel确定仓库根后执行v1路径；保留已存在hook，核对有效core.hooksPath和可执行位。按现有模板测试缺报告、过期digest和错base均失败。无push授权只完成本地门槛验证。

### R03 会话列表/停止权限未完整执行（高）
`v1/src/services/conversation.mjs:199–207`直接分页Host全部sessions/tasks，未按member.sessionIds过滤；`:277–283`停止仅检查绑定，不检查canConverse与当前会话范围。`:119–124`setBinding自身不验证当前会话授权。普通对话`:338`仅canConverse，启用/撤权的最新策略没有统一准入。
另有`services/routes.mjs:146–159`对owner也只使用sessionIds，未实现owner全会话授权；默认owner空scope可能无法对话。
修复：集中当前Policy；owner范围按合同处理，member限制sessionIds；列表先过滤再分页；绑定事务内重新授权；stop需要enabled principal、canConverse及当前会话范围；所有外部效果前重读账号enabled/controlEnabled和主体授权。不得以“UI以后不暴露”替代后端限制。
验收：member不能枚举未授权session；canConverse=false不能stop；排队期间撤权/禁用不能调用Host。

### R04 controlEnabled关闭仍启动入站（高）
`v1/src/runtime/manager.mjs:267–295`只检查account.enabled，不检查controlEnabled；`:120`附近ingest也没有统一账号控制准入。关闭控制的Telegram仍可能轮询，conversation部分命令/对话也没有账号控制开关检查。
修复：reconcile区分通知/控制；controlEnabled=false不start控制transport、不接纳控制事件；旧epoch与策略双检查。通知能力独立保留。

### R05 Telegram可在持久接收失败后推进offset（高）
`telegram/index.mjs:190–198`emit后无条件提高offset，仅对accepted=false且STALE_EPOCH停止。runtime.ingest在Store写失败时会返回accepted=false、STORAGE_UNAVAILABLE等（manager:141–147）。因此未可靠接收的事件也可能被后续offset跳过；cursor.commit拒绝IN_FLIGHT_EVENTS也未阻止下一次请求用提高后的内存offset。
修复：只有可靠接收/明确已去重才能推进连续水位；任一未接受停止该批并保留旧offset；未成功提交cursor不能用新offset发下一次getUpdates。区分durable receive与业务完成，不盲重放started效果。
验收：磁盘失败/CAPACITY/取消/cursor拒绝后重试请求仍从最后可靠offset开始，后续条目不跨越失败条目。

### R06 Telegram后台退出被吞，runtime会假ready（高）
`telegram/index.mjs:203–211`立即返回stop句柄，runLoop错误被catch(()=>null)吞掉；runtime manager:295据start返回即ready。缺秘密、媒体解析/游标失败可令循环终止却仍显示ready，鉴权失败也只固定延迟重试。
修复：start先做同步配置准入；异步fatal/health回调必须接投影。启动/鉴权失败明确degraded；可恢复错误按规格退避，停机不重连；禁止用catch空值掩盖异常。结构可新增明确provider生命周期port，统一给后续5渠道使用。

### R07 控制卡片字段与冻结合同不一致（高）
冻结`spec/ports.d.ts` actions为{label,token}；Telegram `keyboardFor:55–65`读action.value/id，忽略token。现测试telegram.test.mjs:69使用自造{id,value}，没有测试真实服务合同，所以与测试一起偏离了设计。
修复：统一{label,token}至服务、provider、fixture；callback_data按UTF-8字节<=64，而不是码点；超限明确错误不静默丢按钮。测试必须从reply-ref生成到provider真实body，不能另造旁路字段。

### R08 入站秘密解码不遵守定稿编码（高）
冻结15规定literal typed JSON编码；`providers/platform.mjs:11–20`直接str(resolveSecret.value)，`security/secrets.mjs:99–103`不解码；telegram fixture用raw TOK。合法写入JSON编码令牌时会携带引号进入URL。
修复：descriptor驱动的秘密resolver统一实现literal解码与env规则，出站/入站/目标都用它；若现有存量只是开发fixture，按新schema重建fixture，不增加v0兼容分支。覆盖string、JSON headers、UID数组与env，确保日志不含值。

### R09 Telegram callback群类型与ACK缺失（高）
`telegram/index.mjs:113–128`callback分支没有从query.message.chat.type设置chatType，落到platform.mjs默认private；群按钮会被错误归类，不能依赖后续reply-ref碰巧拒绝。整个Telegram实现无answerCallbackQuery调用。
修复：准确归类群并在控制入口拒绝；可靠记录callback后按冻结协议ACK，ACK只表示接收而非批准；业务失败仍给明确结果。测试群callback、ACK失败、重复callback，不把ACK成功当业务成功。

### R10 /pair依赖没注入；/unpair未实现（核心闭环缺口）
`conversation.mjs:583–586`要求ctx.redeemPairing；runtime.ingest:156–166传入的ctx没有此项。默认manager+conversation组装无法核销配对。COMMAND_SPECS:28–43也缺合同中的/unpair。
修复：组合根/manager明确注入Pairing command，保持同一Store事务；实现仅撤自己的unpair，并撤销相关refs/binding。用真实manager、conversation、pairing服务集成验证，不能替换handleInbound绕开。

### R11 Host事件回程仍为占位处理（尚未完成，不能verified整条链）
`runtime/manager.mjs:385–388`明示turn.output/completed/failed、interaction.opened以后再处理，目前只invalidate。普通聊天提交后没有该路径完成原聊天回答，Host待办也不会由此创建并投递。
修复：落实18/20的Host事件→correlation/Interaction→ControlReply；T26尚未完成是已知事实，但先为这些已声明接口补好装配和端到端本地fixture，再扩其他provider。不要把尚未做的真实DSH接入混称本地集成通过。

### R12 媒体在生产对话路径绕过MediaService（高）
`conversation.mjs:350,411–417`直接将envelope.attachments传Host.submit，未调用已有MediaService保存为Host AttachmentRef。Telegram传的是包含令牌URL的下载描述（telegram:94–106），现协议测试只证明生成URL。
修复：对话路径接MediaService安全下载/大小/取消/授权→Host.saveAttachment→传无秘密AttachmentRef；引用解析也接同一路径。纯附件允许；下载失败不给Host透传原始URL和token。入站群/未授权先拒绝再下载。

### R13 控制发送幂等与分段证据未闭合（高）
`control-replies.mjs:73–77`每次同requestId创建新effect，不调用beginRequest去重。Telegram sendControlReply:77–85自己循环多段但只返回最后messageId，控制服务只记录一个effect。后段失败会把之前成功发送的部分报delivery=none。
修复：发送前请求幂等记录；每段/尝试独立effect；保留部分成功receipt，不重发已接受段；JSON响应只证明平台接受，Telegram控制回复的confirmed（:87/99）改为accepted，现fixture断言一起修正。

### R14 交互期限被延长（高）
`interactions.mjs:153–155`把已经过期的Host expiresAt替换成新的15分钟；未来超长expiresAt也没有按本地15分钟取较短值。
修复：显式过期请求拒绝/直接expired，不新建可批准pending；未来期限=min(Host期限,now+15min)，未提供才用默认。覆盖刚过期、超长和精确边界。

## 不是当前已完成的内容

T17飞书、T18微信、T19QQ、T20钉钉、T21WxPusher、T26真实宿主适配、T27/28管理口与CLI、生产前端及最终质量门槛。它们尚未出现不算“删除功能”，但绝不能在报告中标完成。当前tests大部分是独立服务/provider模拟，不能代替产品总装。

## 接手优先序

1. 保存旧agent未提交内容（若还能访问），核对最新远端；不reset、不clean、不覆盖v1。
2. R01/R02恢复可信进度与文档门槛；先不push。
3. R03/R04/R05/R06/R08/R09/R14安全、耐久与生命周期修复。
4. R07/R10/R11/R12/R13串起一条Telegram完整本地闭环，并补真实服务之间的接线测试。
5. 本地针对性验证通过后按原51任务剩余依赖继续T17–T21、T26–T28、UI和质量阶段。不要因交接重新从T00抄一遍。
6. 每次已授权push前neat-freak同步完整文档、生成新DOC-SYNC、运行有效hook；本次交接并不新增push授权。

审查不穷尽所有基础模块；不得将未列问题的代码视为本次已验收。保留用户“不向后兼容、不真机、不降标、宿主风格已定”的约束。
