import { encodeSegment, projectKey, rewriteHeaderFile, verifyRewritten, readHeaderSync, migrateFiles, rollbackFiles } from '../lib/migrate.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

const BS = String.fromCharCode(92);
const CODE = 'D:' + BS + '文件存放处' + BS + 'code';
const FL = CODE + BS + 'fake location破解';

console.log('== projectKey / encodeSegment ==');
assert(projectKey(CODE) === '--D-~6587~4EF6~5B58~653E~5904-code--', 'projectKey(code) matches real dir');
assert(projectKey(FL) === '--D-~6587~4EF6~5B58~653E~5904-code-fake~0020location~7834~89E3--', 'projectKey(fake location) matches real dir');
assert(encodeSegment('session-e8388f2b-79de-4169-80e6-92c235a7f036') === 'session-e8388f2b-79de-4169-80e6-92c235a7f036', 'encodeSegment(id) passthrough');
assert(encodeSegment('a b') === 'a~0020b', 'encodeSegment space');
assert(projectKey('C:') === '--C---', 'projectKey drive only');

// 使用真实的最小会话文件（session-524edf4c，fake location 工作区）作为源，全程只在临时目录
const REAL = 'C:/Users/34021/.dsh/sessions/--D-~6587~4EF6~5B58~653E~5904-code-fake~0020location~7834~89E3--/session-524edf4c-d57a-4a50-ae92-07477f71e430/session.jsonl.zstd';
const ID = 'session-524edf4c-d57a-4a50-ae92-07477f71e430';
const work = join(tmpdir(), 'dsh-migrate-test-' + Date.now());
const srcDir = join(work, 'root', '--D-~6587~4EF6~5B58~653E~5904-code-fake~0020location~7834~89E3--', ID);
const bakRoot = join(work, 'backup');
mkdirSync(srcDir, { recursive: true });
copyFileSync(REAL, join(srcDir, 'session.jsonl.zstd'));

console.log('== header read（真实文件） ==');
const h = readHeaderSync(join(srcDir, 'session.jsonl.zstd'));
assert(h.id === ID, 'header id matches');
assert(h.cwd === FL, 'header cwd is fake location');

console.log('== rewriteHeaderFile + verify ==');
const newBuf = rewriteHeaderFile(join(srcDir, 'session.jsonl.zstd'), CODE);
const tmpFile = join(work, 'rewritten.jsonl.zstd');
writeFileSync(tmpFile, newBuf);
const vh = verifyRewritten(tmpFile, ID, CODE);
assert(vh.cwd === CODE, 'verified header cwd=code');
// 行数一致性：源 vs 重写后（应相同，仅 header 值变化）
const srcLines = zstdDecompressSync(readFileSync(join(srcDir, 'session.jsonl.zstd'))).toString('utf8').split(String.fromCharCode(10));
const newLines = zstdDecompressSync(readFileSync(tmpFile)).toString('utf8').split(String.fromCharCode(10));
assert(srcLines.length === newLines.length, 'line count identical (' + srcLines.length + ')');
let tailSame = true;
for (let i = 1; i < srcLines.length; i++) if (srcLines[i] !== newLines[i]) { tailSame = false; break; }
assert(tailSame, 'all event lines byte-identical');

console.log('== migrateFiles（临时 root 全流程） ==');
const moved = migrateFiles({ root: join(work, 'root'), backupRoot: bakRoot, id: ID, srcCwd: FL, targetCwd: CODE, header: h });
assert(existsSync(moved.newFile), 'new file exists at target dir');
assert(!existsSync(join(srcDir, 'session.jsonl.zstd')), 'old file removed');
assert(existsSync(join(bakRoot, ID)), 'backup created');
const backHeader = readHeaderSync(moved.newFile);
assert(backHeader.cwd === CODE, 'migrated header cwd=code');
// 目标目录名正确
assert(dirname(dirname(moved.newFile)) === join(work, 'root', '--D-~6587~4EF6~5B58~653E~5904-code--'), 'target dir name correct');

console.log('== rollbackFiles（回滚演练） ==');
rollbackFiles({ root: join(work, 'root'), id: ID, srcCwd: FL, newFile: moved.newFile });
const rb = readHeaderSync(join(srcDir, 'session.jsonl.zstd'));
assert(rb.cwd === FL && rb.id === ID, 'rolled back header');
assert(!existsSync(moved.newFile), 'rolled back new file removed');

rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED');
process.exit(failed === 0 ? 0 : 1);