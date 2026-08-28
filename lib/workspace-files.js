/**
 * 磁盘级 workspace 归属同步：直接编辑 storages/workspace.json 与
 * session_projcache.json（原子 tmp+rename + 备份），供零 workspaceRegistry
 * 依赖的迁移路径使用。重启后 DSH 自举（bootstrap/readSessionHeader/重建
 * sessionPaths）从磁盘读取，归属自然收敛正确。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

function atomicWriteJson(p, data) {
  const tmp = p + '.sm-migrate.tmp';
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, p);
}

function backupIfExists(p, backupRoot) {
  if (!existsSync(p)) return;
  const dir = join(backupRoot, 'storages-files', String(Date.now()));
  mkdirSync(dir, { recursive: true });
  cpSync(p, join(dir, p.split(/[\\/]/).pop()), { force: true });
}

/** 更新 workspace.json：把 sessionId 从 oldCwd 工作区移到 newCwd 工作区。 */
export function moveSessionInWorkspaceJson(storageDir, sessionId, oldCwd, newCwd, backupRoot) {
  const p = join(storageDir, 'workspace.json');
  if (!existsSync(p)) return false;
  const data = JSON.parse(readFileSync(p, 'utf8'));
  const tables = data?.tables?.workspaces ?? {};
  let oldKey = null, newKey = null;
  for (const [id, ws] of Object.entries(tables)) {
    if (ws.path === oldCwd) oldKey = id;
    if (ws.path === newCwd) newKey = id;
  }
  if (newKey === null) throw new Error('目标工作区未注册在 workspace.json');
  let changed = false;
  if (oldKey !== null && tables[oldKey].sessionIds.includes(sessionId)) {
    backupIfExists(p, backupRoot);
    tables[oldKey].sessionIds = tables[oldKey].sessionIds.filter((s) => s !== sessionId);
    changed = true;
  }
  if (!tables[newKey].sessionIds.includes(sessionId)) {
    if (!changed) backupIfExists(p, backupRoot);
    tables[newKey].sessionIds.push(sessionId);
    changed = true;
  }
  if (changed) atomicWriteJson(p, data);
  return changed;
}

/** 更新 session_projcache.json：该会话 identity.cwd 同步（投影缓存一致性）。 */
export function updateProjcacheIdentity(storageDir, sessionId, newCwd, backupRoot) {
  const p = join(storageDir, 'session_projcache.json');
  if (!existsSync(p)) return false;
  const data = JSON.parse(readFileSync(p, 'utf8'));
  const rec = data?.tables?.sessions?.[sessionId];
  if (rec === undefined || rec.identity === undefined) return false;
  backupIfExists(p, backupRoot);
  rec.identity.cwd = newCwd;
  atomicWriteJson(p, data);
  return true;
}
