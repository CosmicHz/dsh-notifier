# 冻结宿主/平台事实到v1端口的映射

参考根reference/source，基线9d69dd7a8908fcfec6e20d92d56509764a8f23ec。路径是协议依据，不是允许import旧控制栈。本文件明确已知事实与新内部接口，不臆造DSH API。

|新接口/事件|冻结来源与实现规则|
|---|---|
|Host订阅|src/host-events.mjs 的session/event参数tuple/envelope规范化；仅保留目标rc.2实际支持shape，注册与dispose成对|
|turn.started|src/event-listener.mjs 的turn/start，session.id和event.data.turn；ID保持opaque|
|turn.output|同文件assistantTextOf，assistant/message.data.message.content的text块；event.data.turn/step关联；多块按顺序，禁止读取已移除session.events|
|turn.completed/failed|turn/end；reason.kind=error转failed，其余转completed；未知reason保留脱敏code，不推断成功|
|会话结束|src/inbound/conversation.mjs 的agent/disposed，过滤会话归属，不使用最近活跃猜测|
|submit|src/inbound/conversation.mjs deliverToAgent路径，agent.followup/inject/steer真实payload，attachments/message构造见src/host/messages.mjs|
|stop|src/control/session-arbiter.mjs及conversation的stop路径；只目标session，不全局停止|
|原生审批|src/approval/router.mjs的approval/request waiter，保存agent/toolName/callId/reason/signal，返回宿主期望裁决；不能用approval/asked通知事件伪造审批waiter|
|原生问题|src/host/native-questions.mjs的user-questions/request接入与src/questions/router.mjs；使用真实请求/回答shape，丢弃旧ledger|
|ask_user|src/tool-register.mjs的工具注册shape；本包新DTO由05定义|
|附件|conversation的宿主attachment保存/消息块构造；没有读取能力时readAttachment明确UNSUPPORTED，不暴露任意文件路径|
|Native admission|src/control-surface/rpc.mjs的Connection认证与webServer资源挂载；角色不从payload取|
|callback mount|src/inbound/http-callback.mjs的webServer挂载生命周期/原始请求；具体WxPusher鉴权见wxpusher-callback.mjs|
|客户端|client.js的__ModuleLoader__.load/factory(require)/slots/locale，宿主React唯一实例|

hostRef由v1 adapter生成 `bootUUID:waiterUUID`，不拆平台ID。原生审批/问题/ask_user的resolver只存内存waiter map。queryInteraction：当前boot且map live→pending，已结算tombstone→resolved/cancelled；旧boot且前缀为本插件格式→cancelled（等待闭包不存在）；外部opaque ref未知→unknown。目标rc.2固定interactionRecovery=process-only；不得承诺跨进程恢复已消失的宿主请求，也不为恢复而自动重放批准。Native可见取消原因“运行环境已重启，请在任务中重新发起请求”。将来queryable宿主不是本轮任务。

对话回程：同session的arbiter安装监听并持久reserve之后才调用followup；turn/start绑定保留的correlation。忙时inject/steer绑定当前Host报告的turn，只允许该correlation主体；无法取得或唯一关联turn则CONFLICT，不猜最近任务。收到完整assistant/message时缓存当前turn最后一条完整回答（<=20000码点）；turn/end一次发送它，有多附件则按既有分段规则；没有正文只发“任务已结束，请在DSH查看结果”，明确无正文，不称消息丢失已恢复。缓存不作为日志，重启丢失则correlation uncertain，不把后续另一个turn路由给旧用户。

## 六个控制回复的协议入口

|渠道|冻结来源|回程/登录规则|
|---|---|---|
|telegram|src/inbound/telegram-bot.mjs|sendMessage/callback ACK/引用和媒体；token源inbound，不借用通知方向secret；无扫码|
|feishu|src/inbound/feishu-bot.mjs、_feishu-register.mjs|Client消息create/patch与WS dispatcher；SDK registerApp的onQRCodeReady({url,expireIn})；结果appId/appSecret存inbound；也提供手动表单|
|wechat-ilink|src/inbound/wechat-ilink.mjs、_ilink-api.mjs|context_token/轮询cursor/媒体字段严格取冻结函数；beginLogin结果只写冻结凭据字段，notification outbound=false不影响控制回复|
|qq-bot|src/inbound/qq-gw.mjs|QQ消息回复需冻结msg_id/seq规则及鉴权/网关ACK；本轮手动AppID/AppSecret，无扫码按钮|
|dingtalk|src/inbound/dingtalk-stream.mjs、_dingtalk-auth.mjs|Stream ACK与sessionWebhook期限；手动AppKey/AppSecret，无扫码按钮|
|wxpusher|src/inbound/wxpusher-callback.mjs|callback鉴权与入站UID回程；appToken只在受限resolver使用，不作为新accountId|

登录超时：飞书按冻结5分钟/平台expireIn较短者；微信按冻结qr过期时间。LoginManager最大5分钟，取消后旧结果不得提交；底层SDK无取消接口时独立worker进程执行该登录，结束/超时terminate worker，秘密不进argv/日志（IPC传入）。worker仅用于不可取消SDK调用，不加持久服务。SDK WS固定domain信任边界见04。

外部事实如果与冻结版本有实证冲突：记录具体文件/函数/请求响应差异；不在内部接口之间制造第二个兼容层。本包不以凭空新增Host查询/SDK注入接口掩盖能力缺失。
