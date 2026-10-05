# R03: 会话列表/停止权限完整执行

**sourceId**: R03  
**commit**: 5c36101  
**validated**: 2026-10-05

## 修复内容

1. **`/sessions` 和 `/tasks` 过滤**
   - owner 可以看到所有会话
   - member 只能看到授权的 sessionIds
   - 使用 `isSessionAuthorized()` 统一检查

2. **`/stop` 权限检查**
   - 检查 `canConverse` 权限
   - 检查会话授权范围
   - 拒绝未授权的停止请求

3. **统一授权逻辑**
   - 创建 `isSessionAuthorized(principal, sessionId)` 辅助函数
   - owner 总是通过（sessionIds 为空或包含 '*'）
   - member 必须在 sessionIds 列表中

## 测试验证

```bash
npm run test:unit -- test/unit/conversation.test.js
```

所有 340 个测试通过，包括新增的授权场景测试：
- member 只能看到授权会话
- owner 可以看到所有会话
- canConverse=false 无法 stop
- member 不能 stop 未授权会话
- `/use` 正确检查授权

## 相关文件

- `v1/src/conversation.mjs` - 添加授权检查
- `v1/test/unit/conversation.test.js` - 新增授权测试
