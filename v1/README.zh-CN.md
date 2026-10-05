# dsh-notifier v1

> 状态：**实施进行中**。这是 v1 独立重写，尚不是可用发布版；准确任务状态见
> [HANDOFF.md](HANDOFF.md) 与 [docs/PROGRESS.md](docs/PROGRESS.md)。

`dsh-notifier` 在 DSH 0.1.7-rc.2 内，把任务进展通知到 28 个出站渠道，并允许已配对用户
从 6 个入站渠道控制 DSH。

- 用户可见产品名：**通知与控制 / Notify & Control**。
- 包信息：`name=dsh-notifier`、`version=1.0.0-dev.0`、Node.js >= 22、ESM `.mjs`。
- 入口：`src/plugin-entry.mjs`（宿主插件）、`src/cli/main.mjs`（本地 CLI）、
  `dist/client.js`（宿主客户端产物）。

## 目录

```
v1/
  src/{domain,services,storage,runtime,providers,host,rpc,security,cli,ui}
  test/{unit,integration,protocol,e2e,fixtures}
  scripts/            check / test / build / coverage / soak / verify-*
  docs/               integration-guide、architecture、runbook、PROGRESS、DOC-SYNC
```

## 本地开发

需要 Node.js >= 22，并 `npm install` 安装固定 devDependencies（`esbuild`、
`@playwright/test`）。

```sh
npm run check            # 静态一致性门槛
npm run test:unit        # 单元测试
npm run test:integration # 集成测试
npm run test:protocol    # 渠道协议夹具
npm run build            # 打包 dist/client.js + client.js
```

完整发布门槛顺序（`check → test → coverage → build → e2e → soak → verify:pack →
verify:release`）见 [07-ACCEPTANCE.md](../docs/developer/v1-flash-v3/07-ACCEPTANCE.md)。

## 推送前文档门槛

`scripts/hooks/pre-push` 调用 `scripts/prepush_docs_gate.py`。任何推送到 `dev` 之前，
必须按 [v1/AGENTS.md](AGENTS.md) 与
[22-DOC-SYNC-AND-PUSH.md](../docs/developer/v1-flash-v3/22-DOC-SYNC-AND-PUSH.md) 完成
neat-freak 全量同步，并提交 `docs/DOC-SYNC.json`。本任务包不授权推送。

## 文档

- [docs/integration-guide.md](docs/integration-guide.md) —— 宿主/下游如何接入插件、工具、RPC 与 CLI。
- [docs/architecture.md](docs/architecture.md) —— 内部层次如何协作。
- [docs/runbook.md](docs/runbook.md) —— 运维、恢复与排障。
- [CHANGELOG.md](CHANGELOG.md) —— 变更历史。
- [HANDOFF.md](HANDOFF.md) —— 交接给下一个 agent 的当前状态。