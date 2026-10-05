# 验收命令与断言

所有命令在 v1/。T00 写入 package scripts，后续任务补实现，未实现的检查必须失败，不能 echo PASS。

npm run check = node scripts/check.mjs：递归 node --check src/**/*.mjs（UI不含JSX）、禁止 legacy/reference imports、schema/RPC/locale一致性。
npm test = node scripts/test.mjs unit integration protocol：显式枚举目录 node --test，无外部网络，测试使用loopback。父测试结束清理临时数据。
npm run test:unit = node scripts/test.mjs unit。
npm run test:integration = node scripts/test.mjs integration。
npm run test:protocol = node scripts/test.mjs protocol。
npm run build = node scripts/build.mjs：esbuild client entry，React来自 require，生成dist/client.js。
npm run test:e2e = playwright test：测试配置启动真实 v1 服务+模拟Host容器；生产服务不替换，外部provider替换loopback。
npm run test:coverage = node scripts/coverage.mjs：Node22 --experimental-test-coverage，读取覆盖结果并对v1核心src/domain,storage,security,services执行行>=95/分支>=90；不能排除失败模块。
npm run test:soak = node scripts/soak.mjs --minutes 120：真实计时运行本地provider并周期断线/取消/更换epoch。
npm run verify:release = node scripts/verify-release.mjs：schema/RPC/渠道数/entry/CLI/build产物/locale/无legacy与secrets/测试证据commit一致，任一缺失非0。
npm run verify:pack = node scripts/verify-pack.mjs：npm pack --json到临时目录，解包核查files白名单并在隔离目录安装，import公开入口/运行CLI --help，不向真实宿主安装。

package files 白名单 src（排除test helpers）、dist/client.js、client.js、types、cordis.patch.yml、README.md、README.zh-CN.md、LICENSE、THIRD_PARTY_NOTICES.md。test/reference/legacy/runtime数据不进包。构建依赖不要求安装到终端用户机器。

固定核心测试：
S01 两个并发CAS一个成功一个CONFLICT；S02写盘失败不更新内存；S03损坏state不覆盖；S04实例锁拒绝第二个写者；S05备份恢复读取正确。
A01凭据轮换ID不变；A02开关patch保留其他字段；A03跨账号同userId隔离；A04删除账户关联清理；A05查询/日志无secrets。
P01同配对码并发仅一次；P02跨账号/到期/锁出拒绝；P03配对落盘失败无授权；P04撤权旧回调失效。
C01 Native+IM同时答仅一次Host执行；C02超时不批准；C03Host不确定结果标uncertain且不重放；C04stop/answer/steer仲裁；C05group拒绝控制。
N01 IPv4/IPv6/映射/保留/非HTTP拒绝；N02DNS先合法后私网不能二次解析；N03redirect拒绝；N04无Content-Length超大流中止；N05取消释放socket；N06自托管开关不放宽附件。
D01部分分段不重发；D02accepted不冒充confirmed；D03限流/队列上限；D04失效epoch不提交游标；D05重启不重复副作用。
I01支持格式部分导入；I02损坏/未知全部skip并可新配置；I03原文件字节不变；I04重复导入幂等；I05导入失败不污染新状态。
U01-U12固定如下，不依赖历史纲要。
每个CHANNELS条目P-<id>-out成功/错误/超时/取消；入站P-<id>-in鉴权/规范化/重连/epoch。测试必须检查实际协议内容，不是assert函数被调用。

发布前 commands 按 check→test→coverage→build→e2e→soak→verify:pack→verify:release；产物 evidence/results.json 记录git SHA、Node/OS、命令、退出码、时间、报告路径。没有证据不得标verified。非真机不影响这些门槛。

单任务故障处理：修复导致失败的新代码，重跑针对性测试；不得降低覆盖、替换业务为Mock或删断言。外部真实矛盾按08处理，保留失败测试，不用任意3次重试上限。

release verifier 的 --preflight 仅验证产物/文档/命令和证据文件形状，不要求T39结果；T39默认模式核对check/test/coverage/build/e2e/soak/pack均为当前源提交证据，不要求自身先有成功记录，结束后追加自身结果，避免循环依赖。源提交计算排除evidence生成物，源码有变必须重跑受影响检查和最终gate。

npm run verify:ux = node scripts/verify-ux.mjs：检查13定义的三轮截图/观察/修正记录、当前commit、零未关闭阻断/高缺陷及评分依据；不自动从像素差推断审美分数。verify:release默认模式必须调用verify:ux，preflight只检查脚本/证据结构。


U01首次设置/真实本地test回执；U02新状态重启+备份恢复+可选导入全skip；U03配对→对话→同聊天回程；U04Native/IM并发结算仅一次；U05followup/inject/steer/stop仲裁与不串会话；U06换密钥/禁用/撤权后旧事件拒绝；U07引用附件准入与失败；U08断线重连/health刷新/去重；U09磁盘失败/损坏只读与恢复；U10多账号同userId隔离；U11无SDK/headless保持可用功能与精确诊断；U12中英深浅/窄屏/键盘/100待办分页。
W01–W35测试需求完整见spec/WIRING-CASES.json，以对应当前定稿条款为断言，不照旧审查建议中的已经修订措辞生成另一套实现。必须每项有至少一个行为或静态依赖断言；不能只assert文件存在。
性能：UI反馈p95<=100ms、缓存tab<=200ms、Host依赖就绪后控制面可用<=500ms；本地读RPC<=100ms、持久写<=200ms（外部网络另计）。100次启动释放后listeners/timers/socket归零；120min soak稳定负载无持续增长；记录硬件/样本数/分位，不通过降低耐久性换指标。
阶段任务只执行已有范围的具体tests，报告列出文件；禁止未来任务未实现导致现在门槛永久阻塞，也禁止空测试PASS。最终npm test显式枚举所有应有case及渠道矩阵，缺项失败。
