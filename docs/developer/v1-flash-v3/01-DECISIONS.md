# 决策表：直接执行，不再选型

|项|唯一决策|
|---|---|
|语言|Node.js >=22 ESM .mjs；公开类型 .d.ts；不引入 TypeScript 编译运行时|
|依赖|生产零强制依赖；可选 @larksuiteoapi/node-sdk=1.73.0、qrcode-terminal=0.12.0；新增 SDK 不允许|
|开发工具|esbuild=0.25.10、@playwright/test=1.55.1；宿主 React external，不打包第二份 React|
|宿主|仅 DSH 0.1.7-rc.2 / @deepseek-ai/cordis ^4.0.1；不维护旧 alpha/rc 矩阵|
|实现目录|v1/src/{domain,services,storage,runtime,providers,host,rpc,security,cli,ui}；v1/test/{unit,integration,protocol,e2e,fixtures}|
|入口|src/plugin-entry.mjs 导出 name/inject/apply；src/cli/main.mjs；dist/client.js|
|生产状态|config.stateDir 绝对路径优先，否则 $DSH_HOME/dsh-notifier-v1，否则 os.homedir()/.dsh/dsh-notifier-v1|
|状态介质|一个 state.json；JSON schemaVersion=1；备份为独立只读文件；不使用数据库|
|实例所有权|一个 stateDir 只允许一个写入 runtime；CLI 通过本地管理端口请求，不直接改活跃状态|
|标识|crypto.randomUUID()；accountId/destinationId/principalId/interactionId 不依赖凭据|
|渠道 ID|28 出站使用 provider-fields.json；额外仅入站 wechat-ilink；qq 入站规范为 qq-bot|
|旧数据|仅 09 的固定白名单导入；其余跳过；无旧数据也可完整使用|
|管理|Native 五页 + 本地 CLI；无 v1 Advanced Console|
|旧功能|本轮不删除；旧源码/旧 API/旧 schema 不成为 v1 的运行依赖|
|UI|宿主模块加载器+宿主 React.createElement；CSS 隔离 .dnv1；esbuild 单文件产物|
|公开服务|ctx.provide('notifierV1', facade)；API version=1；不提供旧 notifier 服务别名|
|工具|notify、notify_test、ask_user 通过目标 Host 注册；同一 profile 禁止同时启用旧 notifier|
|RPC|/dsh-notifier-v1；采用 Host Connection 信封与 admission|
|日志|JSONL metadata-only；不记录正文/密钥/原始 payload；轮转 5MB×3|
|权限|Native/本地管理已认证用户作为 local-owner；IM owner/member 按 02；默认不允许对话|

新模块文件名：domain/{schema,errors,limits,capabilities}.mjs；storage/{store,lock,backup}.mjs；services/{accounts,destinations,principals,pairing,routes,notifications,interactions,conversation,activity,settings,import}.mjs；runtime/{application,manager,event-bus,arbiter}.mjs；host/{dsh,port}.mjs；rpc/{router,server}.mjs；security/{network,secrets,redact}.mjs；providers/{registry,http,specs}.mjs 与每渠道目录；ui/{entry,controller,rpc,strings,theme,components,pages}.mjs。

新增文件必须属于上述目录或TASKS.csv明确新增的文件，按单一职责拆分，不新建第二套 Store/鉴权/路由器。旧协议纯函数可改写到新目录并测新合同，禁止 import ../../src 或 reference/。

不确定性处理：代码内部实现可选最直接符合规格的方法；不得改数据/API/权限规则。外部协议与参考相矛盾时记录 BLOCKERS.md 的源码位置、请求/响应证据、失败测试；不猜协议、不假成功，可继续不依赖该问题的任务，但最终不能称全部完成。绝对消除外部不确定性不现实，规定处理动作比掩盖问题更重要。
