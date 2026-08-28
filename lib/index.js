/**
 * @dsh-external/dsh-session-migrate host 插件：会话在工作区之间的迁移。
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

export const name = '@dsh-external/dsh-session-migrate';
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

export function apply(ctx) {
  const root = ctx.sessionPersistence?.root ?? '';
  // 备份目录：root 通常为 <home>/.dsh/sessions
  const backupRoot = root.replace(/[\\/]sessions$/, '') + '/session-migrate-backup';

  const workspacesView = () =>
    ctx.workspaceRegistry.list().map((ws) => ({ id: ws.id, path: ws.path, title: ws.title }));

  async function doMigrate(targetId, targetPath) {
    if (typeof targetId !== 'string' || targetId === '') return { ok: false, code: 'invalid', message: '缺少 targetId' };
    if (typeof targetPath !== 'string' || targetPath === '') return { ok: false, code: 'invalid', message: '缺少目标工作区路径' };

    const live = ctx.sessions.get(targetId);
    if (live !== undefined) {
      return {
        ok: false,
        code: 'attached',
        message: '该会话当前在 DSH 内存中（打开或运行中），不能迁移。请先关闭该会话，或重启 DSH 后再迁移。',
      };
    }

    const wsList = ctx.workspaceRegistry.list();
    const targetWs = wsList.find((ws) => sameCwd(ws.path, targetPath));
    if (targetWs === undefined) return { ok: false, code: 'not-found', message: '目标工作区不存在（请先打开该工作区）' };

    // 磁盘 header（绕过 registry 缓存，保证读的是真实文件）
    let header;
    let oldFile;
    try {
      const { locateSessionFile } = await import('./migrate.js');
      oldFile = locateSessionFile(root, targetId);
      if (oldFile === null) return { ok: false, code: 'not-found', message: '找不到会话日志文件：' + targetId };
      header = readHeaderSync(oldFile);
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
      moved = migrateFiles({ root, backupRoot, id: targetId, srcCwd, targetCwd: targetWs.path, header });
    } catch (error) {
      return { ok: false, code: 'io', message: String(error?.message ?? error) };
    }

    // 官方索引同步（失败则回滚文件与索引）
    try {
      await ctx.workspaceRegistry.indexHeader({ id: targetId, cwd: targetWs.path });
      await targetWs.attachSession(targetId);
      const srcWs = wsList.find((ws) => sameCwd(ws.path, srcCwd) && ws.id !== targetWs.id);
      if (srcWs !== undefined) await srcWs.detachSession(targetId);
    } catch (error) {
      let rollbackNote = '；文件回滚失败，请用备份恢复：' + moved.backup;
      try {
        rollbackFiles({ root, id: targetId, srcCwd, newFile: moved.newFile });
        rollbackNote = '；文件已回滚';
      } catch { /* 保留备份提示 */ }
      try {
        await ctx.workspaceRegistry.indexHeader({ id: targetId, cwd: srcCwd });
      } catch { /* 索引回滚失败留给下次启动 bootstrap */ }
      return { ok: false, code: 'io', message: String(error?.message ?? error) + rollbackNote };
    }

    return { ok: true, moved: true, message: `已迁移到「${targetWs.title}」` };
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
        if (action === 'list') return json(res, 200, { ok: true, workspaces: workspacesView() });
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