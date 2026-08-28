# dsh-session-manager

> ⚠️ **EXPERIMENTAL**：本插件依赖上游内部方法（`workspaceRegistry.indexHeader`，位于
> `@deepseek-ai/dsh-workspace` v0.1.1-rc.2，非公开契约）。官方迁移 API 出现前，请仅用于
> **可备份恢复的会话**；迁移自动整目录备份（含 session-owned companion 文件与 manifest）
> 且目标 no-overwrite。迁移前请确认会话空闲（非运行中）。


> DSH (DeepSeek Harness) 会话迁移插件：Web UI 设置面板中把会话**拖拽**到目标工作区完成迁移，
> 自动备份、自动回滚、官方 workspaceRegistry 同步。零运行时依赖。

Topics: `dsh-plugin`, `deepseek-harness`, `dsh`

## 安装（标准方式）

```bash
# 方式一：官方标准命令（推荐，从 GitHub 安装）
dsh plugin --profile web add github:ailiasdesu/dsh-session-manager#main

# 方式二：本地开发源码路径
cd ~/.dsh/profiles/web
pnpm add file:../../dsh-session-manager
```

安装后确认 `profile/package.json` 的 `dsh.profile.bundles` 已包含本包（插件自带
`dsh.bundle.patch`，装配层自动应用，无需额外 patch 注册）。**重启 DSH** 生效。

## 使用

1. 打开 **设置 → 会话迁移**（设置面板左侧导航）。
2. 左栏「会话」（来自官方 session.list），右栏「目标工作区」。
3. 把会话行**拖到**目标工作区行 → 确认对话框 → 迁移完成（绿色提示）。
4. `刷新` 按钮重新拉取；迁移结果实时反馈。

## 交互约束

- **当前活动会话**（●当前）不可迁移。
- **已打开/运行中的会话**（DSH 内存中 live）会被拒绝：先关闭会话或重启 DSH 后再迁移。
- 迁移自动备份原日志到 `~/.dsh/session-migrate-backup/<session-id>/<epoch>/`；
  官方索引同步失败时自动回滚文件与索引。

## 工作原理

会话归属权 = 日志头部（header）的 `cwd`（workspaceRegistry canonical-cwd 索引，
见 `@deepseek-ai/dsh-workspace`）。迁移 = 磁盘层（zstd 日志仅重写 header 行改 `cwd`，
事件行字节不变，文件搬到目标项目目录）+ 官方层（`workspaceRegistry.indexHeader →
attachSession → detachSession`）。目录命名算法与
`@deepseek-ai/dsh-session-persistence-jsonl` 完全一致（encodeSegment / projectKey），
不会触发 DSH 的 corrupt 校验。

## 架构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | host 插件：REST `/session-migrate/api`（list / migrate）+ 官方服务编排 + 失败回滚 |
| `lib/migrate.js` | 核心：编码、zstd header 读写（node:zlib 原生）、文件级迁移/回滚 |
| `lib/client.js` | 浏览器端：设置面板 section（slots 注册，React 壳 + 纯 DOM UI，拖放交互） |
| `tests/unit.mjs` | 在临时目录对真实会话副本演练迁移/回滚（`node tests/unit.mjs`） |

## 开发

```bash
node --check lib/index.js && node --check lib/migrate.js && node --check lib/client.js
node tests/unit.mjs          # 全量演练（真实会话副本，不碰真实数据）
```

规范检查：`plugin_check`（bundle 形态，PASS；hub catalog 由官方生态后续接入）。

## License

BSD-3-Clause