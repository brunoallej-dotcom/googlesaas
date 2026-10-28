import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { checkStorage, clearStorageFatal, isStorageFatal, readCapture, verifyAudit, writeCapture, writeReport, writeSiteObservation } from '../src/lib/link-audit-evidence/store';
import { AUDIT, captureInput, errno, faulty, registerCleanup, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

test('interrupção antes de publicar: nada vira captura, o temporário órfão é só um temporário e a base segue gravável', async () => {
  const base = tmpDir();
  let linkCalls = 0;
  // simula uma queda: o link falha e a limpeza também (o temporário fica no disco)
  const crashing = faulty({
    link: async () => { linkCalls += 1; throw errno('ECONNRESET', 'queda simulada'); },
    unlink: async () => { throw errno('EIO_SIM', 'sem limpeza'); },
  });
  const r = await writeCapture(base, captureInput(), { fs: crashing });
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.equal(linkCalls, 1, 'sem nova tentativa de publicação');
  const names = fs.readdirSync(path.join(base, AUDIT));
  assert.ok(names.every((n) => n.startsWith('.tmp-')), `só temporários: ${names.join(',')}`);
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.captures.length === 0 && v.value.orphanTempFiles.length === 1 && v.value.state === 'INCOMPLETE');
  // depois da queda, uma gravação normal funciona e usa o número 1
  const again = await writeCapture(base, captureInput());
  assert.ok(again.ok && again.value.captureNumber === 1);
});

test('falha de disco comum (ENOSPC): WRITE_FAILED, sem arquivo parcial publicado e sem bloquear a base', async () => {
  const base = tmpDir();
  const full = faulty({ writeExclusive: async () => { throw errno('ENOSPC', 'disco cheio'); } });
  const r = await writeCapture(base, captureInput(), { fs: full });
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.ok(!isStorageFatal(base));
  assert.deepEqual(fs.readdirSync(path.join(base, AUDIT)), []);
  assert.ok((await writeCapture(base, captureInput())).ok, 'ENOSPC não é fatal: a base volta a gravar');
});

test('EIO/EROFS: STORAGE_FATAL, e NENHUMA outra escrita é tentada naquela base', async () => {
  for (const code of ['EIO', 'EROFS']) {
    const base = tmpDir();
    let writes = 0;
    const broken = faulty({ writeExclusive: async (...args) => { writes += 1; if (writes === 1) throw errno(code, 'falha de disco'); return nodeFsOps.writeExclusive(...args); } });
    const first = await writeCapture(base, captureInput(), { fs: broken });
    assert.ok(!first.ok && first.code === 'STORAGE_FATAL', code);
    assert.ok(isStorageFatal(base));
    const before = writes;
    const later = await Promise.all([
      writeCapture(base, captureInput({ body: JSON.stringify({ places: [] }) }), { fs: broken }),
      writeSiteObservation(base, AUDIT, 1, {}, '2026-10-22T12:00:00.000Z', { fs: broken }),
      writeReport(base, AUDIT, 1, {}, '2026-10-22T12:00:00.000Z', { fs: broken }),
      checkStorage(base, { fs: broken }),
    ]);
    assert.ok(later.every((r) => !r.ok && r.code === 'STORAGE_FATAL'), `${code}: ${JSON.stringify(later.map((r) => r.ok ? 'ok' : r.code))}`);
    assert.equal(writes, before, `${code}: nenhuma escrita depois do erro fatal`);
    clearStorageFatal(base);
    assert.ok((await writeCapture(base, captureInput())).ok, 'liberada manualmente (reinício/operador)');
  }
});

test('EROFS no link() de publicação também é fatal; o temporário não fica como captura', async () => {
  const base = tmpDir();
  const ro = faulty({ link: async () => { throw errno('EROFS', 'somente leitura'); } });
  const r = await writeCapture(base, captureInput(), { fs: ro });
  assert.ok(!r.ok && r.code === 'STORAGE_FATAL');
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.captures.length === 0);
  clearStorageFatal(base);
});

test('sem suporte a link() (EPERM): cai na criação exclusiva do arquivo final, que nunca substitui', async () => {
  const base = tmpDir();
  const noLink = faulty({ link: async () => { throw errno('EPERM', 'sem hard link'); } });
  const status = await checkStorage(base, { fs: noLink });
  assert.ok(status.ok && status.value.linkSupported === false);
  assert.match(status.value.notes.join(' '), /não é atômica/);
  const r = await writeCapture(base, captureInput(), { fs: noLink });
  assert.ok(r.ok);
  assert.ok((await readCapture(base, AUDIT, 1, { fs: noLink })).ok);
  // o número 1 já existe: a criação exclusiva não o substitui e a próxima captura segue em frente
  const other = await writeCapture(base, captureInput({ body: JSON.stringify({ places: [], credits: 1 }) }), { fs: noLink });
  assert.ok(other.ok && other.value.captureNumber === 2);
});

test('pré-voo falha com motivo quando a sonda não grava (STORAGE_NOT_READY) e quando a releitura diverge', async () => {
  const noWrite = faulty({ writeExclusive: async () => { throw errno('EACCES', 'sem permissão'); } });
  const r = await checkStorage(path.join(tmpDir(), 'b'), { fs: noWrite });
  assert.ok(!r.ok && r.code === 'STORAGE_NOT_READY');
  const liar = faulty({ readFile: async () => 'outra coisa' });
  const r2 = await checkStorage(path.join(tmpDir(), 'b'), { fs: liar });
  assert.ok(!r2.ok && r2.code === 'STORAGE_NOT_READY');
  const eio = faulty({ mkdir: async () => { throw errno('EIO', 'falha'); } });
  const base = path.join(tmpDir(), 'c');
  const r3 = await checkStorage(base, { fs: eio });
  assert.ok(!r3.ok && r3.code === 'STORAGE_FATAL');
  clearStorageFatal(base);
});

test('pasta da auditoria que é link simbólico é recusada (nada é gravado fora da base)', async () => {
  const base = tmpDir();
  const outside = tmpDir('laout-');
  fs.symlinkSync(outside, path.join(base, AUDIT));
  const r = await writeCapture(base, captureInput());
  assert.ok(!r.ok && r.code === 'UNSAFE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('arquivo corrompido ou grande demais não derruba a leitura: vira CORRUPT/SCHEMA', async () => {
  const base = tmpDir();
  await writeFull(base);
  const file = path.join(base, AUDIT, 'c0001.capture.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, '{"truncado":');
  const r = await readCapture(base, AUDIT, 1);
  assert.ok(!r.ok && r.code === 'CORRUPT');
  fs.writeFileSync(file, JSON.stringify({ outro: 'formato' }));
  const s = await readCapture(base, AUDIT, 1);
  assert.ok(!s.ok && s.code === 'SCHEMA');
  fs.writeFileSync(file, 'x'.repeat(7 * 1024 * 1024));
  const big = await readCapture(base, AUDIT, 1);
  assert.ok(!big.ok && big.code === 'CORRUPT');
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.state === 'CORRUPT');
});

test('leitura da pasta com erro de disco não é tratada como auditoria vazia', async () => {
  const base = tmpDir();
  await writeFull(base);
  const failing: FsOps = faulty({ readdir: async () => { throw errno('EIO', 'falha de leitura'); } });
  const v = await verifyAudit(base, AUDIT, { fs: failing });
  assert.ok(!v.ok);
});
