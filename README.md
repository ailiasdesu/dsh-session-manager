# dsh-session-manager

> DSH (DeepSeek Harness) 完整会话管理插件：设置面板中**迁移会话**（拖拽/点击，冷热皆可）、
> **归档/恢复**、**彻底删除已归档会话**、**自动清理过期子代理**——全部操作自动备份，安全可逆。
> 零运行时外部依赖；**仅"热迁移"一条路径使用上游内部方法**（详见下面的依赖边界）。

## 功能一览

| 功能 | 说明 | 依赖 |
| --- | --- | --- |
| **会话迁移（冷）** | 磁盘四件套（header 帧 / 文件 / workspace.json / projcache），重启自举收敛 | ✅ 零内部 API |
| **会话迁移（热）** | 内存 header + 磁盘 + 官方索引三方同步，无需重启 | ⚠️ **experimental**（使用上游内部方法）|
| **归档** | 官方公开 API（`archiveSession`）| ✅ 公开 API |
| **恢复已归档** | 磁盘直写 archivedSessionIds（重启自举）| ✅ 磁盘直写（experimental 标注）|
| **彻底删除已归档** | 备份整目录 → 删文件 → 清理全部索引 | ✅ 磁盘直写 + 文件操作 |
| **过期子代理清理** | `delegationDepth>=1` 且闲置 30 天且非运行中 → 自动归档 | ✅ 公开 API |
| **团队状态联动** | 迁移会话时连带搬移 AgentTeams 团队状态（`.agent-teams/`）| ✅ 文件操作 |

## 依赖边界（重要）

本插件对上游（`@deepseek-ai/dsh` v0.1.1-rc.2）的依赖分三类，**只有第三类属于"内部方法"且仅热迁移使用**：

1. **官方公开服务/API**——`webServer`（注册本地路由）、`sessions`（live 查询）、`sessionPersistence`（root）、`workspaceRegistry.list()`、`workspaceRegistry.archiveSession()`、`workspaceRegistry.archivedSessionIds`（公开属性）。
2. **磁盘直写**（`storages/workspace.json`、`session_projcache.json`）——原子 `tmp+rename` + 自动备份；DSH 重启自举时从磁盘收敛（官方 bootstrap 语义）。
3. **上游内部方法**（`workspaceRegistry.indexHeader / attachSession / detachSession`）——**仅"热迁移"分支**使用（运行时内存索引无公开 API 可替代）；已标注 `experimental`，上游提供公开迁移 API 后迁移到公开契约。

> 因此：**"迁移"主路径（冷迁移、重启后自动消费队列、归档/恢复/删除/清理）不依赖任何上游内部 API**；
> 你迁移**任何未打开的会话**走的都是零内部依赖路径。

## 安装

```bash
# 官方标准命令（从 GitHub 安装）
dsh plugin --profile web add github:ailiasdesu/dsh-session-manager#main

# 或本地开发路径
cd ~/.dsh/profiles/web
pnpm add file:../../dsh-session-manager   # 或 pnpm add file:C:/Users/34021/.dsh/dsh-session-manager
```

确认 `profile/package.json` 的 `dsh.profile.bundles` 已包含 `@dsh-external/dsh-session-manager`
（插件自带 `dsh.bundle.patch` 自动应用）。**重启 DSH** 生效。

## 使用

打开 **设置 → 会话管理**：

- **会话列表**：仅显示未归档的活动会话（子代理、已归档自动隐藏）；行 hover 出现 **[归档] [迁移]**；行可**拖拽**到右侧目标工作区
- **点击式迁移**：会话行「迁移」→ 右侧点选目标工作区 → 确认条 → 确认
- **已归档 (N) 折叠区**：展开后每行 **[恢复]** / **[彻底删除]**（红色+确认）
- **右侧目标工作区**：全部已注册工作区（含新创建）

交互约束：
- **●当前**（活动会话）不可归档/迁移/删除
- **正在生成中**的会话：迁移/删除被拒绝（等空闲）
- **打开中（live）**的会话：冷迁移会被**自动排队**（重启后零依赖路径自动完成）；删除被拒绝（存档后需重启再删）
- 全部操作自动备份：迁移 → `~/.dsh/session-migrate-backup/<id>/<epoch>/`（整目录 + manifest）；删除 → `~/.dsh/session-migrate-backup/deleted/<id>/`

## 工作原理

- **会话归属 = 日志 header 的 `cwd`**（DSH canonical 语义；workspace json 的 sessionIds 为持久视图）
- **帧级 zstd 改写**：DSH 日志是多帧 zstd（header 帧 + body 帧，带 checksum）——Node zlib 只解码首帧，
  因此实现移植了官方 `scanZstdFrames`（与 `@deepseek-ai/dsh-session-persistence-jsonl` 一致），
  **迁移只重写 header 帧，body 帧字节原样保留**，并对 header/body 做**字节级校验**（内容零风险）
- **目录命名**：`encodeSegment` / `projectKey` 与官方 jsonl 后端逐字一致（不会触发 DSH corrupt 校验）
- **热迁移**（仅此路径用内部方法）：`header.cwd = 新`（内存对象）→ `indexHeader` → `attachSession` → `detachSession`；失败自动回滚（内存 header + 文件 + 索引）
- **no-overwrite**：迁移/回滚目标已存在同 ID 会话则拒绝（平台无关"先检后写"）

## 架构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | host 插件：REST `/session-manager/api`（list/migrate/archive/unarchive/delete）+ 迁移编排 + 排队/清理调度 + 团队联动 |
| `lib/migrate.js` | 核心：编码（官方算法）、`scanZstdFrames`（官方帧解析）、帧级改写/校验、文件级迁移/回滚 |
| `lib/workspace-files.js` | 磁盘级索引同步：workspace.json 归属移动 / archivedSessionIds / projcache（原子+备份）|
| `lib/client.js` | 浏览器端：设置面板 section（slots 注册，React 壳 + 纯 DOM UI），拖拽 + 点击式 + 归档管理 |
| `tests/unit.mjs` | 合成多帧 fixture + 真实大文件（可选）+ no-overwrite + 迁移/回滚（约 20 项断言）|

## 开发

```bash
node --check lib/index.js && node --check lib/migrate.js && node --check lib/client.js
node tests/unit.mjs        # 全量测试（合成 fixture 机器无关；BIG 真实大文件用例存在才跑）
```

实现为无构建链 ESM（`lib/` 即正式源码；`src/index.ts` 仅 bundle 规范桩）。

## 版本简史

- `v0.1` 会话迁移（拖拽）→ `v0.2` 帧级 zstd（修复多帧截断）+ 热迁移 + 排队 → `v0.3` 社区审查整改（no-overwrite/整目录备份/manifest/合成测试/License）→ `v1.0` **更名 dsh-session-manager**（归档/恢复/彻底删除/子代理清理/团队联动/零内部依赖冷路径）

## License

BSD-3-Clause
