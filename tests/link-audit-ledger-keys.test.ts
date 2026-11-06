import assert from 'node:assert/strict';
import test from 'node:test';
import { createLedgerService } from '../src/lib/link-audit-ledger';
import { createOriginAuthenticator } from '../src/lib/link-audit-origin';
import { ANA, BIA, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';

/*
 * ROTAÇÃO E REVOGAÇÃO da chave EXCLUSIVA do livro (Q3). Rotação PLANEJADA: a antiga fica aposentada (só verifica, teto de 93 dias) e a primeira
 * escrita depois dela grava um PONTO DE VERIFICAÇÃO sob a chave nova; vencida a antiga, o livro segue verificável POR ELE. Rotação por
 * COMPROMETIMENTO: a chave revogada nunca autentica nada (nem registros antigos, nem pontos de verificação posteriores) e o livro congela.
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const day = (y: number, m: number, d: number) => () => new Date(Date.UTC(y, m - 1, d));
const rotated = (now: () => Date) => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-11-30`], now });
const serviceWith = (w: LedgerWorld, auth: ReturnType<typeof ledgerAuth>, over: Parameters<typeof ledgerFor>[1] = {}) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth, ...over }), knownHeads: NO_RESULTS });

test('ROTAÇÃO PLANEJADA: dentro da validade a antiga ainda verifica; a primeira escrita grava o PONTO DE VERIFICAÇÃO sob a chave nova; vencida a antiga, o livro segue PROTEGIDO', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, '2026-10-21T12:00:01.000Z'));
  const before = await ledgerRecords(w);
  assert.ok(before.every((record) => record.origin.kid === 'lk-test-a'));
  // rotaciona (A aposentada até 30/11; B atual)
  const planned = serviceWith(w, rotated(day(2026, 10, 25)));
  assert.equal((await must(planned.list(BIA, w.auditId))).ledger.state, 'PROTECTED', 'registros da chave aposentada VÁLIDA continuam verificáveis');
  const head = (await must(planned.list(BIA, w.auditId))).head;
  await must(planned.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, '2026-10-21T12:00:02.000Z'));
  const after = await ledgerRecords(w);
  assert.deepEqual(after.map((record) => record.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT', 'INTENT', 'CONFIRMED']);
  assert.deepEqual(after.map((record) => record.origin.kid), ['lk-test-a', 'lk-test-a', 'lk-test-a', 'lk-test-b', 'lk-test-b', 'lk-test-b'], 'o que é novo só é assinado pela chave NOVA');
  assert.deepEqual(after[3]?.checkpoint, { throughSeq: 3, throughSha256: after[2]?.contentSha256 });
  // a antiga VENCE: o ponto de verificação (chave nova) cobre os registros antigos
  const expired = serviceWith(w, rotated(day(2026, 12, 20)));
  const view = await must(expired.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.finalizable], ['PROTECTED', true]);
  await must(expired.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, '2026-10-21T12:00:03.000Z'));
  // e a antiga pode até sair da configuração
  assert.equal((await must(serviceWith(w, ledgerAuth(LEDGER_KEY_B)).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});

test('rotação SEM nenhuma escrita antes do vencimento: a antiga vence sem ponto de verificação ⇒ KEY_EXPIRED (congela); RECOVER ANTES do vencimento grava o ponto de verificação e evita isso', async () => {
  const lazy = await ledgerWorld();
  await must(lazy.protectedService.create(ANA, lazy.auditId, { record: rec.c2() }, '2026-10-21T12:00:01.000Z'));
  const view = await must(serviceWith(lazy, rotated(day(2026, 12, 20))).list(BIA, lazy.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'KEY_EXPIRED', [], false]);
  const refused = await serviceWith(lazy, rotated(day(2026, 12, 20))).ledgerAction(ANA, lazy.auditId, { action: 'RECOVER' }, '2026-10-21T12:00:02.000Z');
  assert.ok(!refused.ok, 'depois de vencida não há como "consertar" sem aprovação administrativa');
  assert.deepEqual(await ledgerEvents(lazy), ['GENESIS', 'INTENT', 'CONFIRMED'], 'nada foi gravado');

  const diligent = await ledgerWorld();
  await must(diligent.protectedService.create(ANA, diligent.auditId, { record: rec.c2() }, '2026-10-21T12:00:01.000Z'));
  const action = await must(serviceWith(diligent, rotated(day(2026, 10, 25))).ledgerAction(ANA, diligent.auditId, { action: 'RECOVER' }, '2026-10-21T12:00:02.000Z'));
  assert.equal(action.ledger.state, 'PROTECTED');
  assert.deepEqual(await ledgerEvents(diligent), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT']);
  assert.equal((await must(serviceWith(diligent, rotated(day(2026, 12, 20))).list(BIA, diligent.auditId))).ledger.state, 'PROTECTED', 'vencida, mas coberta');
});

test('REVOGAÇÃO EMERGENCIAL: tudo o que a chave comprometida assinou passa a KEY_REVOKED — a chave nova NÃO limpa isso; nada é escrito; a configuração não aceita o material de id revogado', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, '2026-10-21T12:00:01.000Z'));
  const emergency = ledgerAuth({ current: LEDGER_KEY_B, revokedIds: ['lk-test-a'] });
  const service = serviceWith(w, emergency);
  const view = await must(service.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions, view.operatorRecords, view.finalizable], ['HISTORY_UNRESOLVED', 'KEY_REVOKED', [], [], false]);
  assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'));
  const before = await ledgerEvents(w);
  for (const run of [
    () => service.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, '2026-10-21T12:00:02.000Z'),
    () => service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, '2026-10-21T12:00:03.000Z'),
    () => service.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, '2026-10-21T12:00:04.000Z'),
  ]) {
    const result = await run();
    assert.ok(!result.ok, 'nenhuma operação sobre histórico assinado por chave revogada');
  }
  assert.deepEqual(await ledgerEvents(w), before);
  assert.ok((await ledgerRecords(w)).every((record) => record.origin.kid === 'lk-test-a'), 'a chave nova nunca "abençoou" o histórico comprometido');
  assert.throws(() => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-11-30`], revokedIds: ['lk-test-a'], now: day(2026, 10, 25) }), /revogada/);
});

test('chave DESCONHECIDA (a antiga saiu da configuração sem ponto de verificação): KEY_UNKNOWN — e a chave certa de volta restaura, sem ter sido reescrito nada', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, '2026-10-21T12:00:01.000Z'));
  const view = await must(serviceWith(w, ledgerAuth(LEDGER_KEY_B)).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions], ['HISTORY_UNRESOLVED', 'KEY_UNKNOWN', []]);
  assert.equal((await must(serviceWith(w, ledgerAuth(LEDGER_KEY_A)).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});

test('PONTO DE VERIFICAÇÃO periódico: a cada N registros o livro grava um, sem alterar o que as decisões e a verificação enxergam', async () => {
  const w = await ledgerWorld();
  const periodic = serviceWith(w, ledgerAuth(LEDGER_KEY_A), { checkpointEvery: 5 });
  for (let round = 0; round < 3; round += 1) {
    const head = (await must(periodic.list(ANA, w.auditId))).head;
    const created = await must(periodic.create(ANA, w.auditId, { record: rec.c2(), expectedHead: head }, `2026-10-21T12:00:0${round}.000Z`));
    const next = (await must(periodic.list(ANA, w.auditId))).head;
    await must(periodic.revoke(ANA, w.auditId, { revokes: created.decision.decisionId, reason: REASON, expectedHead: next }, `2026-10-21T12:00:0${round}.500Z`));
  }
  const events = await ledgerEvents(w);
  assert.ok(events.includes('CHECKPOINT'), events.join(','));
  const view = await must(periodic.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.confirmedDecisions, view.decisions.length], ['PROTECTED', 6, 0]);
});

test('Q3: o livro só aceita a chave exclusiva (finalidade ledger): uma chave de ORIGEM é recusada na construção, e a de livro não assina decisões nem resultados', () => {
  assert.throws(() => createLedgerService({ dir: '/tmp/x', authenticator: TEST_ORIGIN, otherDirs: [] }), /exclusiva/);
  assert.equal(ledgerAuth(LEDGER_KEY_A).purpose, 'ledger');
  assert.equal(TEST_ORIGIN.purpose, 'origin');
  assert.throws(() => ledgerAuth(LEDGER_KEY_A).sign('DECISION', { a: 1 }), /domínio/);
  assert.throws(() => TEST_ORIGIN.sign('LEDGER', { a: 1 }), /domínio/);
  // mesmo material e id sob finalidades diferentes ⇒ etiquetas diferentes (derivação própria): uma não valida a outra
  const asOrigin = createOriginAuthenticator(LEDGER_KEY_A);
  const asLedger = ledgerAuth(LEDGER_KEY_A);
  const body = { schemaVersion: 1, x: 'corpo' };
  assert.notEqual(asOrigin.sign('DECISION', body).tag, asLedger.sign('LEDGER', body).tag);
});
