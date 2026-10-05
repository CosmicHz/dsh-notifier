# DSH 0.1.7-rc.2 固定接入

Host 是唯一需要适配的外部程序。reference/source 的下列文件固定了已知调用形状，按其实际调用接入，不凭函数名猜测：
- client.js：window.__ModuleLoader__.load、factory(require)、宿主 React、slots、locale。
- src/control-surface/rpc.mjs：Connection admission 和 webServer 挂载信封。
- src/tool-register.mjs、host-events.mjs、event-listener.mjs：工具和事件注册。
- src/host/messages.mjs、host/native-questions.mjs、host/capability.mjs：消息/问题/能力。
- src/inbound/conversation.mjs、routing/session-registry.mjs、control/session-arbiter.mjs：会话和控制。
这些边界代码可以提取为新 host/dsh.mjs，只保留 rc.2 路径，消除 legacy store/control imports。目标宿主实际缺能力报 UNSUPPORTED，不能伪造响应。

HostPort完整签名见spec/ports.d.ts，实际DSH映射见20。必须实现list/get、submit、stop、settle、queryInteraction、subscribe、saveAttachment/readAttachment和mountCallback；能力不具备时返回类型化UNSUPPORTED，禁止假成功。subscribe内部事件是v1规范，不可把自创事件名称直接ctx.on。
TaskView={id,label,sessionId,status}；SessionView={id,agentId,workspaceId,label,status:'idle'|'running'|'closed'}。Host IDs opaque，不以字符串拆分推断权限。
缺必需工具/事件服务：插件 health=degraded，错误可诊断，不报告 active。缺 webServer：无 Native，仅 CLI；通知与 Headless Host 支持的控制仍运行。没有窗口不等于可以 mock 宿主。

插件 name='dsh-notifier'；使用 ctx.provide('notifierV1',facade)，释放时调用 returned disposer；不能直接赋 ctx.notifierV1。沿用目标宿主的静态 inject 声明及可选能力机制，参考 apply 的真实注册方法。构造与启动顺序唯一按18；不能在依赖未创建时构造services。进入损坏 state 时只提供诊断/恢复，不注册可执行写操作。
客户端模块 id='dsh-notifier'，面板 key='dsh-notifier-v1'，locale namespace='dsh-notifier.v1'；label 必须 thunk，禁止对象直接作为 React child。dist/client.js 独立单文件，不能 import Node 模块。

## 本地 CLI 管理口

runtime 启动绑定127.0.0.1:0，不接受其他地址；生成32字节随机 token，存 <stateDir>/runtime-control.json（0600）{pid,port,token}。退出删除，token 不写日志。POST /v1/rpc 使用 Bearer 和03 payload；所有方法仅本机 local-owner，1MiB上限。GET 不允许 mutation。runtime-control.json 不进备份。
CLI 用 node src/cli/main.mjs <command>，读取管理口，不能绕开服务层直接写活跃状态。
命令固定：status、diagnostics、accounts list|get|create|update|remove、destinations list|create|update|remove、pairing issue|revoke、principals list|update|remove、routes list|save|remove、notify test、settings get|update、backup create、backup restore、import preview|apply、unlock。
create/update/save 输入只支持 --json-file PATH，避免 secrets 在 shell 参数出现；输出必须脱敏。pairing issue 明文仅该次交互终端打印，不进日志。备份含敏感数据，0600且提示保存路径，不打印内容。
backup restore/unlock 在 runtime 未运行时本地执行；import apply 仅通过活跃新服务提交；没有 runtime 返回可行动错误，不创建内存实例假执行。
同一真实 DSH profile 不能同时启用旧/新 notifier，不在本次自动安装真实 profile。

## 客户端包加载固定处理

宿主元数据沿用模板的 dsh.client，不臆造不存在的entry字段。build除dist/client.js外生成相同字节的包根client.js，用于宿主固定资源发现；package files包含两者，./client export仍指dist/client.js。verify:pack必须校验两个文件SHA256一致，避免开发能用安装后找不到客户端。v1启动config仅允许enabled:boolean（默认true）与stateDir?:绝对路径，其他配置全部走新Store/应用服务；不接受旧channels/admin YAML。


## 工具DTO与可信上下文

notify input={requestId?,title?,text,level?,destinationIds?}；Host工具适配器用调用上下文注入sessionId/agentId/workspaceId，模型不得填写这些scope或actor。未给requestId时由工具callId稳定映射UUID，重试不变。返回{receipts}。
notify_test input={destinationId}，仅Host本地管理工具上下文可用；非管理的模型会话返回FORBIDDEN；调用Notifications.test命令，不绕过quiet或账号开关。
ask_user input={prompt,choices:[{id,label}],multiple?:false,allowText?:true,timeoutMs?:900000}，至少choice或allowText，调用上下文提供session与cancelSignal。建立type=question interaction，等待统一arbiter；返回{status:answered|rejected|expired|cancelled|uncertain,choiceIds:[],text:null|string}。超时/Host取消不返回同意；多端只有一winner。工具await是Host adapter本次进程waiter，重启无法凭旧闭包继续，旧boot hostRef查询为cancelled。
原生approval/request与user-questions/request接同一interaction service，不再各造ledger/权限表。宿主请求的signal取消在claim前取消交互；claim后结果如实记录，不能声称中止已提交操作。
所有工具注册采用冻结tool-register.mjs的真实Host注册shape；完整schema约束由以上DTO及02生成，不保留旧notify API别名。

CLI补齐：accounts restart|health、connections create、login start|status|cancel、bindings set、interactions list|settle、tasks list、sessions list。每个管理命令映射同名03方法；只读命令可用--id/--account-id等普通ID参数，所有write业务payload用--json-file。CLI从stdin可接受--json-file -；敏感返回只输出到交互TTY，重定向时pairing.issue/login.start拒绝输出并说明改用Native或TTY，不记录秘密。程序--help与错误不要求runtime存在。
