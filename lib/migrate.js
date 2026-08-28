/**
 * dsh-session-migrate host 核心：session 日志编码、zstd header 读写、文件定位。
 *
 * 目录/文件命名算法同步自 @deepseek-ai/dsh-session-persistence-jsonl v0.1.1-rc.2
 * （encodeSegment / projectKey / logSuffix / projectDir / sessionDir），
 * 修改该版本后需同步更新本文件对应函数。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// 编码（与 jsonl 后端一致，绝不能改成不同算法）
// ---------------------------------------------------------------------------

/** 会话 id / 任意路径段 → 单段安全目录名（与 encodeSegment 一致）。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** 项目路径 → 人类可读的工作区目录名（与 projectKey 一致）。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** cwd 的会话项目目录（root 下）。 */
export function projectDir(root, cwd) {
  return join(root, projectKey(cwd));
}

/** 一个会话的目录（root 下, id 为原始 "session-…" id）。 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

// ---------------------------------------------------------------------------
// header 读写
// ---------------------------------------------------------------------------

/**
 * 读取 zstd 日志的第一行（header 行）并解析。全量解压后取首行——单会话
 * 迁移场景可接受；多帧 zstd（追加写）由 zstdDecompressSync 完整覆盖。
 */
export function readHeaderSync(filePath) {
  const full = zstdDecompressSync(readFileSync(filePath));
  const nl = full.indexOf(0x0a);
  const first = nl === -1 ? full : full.subarray(0, nl);
  try {
    return JSON.parse(first.toString('utf8'));
  } catch (error) {
    throw new Error('session header parse failed: ' + String(error));
  }
}

/**
 * 重写日志 header 的 cwd 字段，返回新文件内容（zstd 单帧）。
 * 仅改动 header 行；其余事件行字节原样保留（解压→拼接→重压）。
 */
export function rewriteHeaderFile(filePath, newCwd) {
  const full = zstdDecompressSync(readFileSync(filePath));
  const nl = full.indexOf(0x0a);
  if (nl === -1) throw new Error('session log has no header line');
  const header = JSON.parse(full.subarray(0, nl).toString('utf8'));
  if (typeof header.id !== 'string' || header.id === '') throw new Error('session header has no id');
  const rest = full.subarray(nl); // 从换行符开始（含）
  const next = { ...header, cwd: newCwd };
  const out = Buffer.concat([Buffer.from(JSON.stringify(next), 'utf8'), rest]);
  return zstdCompressSync(out);
}

/** 在 root 下定位一个会话的日志文件（枚举所有项目目录，与 jsonl 后端 findLog 等价）。 */
export function locateSessionFile(root, id) {
  const encoded = encodeSegment(id);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cand = join(root, entry.name, encoded, 'session.jsonl.zstd');
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** 整文件校验：用 zstdDecompressSync 读回并解析 header（迁移落位前调用）。 */
export function verifyRewritten(filePath, id, cwd) {
  const full = zstdDecompressSync(readFileSync(filePath));
  const nl = full.indexOf(0x0a);
  const header = JSON.parse((nl === -1 ? full : full.subarray(0, nl)).toString('utf8'));
  if (header.id !== id) throw new Error('header id mismatch: ' + header.id + ' !== ' + id);
  if (header.cwd !== cwd) {
    throw new Error('header cwd mismatch: ' + JSON.stringify(header.cwd) + ' !== ' + JSON.stringify(cwd));
  }
  return header;
}

// ---------------------------------------------------------------------------
// 迁移文件层：备份 → 新位置写入 → 校验 → 落位 → 删旧
// ---------------------------------------------------------------------------

/**
 * 执行文件级迁移：
 * 1. 备份原日志到 backupRoot/<id>/<epoch>/session.jsonl.zstd
 * 2. 重写 header 到目标目录临时文件
 * 3. 校验重写后的文件（header id/cwd 正确）
 * 4. rename 落位 + 删除旧目录
 * 任何失败抛出（临时文件尝试清理）。
 */
export function migrateFiles({ root, backupRoot, id, srcCwd, targetCwd }) {
  const oldFile = locateSessionFile(root, id);
  if (oldFile === null) throw new Error(`session log not found under root '${root}'`);

  // 位置一致性：旧文件应位于 srcCwd 对应的项目目录下（DSH 强校验；不一致说明已损坏）
  const oldDir = dirname(dirname(oldFile));
  if (oldDir !== projectDir(root, srcCwd)) {
    throw new Error('session file location (' + oldDir + ') does not match header cwd: ' + JSON.stringify(srcCwd) + '; 请先修复错位再迁移');
  }

  // 备份（先于任何写操作）
  const backupDir = join(backupRoot, id, String(Date.now()));
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'session.jsonl.zstd'), readFileSync(oldFile));

  // 写入新位置
  const newDir = projectDir(root, targetCwd);
  const newFile = join(newDir, encodeSegment(id), 'session.jsonl.zstd');
  const tmp = newFile + '.tmp';
  mkdirSync(join(newDir, encodeSegment(id)), { recursive: true });
  writeFileSync(tmp, rewriteHeaderFile(oldFile, targetCwd));

  // 校验
  try {
    verifyRewritten(tmp, id, targetCwd);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  // 落位
  renameSync(tmp, newFile);
  rmSync(dirname(oldFile), { recursive: true, force: true });

  return { oldFile, newFile, backup: backupDir };
}

/** 回滚文件层（官方索引同步失败时）：文件回到旧 header/旧位置。 */
export function rollbackFiles({ root, id, srcCwd, newFile }) {
  const oldDir = projectDir(root, srcCwd);
  const oldFile = join(oldDir, encodeSegment(id), 'session.jsonl.zstd');
  mkdirSync(dirname(oldFile), { recursive: true });
  const tmp = oldFile + '.tmp';
  writeFileSync(tmp, rewriteHeaderFile(newFile, srcCwd));
  verifyRewritten(tmp, id, srcCwd);
  renameSync(tmp, oldFile);
  rmSync(newFile, { force: true });
  return oldFile;
}
