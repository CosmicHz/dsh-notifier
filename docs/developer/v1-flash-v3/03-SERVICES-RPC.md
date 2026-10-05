# 新服务、RPC 与命令合同

应用服务最小依赖按18注入，不能 import UI、runtime具体类或DSH ctx。Host/provider为ports，不使用全服务依赖袋。函数均 async，失败抛 DomainError(code,message,details)，router 捕获并脱敏。

Host RPC envelope 使用 frozen control-surface/rpc.mjs 的 client-request/server-response 形状，通道替换 /dsh-notifier-v1。成功 value 内固定 {data,storeRevision,surfaceVersion}；失败 {code,message,details}。code 集合：VALIDATION,NOT_FOUND,CONFLICT,FORBIDDEN,EXPIRED,ALREADY_HANDLED,CAPACITY,UNSUPPORTED,STORAGE_UNAVAILABLE,NETWORK,TIMEOUT,CANCELLED,INTERNAL,UNCERTAIN。CONFLICT.details 仅含 currentRevision，无 secrets。

读请求不用 requestId；所有写请求要求 requestId UUID。幂等key与hash按02，重放前仍认证授权；同key同hash返回脱敏原结果，异hash返回CONFLICT；TTL24h/最多10000。纯配置写的幂等记录与数据一起提交；副作用写先保存 intent、后执行、后保存结果，重启发现未完成 intent 标 UNCERTAIN，不自动再次投递或批准。

分页输入{limit:1..100默认50,cursor?:string}，输出{items,nextCursor,total}。账号/目标/身份/路由按createdAt/id；Activity按time/id；Interaction按expiresAt/createdAt/id；Host列表按id并带snapshotVersion。cursor为base64url的{sortValues,filterHash,snapshotVersion?}，服务端严格校验，不同过滤器VALIDATION，Host快照变更CONFLICT。Host快照以当前排序列表内容hash为版本。

|方法|输入 payload（写请求另含 requestId）|data|
|---|---|---|
|surface.home|{}|{counts:{accounts,destinations,principals},health,pendingCount,recentActivity:最多20条,setup:{notificationSetup,controlSetup},attention:[{kind,accountId?,interactionId?,title,nextAction}]}；setup枚举not-started/incomplete/ready，nextAction为edit-connection/retry-connection/open-inbox/pair-identity|
|surface.wait|{afterVersion:{bootId,sequence},timeoutMs:25000}|{changed,surfaceVersion}；断开abort，bootId不同立即changed|
|channels.list|{}|29 个 canonical 条目及字段/capabilities，无敏感值|
|accounts.list|分页|AccountView 分页|
|accounts.get|{id}|AccountView|
|accounts.create|{channelId,label,enabled?:boolean,config,secretChanges,notificationEnabled,controlEnabled}|AccountView；默认值按02，扫码草稿enabled=false|
|accounts.update|02 更新形状|AccountView|
|accounts.remove|{id,expectedRevision}|{removed:true}|
|accounts.restart|{id,expectedRevision}|{status:'connecting',epoch}|
|destinations.list|{accountId?,...分页}|DestinationView 分页|
|destinations.create|{accountId,label,kind,target,secretChanges}|DestinationView|
|destinations.update|{id,expectedRevision,patch:{label?,target?,enabled?},secretChanges?}|DestinationView|
|destinations.remove|{id,expectedRevision}|{removed:true}|
|notifications.test|{destinationId}|Receipt|
|principals.list|{accountId,...分页}|Principal 分页|
|principals.update|{id,expectedRevision,patch:{enabled?,role?,canConverse?,sessionIds?}}|Principal|
|principals.remove|{id,expectedRevision}|{removed:true}|
|pairing.issue|{accountId,role?:'owner'|'member',canConverse?:false}，默认首owner后member，不允许第二owner|{id,code,expiresAt}|
|pairing.revoke|{id}|{revoked:true}|
|interactions.list|{state?:'pending'|'resolved'|'rejected'|'expired'|'cancelled'|'uncertain',type?,search?,...分页}，state默认pending|脱敏 Interaction 分页|
|interactions.settle|{id,expectedRevision,decision:'approve'|'reject'|'answer',choiceIds?:string[],text?:string}|{state,result}|
|tasks.list|分页|Host TaskView 分页|
|sessions.list|分页|Host SessionView 分页|
|bindings.set|{principalId,sessionId}|{principalId,sessionId}|
|routes.list|分页|Route 分页|
|routes.save|{id?,expectedRevision?,scope,scopeId,destinationIds,quiet}|Route|
|routes.remove|{id,expectedRevision}|{removed:true}|
|activity.list|分页及accountId?/status?|Activity 分页|
|settings.get|{}|settings|
|settings.update|{expectedRevision,patch:{defaultDestinationIds?,quiet?,activityRetentionDays?}}|settings；retention 1..30|
|diagnostics.export|{}|脱敏版本/能力/health/计数/最近100错误元数据|
|login.start|{accountId}|{loginId,status:'pending',qrText?,expiresAt}，每账号一session|
|login.status|{loginId}|{status:'pending'|'succeeded'|'expired'|'cancelled'|'failed',qrText?,expiresAt?,accountId?,errorCode?}，成功只返status/accountId|
|login.cancel|{loginId}|{status:'cancelled'}|

本表全部Native/CLI方法仅local-owner；actor来自Host admission或本机Bearer，payload不可声明身份。IM不访问这些RPC，使用18权限表的受限command。所有write方法由spec/RPC-METHODS.json枚举。配对码/扫码响应标记sensitive-once，重试返回ALREADY_HANDLED，不存明文。

交互回答校验：approval/action 只 approve/reject；question 拒绝或 answer，choiceIds 必须属于 choices；multiple=false 最多1项；text 仅 allowText=true；最多4000码点；无选择且无文本拒绝。原子 claim 后调用 host.settleInteraction，再记录终态。权限/过期/版本在 claim 内检查，host 已处理则 ALREADY_HANDLED。不能以普通聊天文字猜测批准；只接受明确 token/回复来源与编号映射。

出站 route 按 session→agent→workspace→global→settings 默认找第一条非null destinationIds（[]明确停止发送）；quiet 独立按相同顺序找到首个非null值，最后 settings.quiet。指定 destinationIds 的 notify 调用仍受身份/quiet/启用约束；空目的地返回 skipped，不广播到未知目标。
入站会话：显式 binding→该 principal 授权范围内唯一活动 session→否则回复要求 /sessions 与 /use，禁止“最近活跃”猜测导致串会话。
IM命令见18，额外定义/approve REF、/reject REF、/answer REF JSON，不猜普通聊天文字。/route只读，/quiet仅owner改已绑定会话quiet，不可改目标；/unpair只撤自己。普通文本：空闲 followup，忙碌 inject；! 文本为 steer；群聊全部拒绝控制（允许出站 group）。

Public facade {apiVersion:1,notify(input),getCapabilities()}；notify({requestId,title:'',text,level:'active'|'passive'|'timeSensitive',destinationIds?,sessionId?,agentId?,workspaceId?}) 返回 {receipts:Receipt[]}；不输出凭据。公开事件 dsh-notifier-v1/receipt 只含 Receipt metadata。

生命周期：Account 保存后提交 desired revision，异步 reconcile；每次重建随机 epoch，迟到入站/健康/游标事件比较epoch后拒绝，已started effect的完成证据必须收尾。控制连接默认热重启，不需要重启整个 Host；失败 status=degraded，配置仍保存且 UI 可重试。start/stop/dispose 幂等；顺序 stop intake→abort in-flight→close sockets→cancel timers→dispose listeners；不给新 epoch 的事件旧权限。

## 本地管理专有方法（不暴露Host Native通道）

backup.create({requestId})->{path,sha256}；import.preview({file})->09的报告及sourceHash；import.apply({requestId,file,sourceHash})->{imported,skipped,failed,reasons}。这3个方法仅05的loopback/Bearer router注册。Native settings仅提供精确CLI操作说明。diagnostics.export只返回JSON，不带文件系统路径或读取任意文件能力。
Bindings与lockouts/requests表形状见02。notifications.test固定内容title='dsh-notifier v1'、text='Test notification'、level='active'，每次requestId唯一，不能自动后台重发。


## 已合并的连接与运行时接口（原14不再定义）

|方法|输入|data|
|---|---|---|
|connections.create|{requestId,channelId,label,config,secretChanges,notificationEnabled:true,controlEnabled:false,destination:{label,kind,target,secretChanges},makeDefault:boolean}|{account:AccountView,destination:DestinationView}|
|accounts.health|{accountId?}|{items:[{accountId,configuration:complete或incomplete,notificationEnabled,controlEnabled,transport:disabled或connecting或ready或degraded,desiredRevision,appliedRevision,lastError:null或{code,message,time},lastReceipt:null或Receipt,pairedPrincipalCount}],updatedAt}|

connections.create一次事务创建Account+Destination；makeDefault是按ID追加到默认列表（非替换），settings.revision只加一次。事务失败无孤儿；不发送通知，UI成功后单独test。完整凭据不等于平台可达，health.ready仅表示runtime已具备尝试能力。
accounts.restart仅重新连接，不增加配置revision；runtime epoch改变并推进surfaceVersion。配置desiredRevision取Account.revision，appliedRevision是最近成功应用的revision，禁用时也应推进applied。login状态变化、Host能力变化与health都推进surfaceVersion；一次长轮询只做投影通知，不将health写Store。
所有管理写成功都触发投影失效；UI读取新列表/详情时保存各record revision，不能拿storeRevision当expectedRevision。interactions.settle失败的ALREADY_HANDLED/EXPIRED仍刷新列表，正文与失败原因就地保留。
首次使用accounts=0；setup.notificationSetup由启用且字段完整的目标推导；controlSetup由启用完整入站+至少一个有效配对推导。可用会话对话还要求canConverse和binding，这不强迫纯审批用户开启对话。
