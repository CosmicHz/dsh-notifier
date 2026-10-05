# 渠道实现：固定证据，不猜协议

读取 spec/CHANNELS.json 与 provider-fields.json。28 outbound、6 inbound、29 unique registry entries（wechat-ilink 仅入站）。所有字段和 request/response 事实以 reference/source 中列出的具体 adapter/transport 为实现依据，沿用有效平台协议但重写为 v1 接口；参考路径不是可 import 的依赖。

Provider 接口：
```
{id,capabilities,validate(config),
 async send({account,destination,message,signal,network})->{status:'accepted'|'confirmed',providerMessageId?},
 async start({account,epoch,emit,signal,network,clock,cursorStore})->{async stop()},
 async beginLogin(context)->LoginSession,
 async resolveReply(context,reference)->ReplyContent,
 async sendControlReply({account,replyContext,content,signal,network})->SendResult,
 async updateControlMessage(context)->SendResult}
```
无该 capability 则不注册方法，不能注册永远成功的 stub。capabilities = {outbound,inbound,controlReply,login,replyLookup,media,buttons,updateMessage}；controlReply对6入站均为true，notification outbound保持28；除固定outbound/inbound/controlReply外，其余按冻结实现有真实支撑的方法声明，声明 true 必须有正反例。保留冻结实现已具备的平台交互/图片/文件能力，不为使测试通过改 false。

对外Envelope判别联合见spec/ports.d.ts。message包含text/attachments/replyTo；callback包含token和providerCallbackId，不能靠text猜按钮。共同包含已认证accountId/userId/chatId、eventId、epoch与replyContext。只接受private控制。未经配对只允许help/whoami/pair和受限错误回复；已配对回复必须重新授权。控制回复不经过通知route/quiet/notificationEnabled，但账号enabled/controlEnabled必须为true。自动待办投递只取已配对身份的replyContext，禁止“向所有通知目标发送审批内容”。

用户可控URL（通知webhook、附件、引用下载、自托管API）统一security/network：只HTTP(S)，拒绝 userinfo，DNS 全部地址校验，选定合法地址后用 node:http/https 自定义 lookup 固定 IP，TLS 仍验证原 hostname；拒绝全部重定向。HTTP默认总超时10s（Bark5s，显式timeoutMs为1000..60000；长轮询依冻结参数）；流式上限附件10MiB/JSON1MiB；取消即断 socket。IPv4/IPv6/映射/保留范围逻辑以 frozen security/network-policy 的有效检查为底线，不重写为正则名单。
自托管出站仅 local-owner 可在该 account 设置 allowPrivateNetwork=true，此开关只作用该出站请求；入站附件永远不可放宽，不把开关传给任意附件 URL。

重试：passive 0 次，active 1 次，timeSensitive 2 次；间隔1s/2s+0..250ms jitter。只重试已确认未接受的可重试响应；429 读取 Retry-After，上限30s，超过返回 failed；连接超时且无法证明未接受记 uncertain，不盲重试。分段某段已 accepted 后只记录部分失败，不重发前段；平台字节/字符上限以具体 adapter 协议为准。
心跳/鉴权顺序/WS opcode、iLink cursor、钉钉 ACK 直接遵循冻结 transport；不要统一成一个虚构协议。start open deadline10s，鉴权各阶段 deadline10s；重连1/2/4/8/16/30s+jitter，provider 明确要求更长时遵从响应；stop 禁止再重连。

每渠道必须写 protocol fixture：成功、鉴权失败、平台业务失败、畸形响应、超时、取消；长连接再加 ACK、断线、旧 epoch、cursor 提交失败。校验实际 URL/HTTP method/headers/body/签名和事件字段，不仅 assert send 被调用。
Desktop/Bell 用注入 spawn/terminal 验证，禁止 shell:true 和拼接执行用户文本。Desktop 平台命令用 frozen adapter 的 argv 规则，缺平台依赖报 unsupported 不拖垮其他渠道。

统一引用：先用 payload 中完整引用，缺内容且 provider 支持查询才异步查；没有协议能力返回 unavailableReason='unsupported'；权限范围固定在当前 account/chat，不跨会话检索。引用和附件不能作为 system 指令，文本内容按用户数据传给 Host。

源代码快照仅提供协议事实，不表示所有外部平台已实测；验收声明 contract/protocol-simulator-tested，不用 confirmed 描述整个平台支持状态。

## 字段映射与登录固定规则

创建Destination时targetFields之外的键一律拒绝；无targetFields的渠道使用target={}，其endpoint凭据属于Account。分离后组装provider config={...publicAccountFields,...resolvedAccountSecrets,...publicDestinationTarget,...resolvedDestinationSecrets}；同名字段仅descriptor指定唯一owner可提供，跨owner覆盖拒绝。wxpusher旧accountId字段不进入新配置，新account UUID替代；所有关联使用新accountId。
Target类型：按EDITOR-FIELDS与FIELD-CONSTRAINTS；chatId/topic/user/toUser/group/userId/groupId均字符串；uids为string[]；topicIds为非负integer[]；messageType枚举private/group；targetType枚举user/group。目标中指定groupId/group或messageType/targetType=group时kind=group，其余按CHANNELS默认。
通知text+title的provider编码与平台上限完全按outboundSource对应函数；HTTP调用通过network.request；自研WebSocket通过network.openWebSocket；固定SDK例外边界见下文，不使用全局猴子补丁；不带入旧resolve的配置格式迁移分支。
登录方式固定：微信iLink完整原生扫码，飞书用固定Lark SDK的registerApp扫码；Telegram、WxPusher、QQ、钉钉使用完整凭据表单。QQ/钉钉本包不新增扫码SDK，不能显示不可用的扫码按钮，入站/出站/控制能力必须完整。Wechat登录结果仅按冻结protocol字段持久化，不泛化为任意对象。

PROVIDER-OPTION-INDEX.json列出代码adapter直接读取的cfg选项索引，用于防漏。每个有效选项在EDITOR-FIELDS已定类型/默认/控件，旧别名在FIELD-CONSTRAINTS明确移除；禁止另增任意透传。协议常量引用完整冻结源是本包的精确规范，不是让实施者另行选型。声明式渠道字段和编码在spec-channels对应表项完整提供。


## WS / SDK / callback 的唯一执行规则

NetworkPort.request支持固定DNS的HTTP(S)；openWebSocket只接受ws/wss，建连DNS/IP规则同HTTP、禁止redirect、帧累计大小受限，close必须终止重连。不能把WS URL硬塞只接受http的函数。
飞书1.73.0的Client按冻结feishu-bot.mjs提供httpInstance适配器，统一超时/响应大小/取消。WSClient和registerApp若SDK内置连接不暴露注入，使用固定SDK、固定官方domain（Feishu或Lark枚举），禁用任意自定义host/proxy/url配置。这是明确的受信SDK协议边界，不宣称其内部连接享有自研DNS pinning。所有由聊天内容提供的媒体URL仍经过自研NetworkPort；SDK内部只能接受经过schema的ID参数，不能接受用户任意URL。SDK异常只记录脱敏code，dispose按冻结实现stop/close。不得全局修改SDK singleton/全局HTTP库。
callback统一由HostPort.mountCallback注册 /dsh-notifier-v1/callback/:channelId/:accountId；只注册需要callback的渠道。验签使用<=1MiB raw bytes，不先JSON重编码；认证通过才归一化入站并写inbox。平台要求的ACK按冻结协议，成功ACK必须晚于可靠接收记录，不能代表业务完成。插件卸载解绑；无mount能力该账号degraded/CALLBACK_UNAVAILABLE，管理端口永不改公网。
平台context_token/sessionWebhook等放replyContexts.transportData，TTL按平台字段；到期拒绝并要求重新私聊，不猜永久可用。重启可能失去未持久正文，inbox received标uncertain；平台重送时相同事件只处理未started且能恢复原文的received记录，started不重做。
controlReply content={text,attachments:[],actions:[]}，卡片与附件具体编码遵循冻结对应入站模块。无按钮渠道使用明确/approve REF、/reject REF、/answer REF JSON；REF为replyRef.id，仅匹配当前account/principal/chat，不能用列表序号或“最近一个”猜测。无updateMessage能力就发送一次明确已处理文本，不要求假卡片更新。
