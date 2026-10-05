# best-effort 导入：明确有限范围

输入 CLI import preview|apply --file <旧JSON路径>。只读一个用户指定文件，不扫描home、不解析旧进程、不修复旧数据、不把import作为启动条件。

唯一接受格式：普通JSON对象中 `channel:<type>:outbound` 的值为普通对象，type为28出站canonical ID。只接受这个canonical前缀；不导入 admin:channel 或 <type>:account，也不导入 YAML。精确正则与来源固定在 spec/IMPORT-KEYS.json。
提取该type字段白名单（EDITOR-FIELDS及FIELD-CONSTRAINTS）；未知字段丢弃并report。没有完整必需字段时整条skip，不生成半配置启用账号。只导入出站账号+一个目的地，controlEnabled=false，所有权限重新配对。group仅作为出站Destination，不给群控制权限。
身份、配对、待办、游标、tokens、routes、未知顶层键一律不导入；用户在新UI重建。没有任何识别键输出 imported=0/skipped及 reason=NO_SUPPORTED_RECORDS，正常进入新配置。
每条sourceKey生成import fingerprint=SHA256(原文件SHA256+sourceKey)，成功导入时同事务记录到state.imports；同fingerprint再导入跳过already-imported；不根据token去推断账号身份。文件内容变更视为新导入，preview必须提示可能重复，apply不得覆盖已有账号。
preview 返回 {supported,items:[{sourceKey,channelId,status:'ready'|'skipped',reason}],counts}，无secret值。apply 重新读取并验证 preview时的source hash（CLI内部先preview），变更返回CONFLICT；所有ready条目一次新Store事务创建，提交失败全不落盘；单条不支持事先skip不影响其他ready。
原文件SHA256前后相同；文件不存在/无权限/坏JSON→skipped报告，不返回“迁移成功”，无写入副作用。不会开发其他旧格式导入，也不改变v1 schema去容纳历史数据。


读取固定上限32MiB，先有限读取一份buffer，再同一buffer计算sha256并parse；深度16、原型键拒绝，超限skipped/INPUT_TOO_LARGE；不重新读取未hash的新内容提交。JSON秘密按15编码；调用Connections纯事务函数，所有ready一起提交，不经RPC自身回调；导入服务不依赖CLI。
导入preview返回sourceHash及每行reason；apply sourceHash不符CONFLICT。变更过的文件导致新fingerprint，预览明确“可能新增重复连接，不会覆盖现有连接”；CLI apply输出此提示但不新增强制交互确认。import操作无秘密值输出。
精确CLI示例：dsh-notifier import preview --file ./old-store.json；dsh-notifier import apply --file ./old-store.json；dsh-notifier backup create；离线dsh-notifier backup restore --file ./backup.json。CLI apply内部preview取得hash，用同一buffer解析结果提交；外部管理apply仍需传sourceHash。
