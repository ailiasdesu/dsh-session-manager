import { encodeSegment, projectKey, rewriteHeaderFile, verifyRewritten, readHeaderSync, migrateFiles, rollbackFiles, readFullZstd } from '../lib/migrate.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

let failed = 0;
function assert(cond, label) {
  if (cond) console.log('  PASS  ' + label);
  else { failed += 1; console.log('  FAIL  ' + label); }
}
const BS = String.fromCharCode(92);
const CODE = 'D:' + BS + '文件存放处' + BS + 'code';
const FL = CODE + BS + 'fake location破解';

console.log('== projectKey / encodeSegment ==');
assert(projectKey(CODE) === '--D-~6587~4EF6~5B58~653E~5904-code--', 'projectKey(code) matches real dir');
assert(projectKey(FL) === '--D-~6587~4EF6~5B58~653E~5904-code-fake~0020location~7834~89E3--', 'projectKey(fl) matches real dir');
assert(encodeSegment('session-e8388f2b-79de-4169-80e6-92c235a7f036') === 'session-e8388f2b-79de-4169-80e6-92c235a7f036', 'encodeSegment passthrough');

const work = join(tmpdir(), 'dsh-migrate-test-' + Date.now());
const BIG = 'C:/Users/34021/.dsh/repair-backup-20260828/session-e8388f2b-79de-4169-80e6-92c235a7f036/session.jsonl.zstd';
const BIG_ID = 'session-e8388f2b-79de-4169-80e6-92c235a7f036';
let haveBig = existsSync(BIG);

console.log('== BIG multi-frame file (38MB, e8388f2b backup) ==');
if (haveBig) {
  const srcDir = join(work, 'root', projectKey(FL), BIG_ID);
  mkdirSync(srcDir, { recursive: true });
  copyFileSync(BIG, join(srcDir, 'session.jsonl.zstd'));
  const h = await readHeaderSync(join(srcDir, 'session.jsonl.zstd'));
  assert(h.id === BIG_ID, 'big header id');
  assert(h.cwd === CODE, 'big header cwd=code (backup)');
  const fullBefore = await readFullZstd(join(srcDir, 'session.jsonl.zstd'));
  const linesBefore = fullBefore.reduce((n, b) => n + (b === 10 ? 1 : 0), 0) + 1;
  console.log('  lines before:', linesBefore, '(multi-frame)');
  assert(linesBefore > 100000, 'multi-frame fully decoded (>100k lines)');
  const oldRaw = readFileSync(join(srcDir, 'session.jsonl.zstd'));
  const { buf } = await rewriteHeaderFile(join(srcDir, 'session.jsonl.zstd'), FL);
  const tmpFile = join(work, 'big-rewritten.jsonl.zstd');
  writeFileSync(tmpFile, buf);
  await verifyRewritten(tmpFile, BIG_ID, FL, oldRaw);
  console.log('  verify OK: header + body frames byte-identical');
} else {
  console.log('  (big backup missing, skip)');
}

console.log('== migrateFiles + rollback (real session copy) ==');
const REAL = 'C:/Users/34021/.dsh/sessions/--D-~6587~4EF6~5B58~653E~5904-code-fake~0020location~7834~89E3--/session-524edf4c-d57a-4a50-ae92-07477f71e430/session.jsonl.zstd';
const ID = 'session-524edf4c-d57a-4a50-ae92-07477f71e430';
if (existsSync(REAL)) {
  const srcDir2 = join(work, 'root', projectKey(FL), ID);
  mkdirSync(srcDir2, { recursive: true });
  copyFileSync(REAL, join(srcDir2, 'session.jsonl.zstd'));
  const moved = await migrateFiles({ root: join(work, 'root'), backupRoot: join(work, 'backup'), id: ID, srcCwd: FL, targetCwd: CODE });
  assert(existsSync(moved.newFile), 'new file exists');
  assert(!existsSync(join(srcDir2, 'session.jsonl.zstd')), 'old removed');
  const backH = await readHeaderSync(moved.newFile);
  assert(backH.cwd === CODE, 'migrated cwd');
  await rollbackFiles({ root: join(work, 'root'), id: ID, srcCwd: FL, newFile: moved.newFile });
  const rb = await readHeaderSync(join(srcDir2, 'session.jsonl.zstd'));
  assert(rb.cwd === FL && rb.id === ID, 'rolled back');
}

rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED');
process.exit(failed === 0 ? 0 : 1);