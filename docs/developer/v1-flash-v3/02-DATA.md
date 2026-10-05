# 持久数据合同（唯一权威）

普通JSON；拒绝原型键和未知字段，最大深度16，ID为非空<=128字符opaque string，名字1..80码点，普通字段字符串<=8KiB；消息/交互正文例外<=20000码点。UTC毫秒。所有复合键用JSON.stringify(string[])编码，不拆平台ID。记录revision初始0，修改+1；一次Store实际提交全局revision+1。View全部由唯一serializer生成。

根：{schemaVersion:1,revision,accounts:{},destinations:{},principals:{},pairing:{},interactions:{},routes:{},receipts:{},cursors:{},imports:{},bindings:{},lockouts:{},requests:{},effects:{},inbox:{},replyContexts:{},replyRefs:{},correlations:{},settings:{revision:0,defaultDestinationIds:[],quiet:false,activityRetentionDays:7},activity:[]}。
所有普通实体map以id为键；bindings以principalId为键，cursors以accountId为键，lockouts/requests/inbox使用下述复合键，imports以fingerprint为键，不适用“所有map key等于id”的旧规则。

## 实体

- Account={id,revision,channelId,label,enabled,notificationEnabled,controlEnabled,config:{outbound:{},inbound:{}},secrets:{},policyRevision,createdAt,updatedAt}。
- Destination={id,revision,accountId,label,kind:private|group|local|endpoint,target:{},secrets:{},enabled,createdAt,updatedAt}。
- Principal={id,revision,accountId,userId,role:owner|member,canConverse:false,sessionIds:[],enabled:true,replyContextId,createdAt,updatedAt}。每account最多1个enabled owner。首个配对owner，之后member；只能local-owner改权限。
- Pairing={id,accountId,codeHash,role,canConverse,expiresAt,state:active|redeemed|revoked,createdAt}。
- Interaction={id,revision,type:approval|question|action,sessionId,turnId:null|string,hostRef,prompt,choices:[{id,label}],multiple,allowText,targets:[{accountId,principalId,replyContextId,policyRevision}],state:pending|claimed|resolved|rejected|expired|cancelled|uncertain,recovery:live|unconfirmed,expiresAt,claim:null|{effectId,actorKey,at},result:null|{decision,choiceIds,text,code},createdAt,updatedAt}。
- Route={id,revision,scope:session|agent|workspace|global,scopeId,destinationIds:null|string[],quiet:null|boolean,createdAt,updatedAt}。global scopeId='*'；同scope/scopeId唯一。destinationIds=null表示继承，[]显式不发送；quiet=null表示继承。至少一项非null。
- Receipt={id,requestId,destinationId:null|string,accountId,kind:notification|control,status:accepted|confirmed|failed|skipped|uncertain,delivery:complete|partial|none,effectIds:[],providerMessageIds:[],destinationLabel:null|string,errorCode:null|string,createdAt}。历史ID允许目标已删除，不作活跃外键。
- Activity={id,time,kind,accountId:null|string,sessionId:null|string,status,code:null|string}，只有metadata。
- binding={principalId,sessionId,updatedAt}；lockout={failures,lockedUntil,lastAttemptAt}，key=[accountId,userId]。
- request key=[actorKind,actorId,method,requestId]；value={hash,kind:config|effect,status:pending|done|uncertain,result:null|JSON,createdAt,expiresAt}。hash含method与规范化payload。result只存脱敏DTO，不存配对码/QR/secret。
- effect={id,requestKey,accountId:null|string,destinationId:null|string,segmentIndex,attempt,kind:notify|controlReply|hostSubmit|hostSettle|hostStop,status:planned|started|accepted|confirmed|failed|uncertain|cancelled,providerMessageId:null|string,errorCode:null|string,createdAt,updatedAt}。发送正文不进入effect表。
- inbox key=[accountId,eventId]；value={accountId,eventId,status:received|claimed|done|uncertain,receivedAt,expiresAt,effectIds:[]}。不存聊天原文，received重启且原事件不可重取时uncertain；绝不假称接收journal本身足以恢复正文。
- replyContext={id,accountId,userId,chatId,chatType:private,transportData:{},expiresAt:null|number,createdAt,updatedAt}，provider限定schema<=16KiB，可含平台回复上下文秘密，绝不作为RPC View返回。只能经鉴权入站创建/更新；无有效context时控制推送failed/CONTEXT_EXPIRED，UI指引用户发一条私聊刷新。
- replyRef={id,tokenHash:null|string,accountId,principalId,replyContextId,interactionId,interactionRevision,policyRevision,action:approve|reject|answer,messageId:null|string,expiresAt,state:active|used|revoked,createdAt}。卡片发送前存token哈希，messageId返回后补记；按钮token原文不落盘。
- correlation={id,requestKey,accountId,principalId,replyContextId,sessionId,hostRef:null|string,turnId:null|string,state:reserved|active|completed|cancelled|uncertain,createdAt,updatedAt}。同session同时只允许一个发起principal的active/reserved回程；同主体忙时消息关联同turn，不另广播；不同主体返回CONFLICT。
- cursors[accountId]为provider限定对象<=16KiB。imports[fingerprint]={fingerprint,sourceHash,sourceKey,accountId,destinationId,createdAt}，历史引用。

## 字段、秘密与DTO

spec/EDITOR-FIELDS.json固定每字段owner/account或destination、direction、exposure、类型和控件。非public存相应实体secrets；Account secret path为outbound.field/inbound.field，literal的typed JSON编码规则唯一见15，Destination为target.field；平台扫码结果按20映射保存于account inbound秘密。公开config/target不得出现这些值。内部secrets[path]={kind:literal,value:string}|{kind:env,name:string}，env名匹配^[A-Z_][A-Z0-9_]*$。解析失败VALIDATION，值不写日志。
AccountView去secrets，加secretFields:[{path,configured}]、destinationCount。DestinationView同理。InteractionView排除claim.actorKey、targets与hostRef，只给业务可读数据/来源名称、canSettle和disabledReason。所有管理View仅local-owner可读；IM为单独权限过滤结果。
create/update统一secretChanges:[{path,op:set|clear,value?:SecretValue}]；create只允许set。缺席保持，clear明确移除；不能提交星号掩码作为secret。config只含public方向字段，target只含public目标字段。
account create默认enabled=true、controlEnabled=false、notificationEnabled=false；扫码必须显式enabled=false。启用notification需该方向账户凭据完整（不要求已有Destination）；启用control需入站完整。disabled方向允许草稿。patch递归合并plain object、数组替换，null不是删除；只允许label/enabled/notificationEnabled/controlEnabled/config；不可写id/revision/policyRevision/timestamps。

## 原子性、撤权与删除

配置写+幂等result+审计同一事务。权限/开关/入站凭据修改推进Account.policyRevision；仅label不推进。Principal修改/删除同事务推进其Account策略版本。
撤权后待办target重新按当前授权计算；仍授权者刷新target版本并重签replyRefs，旧token一律失效；无授权者移除。无IM target仍可Native处理，不因移除一个target取消整项。Native和IM同一claim入口，claim内检查当前权限、revision、期限和Host活跃状态。
已claim外部操作可能已提交，撤权无法承诺回滚；阻止新claim并abort未提交任务，保留已开始effect收尾证据。旧epoch只丢入站/健康/游标更新，不能丢已执行effect的完成结果。
删除Account原子删destinations/principals/pairing/cursors/bindings/replyContexts，清routes/default引用，吊销replyRefs，取消该账号correlations；移除未claim interaction targets；不中断其他target的Native待办。删除Destination清routes/default；历史Receipt/Activity/effect/import允许悬空ID。删除Principal清binding、replyRefs与correlation。active关系强外键，历史关系非强外键。完成后异步stop其runtime，禁止新的操作准入。

## Store与恢复

openStore(dir)->{status:ready,store,error:null}|{status:degraded,store:null,error}。Store.snapshot()->clone；transact(expectedGlobalRevision|null,syncMutator)->Promise<{revision,value}>；close()->Promise<void>。FIFO mutex；mutator无IO、无await、不重入Store。事务clone→校验→0600同目录临时文件→fsync→close→rename→目录fsync→发布内存。rename前失败不发布；rename后目录fsync失败进入durability-uncertain并停止写，重新读盘核对，不自动重试副作用。
启动用runtime.lock wx/0600，含pid/host/nonce；不自动抢锁。离线restore/unlock同样先取得维护排他所有权，防runtime同时启动；unlock只在同host且kill(pid,0)=ESRCH可移除，EPERM/存活拒绝。损坏/未知schema不清空；degraded只启用诊断与恢复指引。正常备份在Store队列取已提交快照；损坏原文件仅保全为.invalid副本，不能当有效恢复备份。restore先验证新schema，保留旧文件后原子替换。
启动active配对码revoked；started effect/claimed interaction/correlation无法证明结果则uncertain；pending通过HostPort查询。HostRef含旧boot且对应等待闭包已丢失→cancelled；不能确认的外部hostRef→recovery=unconfirmed，禁执行，等待对账/到期。只有明确pending才恢复可执行。

## 限额与保留

账号100/目标500/身份1000/pending交互100；inbox每账号2048/24h；request10000/24h；effect20000/24h；receipt10000/24h；replyRef10000/交互TTL；correlation1000/终态24h；replyContext每principal最多1个另加未配对上下文每账号64/5min；引用缓存每账号256/10min。activity10000/按settings 1..30天默认7天；终态interaction最多1000/24h，届时整条删除（不制造缺必填字段的半记录）。活跃不淘汰，满CAPACITY。
每60s清扫仅变化时提交，优先过期再最旧终态，单事务合并effect/receipt/activity/request/inbox/cursor更新。全state上限32MiB，超限拒绝提交。消息20000码点、最多4附件各10MiB合计40MiB；RPC1MiB；每账号网络并发4、全局16、等待发送256。交互TTL15min但Host更短优先；配对5min，5次失败锁15min；请求effect无自动崩溃重放。自动备份最多10份。正文不进活动、effect、inbox；活跃Interaction正文是唯一明确例外，凭据/平台context存储需0600。

更新Account命令完整形状：{id,expectedRevision,patch,secretChanges:[]}；Destination更新形状见03。secret literal的value按15编码，不直接存typed对象。配对码使用无易混字符的8位随机大写字母数字；hash=SHA256(JSON.stringify([accountId,code]))，返回后不持久保存明文。
