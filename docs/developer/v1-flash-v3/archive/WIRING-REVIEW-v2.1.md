# dsh-notifier v1 设计接线与耦合审查

日期：2026-10-05。对象：`/workspace/dsh-notifier-v1-flash` 的 2.1 工作稿。方式：只读规格、字段合同、任务依赖和已有设计文件；不运行软件、浏览器、测试或真机验证。

结论：当前计划不能作为 Flash 的无歧义实施合同。以下 35 项为静态设计问题；P0 表示核心闭环无法按现有合同完成，P1 表示会导致错误实现、权限/一致性问题或交付失真，P2 表示需在实施前消除的规格歧义。不是已验证的实现漏洞。修订决定是下一版规范的约束，不表示现有全部文档已经完成同步。

约束不变：新 API、新 schema，不承担旧版兼容；旧版本另行保留；导入可跳过；不削减既定渠道和产品功能；不要求真机验证。解决新系统内部的接口断线，与兼容旧代码无关。

## P0：必须先闭合的六条链路

### W01 入站接收 → 控制回复没有出口
证据：04 只有通知 `send(account,destination,message)` 与入站 `start`；wechat-ilink 被明确标记 outbound=false。03 却要求 `/help`、配对、会话列表与对话回复。
后果：实现者只能偷偷把控制回复接到通知目的地，或者将微信回复判为不支持；quiet/通知开关也可能误伤控制回复。
修订决定：保留 outbound 的“通知能力”语义，新增独立 `controlReply` 能力和 `sendControlReply({account,replyContext,content,signal})`。replyContext 仅由已鉴权入站生成并由服务保存，不接受 UI/模型任意 chatId。控制响应不查通知 route，不受通知 quiet 影响，但受账号启用、controlEnabled、身份与会话授权约束。平台实际回复能力按冻结协议实现，不以新增任意目的地模拟。

### W02 Host 提交 → 运行结果 → 原聊天缺少回程
证据：05 `submit` 只返回 hostRef，`subscribe(handler)` 没有事件类型、turn 关联、输出正文、终止事件合同。
后果：用户发消息能进入宿主，却无法保证回答回到原用户；并发会话容易串线。
修订决定：定义 typed HostEvent（interaction.opened、interaction.closed、turn.output、turn.completed、turn.failed、session.closed、capabilities.changed）；每条含 eventId、sessionId，turn 事件含 turnId/hostRef。提交先持久化调用者/原聊天的 correlation，再执行 Host 提交；回程仅投递给仍有权限的原主体。输出适配沿用宿主已有事件事实，不能虚构事件名即可接通。输出无最终内容时必须有明确的读取结果 port 或报告能力缺失。

### W03 待办恢复依赖不存在的 HostPort
证据：02 要求重启时判断 hostRef 仍存在；05 没有查询待办的方法，subscribe 也没定义初始快照。
后果：pending 只能被无依据地恢复或取消，重启语义无法实现。
修订决定：新增 `getInteractionStatus(hostRef)` → pending/resolved/cancelled/unknown，以及订阅完成后的初始对账。unknown 不等于 cancelled：显示“无法确认”，禁止执行，保留原记录等待对账或到期。Host 不支持查询时不得声称具备可恢复待办能力。

### W04 平台按钮 → 交互实体 → Host 结算缺少凭证模型
证据：03 要求明确 token/回复映射；04 Envelope 只有 text/attachments/replyTo；02 没有 callback token 或消息到交互的映射。
后果：无法区分按钮动作和普通文字，无法限定账号/聊天/主体/交互版本，也无法使旧按钮失效。
修订决定：入站改成 message/callback 两种判别联合；持久化 replyReference 与 callback token 哈希映射。映射绑定 accountId、chatId、interactionId、动作、expiry、policyRevision；实际主体必须在结算事务内授权。token 使用随机不透明值，明文只出现在发送卡片时；重启可验证，终态/过期失效。平台需 ACK 的回调先按协议完成接收 ACK，业务成功必须等 Host 结算结果。卡片编辑是可选展示优化，失败不得回滚已完成审批。

### W05 runtime 健康状态 → UI 刷新断线
证据：03 `surface.wait` 只用 revision；14 health 来自 runtime 投影。连接失败、重连和登录进度未必写 Store。
后果：UI 长期停在 connecting/旧错误；伪造持久化写入来刷新又会让状态存储承担运行时事件流。
修订决定：分开 `storeRevision` 与进程内 `surfaceVersion={bootId,sequence}`。账号健康、登录、Host 能力、Store 提交统一通知只读投影；wait 使用 surfaceVersion，bootId 不同立即要求刷新。订阅与检查 version 必须原子衔接，避免丢唤醒。健康事件不为刷新而写 state.json。

### W06 公开 callback 没有实际挂载边界
证据：04 允许 HTTP callback；05 只定义 Native RPC 和 127.0.0.1 CLI 管理口，没有 callback mount port、路径、原始请求体验签和释放合同。
后果：WxPusher 等可以有解析器但收不到外部事件，或误复用管理鉴权。
修订决定：由 Host adapter 提供独立 callback mount port；路由 `/dsh-notifier-v1/callback/:channelId/:accountId`，实际支持渠道才注册。适配器取得有限长 raw body 和 headers 验证平台协议后形成 envelope；鉴权成功前不进入应用服务。关闭时卸载路由。宿主没有公网可达路由时将该账号标记 callback-unavailable，并给出配置原因；不得把 loopback 管理口开放到公网补洞。

## P1：一致性、授权与装配问题

### W07 大依赖袋造成全服务相互耦合
证据：03 所有服务统一接收 `{store,host,providers,clock,ids,audit}`。
修订：按最小 port 注入；配置服务只需 Store/descriptor/secret codec；权限服务只需 Store/clock；编排服务依赖精简 Host/消息端口。audit 在同一事务追加 metadata，不能再调用一个会重入 Store 的独立写服务。禁止 service locator 和服务通过 runtime 反查其他服务。

### W08 启动顺序与构造依赖相反
证据：05 顺序 Store→services→Host→providers→RPC，但 services 构造依赖 Host/providers。
修订：区分 construct 与 start。先创建无副作用 ports/descriptors，再开 Store、构造 services/runtime；安装 Host 订阅缓冲，完成恢复对账，再开放 intake、工具与 RPC；最后 reconcile 账号。失败按已注册 disposer 逆序清理。storage-degraded 只装诊断，不能创建半可用业务服务。

### W09 Provider registry 同时承担字段规范和运行实例
证据：T05 创建账户要按字段验证，registry 在 T13；T13 又含 http/specs，而具体 provider 在 T16–24。
修订：T01 后增加纯静态 descriptor 任务，仅依赖 domain。字段验证/表单/import 使用它；provider factories 是另一份显式注册表，composition root 才实例化。不让 schema import transport，也不让 adapter 回调 registry 取服务。

### W10 全局 requestId 不能隔离调用者与方法
证据：02 requests[requestId]；03 仅 payload hash，没有 actor/method namespace。
修订：幂等键为规范编码的 `[actorKind,actorId,method,requestId]`，hash 包含完整规范化业务输入；每次重放仍重新认证与检查可见权限。跨方法或跨主体不得读取别人的结果。撤权后的原成功响应不能绕过新权限继续返回敏感内容。

### W11 效果 intent 粒度太粗
证据：03 单个 effect journal；04 有多目的地、消息分段和局部成功；02 Receipt 不含 segment 或 attempt。
修订：父 request 下固定 effectId、destinationId、segmentIndex、attempt、开始/结束证据。崩溃只将执行已开始而无结果的叶子效果置 uncertain；未开始的工作不得冒充已发送。accepted 部分不重发；部分结果须能在返回值和活动中表达。HTTP 失败不等于业务未接受。

### W12 删除与外部副作用存在竞态
证据：02 删除只取消 pending；claimed 已在执行；03 旧 epoch 事件一律拒绝。
修订：明确线性化点：撤权/删除提交之前已 claim 的外部操作可能完成，不能承诺可撤回。禁止再 claim，abort 尚未提交的调用；已发出的效果继续记终态或 uncertain。epoch 用于拒绝旧入站/状态回调，不能丢弃已经发生的发送证据。UI 删除确认需说明已提交操作可能完成。

### W13 外键校验与历史记录保留互相冲突
证据：02 全 schema/外键校验；删除 Destination 后 Receipt 仍引用 destinationId；删除 Principal 未规定 bindings 清理。
修订：活跃关系强外键；历史 Receipt/Activity 引用定义为可悬空历史 ID 与脱敏 label snapshot，不再 join 已删除凭据。删除原子清理 binding/pairing/route/default references，取消未 claim 的相关交互目标。终态交互使用独立 schema，允许正文清理后字段缺席。

### W14 Native 身份来源与 trusted facade 没有明确界线
证据：01/02 将 Native 已认证用户视作 local-owner；03 notify 又说受身份约束，但 public facade input 没有 actor。
修订：Native local-owner 必须由宿主 admission 产生，不接收客户端声明角色。CLI 由本机 token 产生。Host facade 是仅供可信宿主插件的进程内能力，不注册到 IM；工具调用使用 Host 提供的可信调用上下文绑定 session，而不是模型提供 sessionId 获得权限。context 缺失的工具调用拒绝。

### W15 “所有 IM 管理拒绝”与 /quiet、/route 冲突
证据：02 全部管理拒绝，03 IM owner 可 quiet 当前会话。
修订：区分全局配置管理与受限会话控制。`/route` 固定只读查询当前绑定会话有效通知路径；`/quiet`、`/unquiet` 仅 IM owner 对当前绑定且授权的会话设置 quiet override，禁止改目的地和全局设置。Native/CLI 才可 routes.save。建立按入口/动作权限表，不能仅靠“危险方法”这个未枚举词。

### W16 policyRevision 粒度与撤权后 pending 的处理不完整
证据：02 任一 Principal 改动都推进 Account.policyRevision，所有 target 记录旧 revision。
修订：保留账号级 revision 作为失效标志；结算时重读最新主体权限。仍被授权的目标需重新签发交互引用并更新目标版本，已撤权目标取消；不得简单让同账号所有人的待办永久不可回答。对话回程、附件下载和回复查询也要在执行前重新检查当前授权。

### W17 扫码开户与必填凭据形成死锁
证据：06 启用方向必须凭据完整；03 login.start 要 accountId；创建账号默认 enabled=true。
修订：允许显式创建 enabled=false 的扫码草稿，controlEnabled=false；login 独立于接收 runtime 启动。成功在一次事务中写凭据并启用 control；取消/超时保留可删除草稿。登录 session 绑定账号配置 revision；编辑、删除、重新扫码使旧 session 失效；迟到结果不得覆盖新凭据。

### W18 登录生命周期没有负责模块
证据：03 有 login 三方法，服务目录和任务表无 login manager；02 又禁止任意新增 schema 字段。
修订：新增 runtime/login-manager，内存保存 session、deadline、abort/disposer；不持久化 QR 原文和 SDK 对象。进程重启旧 loginId 返回 EXPIRED，UI 可重新开始。成功凭据提交由 Account service 执行，SDK 不直接写 Store；每账号同时一个 session，替换时先取消旧 session。

### W19 统一 HTTP 网络 port 与 WS/SDK 不匹配
证据：04 只 HTTP(S)+node:http pinning，实际有 WebSocket 与飞书 SDK；“所有网络替换统一 port”没有可实现的对应接口。
修订：NetworkPort 明确 request、openWebSocket 两类；SDK 注入受控 transport 或通过 SDK 已公开的代理/连接选项满足同样策略。若冻结 SDK 没有可注入路径，该适配为明确阻断，不能偷偷绕过网络限制或声称已满足。协议测试用注入 NetworkPort 的 fixture，不为测试开放生产任意内网。

### W20 入站去重与游标提交没有可恢复语义
证据：02 有去重上限、cursor 在处理持久化后推进，却没有 durable inbox 表；04 平台有 ACK。
修订：新增有界 inbox，键为规范编码的 accountId+eventId，记录 received/claimed/done/uncertain 与去重期限。先持久接收，再按平台要求 ACK；游标推进到连续已可靠接收的水位，不越过未持久化事件。外部调用前记录 claim，重启不重放不明效果。不能以“去重 exactly once”声称宿主和平台具备分布式事务。

### W21 目的地敏感字段可能绕过 View 脱敏
证据：02 仅 AccountView 明确移除 secrets；04 targetFields 被移到 Destination.target，未对其 exposure 再定义返回行为。
修订：字段分配先看 exposure 再看所属实体；敏感 target 存独立 secret 引用，DestinationView 返回 configured 标记；所有 list/get/幂等结果/诊断共用 DTO serializer。不能把目标字段一律当公开字符串。编辑使用 keep/set/clear，不回传密钥再保存。

### W22 开户 secrets 输入没有统一形状
证据：03 accounts.create 与14 connections.create 写 secrets，02仅更新定义操作数组，持久化又是 map。
修订：所有写接口使用 `secretChanges:[{path,op,value?}]`；create 只允许 set，update 允许 set/clear；存储 map 仅内部。向导、导入都调用同一命令规范化函数，禁止把表单字段直接 spread 到 Account。

### W23 备份与损坏存储恢复入口互斥
证据：02 openStore 同时写 Promise<Store> 与 tagged union；05 storage-degraded 不注册写入，backup/create 可能仍要求 Store。
修订：统一 tagged union。损坏态诊断不调用 snapshot；原文件保全由独立 BackupPort 原样复制并标记 invalid，不能作为可恢复有效备份展示。正常在线备份在 Store 队列取得已提交快照；restore/unlock 只离线，使用独立排他锁防启动竞态。只提供恢复指引不等于已有可用业务服务。

### W24 settings 默认目标更新的并发含义不清
证据：14 connections.create makeDefault 没有 expected settings revision，03 settings.update 有乐观锁。
修订：makeDefault=true 固定为事务内按 ID 去重追加，不替换已有默认目标；settings.revision 增加一次。设置页替换整个列表仍需 expectedRevision。连接创建幂等重试不得再次追加或推进 revision。

### W25 Host tools 与 ask_user 等待生命周期未定义
证据：01 承诺 notify/notify_test/ask_user，05仅说参考工具注册，没有参数、返回、取消及宿主等待合同。
修订：单独定义三个 Tool DTO。ask_user 建立 Interaction 并等待 arbiter 的终态，Host取消使未 claim 交互取消；超时不得返回批准。通知返回 receipts 分层语义。Host adapter 只转换工具协议，不另写一套权限/结算逻辑。Native 和 IM 都调用同一个 settle command。

### W26 媒体与引用只定义输入，没有资源归属
证据：05 saveAttachment，04 resolveReply，但临时文件/下载取消/过期/回传附件/大小累计没有完整生命周期。
修订：MediaService 独占下载和临时资源；解析引用受 account/chat 范围约束；Host adapter 独占 attachmentId 转换。取消、撤权、会话关闭清理未移交资源；移交 Host 后由 Host负责存活。回程附件使用受控内容句柄，禁止把宿主任意路径或远程 URL 直接交给 provider 读取。

### W27 任务表语法无环，实际完成依赖有环
证据：T27 要所有 RPC，含 import；T28 CLI 全命令包含 import；T29 Importer 却依赖 T28。T26 真实装配未依赖 T16–24 具体 factories。
修订：Importer service 在 RPC 前，只依赖 descriptor/Store/account command；CLI 最后接线。Host adapter 与最终 composition 分任务，最终 composition 依赖所有 factories。每阶段门槛仅运行该阶段已要求的测试；最终门槛负责全覆盖，不能让早期任务靠未实现 stub 满足全局 protocol 命令。

### W28 Host能力变化没有传播到 UI 和待办
证据：05 capabilities 只有读取方法；14首页关注项有限；缺 Host 能力时只笼统 degraded。
修订：Host能力改变进入 typed event → runtime projection → surfaceVersion。UI 使用能力+当前授权决定按钮是否可执行，显示具体禁用原因；后端始终再验证。功能不可用不能用空列表表现成“没有任务”，也不能只靠前端禁用。

## P2：接口与交付歧义

### W29 通用分页假设不适用于全部数据
证据：03 按 createdAt/id，02 Activity 字段叫 time，05 Host views 无 createdAt。
修订：每个列表声明排序键；Activity time/id；Interaction expiresAt/createdAt/id；Host Task/Session 固定 id 排序并使用带快照版本的 cursor，版本失效返回 CONFLICT 重新读取。cursor 包含过滤条件指纹，不能跨过滤器复用。

### W30 首页“完成配置”过度依赖通知目标
证据：14 setup 只有 hasUsableDestination/hasPairedIdentity；微信仅控制用户没有通知目标也应完成自己的主要路径。
修订：分别暴露 notificationSetup 与 controlSetup，状态为 not-started/incomplete/ready；总首次使用态按 accounts 为空判断。ready 表示配置与授权完成，不表示平台已收取每次消息。首页同时显示两条独立能力，不强迫控制用户配通知。

### W31 复合键拼接可能混淆 opaque ID
证据：02 lockouts 用 accountId+':'+userId；统一字符串 ID 未排除冒号。
修订：所有多字段 key 用 JSON.stringify 的字符串元组统一编码；不拆分平台 ID。配对 hash 也采用明确的版本化结构序列化，不依赖分隔符约定。

### W32 全量 state 改写与高频事件生命周期耦合
证据：02 每次事务 clone/全校验/fsync/rename，含 receipts、activity、requests 和 cursor，限32MiB。
修订：本轮不因此改数据库架构；合并同一业务事件的 inbox/receipt/activity/request/cursor 提交为一个事务，运行时 health 不落盘；清扫仅实际变化才提交，队列有界背压。已有性能门槛仍需后续实施验证，此处不能断言全量 JSON 必然达标或必然失败。

### W33 导入虽然可跳过，也需要输入资源边界
证据：09 只读指定文件，但无最大文件大小和解析深度；变更文件视为新导入，可能重复。
修订：按32MiB上限先有限读取，同一缓冲计算 hash/解析，深度16；超过范围返回 skipped+明确原因。preview列出“文件变更可能新建重复连接”，apply只按该缓冲 sourceHash提交。导入失败不阻碍全新使用，不引入旧格式兼容层。

### W34 前端设计稿与生产合同并非同一权威
证据：06标题28/36与 design/tokens.css 宿主20/28不一致；示意向导不能代表29渠道的真实字段行为。
修订：宿主标题20/28、weight500为主，产品交互命中区域至少44px；tokens只有一份机器源生成 CSS。预览是布局/视觉参考，生产表单只能由 descriptor 驱动。新增渠道切换必须清除不适用字段与错误，保留通用名称；不能将 Telegram botToken/chatId 硬套其他渠道。不得将预览 toast 视作实际接线验收。

### W35 包版本、文档优先级与校验器已经漂移
证据：00称46任务，verify_bundle.py仍断言40且T00连续；03/14覆盖式接口规范、02重复openStore签名；当前工作稿更新并不等于已交付ZIP同步。
修订：下一版合并合同，单个接口只保留一处权威定义；机器 RPC清单与DTO对应；TASKS显式topological order和唯一ID。重新生成 manifest/ZIP后才能标记可交付；仅文件hash通过也不证明合同闭合。本次只出审查包，不将未完成同步的执行包冒充修订完成。

## 必须统一的模块依赖方向

- domain + descriptors：纯数据/校验，无 IO，不 import services/runtime/providers。
- storage、security、host adapter、provider adapter：实现 ports，不掌握产品路由或调用 UI。
- services：拥有业务命令、授权、事务边界；依赖 ports 与 domain，不依赖具体 DSH/SDK。
- runtime：管理登录/连接/事件队列/健康投影；不另存一份权限真相，不直接绕开命令写账号。
- RPC、CLI、Host tools、IM dispatcher：只做输入认证、DTO转换、调用 services、输出脱敏。
- UI：只用 Native RPC DTO，不 import Store/schema实现/SDK；频道表单用公开 descriptors。
- composition root：唯一组装具体实现的模块，负责全生命周期；不可被上述模块反向 import。

## 状态唯一归属

|状态|唯一归属|其他层拿到什么|
|账号/目标/权限/路由/幂等/交互/inbox|Store，经应用命令修改|脱敏快照或受限port|
|连接epoch/健康/登录session/订阅/abort|Runtime|只读投影及surfaceVersion|
|宿主任务/会话/运行结果|Host|DTO与事件，不缓存为新权限真相|
|表单草稿/当前页/焦点|UI|提交时转换Command DTO|
|第三方协议游标|Store中provider限定schema|provider只经cursor port访问|
|密钥明文|受限secret resolver临时解析|不进入View/日志/活动/幂等结果|

## 修订顺序与交付门槛

1. 先统一 DTO：入口身份、Provider控制回复、Host typed events、交互引用、effect/inbox、surfaceVersion。
2. 再统一事务：撤权/删除/claim/幂等/游标/历史记录规则；明确外部操作无法撤回的边界。
3. 修复 composition 与任务图：descriptor提前，import早于RPC，所有factory早于最终装配。
4. 合并02/03/04/05/14冲突条款，同步 machine spec；补每条核心旅程的端到端接线表。
5. 最后再更新UI绑定、设计tokens、校验器、manifest和ZIP。不能只在末尾加“以新补充为准”让Flash解决冲突。

完成定义：每个UI动作/IM命令/Host工具都有确定入口、认证上下文、应用命令、持久化/副作用边界、结果DTO、刷新事件、取消与恢复行为；没有“某层自行判断”的缺口。六条P0闭环和全部P1必须落实到规范与任务，不允许带着开放题交给Flash。

本报告未运行验证，不证明协议适配、网络策略、性能或宿主接入已经正确实现，也未完成全包重写。当前成果是可逐条落实的静态设计审查与修订决定。
