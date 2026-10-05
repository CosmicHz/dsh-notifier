# 最新中途静态审查 · 2eb91c9

只读Git树、提交diff、源文件和记录；未运行测试。仓库报告356 tests pass，是提交者记录，本次不重新背书。卡死/阻塞原因没有进程日志，不能推断；可以确认多份旧交接状态一直并存，容易造成返工。

## 已有进展保留

3308719：literal JSON解码；fb264a4：文档/旧证据补录；263671e：hook路径改为仓库根；8bbac37：会话过滤与stop权限；3d7f6e7：controlEnabled准入、可靠offset与fatal→health；2eb91c9：补交接文件与说明。
R04接纳开关、R05不越未提交水位等代码已经改变，不要求机械重做。最终回归仍须覆盖。

## 当前必须补齐的新发现

### N01 R03仅部分闭合：任务ID、owner路由和最新授权
`v1/src/services/conversation.mjs:135–139`对sessions/tasks共用item.id过滤。TaskView具有独立id及sessionId，任务必须按sessionId筛选；使用会话ID做任务ID比较会隐藏合法任务，也可能因ID偶合暴露不相关任务。
`services/routes.mjs:146–159`仍只看principal.sessionIds，没有owner全会话规则；默认owner空scope虽然/use能绑定，却可能无法发起对话。
`setBinding:146–151`只检查身份存在；/use事务仍引用await前的principal，stop在arbiter排队前校验后没有执行时重查。
固定修复：Policy纯函数统一；task按sessionId，session按id；owner显式binding须对应存在可用Host会话，无绑定只允许唯一活动会话；member按scope。每个写事务/外部调用前读取当前Account和Principal启用/会话/对话授权，不能用闭包旧对象。
验收：taskId≠sessionId、taskId与另一授权session偶合、owner空scope、排队期间撤权/禁用、绑定前后Host会话变化。

### N02 R08解析完成但类型校验未完成
`security/secrets.mjs:102–130`JSON.parse成功即ok，literal分支不使用descriptor；env非string同样未检查解析结果类型。`providers/platform.mjs:11–23`没传descriptor且String(value)，对象可变为[object Object]令牌。Accounts当前主要检查secret路径与存在，不能拦下所有错误typed值。
固定修复：resolver必须拿字段descriptor，在返回值前调用唯一validateFieldValue；string只收string，arrays/headers按字段schema，缺失/无效明确失败，禁止宽松String对象。env每次解析仍校验，值不落盘。更新所有调用点与fixtures，不新增旧raw-string兼容。

### N03 R06可能把提前fatal覆盖回ready
`runtime/manager.mjs`已把onFatal传provider，回调置degraded；但await provider.start返回后仍无条件`connection.state='ready'`。若start在返回前发fatal，后续赋值覆盖错误。
固定修复：只在连接仍为当前epoch且state=connecting、无fatal、未abort时转ready；onFatal为单调状态变化，晚到start不能覆盖；已替换连接的句柄要dispose，避免泄漏。
验收：provider.start同步onFatal再resolve、异步fatal发生在resolve前、停机/重连时迟到start，投影与资源释放一致。

### N04 capability声明不符合实际方法/既定登录方案
`domain/descriptors.mjs:14–21`六个入站都login=true；合同只微信/飞书扫码，其余手动凭据。Telegram声明replyLookup/media等，但相应真实方法与回程附件能力仍需逐项接齐；registry一致性仅比较outbound不够。
固定修复：login=true仅wechat-ilink/feishu，其他false；按钮/媒体/引用按既定协议分别建立能力→方法→测试映射。不能为通过检查关闭合同已要求的媒体/按钮，只能实现缺方法；未实现时最终gate失败。descriptor声明与工厂方法/界面入口必须一致。

## 仍未完成的七项既有修复

- R07：actions统一{label,token}，UTF-8 callback长度，服务生成到实际平台body的接线。
- R09：Telegram callback按真实chat.type拒绝群，可靠接收后的answerCallbackQuery ACK。
- R10：manager默认链注入redeemPairing，/unpair仅撤自己。
- R11：turn/interaction事件仍主要invalidate，原会话回程与待办投递必须实现。
- R12：对话媒体仍有直接转交envelope附件的路径，必须安全下载→Host保存→AttachmentRef。
- R13：控制发送幂等/逐段effect/partial证据，Telegram accepted不伪称confirmed。
- R14：Host已过期请求不续命，期限按Host与默认15min较短者。

## 发行阻断，不是代码行数问题

当前没有完整plugin-entry、host/dsh、runtime/application、RPC、CLI、生产UI页面；package仍1.0.0-dev.0，main/bin指向未完成文件。coverage/soak/verify-pack/verify-release/verify-ux脚本尚缺。T17–21五平台仍缺。
原TASKS.csv仍写T16 planned，PROGRESS却verified；两者需要本包统一。旧计划文件逐项对比本地已交付v3，未发现文件缺失，但这次仍附完整合同和源码快照，避免二次传递漏文件。

## 行数口径

只按v1下源码扩展名逐文件物理行计数：src 72文件/13928行，其中descriptor-data.mjs生成数据2713行；test 38文件/6529行；scripts 4个.js/.mjs/.py文件/248行（另有无扩展名hook）。注释/空行计入，不把reference和docs算产品代码。
小而完整的实现完全可能优秀；此处行数无法证明成熟度，且主要产品入口尚缺。禁止定“必须五万行”等目标；要求RELEASE-MATRIX与REQUIRED-ARTIFACTS以及全部行为门槛满足。
