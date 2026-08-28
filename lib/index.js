/**
 * @dsh-external/dsh-session-manager host 插件：会话在工作区之间的迁移。
 *
 * 迁移语义与官方一致：会话归属权 = 日志 header 的 cwd（workspaceRegistry 的
 * canonical-cwd 索引）。因此迁移 = ①磁盘：改 header.cwd + 文件搬到目标项目目录
 * ②官方：indexHeader → attachSession → detachSession。冷会话迁移后列表即刻生效；
 * 打开/运行中的会话（ctx.sessions 中 live）拒绝迁移（关闭/重启后即可）。
 *
 * REST（仅本机 web UI，鉴权 = body.sessionId 须为 live 会话）：
 *   POST /session-migrate/api  { sessionId, action: 'list' }
 *     -> { ok:true, workspaces:[{id,path,title}] }
 *   POST /session-migrate/api  { sessionId, action:'migrate', targetId, targetPath }
 *     -> { ok:true, moved:true, message } | { ok:false, code, message }
 */
import { migrateFiles, rollbackFiles, projectKey, readHeaderSync } from './migrate.js';
import { moveSessionInWorkspaceJson, updateProjcacheIdentity, unarchiveSession, purgeSession } from './workspace-files.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

export const name = '@dsh-external/dsh-session-manager';
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

const ROUTE = '/session-migrate/api';
const MAX_BODY = 4 * 1024 * 1024;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** 规范化路径等价比较：以 projectKey 编码为准（与 DSH 目录命名等价）。 */
function sameCwd(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  try {
    return projectKey(a) === projectKey(b);
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// 排队自动迁移（attached 会话）：重启 DSH 后由启动钩子消费
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 会话迁移联动：随 captain 会话迁移其 AgentTeams 团队状态（.agent-teams/<id>）
// ---------------------------------------------------------------------------
export function migrateTeamsForSession(srcCwd, targetCwd, targetId) {
  try {
    const srcRoot = join(srcCwd, '.agent-teams');
    const dstRoot = join(targetCwd, '.agent-teams');
    if (!existsSync(srcRoot)) return 0;
    let moved = 0;
    for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const teamJson = join(srcRoot, entry.name, 'team.json');
      if (!existsSync(teamJson)) continue;
      try {
        const team = JSON.parse(readFileSync(teamJson, 'utf8'));
        if (team.captainSessionId !== targetId) continue;
        const srcTeam = join(srcRoot, entry.name);
        const dstTeam = join(dstRoot, entry.name);
        mkdirSync(dstRoot, { recursive: true });
        cpSync(srcTeam, dstTeam, { recursive: true, force: true });
        rmSync(srcTeam, { recursive: true, force: true });
        moved += 1;
      } catch { /* 单个团队失败不影响迁移 */ }
    }
    return moved;
  } catch {
    return 0;
  }
}


// ---------------------------------------------------------------------------
// 过期子代理定时清理（归档式：安全可逆，不删除；不触碰运行中/近期活跃）
// 阈值 CLEANUP_IDLE_DAYS 可调（天）；定时 24h + 启动 90s 后首跑
// ---------------------------------------------------------------------------
const CLEANUP_IDLE_DAYS = 30;
async function cleanupStaleSubagents(ctx, root) {
  try {
    const candidates = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const sub of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const f = join(root, entry.name, sub.name, 'session.jsonl.zstd');
        if (!existsSync(f)) continue;
        try {
          const h = await readHeaderSync(f);
          if ((h.delegationDepth ?? 0) >= 1) {
            candidates.push({ id: h.id, mtime: statSync(f).mtimeMs });
          }
        } catch { /* 跳过损坏样本 */ }
      }
    }
    const cutoff = Date.now() - CLEANUP_IDLE_DAYS * 24 * 3600 * 1000;
    let archived = 0, skippedRecent = 0, skippedRunning = 0;
    for (const c of candidates) {
      if (c.mtime >= cutoff) { skippedRecent++; continue; }
      const agent = ctx.get?.('agents')?.get?.(c.id);
      if (agent?.status === 'running') { skippedRunning++; continue; }
      try {
        await ctx.workspaceRegistry.archiveSession(c.id);
        archived++;
      } catch { /* 单个失败继续 */ }
    }
    ctx.logger?.info?.('[session-migrate] subagent cleanup: scanned=' + candidates.length + ' archived=' + archived + ' recent=' + skippedRecent + ' running=' + skippedRunning);
  } catch (e) {
    ctx.logger?.warn?.('[session-migrate] subagent cleanup error: ' + String(e?.message ?? e));
  }
}

function pendingPath(root) {
  // root = <home>/.dsh/sessions → <home>/.dsh/session-migrate-pending.json
  const base = (root && typeof root === 'string' && root !== '') ? root : join(process.env.DSH_HOME ?? os.homedir(), '.dsh', 'sessions');
  return join(dirname(base), 'session-migrate-pending.json');
}
function readPending(root) {
  try {
    const p = pendingPath(root);
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return []; }
}
function writePending(root, list) {
  const p = pendingPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(list, null, 2), 'utf8');
}
async function drainPending(ctx, root) {
  const list = readPending(root);
  if (list.length === 0) return;
  const remaining = [];
  for (const entry of list) {
    try {
      const res = await doMigrate(entry.targetId, entry.targetPath);
      if (res.ok === true) { ctx.logger?.info?.('[session-migrate] pending migration done: ' + entry.targetId); continue; }
      // attached（重启后仍被占用）：保留待下次；其他错误保留以便重试
      remaining.push(entry);
      ctx.logger?.warn?.('[session-migrate] pending migration kept: ' + entry.targetId + ' (' + res.code + ')');
    } catch (e) {
      remaining.push(entry);
      ctx.logger?.warn?.('[session-migrate] pending migration error: ' + String(e?.message ?? e));
    }
  }
  writePending(root, remaining);
}

export function apply(ctx) {
  const root = ctx.sessionPersistence?.root ?? '';
  const storageDir = join(root.replace(/[\\/]sessions$/, ''), 'storages');
  // 排队自动迁移：启动后消费（此时用户尚未打开会话，目标均为冷会话）
  setTimeout(() => { void drainPending(ctx, root); }, 2500);
  // 过期子代理清理：90s 首跑 + 每 24h
  setTimeout(() => { void cleanupStaleSubagents(ctx, root); }, 90000);
  setInterval(() => { void cleanupStaleSubagents(ctx, root); }, 24 * 3600 * 1000);
  // 备份目录：root 通常为 <home>/.dsh/sessions
  const backupRoot = root.replace(/[\\/]sessions$/, '') + '/session-migrate-backup';

  const workspacesView = () => ({
    workspaces: ctx.workspaceRegistry.list().map((ws) => ({ id: ws.id, path: ws.path, title: ws.title })),
    archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds],
  });

  async function doMigrate(targetId, targetPath) {
    if (typeof targetId !== 'string' || targetId === '') return { ok: false, code: 'invalid', message: '缺少 targetId' };
    if (typeof targetPath !== 'string' || targetPath === '') return { ok: false, code: 'invalid', message: '缺少目标工作区路径' };

    const wsList0 = ctx.workspaceRegistry.list();
    const targetWs0 = wsList0.find((ws) => sameCwd(ws.path, targetPath));
    if (targetWs0 === undefined) return { ok: false, code: 'not-found', message: '目标工作区不存在（请先打开该工作区）' };

    const live = ctx.sessions.get(targetId);
    if (live !== undefined) {
      // A) 运行中：拒绝（正在生成）
      const agent = ctx.get?.('agents')?.get?.(targetId);
      if (agent?.status === 'running') {
        return { ok: false, code: 'running', message: '该会话正在生成中，请等它空闲后再迁移。' };
      }
      // B) 热迁移（attached 但空闲）：内存 header + 磁盘 + 官方索引三方同步，无需重启
      const header = live.header;
      if (header && typeof header === 'object' && Object.isFrozen(header) === false) {
        const srcCwdHot = header.cwd;
        if (typeof srcCwdHot === 'string' && !sameCwd(srcCwdHot, targetWs0.path)) {
          let movedHot;
          try {
            movedHot = await migrateFiles({ root, backupRoot, id: targetId, srcCwd: srcCwdHot, targetCwd: targetWs0.path });
          } catch (e) {
            return { ok: false, code: 'io', message: '文件迁移失败：' + String(e?.message ?? e) };
          }
          try {
            header.cwd = targetWs0.path; // 内存会话对象立即更新（DSH 内核读取即生效）
            await ctx.workspaceRegistry.indexHeader({ id: targetId, cwd: targetWs0.path });
            await targetWs0.attachSession(targetId);
            const srcWsHot = wsList0.find((ws) => sameCwd(ws.path, srcCwdHot) && ws.id !== targetWs0.id);
            if (srcWsHot !== undefined) await srcWsHot.detachSession(targetId);
            const movedTeamsHot = migrateTeamsForSession(srcCwdHot, targetWs0.path, targetId);
            return { ok: true, moved: true, hot: true, message: '✅ 已热迁移（无需重启）：会话已归属「' + targetWs0.title + '」（含 ' + movedTeamsHot + ' 个团队状态），下次对话工作目录自动切换。' };
          } catch (e) {
            // 回滚：内存 header + 磁盘 + 索引
            try { header.cwd = srcCwdHot; } catch { /* ignore */ }
            try { await rollbackFiles({ root, id: targetId, srcCwd: srcCwdHot, newFile: movedHot.newFile }); } catch { /* 备份在 backupRoot */ }
            try { await ctx.workspaceRegistry.indexHeader({ id: targetId, cwd: srcCwdHot }); } catch { /* ignore */ }
            return { ok: false, code: 'hot-failed', message: '热迁移失败（' + String(e?.message ?? e) + '），已自动回滚；请稍后重试或重启 DSH 后迁移。' };
          }
        }
      }
      // C) 兜底：排队（header 不可写等情况），重启后自动完成
      try {
        const list = readPending();
        if (!list.some((e) => e.targetId === targetId && sameCwd(e.targetPath, targetPath))) {
          list.push({ targetId, targetPath: targetWs0.path, targetLabel: targetWs0.title, at: Date.now() });
          writePending(list);
        }
        return {
          ok: false,
          code: 'attached',
          scheduled: true,
          message: '该会话无法立即热迁移，已安排自动迁移：重启 DSH 后自动迁移到「' + targetWs0.title + '」。',
        };
      } catch (e) {
        return { ok: false, code: 'attached', message: '该会话当前在 DSH 内存中；重启 DSH 后再迁移。' };
      }
    }

    const wsList = wsList0;
    const targetWs = targetWs0;

    // 磁盘 header（绕过 registry 缓存，保证读的是真实文件）
    let header;
    let oldFile;
    try {
      const { locateSessionFile } = await import('./migrate.js');
      oldFile = locateSessionFile(root, targetId);
      if (oldFile === null) return { ok: false, code: 'not-found', message: '找不到会话日志文件：' + targetId };
      header = await readHeaderSync(oldFile);
    } catch (error) {
      return { ok: false, code: 'invalid', message: String(error?.message ?? error) };
    }
    if (header.id !== targetId) return { ok: false, code: 'invalid', message: 'session header id 不匹配' };
    const srcCwd = header.cwd;
    if (srcCwd === undefined) return { ok: false, code: 'invalid', message: '会话 header 无 cwd' };
    if (sameCwd(srcCwd, targetWs.path)) return { ok: false, code: 'same', message: '会话已在目标工作区' };

    // 文件级迁移（含备份、校验、落位）
    let moved;
    try {
      moved = await migrateFiles({ root, backupRoot, id: targetId, srcCwd, targetCwd: targetWs.path, header });
    } catch (error) {
      return { ok: false, code: 'io', message: String(error?.message ?? error) };
    }

    // 磁盘级归属同步（零 workspaceRegistry 依赖；重启后官方自举收敛）
    let diskSynced = true;
    try {
      diskSynced = moveSessionInWorkspaceJson(storageDir, targetId, srcCwd, targetWs.path, backupRoot);
      updateProjcacheIdentity(storageDir, targetId, targetWs.path, backupRoot);
    } catch (error) {
      diskSynced = false;
      try { await rollbackFiles({ root, id: targetId, srcCwd, newFile: moved.newFile }); } catch { }
      return { ok: false, code: 'io', message: '归属同步失败（' + String(error?.message ?? error) + '），文件已回滚' };
    }
    const movedTeams = migrateTeamsForSession(srcCwd, targetWs.path, targetId);
    return {
      ok: true,
      moved: true,
      disk: true,
      message: movedTeams > 0
        ? `已迁移到「${targetWs.title}」（含 ${movedTeams} 个团队状态；重启后分组自举）`
        : `已迁移到「${targetWs.title}」（重启后分组自举）`,
    };
  }

  ctx.effect(() => {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTE, 'http://localhost');
        const body = req.method === 'POST' ? await requestBody(req) : {};
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : url.searchParams.get('sessionId');
        if (sessionId === null || sessionId === '') throw new Error('sessionId is required');
        if (ctx.sessions.get(sessionId) === undefined) throw new Error('sessionId is not a live session');
        const action = body.action ?? 'list';
        if (action === 'list') {
          const view = workspacesView();
          return json(res, 200, { ok: true, workspaces: view.workspaces, archivedSessionIds: view.archivedSessionIds });
        }
        if (action === 'archive') {
          if (typeof body.targetId !== 'string' || body.targetId === '') throw new Error('targetId is required');
          await ctx.workspaceRegistry.archiveSession(body.targetId);
          return json(res, 200, { ok: true, archived: true, message: '已归档' });
        }
        if (action === 'unarchive') {
          if (typeof body.targetId !== 'string' || body.targetId === '') throw new Error('targetId is required');
          const ok = unarchiveSession(storageDir, body.targetId, backupRoot);
          return json(res, 200, { ok, archived: false, message: ok ? '已恢复（重启后完全生效）' : '该会话不在归档列表' });
        }
        if (action === 'delete') {
          if (typeof body.targetId !== 'string' || body.targetId === '') throw new Error('targetId is required');
          const archived = [...ctx.workspaceRegistry.archivedSessionIds];
          if (!archived.includes(body.targetId)) {
            return json(res, 200, { ok: false, code: 'not-archived', message: '只能彻底删除已归档的会话（先归档后再删除）' });
          }
          if (ctx.sessions.get(body.targetId) !== undefined) {
            return json(res, 200, { ok: false, code: 'live', message: '该会话当前在 DSH 内存中，不能删除；重启 DSH 后再删除' });
          }
          const agent = ctx.get?.('agents')?.get?.(body.targetId);
          if (agent?.status === 'running') {
            return json(res, 200, { ok: false, code: 'running', message: '该会话正在生成中，不能删除' });
          }
          const id = body.targetId;
          // 定位会话目录（全项目目录扫描）
          let dir = null;
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const cand = join(root, entry.name, encodeSegment(id));
            if (existsSync(cand)) { dir = cand; break; }
          }
          if (dir === null) { purgeSession(storageDir, id, backupRoot); return json(res, 200, { ok: true, deleted: true, message: '会话文件已不存在，索引残留已清理' }); }
          // 备份整目录后删除
          const delBackup = join(backupRoot, 'deleted', id, String(Date.now()));
          mkdirSync(delBackup, { recursive: true });
          cpSync(dir, delBackup, { recursive: true, force: true });
          rmSync(dir, { recursive: true, force: true });
          purgeSession(storageDir, id, backupRoot);
          return json(res, 200, { ok: true, deleted: true, message: '已彻底删除（备份保留在 ~/.dsh/session-migrate-backup/deleted/）' });
        }
        if (action === 'migrate') return json(res, 200, await doMigrate(body.targetId, body.targetPath));
        throw new Error('unknown action: ' + action);
      } catch (error) {
        return json(res, 200, { ok: false, code: 'invalid', message: String(error?.message ?? error) });
      }
    },
  });
  return dispose;
}, 'session-migrate: route');
}