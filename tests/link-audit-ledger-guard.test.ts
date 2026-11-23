import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createSyntheticGuard } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * GUARDA EXTERNA (Q6): testemunha imutável em domínio de falha separado da VPS. Em produção ela é REQUISITO e AINDA NÃO EXISTE; aqui só o adaptador SINTÉTICO,
 * para provar o que ela daria. O teste "SEM guarda" TRAVA o limite declarado: o rollback COORDENADO de todos os volumes não é detectado sem ela.
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

const VOLUMES = (w: LedgerWorld): string[] => [path.join(w.decisionsDir, w.auditId), path.join(w.anchorDir, w.auditId), path.join(w.ledgerDir, w.auditId)];
function snapshot(w: LedgerWorld): string {
  const copy = tmpDir('lad-snap-');
  for (const [index, dir] of VOLUMES(w).entries()) fs.cpSync(dir, path.join(copy, String(index)), { recursive: true });
  return copy;
}
function restore(w: LedgerWorld, copy: string): void {
  for (const [index, dir] of VOLUMES(w).entries()) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(path.join(copy, String(index)), dir, { recursive: true });
  }
}
const withGuard = (w: LedgerWorld, guard = w.guard) => decisionsOver(w, { ledger: ledgerFor({ ...w, guard }, { guard }), knownHeads: NO_RESULTS });
const withoutGuard = (w: LedgerWorld) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });

async function twoOps(w: LedgerWorld): Promise<{ afterFirst: string }> {
  const service = withGuard(w);
  await must(service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  const afterFirst = snapshot(w);
  const head = (await must(service.list(ANA, w.auditId))).head;
  await must(service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock()));
  return { afterFirst };
}

test('com guarda: cada GENESIS/CONFIRMED publica a cabeça; a guarda acompanha o livro e o estado diz CONSISTENT', async () => {
  const w = await ledgerWorld({ withGuard: true });
  assert.deepEqual(await w.guard.latest(w.auditId), { ok: true, head: { ledgerSeq: 1, sha256: (await ledgerRecords(w))[0]?.contentSha256 } });
  await twoOps(w);
  const records = await ledgerRecords(w);
  assert.equal(records.length, 5);
  assert.deepEqual(await w.guard.latest(w.auditId), { ok: true, head: { ledgerSeq: 5, sha256: records[4]?.contentSha256 } });
  const view = await must(withGuard(w).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.externalGuard], ['PROTECTED', 'CONSISTENT']);
  // idempotente: o mesmo par é aceito de novo; outro hash na mesma posição é recusado com o motivo (regra 7, G1.b.1)
  assert.deepEqual(await w.guard.publish({ auditId: w.auditId, ledgerSeq: 5, sha256: records[4]?.contentSha256 as string }), { ok: true });
  assert.deepEqual(await w.guard.publish({ auditId: w.auditId, ledgerSeq: 5, sha256: 'f'.repeat(64) }), { ok: false, reason: 'CONFLICT' });
});

test('LIMITE DECLARADO (travado em teste): SEM guarda externa, o rollback COORDENADO de decisões + recibos + livro a um instante anterior NÃO é detectado — a revogação some e a decisão volta a valer', async () => {
  const w = await ledgerWorld();
  const service = withoutGuard(w);
  await must(service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  const before = snapshot(w);
  const head = (await must(service.list(ANA, w.auditId))).head;
  await must(service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock()));
  assert.deepEqual((await must(service.list(BIA, w.auditId))).decisions, []);
  restore(w, before); // quem escreve nas TRÊS pastas devolve tudo ao instante anterior à revogação
  const after = await must(withoutGuard(w).list(BIA, w.auditId));
  assert.deepEqual([after.ledger.state, after.ledger.externalGuard, after.decisions.map((d) => d.decisionId), after.finalizable], ['PROTECTED', 'NOT_CONFIGURED', ['op-0001'], true], 'NÃO detectado: é por isso que a guarda externa é requisito de produção');
});

test('COM guarda: o MESMo rollback coordenado é detectado (a guarda guarda uma cabeça que o livro já não tem): nada vigente, nada finalizável, escritas recusadas', async () => {
  const w = await ledgerWorld({ withGuard: true });
  const { afterFirst } = await twoOps(w);
  restore(w, afterFirst);
  const service = withGuard(w);
  const view = await must(service.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH', 'MISMATCH', [], false]);
  const before = (await ledgerEvents(w)).length;
  const write = await service.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED');
  assert.equal((await ledgerEvents(w)).length, before, 'o livro não foi alterado');
});

test('guarda INDISPONÍVEL: leitura NÃO resolvida (nunca "sem guarda"), escrita recusada; guarda atrasada: o próximo registro só entra depois de a guarda alcançar o livro', async () => {
  const w = await ledgerWorld({ withGuard: true });
  const down = createSyntheticGuard({ dir: w.guardDir, fs: faulty({ async readdir() { throw errno('EIO'); } }) });
  const unavailable = withGuard(w, down);
  const view = await must(unavailable.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard], ['HISTORY_UNRESOLVED', 'GUARD_UNAVAILABLE', 'UNAVAILABLE']);
  const refused = await unavailable.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!refused.ok);
  // a publicação falha DEPOIS do CONFIRMED: a operação é válida e a guarda fica atrasada
  let failPublish = false;
  const flaky = {
    publish: async (record: { auditId: string; ledgerSeq: number; sha256: string }) => (failPublish && record.ledgerSeq > 1 ? { ok: false as const, reason: 'UNAVAILABLE' as const } : w.guard.publish(record)),
    latest: (auditId: string) => w.guard.latest(auditId),
  };
  const service = withGuard(w, flaky);
  failPublish = true;
  await must(service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  const behind = await must(service.list(BIA, w.auditId));
  assert.deepEqual([behind.ledger.state, behind.ledger.externalGuard], ['PROTECTED', 'BEHIND']);
  const blocked = await service.create(BIA, w.auditId, { record: rec.c3(), expectedHead: behind.head }, clock());
  assert.ok(!blocked.ok && blocked.code === 'LEDGER_GUARD_UNAVAILABLE', 'sem alcançar a guarda a escrita seguinte não começa');
  failPublish = false;
  await must(service.create(BIA, w.auditId, { record: rec.c3(), expectedHead: behind.head }, clock()));
  assert.equal((await must(service.list(BIA, w.auditId))).ledger.externalGuard, 'CONSISTENT');
});

test('o adaptador sintético é só de teste: recusa auditId inválido, pasta inexistente e pasta da guarda que não é diretório comum', async () => {
  const guard = createSyntheticGuard({ dir: path.join(tmpDir('lad-g-'), 'nao-existe') });
  assert.deepEqual(await guard.latest('auditoria-guarda-01'), { ok: false });
  assert.deepEqual(await guard.publish({ auditId: 'auditoria-guarda-01', ledgerSeq: 1, sha256: 'a'.repeat(64) }), { ok: false, reason: 'UNAVAILABLE' });
  const real = createSyntheticGuard({ dir: tmpDir('lad-g-'), fs: nodeFsOps });
  assert.deepEqual(await real.latest('../fora'), { ok: false });
  assert.deepEqual(await real.publish({ auditId: 'auditoria-guarda-01', ledgerSeq: 1, sha256: 'curto' }), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await real.latest('auditoria-guarda-01'), { ok: true, head: null });
});
