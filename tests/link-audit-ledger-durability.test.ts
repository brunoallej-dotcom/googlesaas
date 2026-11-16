import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DURABILITY_UNPROVEN_MESSAGE } from '../src/lib/link-audit-storage';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, entryPath, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * R7-04 — FSYNC E DURABILIDADE no PROTOCOLO (não só na resposta HTTP). Três resultados distintos:
 *   DURÁVEL ............................ sucesso: entrada, recibo e livro sincronizados (diretórios e, na criação, o diretório-PAI);
 *   RECUPERÁVEL E PENDENTE ............. `ANCHOR_PENDING` (recibo não gravado): o reenvio conclui;
 *   DURABILIDADE DESCONHECIDA .......... `DECISIONS_DURABILITY_UNKNOWN`: nunca sucesso; a base trava; depois do reinício o MESMO pedido só conclui depois de SINCRONIZAR DE NOVO.
 * Falha de fsync por injeção de falha E em processo filho real (reinício de verdade); nenhum armazenamento real é tocado.
 */
registerCleanup();
const syncLogOf = (): string => path.join(tmpDir('lad-synclog-'), 'sync.log');
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const auditDirs = (w: LedgerWorld) => ({ decisions: path.join(w.decisionsDir, w.auditId), anchors: path.join(w.anchorDir, w.auditId), ledger: path.join(w.ledgerDir, w.auditId) });

test('RETOMADA depois de falha de fsync (processo REAL reiniciado): o MESMO pedido só conclui depois de sincronizar de novo a pasta que falhou — decisões, recibos ou livro —, nunca devolve sucesso sem isso', async () => {
  for (const folder of ['decisions', 'anchors', 'ledger'] as const) {
    const w = await ledgerWorld();
    const failed = await runChild(w, null, { task: 'create', resend: true, failSync: folder, actor: 'ana@empresa.com' });
    assert.equal(failed.line?.ok, false, `${folder}: sem durabilidade comprovada NÃO é sucesso (${JSON.stringify(failed.line)})`);
    assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN', `${folder}: resultado próprio`);
    assert.ok(!(await ledgerEvents(w)).includes('CONFIRMED'), `${folder}: o livro não confirmou`);
    // reinício com disco saudável, registrando cada diretório sincronizado
    const log = syncLogOf();
    const resumed = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com', staleOperationMs: 1 });
    assert.equal(resumed.line?.ok, true, `${folder}: ${JSON.stringify(resumed.line)} ${resumed.stderr.slice(0, 200)}`);
    const synced = read(log);
    const dirs = auditDirs(w);
    for (const [name, dir] of Object.entries(dirs)) assert.ok(synced.includes(dir), `${folder}: a retomada sincronizou a pasta ${name} (log: ${synced.map((d) => path.basename(path.dirname(d)) + '/' + path.basename(d)).join(', ')})`);
    const events = await ledgerEvents(w);
    assert.equal(events.at(-1), 'CONFIRMED', `${folder}: ${events.join()}`);
    const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.decisions.length, view.history.length], ['PROTECTED', 1, 1], `${folder}: uma decisão, sem duplicata`);
  }
});

test('falha de fsync no PAI de uma pasta recém-criada: nada é dado como feito (nem INTENT, nem entrada) e, reiniciado com disco saudável, o mesmo pedido conclui', async () => {
  for (const folder of ['decisions', 'anchors'] as const) {
    const w = await ledgerWorld();
    const failed = await runChild(w, null, { task: 'create', failSync: folder, failSyncParents: true, actor: 'ana@empresa.com' });
    assert.equal(failed.line?.ok, false, `${folder}: ${JSON.stringify(failed.line)}`);
    assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN');
    assert.deepEqual(await ledgerEvents(w), ['GENESIS'], `${folder}: o pai não ficou durável ⇒ a INTENT nem foi escrita`);
    const resumed = await runChild(w, null, { task: 'create', resend: true, actor: 'ana@empresa.com' });
    assert.equal(resumed.line?.ok, true, `${folder}: ${JSON.stringify(resumed.line)}`);
  }
});

test('CRIAÇÃO de pastas: o fsync da pasta da auditoria NÃO persiste o nome dela — o diretório-PAI também é sincronizado (livro na inscrição; decisões e recibos na primeira decisão)', async () => {
  const w = await ledgerWorld({ enroll: false });
  const enrollLog = syncLogOf();
  const enrolled = await runChild(w, null, { task: 'enroll', syncLog: enrollLog, actor: 'ana@empresa.com' });
  assert.equal(enrolled.line?.ok, true);
  const afterEnroll = read(enrollLog);
  assert.ok(afterEnroll.includes(w.ledgerDir), `o pai do livro (${w.ledgerDir}) foi sincronizado`);
  assert.ok(afterEnroll.includes(auditDirs(w).ledger));
  const createLog = syncLogOf();
  const created = await runChild(w, null, { task: 'create', resend: true, syncLog: createLog, actor: 'ana@empresa.com' });
  assert.equal(created.line?.ok, true);
  const afterCreate = read(createLog);
  assert.ok(afterCreate.includes(w.decisionsDir), 'o pai das decisões foi sincronizado');
  assert.ok(afterCreate.includes(w.anchorDir), 'o pai dos recibos foi sincronizado');
  assert.ok([auditDirs(w).decisions, auditDirs(w).anchors, auditDirs(w).ledger].every((d) => afterCreate.includes(d)));
  // uma segunda decisão não recria pastas, mas SEMPRE ressincroniza os pais (revisão 7, M2): um fsync de pai que falhou numa criação anterior não pode ficar sem prova depois de um reinício
  const secondLog = syncLogOf();
  const second = await runChild(w, null, { task: 'revoke', decisionId: 'op-0001', syncLog: secondLog, actor: 'ana@empresa.com' });
  assert.equal(second.line?.ok, true, JSON.stringify(second.line));
  assert.ok(read(secondLog).includes(w.decisionsDir) && read(secondLog).includes(w.anchorDir), 'os pais são sincronizados em toda gravação');
});

test('os TRÊS resultados são distintos e verificáveis: durável (sucesso), recuperável e pendente (recibo não gravado) e durabilidade DESCONHECIDA (fsync); só o primeiro é sucesso, e só o segundo se resolve reenviando sem reiniciar', async () => {
  // (1) durável
  const durable = await ledgerWorld();
  const ok = await durable.rawProtected.create(ANA, durable.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(ok.ok);
  // (2) recuperável e pendente
  const pendingWorld = await ledgerWorld();
  let failReceipts = true;
  const flaky = faulty({ async writeExclusive(target, data, mode) { if (failReceipts && target.startsWith(pendingWorld.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const svc = decisionsOver(pendingWorld, { ledger: ledgerFor(pendingWorld, { guard: null }), knownHeads: NO_RESULTS, fs: flaky });
  const pending = await svc.create(ANA, pendingWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING', JSON.stringify(pending).slice(0, 160));
  failReceipts = false;
  const resent = await svc.create(ANA, pendingWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(resent.ok, 'o reenvio conclui, SEM reiniciar o processo');
  // (3) durabilidade desconhecida
  const unknownWorld = await ledgerWorld();
  const noSync = faulty({ async syncDirectory(dir) { if (dir.startsWith(unknownWorld.decisionsDir)) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } });
  const broken = decisionsOver(unknownWorld, { ledger: ledgerFor(unknownWorld, { guard: null }), knownHeads: NO_RESULTS, fs: noSync });
  const unknown = await broken.create(ANA, unknownWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!unknown.ok && unknown.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(unknown).slice(0, 200));
  assert.deepEqual(unknown.issues, [DURABILITY_UNPROVEN_MESSAGE], 'texto fixo, sem caminho');
  assert.match(DURABILITY_UNPROVEN_MESSAGE, /DESCONHECIDA/);
  assert.match(DURABILITY_UNPROVEN_MESSAGE, /NÃO é sucesso/);
  const again = await broken.create(ANA, unknownWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!again.ok, 'a base está travada: o reenvio SEM reiniciar também não é sucesso');
  assert.deepEqual(new Set(['ok', pending.code, unknown.code]).size, 3, 'três resultados distintos');
});

test('sistema de arquivos que NÃO suporta fsync de diretório (EINVAL, ENOTSUP, ENOSYS, EPERM): nenhuma gravação é dada como feita — a limitação aparece, as leituras continuam funcionando', async () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM']) {
    const w = await ledgerWorld();
    const unsupported = faulty({ async syncDirectory() { throw errno(code); } });
    const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs: unsupported });
    const result = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
    assert.ok(!result.ok && result.code === 'DECISIONS_DURABILITY_UNKNOWN', `${code}: ${JSON.stringify(result).slice(0, 160)}`);
    const view = await svc.list(BIA, w.auditId, clock());
    assert.ok(view.ok, `${code}: a leitura continua`);
  }
});

test('RECOVER da fase C (CONFIRMED que faltou): só grava o CONFIRMED depois de sincronizar entrada e recibo; se o fsync falha, NÃO grava e não é sucesso', async () => {
  let failConfirmed = true;
  const ledgerFs = faulty({ async writeExclusive(target, data, mode) { if (failConfirmed && target.includes('l000003.json')) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w = await ledgerWorld({ ledgerFs });
  const failed = await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!failed.ok);
  failConfirmed = false;
  assert.ok(fs.existsSync(entryPath(w, 1)) && fs.existsSync(anchorPath(w, 1)), 'fase C: entrada e recibo existem, CONFIRMED não');
  // fsync da pasta de DECISÕES falha na recuperação: o CONFIRMED NÃO é gravado (o RECOVER é do AUTOR: §16.16, só ele conclui a fase C)
  const noConfirm = await runChild(w, null, { task: 'recover', failSync: 'decisions', actor: 'ana@empresa.com' });
  assert.equal(noConfirm.line?.ok, false);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'sem durabilidade da entrada o CONFIRMED não entra');
  // saudável: sincroniza decisões e recibos ANTES do CONFIRMED e conclui
  const log = syncLogOf();
  const done = await runChild(w, null, { task: 'recover', syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(done.line?.ok, true, JSON.stringify(done.line));
  const synced = read(log);
  assert.ok(synced.includes(auditDirs(w).decisions) && synced.includes(auditDirs(w).anchors), `entrada e recibo sincronizados (${synced.length} chamadas)`);
  assert.equal((await ledgerEvents(w)).at(-1), 'CONFIRMED');
});
