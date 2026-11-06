import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveCapacityPolicy } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * M2 (revisão independente, 05/11/2026) — DURABILIDADE DA RAIZ DO LIVRO. O fsync da pasta da auditoria NÃO persiste o NOME dela: quem o persiste é o fsync do diretório-PAI (a raiz). A correção anterior só
 * sincronizava a raiz quando a pasta da auditoria era CRIADA naquele instante; depois de uma falha e de um reinício, criação/revogação devolviam sucesso sem nunca provar a raiz, e uma falha de
 * fsync simultânea a outro erro era descartada. Aqui: a raiz é sincronizada em TODA publicação, uma falha de fsync tem precedência sobre qualquer outro erro, a base trava, e o estado do livro
 * fica NÃO RESOLVIDO (`DURABILITY_UNKNOWN`) em vez de "protegido". Falhas por injeção em processos filhos reais (reinício de verdade); nada real é tocado.
 */
registerCleanup();
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const logPath = (): string => path.join(tmpDir('lad-m2log-'), 'sync.log');
const count = (lines: string[], dir: string): number => lines.filter((line) => line === dir).length;

test('M2/C1 (processo REAL, reinício): o fsync da RAIZ do livro falha numa gravação comum ⇒ sem sucesso; depois do reinício CREATE, REVOKE e RECOVER só têm sucesso DEPOIS de sincronizar a raiz de novo', async () => {
  for (const task of ['create', 'revoke', 'recover'] as const) {
    const w = await ledgerWorld();
    if (task !== 'create') await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())); // histórico saudável: op-0001 (o `create` do filho usa o mesmo subcritério)
    const extra = task === 'revoke' ? { decisionId: 'op-0001' } : {};
    const eventsBefore = await ledgerEvents(w);
    const failed = await runChild(w, null, { task, failSync: 'ledger', failSyncBaseOnly: true, actor: 'ana@empresa.com', ...extra });
    assert.equal(failed.line?.ok, false, `${task}: sem a raiz comprovada NÃO é sucesso (${JSON.stringify(failed.line)} ${failed.stderr.slice(0, 160)})`);
    assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN', `${task}: resultado próprio`);
    assert.deepEqual(await ledgerEvents(w), eventsBefore, `${task}: com a raiz não comprovada NADA é publicado (fail-fast)`);
    const log = logPath();
    const resumed = await runChild(w, null, { task, syncLog: log, actor: 'ana@empresa.com', staleOperationMs: 1, ...extra });
    assert.equal(resumed.line?.ok, true, `${task}: ${JSON.stringify(resumed.line)} ${resumed.stderr.slice(0, 200)}`);
    assert.ok(read(log).includes(w.ledgerDir), `${task}: a retomada sincronizou a RAIZ do livro (log: ${read(log).length} chamadas)`);
  }
});

test('M2/C2 (em processo): falha de fsync da raiz SIMULTÂNEA a outro erro de gravação (ENOSPC) não é descartada — a base trava, a 2ª tentativa NÃO tem sucesso e o estado fica DURABILITY_UNKNOWN', async () => {
  let enospc = true;
  const ledgerFs = faulty({
    async syncDirectory(dir) {
      if (dir === wLedgerDir) throw errno('EIO');
      return nodeFsOps.syncDirectory(dir);
    },
    async writeExclusive(target, data, mode) {
      if (enospc && target.startsWith(wLedgerDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await ledgerWorld({ enroll: false, ledgerFs });
  const wLedgerDir = w.ledgerDir;
  const first = await w.rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', `1ª: ${JSON.stringify(first).slice(0, 200)}`);
  assert.deepEqual(await ledgerEvents(w).catch(() => []), [], 'nenhum registro foi publicado com a raiz não comprovada');
  enospc = false;
  // disco "saudável" agora e serviço novo sobre a MESMA pasta: depois de um erro de fsync não se presume nada (a base fica travada até reiniciar)
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });
  const second = await healthy.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `2ª tentativa NÃO pode ter sucesso: ${JSON.stringify(second).slice(0, 200)}`);
  const view = await must(healthy.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable, view.decisions.length], ['HISTORY_UNRESOLVED', 'DURABILITY_UNKNOWN', false, 0], 'estado de durabilidade NÃO resolvida: nada vigente, nada finalizável');
});

test('M2: a RAIZ do livro é sincronizada em TODA publicação (INTENT e CONFIRMED de uma criação comum), não só na criação da pasta; custo: 1 fsync de diretório por registro', async () => {
  const w = await ledgerWorld();
  const log = logPath();
  const before = (await ledgerRecords(w)).length;
  const created = await runChild(w, null, { task: 'create', syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(created.line?.ok, true, JSON.stringify(created.line));
  const published = (await ledgerRecords(w)).length - before;
  assert.equal(published, 2, 'INTENT + CONFIRMED');
  assert.ok(count(read(log), w.ledgerDir) >= published, `raiz sincronizada ao menos uma vez por registro (${count(read(log), w.ledgerDir)} × para ${published} registros)`);
});

test('estado NÃO RESOLVIDO depois de falha fatal de durabilidade: o livro não é lido como protegido enquanto a base estiver travada (um resultado selado nessa janela citaria uma cabeça talvez não durável)', async () => {
  let fail = false;
  const ledgerFs = faulty({
    async syncDirectory(dir) {
      if (fail && dir.startsWith(wLedgerDir)) throw errno('EIO');
      return nodeFsOps.syncDirectory(dir);
    },
  });
  const w = await ledgerWorld({ ledgerFs });
  const wLedgerDir = w.ledgerDir;
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  assert.equal((await must(w.rawProtected.list(BIA, w.auditId, clock()))).ledger.state, 'PROTECTED');
  fail = true;
  const broken = await w.protectedService.create(ANA, w.auditId, { record: rec.c3() }, clock());
  assert.ok(!broken.ok && broken.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(broken).slice(0, 200));
  fail = false; // o disco "volta", mas depois de um erro de fsync a base fica travada
  const view = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable], ['HISTORY_UNRESOLVED', 'DURABILITY_UNKNOWN', false]);
  assert.deepEqual(view.decisions, [], 'nenhuma decisão vigente enquanto a durabilidade não estiver resolvida');
});

/* ============================================================================ capacidade: RECEIPT_REISSUED repetido */

test('RECEIPT_REISSUED: reenvios repetidos com o recibo FALHANDO (ENOSPC) não gravam um registro por tentativa nem consomem a reserva — revogações e rotação continuam possíveis quando o disco volta', async () => {
  const policy = deriveCapacityPolicy(40, 3, 64, 4); // RECORD ≤ 27, REVOKE ≤ 36, 3 revogações reservadas
  const w = await ledgerWorld({ capacityPolicy: policy });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1)); // recibo removido de entrada que o livro já confirmou
  let failReceipts = true;
  const flaky = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.startsWith(w.anchorDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: policy }), knownHeads: NO_RESULTS, fs: flaky });
  const before = (await ledgerRecords(w)).length;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const resend = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
    assert.ok(!resend.ok, `tentativa ${attempt}: o recibo falha`);
    assert.ok(!/LEDGER_CAPACITY_EXHAUSTED|LIMIT_REACHED/.test(JSON.stringify(resend)), `tentativa ${attempt}: a reemissão repetida não pode esgotar o livro (${JSON.stringify(resend).slice(0, 160)})`);
  }
  const events = await ledgerEvents(w);
  assert.ok(events.length <= before + 1, `no máximo UM RECEIPT_REISSUED por recibo removido (livro: ${before} → ${events.length}; ${events.filter((e) => e === 'RECEIPT_REISSUED').length} reemissões)`);
  failReceipts = false;
  const healed = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(healed.ok, `o disco volta e o reenvio conclui: ${JSON.stringify(healed).slice(0, 200)}`);
  const view = await must(svc.list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.state, 'PROTECTED');
  assert.ok((view.ledger.capacity?.revocationsAvailable ?? 0) >= 3, `as revogações reservadas continuam disponíveis (${view.ledger.capacity?.revocationsAvailable})`);
  const revoked = await svc.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: view.head }, clock);
  assert.ok(revoked.ok, `a revogação continua possível: ${JSON.stringify(revoked).slice(0, 200)}`);
});
