/**
 * dsh-session-manager host 核心：session 日志编码、zstd header 读写、文件定位。
 *
 * 目录/文件命名算法同步自 @deepseek-ai/dsh-session-persistence-jsonl v0.1.1-rc.2；
 * zstd 帧解析（scanZstdFrames）与帧级改写逻辑同步自该版本官方实现（含 checksum 帧）。
 * 官方写入 = header 帧 + body 帧（每帧独立 checksum）；迁移只重写 header 帧，
 * body 帧字节原样保留——内容零风险。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { constants, zstdCompress, zstdDecompressSync, createZstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const zstdCompressAsync = promisify(zstdCompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const ZSTD_MAGIC = 4247762216;

// ---------------------------------------------------------------------------
// 编码（与 jsonl 后端一致，绝不能改成不同算法）
// ---------------------------------------------------------------------------

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

export function projectDir(root, cwd) {
  return join(root, projectKey(cwd));
}

export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

// ---------------------------------------------------------------------------
// zstd 帧解析与读写（同步自官方 jsonl 后端）
// ---------------------------------------------------------------------------

/** 官方帧扫描：定位每个完整 frame 的 [start,end)。 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt Zstandard session log: invalid frame magic at byte ' + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('corrupt Zstandard session log: reserved frame-header bit at byte ' + (offset - 1));
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('corrupt Zstandard session log: reserved block type at byte ' + (offset - 3));
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 解压整个日志（全部帧）→ 完整字节。 */
export function readFullZstd(filePath) {
  const raw = readFileSync(filePath);
  const { frames } = scanZstdFrames(raw);
  const parts = frames.map((f) => zstdDecompressSync(raw.subarray(f.start, f.end)));
  return Promise.resolve(Buffer.concat(parts));
}

/** 流式读取首行（header），覆盖多帧；解压到首个换行即停。 */
export function readHeaderSync(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const dec = createZstdDecompress();
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; try { fn(v); } catch (e) { reject(e); } stream.destroy(); dec.destroy(); } };
    stream.on('error', (e) => done(reject, e));
    dec.on('error', (e) => done(reject, e));
    dec.on('data', (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) { try { done((v) => resolve(JSON.parse(v.toString('utf8'))), buf.subarray(0, nl)); } catch (e) { done(reject, e); } }
      else if (buf.length > 65536) done(reject, new Error('session header line too long'));
    });
    dec.on('end', () => { if (!settled) { if (buf.length === 0) done(reject, new Error('session log is empty')); else done((v) => resolve(JSON.parse(v.toString('utf8'))), buf); } });
    stream.pipe(dec);
  });
}

/**
 * 重写 header 帧（body 帧字节原样保留），返回 { buf, lines }。
 */
export async function rewriteHeaderFile(filePath, newCwd) {
  const raw = readFileSync(filePath);
  const { frames } = scanZstdFrames(raw);
  if (frames.length === 0) throw new Error('session log has no zstd frame');
  const headerPlain = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end));
  const nl = headerPlain.indexOf(0x0a);
  if (nl === -1) throw new Error('session log has no header line');
  const header = JSON.parse(headerPlain.subarray(0, nl).toString('utf8'));
  if (typeof header.id !== 'string' || header.id === '') throw new Error('session header has no id');
  const restLine = headerPlain.subarray(nl); // trailing newline byte, if any
  const next = { ...header, cwd: newCwd };
  const newHeaderPlain = Buffer.concat([Buffer.from(JSON.stringify(next), 'utf8'), restLine]);
  const newHeaderFrame = await zstdCompressAsync(newHeaderPlain, CHECKSUM_OPTIONS);
  const bodyStart = frames.length > 1 ? frames[1].start : frames[0].end;
  const out = Buffer.concat([newHeaderFrame, raw.subarray(bodyStart)]);
  return { buf: out };
}

/** 整文件校验：header 字段正确 + body 帧与原文件字节等价（零解码，强校验）。 */
export async function verifyRewritten(filePath, id, cwd, originalRaw) {
  const raw = readFileSync(filePath);
  const { frames } = scanZstdFrames(raw);
  if (frames.length === 0) throw new Error('no frames');
  const first = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end));
  const nl = first.indexOf(0x0a);
  const header = JSON.parse((nl === -1 ? first : first.subarray(0, nl)).toString('utf8'));
  if (header.id !== id) throw new Error('header id mismatch: ' + header.id + ' !== ' + id);
  if (header.cwd !== cwd) throw new Error('header cwd mismatch: ' + JSON.stringify(header.cwd) + ' !== ' + JSON.stringify(cwd));
  if (originalRaw !== undefined) {
    const { frames: of } = scanZstdFrames(originalRaw);
    if (of.length !== frames.length) throw new Error('frame count changed: ' + of.length + ' -> ' + frames.length);
    for (let i = 1; i < frames.length; i++) {
      const a = raw.subarray(frames[i].start, frames[i].end);
      const b = originalRaw.subarray(of[i].start, of[i].end);
      if (!a.equals(b)) throw new Error('body frame ' + i + ' bytes changed');
    }
  }
  return header;
}

/** 在 root 下定位一个会话的日志文件（枚举所有项目目录）。 */
export function locateSessionFile(root, id) {
  const encoded = encodeSegment(id);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cand = join(root, entry.name, encoded, 'session.jsonl.zstd');
    if (existsSync(cand)) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 迁移文件层
// ---------------------------------------------------------------------------

export async function migrateFiles({ root, backupRoot, id, srcCwd, targetCwd }) {
  const oldFile = locateSessionFile(root, id);
  if (oldFile === null) throw new Error(`session log not found under root '${root}'`);

  const oldDir = dirname(dirname(oldFile));
  if (oldDir !== projectDir(root, srcCwd)) {
    throw new Error('session file location (' + oldDir + ') does not match header cwd: ' + JSON.stringify(srcCwd));
  }

  // no-overwrite 门禁：目标已存在同会话文件则拒绝（平台无关的独占语义）
  const newDir = projectDir(root, targetCwd);
  const newSessionDir = join(newDir, encodeSegment(id));
  const newFile = join(newSessionDir, 'session.jsonl.zstd');
  if (existsSync(newFile)) throw new Error('目标工作区已存在同 ID 会话（' + newFile + '），拒绝覆盖');

  // 整目录备份（session.jsonl.zstd + 任何 session-owned companion 文件）+ manifest
  const backupDir = join(backupRoot, id, String(Date.now()));
  mkdirSync(backupDir, { recursive: true });
  const { cpSync } = await import('node:fs');
  cpSync(dirname(oldFile), backupDir, { recursive: true, force: true });
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
    id, srcCwd, targetCwd, at: Date.now(), sourceFile: oldFile,
  }, null, 2), 'utf8');

  const tmp = newFile + '.tmp';
  mkdirSync(newSessionDir, { recursive: true });
  const oldRaw = readFileSync(oldFile);
  const { buf } = await rewriteHeaderFile(oldFile, targetCwd);
  writeFileSync(tmp, buf);
  try {
    await verifyRewritten(tmp, id, targetCwd, oldRaw);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  renameSync(tmp, newFile);
  rmSync(dirname(oldFile), { recursive: true, force: true });
  return { oldFile, newFile, backup: backupDir };
}

export async function rollbackFiles({ root, id, srcCwd, newFile }) {
  const oldDir = projectDir(root, srcCwd);
  const oldFile = join(oldDir, encodeSegment(id), 'session.jsonl.zstd');
  if (existsSync(oldFile)) throw new Error('回滚目标已存在（' + oldFile + '），拒绝覆盖——请人工处理');
  mkdirSync(dirname(oldFile), { recursive: true });
  const tmp = oldFile + '.tmp';
  const { buf } = await rewriteHeaderFile(newFile, srcCwd);
  writeFileSync(tmp, buf);
  await verifyRewritten(tmp, id, srcCwd);
  renameSync(tmp, oldFile);
  rmSync(newFile, { force: true });
  return oldFile;
}