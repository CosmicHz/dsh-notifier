# 打包前一致性审查

- 新代码目录与旧代码边界固定，取消旧API/旧测试/无损迁移前置。
- schema补齐bindings、lockouts、requests，不让实现者临时加第二套状态。
- 旧数据实际canonical键已从源码核实为channel:<type>:outbound，拒绝虚构accounts结构。
- 28出站与6入站路径全部存在，29个canonical registry条目。
- Native RPC及本地专有备份/导入方法分别列明。
- Host客户端根client.js与dist导出同时生成并校验，避免宿主加载路径遗漏。
- 40任务有依赖图；协议任务可在共同基础完成后独立推进。
- release preflight与最终证据检查分开，避免自证循环。
- 导入可全部跳过；新Store写入正确性不能跳过。
- 外部协议真实性、工具版本可获取性、目标Host运行效果仍须实施时验证。本包没有把这些未知事项标为已通过。

verify_bundle.py检查清单、哈希、文件路径、任务依赖和渠道计数。不是实现测试。
