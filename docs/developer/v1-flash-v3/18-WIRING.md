# 装配、状态与权限接线（唯一权威）

## 依赖与构造

domain/descriptors纯函数；storage/security/providers/host实现ports；services只依赖ports；runtime管理连接与进程资源；RPC/CLI/IM/工具只是入口。composition root是唯一导入所有具体实现处，任何模块不可反向import它。
Accounts/Destinations/Connections：Store、Descriptors、SecretCodec、Clock、Ids。
Principals/Pairing/Routes/Settings：Store、Clock、Ids、Policy（纯函数）。
Interactions：Store、HostPort、ControlReplyPort、Policy、Clock、Ids。
Conversation：Store、HostPort、MediaPort、ControlReplyPort、Policy、Clock、Ids。
Notifications：Store、NotificationSenderPort、Policy、Clock、Ids。
Import：Store、Descriptors、ConnectionCommand纯事务函数、有限FileReader。
Diagnostics：ReadProjection、Redactor；Activity：Store只读，写活动由各业务同一事务调用纯appendActivity。
RuntimeManager实现NotificationSenderPort/ControlReplyPort，创建时先提供闭包port、尚未start时返回NOT_READY；此阶段不接受业务请求。manager内部不调用服务定位器，构造后注入唯一inbound handler。服务不持有DSH ctx、SDK、UI、manager实例。

生命周期：创建无IO descriptor/ports → openStore → 构造services/manager/login/projection → 安装Host订阅到有界256事件缓冲 → 查询与恢复交互 → 开启dispatcher并处理缓冲 → 注册工具/Native/CLI → reconcile账号并启用callback/intake。不能在registry构造阶段启动socket。缓冲满停止接收并health degraded，不丢事件假继续。
停止：封闭新写与intake → abort尚未提交请求 → 有限10s等待started效果记录（超时uncertain）→ stop所有provider/login → dispose callback/Host listeners/timers → drain Store → close Store/移除自己nonce的锁及runtime-control文件。每个disposer幂等；部分启动失败按已完成步骤逆序清理。

## 入口身份与命令权限

|入口/角色|允许|
|Native admission确认local-owner、本机Bearer|03全部管理方法；import/backup仅CLI local管理|
|Host进程内facade|可信插件notify/capabilities；不暴露IM或未鉴权网络|
|Host工具|由宿主调用上下文确定session；notify/ask_user；notify_test需local管理标志|
|未配对私聊|/help /whoami /pair CODE，受限回复不能包含会话/待办|
|IM member|/status /tasks /sessions只见sessionIds；/use确切授权ID；/route只读；回答授权pending；/unpair自己|
|IM owner|上述+所有会话observe/answer、/quiet /unquiet当前绑定会话|
|允许对话的owner/member|普通followup/inject、! steer、/stop，仍按会话范围|
|群聊|拒绝全部控制/配对/敏感回复；出站group通知独立|

/help、/whoami可查看自己；/status无绑定时返回账号连接和“请先/use”，不猜session。/tasks、/sessions分页每20项，命令可加page正整数；/use严格完整ID，不用含糊名称或最近活跃。/route只读当前会话通知路径；quiet在Route保存destinationIds=null、quiet=boolean，member拒绝。owner也不能通过IM改凭据/角色/目标。
/approve REF、/reject REF、/answer REF JSON为明确交互回复；JSON={choiceIds?:string[],text?:string}，最大4000码点，解析失败给具体例子且不提交。REF必须绑定当前主体/聊天/交互；只接受按钮token或该语法，不把单独“同意”“1”当审批。

## 十条完整链

1. 新通知：表单descriptor → connections.create → schema+secret normalize → 一次Store提交账号/目标/默认设置/request → projection失效 → UI保存完成 → notifications.test → per-segment effect → provider → receipt → projection → UI准确结果。
2. 扫码：disabled account草稿 → login.start → 单账号LoginManager+SDK/协议 → 校验账号revision未变 → Account命令事务保存凭据/启用 → reconcile → status成功 → 配对。取消/重新扫码使旧session abort；旧结果不得覆盖。进程重启loginId EXPIRED。
3. 配对：Native issue → 哈希持久化 → 仅一次明文 → 已认证私聊/pair → 原子核销建Principal及replyContext → 更新projection → UI显示已配对。先前QR/连接成功不是配对成功。
4. 对话：认证入站 → inbox去重 → 最新Policy+binding → per-session arbiter → 持久correlation/effect.started → Host submit → 真实turn事件 → 原主体最新Policy → ControlReply → 回执。通知route不参与；不同主体抢同会话CONFLICT，同主体忙碌inject归同turn。
5. 待办：Host request → Interaction+目标列表（当前有observe权限、enabled、context有效）→ refs → control card或明确命令文本 → callback/Native settle → 单事务claim → Host settle → 终态 → 使其余refs失效+surface更新 → 各端显示已处理。quiet不屏蔽安全待办。
6. 撤权：更新Principal/Account+policyRevision → 吊销旧refs/重算target/取消无权限correlation → reconcile → 拒绝旧回调。已started效果保留结算证据，不承诺远端撤回。
7. 删除：单事务清活跃外键+references → manager停止intake → finished effect记录历史ID → projection → UI移除连接；不是UI串行删成员/目标。
8. 重启：锁与Store恢复 → revoked pairing/uncertain effects → Host query pending → boot闭包失效则cancelled/未知则unconfirmed → projection → 才允许新业务。
9. callback：Host mount raw request → 平台验签/期限 → normalize → inbox可靠接收 → 平台ACK → dispatcher；管理Bearer路径完全独立。
10. 健康：runtime/login/Host事件或Store提交 → ReadProjection sequence+1 → surface.wait → UI刷新受影响query，保留草稿/旧数据，断线显示stale。

## 并发与副作用

单session arbiter串行决定submit/stop/settle的准入，不持Store mutex等待网络。stop胜出后未claim的该turn交互cancelled；已claim settle先完成或uncertain，后处理stop。Host是最后实际状态权威，Host ALREADY_HANDLED映射同名错误，不能改成成功批准。
request→effects→receipt全部可追踪；effect先started落盘再外部执行。一个request多目的地/分段时每个effect独立，结果聚合：全confirmed=confirmed；全部至少accepted=accepted；部分成功余失败=failed+partial；任一无法确认=uncertain且delivery按已知证据；全部策略跳过=skipped。重试只对已证明未接受的叶子效果，attempt递增；重启started不再执行。账号删除不删除这些历史证据。
配对失败、密码、错误详情统一脱敏；通用serializer不得序列化Store原对象。SurfaceVersion={bootId:随机UUID,sequence:非负整数}，进程内递增；wait以注册监听并再次检查version避免丢唤醒，最多1个/客户端，25s超时返回changed=false；先断开者释放listener。
