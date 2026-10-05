# dsh-notifier v1

> Status: **implementation in progress**. This is the v1 independent rewrite. It is
> not yet a working release; see [HANDOFF.md](HANDOFF.md) and
> [docs/PROGRESS.md](docs/PROGRESS.md) for the exact task state.

`dsh-notifier` delivers task notifications to 28 outbound channels and lets a paired
user control DSH from 6 inbound channels, from inside DSH 0.1.7-rc.2.

- Product name shown to users: **Notify & Control / 通知与控制**.
- Package: `name=dsh-notifier`, `version=1.0.0-dev.0`, Node.js >= 22, ESM `.mjs`.
- Entry points: `src/plugin-entry.mjs` (host plugin), `src/cli/main.mjs` (local CLI),
  `dist/client.js` (host client bundle).

## Layout

```
v1/
  src/{domain,services,storage,runtime,providers,host,rpc,security,cli,ui}
  test/{unit,integration,protocol,e2e,fixtures}
  scripts/            check / test / build / coverage / soak / verify-*
  docs/               integration-guide, architecture, runbook, PROGRESS, DOC-SYNC
```

## Local development

Requires Node.js >= 22 and `npm install` for the pinned devDependencies
(`esbuild`, `@playwright/test`) plus dev-only test tooling.

```sh
npm run check            # static consistency gate
npm run test:unit        # unit tests
npm run test:integration # integration tests
npm run test:protocol    # per-channel protocol fixtures
npm run build            # bundle dist/client.js + client.js
```

The full release gate sequence (`check → test → coverage → build → e2e → soak →
verify:pack → verify:release`) is defined in
[docs/developer/v1-flash-v3/07-ACCEPTANCE.md](../docs/developer/v1-flash-v3/07-ACCEPTANCE.md).

## Push documentation gate

`scripts/hooks/pre-push` calls `scripts/prepush_docs_gate.py` to verify documentation
consistency before any push to `dev`. The hook uses `git rev-parse --show-toplevel` to
locate the repository root, ensuring it works regardless of where Git invokes it.

To install the hook:

```sh
cp v1/scripts/hooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Before any push to `dev`, run the full neat-freak sync described in
[v1/AGENTS.md](AGENTS.md) and
[docs/developer/v1-flash-v3/22-DOC-SYNC-AND-PUSH.md](../docs/developer/v1-flash-v3/22-DOC-SYNC-AND-PUSH.md),
and commit `docs/DOC-SYNC.json`. The hook will reject pushes with:
- Missing or stale `DOC-SYNC.json`
- Mismatched sourceDigest
- Incorrect base commit
- Code changes without accompanying documentation updates

This task package does not authorize a push.

## Docs

- [docs/integration-guide.md](docs/integration-guide.md) — how a host / downstream
  consumer integrates the plugin, tools, RPC, and CLI.
- [docs/architecture.md](docs/architecture.md) — how the internal layers fit.
- [docs/runbook.md](docs/runbook.md) — operations, recovery, troubleshooting.
- [CHANGELOG.md](CHANGELOG.md) — history.
- [HANDOFF.md](HANDOFF.md) — current state for the next agent.