# 前端定稿与动作接线

结构/样式直接遵循design参考、11、12和tokens；不另选组件库/字体/页面风格。截图示例不是生产数据。五页固定：概览、通知、手机控制、待处理、设置。

## 查询和组件状态

App controller持有server snapshots、surfaceVersion、connectionState、pendingRequests；表单草稿只在组件内存，不将secret存浏览器持久存储。查询key=method+规范payload，任何写成功invalidate下表query；surface.wait changed刷新当前页及home badge，隐藏页暂停等待。首次加载骨架，refresh保留旧数据，disconnect显示stale时间，不能清空成空态。
requestId在一次用户操作开始时生成，网络响应丢失重试同ID；用户明确重新发送test或重新批准新交互才换ID。表单校验失败可修正后新ID；已有effect uncertain不自动重试。交互冲突仍保留文本，刷新后用户重新确认。late response按组件generation丢弃展示，不撤销已保存结果。

|组件/动作|读取|写入及后续|
|---|---|---|
|Overview首次使用/关注项|surface.home|主动作跳通知向导，次动作跳手机控制；attention枚举本地导航，不执行URL|
|通知列表与详情|channels.list/accounts.list/get/health/destinations.list|添加connections.create→notifications.test；编辑accounts.update或destinations.update；测试独立notifications.test；成功刷新列表/home/health|
|新增接收位置|channels.list+account detail|destinations.create，只新建目标；设默认另走带expectedRevision的settings.update，不能默默覆盖|
|暂停通知|accounts.get|accounts.update patch.notificationEnabled；恢复前后端都验证完整凭据|
|删除连接|accounts.get.destinationCount、accounts.health.pairedPrincipalCount|确认取消默认焦点→accounts.remove一次；提醒目的地与配对删除、已提交操作可能完成；失败保留条目|
|手机控制选择连接|channels.list过滤inbound/accounts.list/get/health|手动accounts.create/update开启control；扫码accounts.create(enabled=false)→login.start|
|扫码弹层|login.status每2s仅当前session|取消login.cancel；成功刷新accounts/health；EXPIRED显示重新开始；不由timer猜成功|
|配对弹层|principals.list+账号健康|pairing.issue→显示一次码/5min倒计时→已配对刷新；关闭pairing.revoke，已核销ALREADY_HANDLED只刷新不撤销身份|
|成员详情/对话授权|principals.list/sessions.list|principals.update expectedRevision；会话scope多选，canConverse单独开关；保存刷新待办、成员、home|
|选择对话会话|sessions.list权限内列表|bindings.set；无会话显示“在DSH中打开任务后刷新”，不可默认绑定第一个|
|重连|accounts.health/get|accounts.restart expectedRevision→health connecting；不以RPC成功冒充网络连接成功|
|Inbox列表/详情|interactions.list state/type/search/cursor|settle同一方法；approve/reject/answer严格匹配类型；就地结果+列表刷新；cannotSettle显示disabledReason|
|默认位置/暂停全部|settings.get/destinations.list全分页|settings.update同一revision；默认目标多选不是单选；quiet不影响控制回复|
|发送规则编辑|routes.list/settings.get/destinations.list|routes.save/remove expectedRevision；scope四枚举，scopeId非global必填；destinationIds三态继承/null、明确不发/[]、选定/ids；quiet三态|
|诊断|diagnostics.export|客户端下载JSON，仅元数据；不能下载秘密backup|
|备份/导入|静态CLI指引|提供精确命令，无假上传/恢复按钮；失败例与skip含义固定09|

## 通用控件规格

连接panel桌面560px，最大calc(100%-32px)；<=719px占满可用panel，顶栏固定返回标题，底部保存区不遮字段。ConfirmDialog宽440px；PairingDialog440px；QR登录480px；所有对话框焦点锁定/Esc关闭/关闭回触发器。表单dirty关闭确认只问“放弃未保存的修改？”，取消默认焦点；已保存但test失败不算未保存。
Checkbox目标/会话列表可搜索，50项分页但已选项独立可见；不可因为当前页没有某选项就删掉已选。所有主动作44px命中区，次级图标同样44px；删除始终文字标识，不仅垃圾桶。每页页级主按钮一个。
通知字段两组“连接应用”“发送到哪里”；前6项默认显示，超出折叠；required可见条件切换到未填项时自动展开。枚举显示本地化标签，不暴露raw field key。secret初值为空、旁边“已配置”，可更换/单独清除；secret JSON（headers）也不回显。数组用多行一个值，JSON字段提供语法错误定位。
配对操作以enabled且control ready为前提；ready但未配对显示下一步；已有配对但无canConverse仅“审批可用”，不显示“对话就绪”。账号完全禁用时显示恢复连接，不给失效配对入口。
待办详情按钮顺序：批准primary/拒绝secondary；question为提交回答primary/拒绝secondary；过期/并发处理隐藏可执行区，留结果；recovery=unconfirmed只显示“暂时无法确认请求状态”。

## 固定状态与对应恢复

loading=原结构骨架；empty=一行用途+一个明确主动作；error=就地原因+可执行恢复；stale=旧数据+上次刷新时间；conflict=保留输入+查看最新，禁止自动覆盖；uncertain=先查收/查看任务，再显式确认可能重复；cancelled/expired=重开来源流程，不能对旧ID再批准。
errorRequired文案直接用EDITOR-FIELDS，所有错误aria-describedby关联字段；submit后聚焦第一个错误；组合输入法期间Enter不提交。首屏不要技术码，技术详情可看code/version。中英文strings键一致。
手机布局使用容器宽度，不是window宽度：Inbox<900px列表与详情二选一（返回保留列表位置），不是上下同时塞满；概览<900px单列；通知<720px动作换行；设置<=760px阅读宽度。

## 验收样例数据（固定，不让实施者决定场景）

每页ready fixture：3连接（Telegram正常、Bark通知暂停、飞书连接失败）；2待办（approval与多选question）；7活动。另有全空/100待办/80字符中英名称/4附件/1000身份分页场景。所有fixture凭据synthetic，不包含真实用户标识。
R1允许design样张；R2/R3必须真实UI+本地业务后端，以03接口驱动，不复制preview.js硬编码数据。验收矩阵07/13，设计参考不代表测试通过。
