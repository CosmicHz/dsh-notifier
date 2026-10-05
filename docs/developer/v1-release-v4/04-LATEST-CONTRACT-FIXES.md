# 明确收口的合同细节（覆盖对应旧措辞）

1. tasks.list的授权键是TaskView.sessionId；sessions.list的授权键是SessionView.id。owner并非靠sessionIds数组授权，member才受scope约束。bound session必须当前存在且可用。所有Host效果执行前重读Policy。
2. resolveSecret(secret,env,descriptor)必须解码且校验typed值；descriptor不明时拒绝在provider路径解析，不宽松String对象。字符串literal为JSON字符串编码，env字符串原样但类型/长度仍检查；非字符串env解析JSON再校验。
3. Provider.start接收onFatal({code,message})，消息必须脱敏；manager确保fatal/stop/epoch替换优先于start完成，不无条件覆盖ready。onFatal早于start resolve也必须保持degraded。start返回未使用旧句柄立即stop。
4. login capability代表beginLogin扫码流程，只有Feishu/Wechat为true；手动凭据渠道不显示扫码。其他既定能力按冻结证据实现，不靠关false规避。
5. T16已提交，状态是implemented-with-open-recovery而不是planned或全链verified；N/R修复与最终渠道测试关闭后升级verified。旧任务CSV状态不作为继续开发顺序。
6. 工作分支dev；当前dev与main无共同业务历史时，不要求merge。发行包从v1目录构建，许可证完整保留；版本最终1.0.0，旧1.0.0-dev.0只适用于开发中。
7. 唯一活动执行清单REMAINING-TASKS.csv；原任务覆盖表只解释继承关系，不发第二份命令。每次push同步文档，不因任务粒度变化而降低。
