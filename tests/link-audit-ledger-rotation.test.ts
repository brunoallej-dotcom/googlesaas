import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveCapacityPolicy, replayLedger, verifyTags } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { buildLongLedger } from './helpers/link-audit-ledger-long';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * R7-02 — ROTAÇÃO PLANEJADA da chave do livro: o CHECKPOINT da chave nova é manutenção (reserva própria, nunca consumido por decisões), idempotente, durável e coberto contra queda,
 * concorrência e vencimento da chave antiga. Nenhum sucesso enquanto a transição entre chaves não estiver autenticada e durável; chave comprometida nunca volta a valer.
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const at = (iso: string) => () => new Date(iso);
const rotatedAuth = (now = '2026-11-03T12:00:00Z', until = '2026-12-02') => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:${until}`], now: at(now) });
const rotatedService = (w: LedgerWorld, over: Parameters<typeof ledgerFor>[1] = {}, now?: string, until?: string) =>
  decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: rotatedAuth(now, until), ...over }), knownHeads: NO_RESULTS });
const kids = async (w: LedgerWorld) => (await ledgerRecords(w)).map((r) => `${r.event}:${r.origin.kid.slice(-1)}`);

async function worldWithOneDecision(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  return w;
}

test('ciclo completo: a rotação aparece como NÃO coberta, o RECOVER grava UM CHECKPOINT da chave nova, repetir não grava mais nada, e a chave antiga pode vencer sem matar a auditoria', async () => {
  const w = await worldWithOneDecision();
  const svc = rotatedService(w);
  const before = await must(svc.list(BIA, w.auditId, clock()));
  assert.deepEqual([before.ledger.state, before.ledger.keyCoverage?.covered, before.ledger.keyCoverage?.otherKeyRecords, before.ledger.keyCoverage?.keyId], ['PROTECTED', false, 3, 'lk-test-b'], 'a leitura mostra que falta o ponto de verificação da chave atual');
  // SEM o CHECKPOINT, vencida a antiga, a auditoria morre (por isso o RECOVER não é opcional)
  const expiredWithout = await must(rotatedService(w, {}, '2026-12-20T12:00:00Z').list(BIA, w.auditId, clock()));
  assert.deepEqual([expiredWithout.ledger.state, expiredWithout.ledger.reason, expiredWithout.decisions.length], ['HISTORY_UNRESOLVED', 'KEY_EXPIRED', 0]);
  const first = await svc.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(first.ok);
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'CHECKPOINT:b']);
  assert.equal(first.ok && first.value.ledger.keyCoverage?.covered, true);
  const again = await svc.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(again.ok);
  assert.equal((await ledgerRecords(w)).length, 4, 'idempotente: nenhum segundo CHECKPOINT');
  const expired = await must(rotatedService(w, {}, '2026-12-20T12:00:00Z').list(BIA, w.auditId, clock()));
  assert.deepEqual([expired.ledger.state, expired.decisions.length], ['PROTECTED', 1], 'a chave nova está vinculada ao estado anterior e a aposentada pode vencer');
  // o CHECKPOINT vincula a chave nova ao estado anterior: aponta para o último registro da chave antiga
  const records = await ledgerRecords(w);
  assert.deepEqual(records[3]?.checkpoint, { throughSeq: 3, throughSha256: records[2]?.contentSha256 });
  assert.equal(verifyTags(records, rotatedAuth('2026-12-20T12:00:00Z')), null);
});

test('chave antiga prestes a expirar: no último dia de validade o RECOVER ainda cobre; no dia seguinte a auditoria já está não resolvida (KEY_EXPIRED) e NENHUM caminho da aplicação a reabre — a rotação tem de ser coberta antes', async () => {
  const w = await worldWithOneDecision();
  const lastDay = rotatedService(w, {}, '2026-12-02T23:59:00Z', '2026-12-02');
  assert.ok((await lastDay.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock())).ok, 'no último dia ainda cobre');
  assert.equal((await must(rotatedService(w, {}, '2026-12-03T00:01:00Z', '2026-12-02').list(BIA, w.auditId, clock()))).ledger.state, 'PROTECTED', 'coberta a tempo, vence sem consequência');
  // outra auditoria que NÃO foi coberta a tempo
  const late = await worldWithOneDecision();
  const dayAfter = rotatedService(late, {}, '2026-12-03T00:01:00Z', '2026-12-02');
  const view = await must(dayAfter.list(BIA, late.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length], ['HISTORY_UNRESOLVED', 'KEY_EXPIRED', 0]);
  const before = (await ledgerRecords(late)).length;
  for (const action of ['RECOVER', 'ENROLL', 'ADOPT'] as const) assert.ok(!(await dayAfter.ledgerAction(ANA, late.auditId, { action }, clock())).ok, action);
  assert.ok(!(await dayAfter.create(ANA, late.auditId, { record: rec.naModel(), expectedHead: view.head }, clock())).ok);
  assert.equal((await ledgerRecords(late)).length, before, 'nada foi gravado');
});

test('rotação PERTO DA CAPACIDADE (política pequena): o CHECKPOINT cabe até o último registro (manutenção), idempotente, mesmo com decisões e revogações esgotadas; no limite exato recusa com texto próprio e a vista diz que a rotação ficou sem cobertura', async () => {
  const policy = deriveCapacityPolicy(60, 3, 8);
  for (const total of [52, 55, 58, 59, 60]) {
    const w = await ledgerWorld({ enroll: false, capacityPolicy: policy, checkpointEvery: 8 });
    await buildLongLedger(w, 9, total, { checkpointEveryOps: 100 });
    const svc = rotatedService(w, { capacityPolicy: policy, checkpointEvery: 8 });
    const view = await must(svc.list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED', `total ${total}`);
    assert.equal(view.ledger.capacity?.level, total >= 53 ? 'EXHAUSTED' : view.ledger.capacity?.level);
    const done = await svc.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
    if (total < 60) {
      assert.ok(done.ok, `total ${total}: ${JSON.stringify(done).slice(0, 160)}`);
      assert.equal((await ledgerRecords(w)).length, total + 1);
      assert.equal(done.ok && done.value.ledger.keyCoverage?.covered, true);
      assert.ok((await svc.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock())).ok);
      assert.equal((await ledgerRecords(w)).length, total + 1, `total ${total}: idempotente`);
      const expired = rotatedService(w, { capacityPolicy: policy, checkpointEvery: 8 }, '2026-12-20T12:00:00Z');
      assert.equal((await must(expired.list(BIA, w.auditId, clock()))).ledger.state, 'PROTECTED', `total ${total}: depois do vencimento`);
    } else {
      assert.ok(!done.ok && done.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(done).slice(0, 200));
      assert.match(JSON.stringify(done), /ESGOTADA|INTERVENÇÃO/);
      assert.equal((await ledgerRecords(w)).length, 60);
      const after = await must(svc.list(BIA, w.auditId, clock()));
      assert.equal(after.ledger.keyCoverage?.covered, false, 'o livro avisa que a rotação ficou SEM cobertura');
    }
  }
});

test('RECOVER com operação aberta em FASE B (decisão publicada sem recibo): grava o CHECKPOINT da chave nova (R7-03); vencida a antiga, o autor ainda conclui a pendência — o CONFIRMED sai assinado pela chave nova', async () => {
  const w = await ledgerWorld();
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(w.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const flaky = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts });
  const pending = await flaky.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING');
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a']);
  const svc = rotatedService(w);
  const mid = await must(svc.list(BIA, w.auditId, clock()));
  assert.deepEqual([mid.ledger.openOperation?.phase, mid.ledger.keyCoverage?.covered], ['B', false]);
  assert.ok((await svc.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock())).ok);
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b'], 'o CHECKPOINT entra entre a INTENT e o fecho; a operação aberta continua aberta');
  assert.equal((await must(svc.list(BIA, w.auditId, clock()))).ledger.keyCoverage?.covered, true);
  // a chave antiga vence; o autor reenvia o MESMO pedido e a pendência conclui
  const late = rotatedService(w, {}, '2026-12-20T12:00:00Z');
  const concluded = await late.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(concluded.ok, JSON.stringify(concluded).slice(0, 220));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b', 'CONFIRMED:b']);
  const end = await must(late.list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.decisions.length], ['PROTECTED', 1]);
});

test('SIGKILL REAL antes e depois de publicar o CHECKPOINT da rotação: antes ⇒ nada gravado e a retomada com a chave nova grava UM; depois ⇒ o registro existe e a retomada é idempotente', async () => {
  for (const when of ['before', 'after'] as const) {
    const w = await worldWithOneDecision();
    const killed = await runChild(w, null, { task: 'recover', rotated: true, actor: 'ana@empresa.com', crash: { at: when, match: 'l000004.json' } });
    assert.notEqual(killed.status, 0, `${when}: o processo foi morto`);
    assert.equal(killed.line, null);
    const svc = rotatedService(w);
    const events = await ledgerEvents(w);
    assert.deepEqual(events, when === 'before' ? ['GENESIS', 'INTENT', 'CONFIRMED'] : ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT'], `${when}: o que sobrou`);
    const mid = await must(svc.list(BIA, w.auditId, clock()));
    assert.equal(mid.ledger.state, 'PROTECTED');
    assert.equal(mid.ledger.keyCoverage?.covered, when === 'after', `${when}: a cobertura reflete o que está no disco`);
    // retomada com a chave nova (em outro processo)
    const resumed = await runChild(w, null, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
    assert.equal(resumed.line?.ok, true, `${when}: ${JSON.stringify(resumed.line)}${resumed.stderr.slice(0, 160)}`);
    assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'CHECKPOINT:b'], `${when}: exatamente UM CHECKPOINT`);
    const again = await runChild(w, null, { task: 'recover', rotated: true, actor: 'ana@empresa.com' });
    assert.equal(again.line?.ok, true);
    assert.equal((await ledgerRecords(w)).length, 4, `${when}: idempotente`);
    const records = await ledgerRecords(w);
    assert.ok(replayLedger(records, w.auditId).ok);
    assert.equal((await must(rotatedService(w, {}, '2026-12-20T12:00:00Z').list(BIA, w.auditId, clock()))).ledger.state, 'PROTECTED', `${when}: sobrevive ao vencimento`);
  }
});

test('retomada por uma ESCRITA com a chave nova: uma decisão nova depois de uma rotação sem cobertura grava o CHECKPOINT antes da INTENT e fica toda assinada pela chave nova', async () => {
  const w = await worldWithOneDecision();
  const svc = rotatedService(w);
  const head = (await must(svc.list(ANA, w.auditId, clock()))).head;
  await must(svc.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: head }, clock()));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'CHECKPOINT:b', 'INTENT:b', 'CONFIRMED:b']);
  assert.equal((await must(rotatedService(w, {}, '2026-12-20T12:00:00Z').list(BIA, w.auditId, clock()))).ledger.state, 'PROTECTED');
});

test('CONCORRÊNCIA: a rotação (RECOVER, em 2 processos) corre junto com uma CRIAÇÃO e uma REVOGAÇÃO — tudo conclui, existe exatamente UM CHECKPOINT da chave nova e a cadeia continua válida e coberta', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  // §16.16: um RECOVER de quem NÃO é o autor que lê a fase C de um dono VIVO (recibo gravado, CONFIRMED ainda não) recebe o 409 transitório `PENDING_UNCONFIRMED`; o cliente
  // real tenta de novo pelo `Retry-After`. Era a causa da falha intermitente deste teste (não o RL-32). Os RECOVERs repetem SÓ esse código (`recover-retry`); o contrato da
  // janela está travado, de forma determinística, no teste seguinte.
  const outcomes = await Promise.all([
    runChild(w, null, { task: 'recover-retry', rotated: true, actor: 'ana@empresa.com' }),
    runChild(w, null, { task: 'revoke-retry', rotated: true, decisionId: 'op-0001', actor: 'ana@empresa.com' }),
    runChild(w, null, { task: 'create-retry', rotated: true, worker: 2, actor: 'ana@empresa.com' }),
    runChild(w, null, { task: 'recover-retry', rotated: true, actor: 'bia@empresa.com' }),
  ]);
  for (const [index, o] of outcomes.entries()) assert.equal(o.line?.ok, true, `processo ${index}: ${JSON.stringify(o.line)} ${o.stderr.slice(0, 200)}`);
  const records = await ledgerRecords(w);
  assert.equal(records.filter((r) => r.event === 'CHECKPOINT' && r.origin.kid === 'lk-test-b').length, 1, 'um único CHECKPOINT da chave nova');
  assert.ok(replayLedger(records, w.auditId).ok);
  assert.equal(verifyTags(records, rotatedAuth('2026-12-20T12:00:00Z')), null, 'coberto depois do vencimento da antiga');
  const end = await must(rotatedService(w, {}, '2026-12-20T12:00:00Z').list(BIA, w.auditId, clock()));
  // a ordem em que os processos vencem decide os números das entradas; o que importa é o resultado: C2 revogada, C3 mantida, P3 criada
  assert.deepEqual([end.ledger.state, end.ledger.keyCoverage?.covered, end.ledger.openOperation, end.decisions.map((d) => (d.record as { subcriterionId?: string }).subcriterionId).sort()], ['PROTECTED', true, null, ['C3', 'P3']]);
});

test('§16.16 na rotação concorrente (o contrato em que o teste de CONCORRÊNCIA esbarrava): o RECOVER de quem NÃO é o autor, na janela entre o recibo e o CONFIRMED de um dono VIVO, recebe PENDING_UNCONFIRMED e não grava nada; depois do CONFIRMED do dono o MESMO RECOVER conclui', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  const auditDirs = [path.join(w.ledgerDir, w.auditId), path.join(w.decisionsDir, w.auditId), path.join(w.anchorDir, w.auditId)];
  const listing = (): string[][] => auditDirs.map((dir) => fs.readdirSync(dir).filter((name) => !name.startsWith('.tmp-')).sort());
  let inWindow: { line: Record<string, unknown> | null; before: string[][]; after: string[][] } | null = null;
  // o dono (Ana, processo já rotacionado) para IMEDIATAMENTE antes de publicar o CONFIRMED (entrada e recibo já existem); Bia roda o RECOVER em OUTRO processo nesse instante
  const pauseBeforeConfirmed = faulty({
    async link(from, to) {
      if (inWindow === null && path.dirname(to) === auditDirs[0] && (JSON.parse(fs.readFileSync(from, 'utf8')) as { event?: string }).event === 'CONFIRMED') {
        const before = listing();
        const child = await runChild(w, null, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
        inWindow = { line: child.line, before, after: listing() };
      }
      return nodeFsOps.link(from, to);
    },
  });
  const owner = rotatedService(w, { fs: pauseBeforeConfirmed });
  const head = (await must(owner.list(ANA, w.auditId, clock()))).head;
  const done = await owner.create(ANA, w.auditId, { record: rec.p3(5), expectedHead: head }, clock);
  const seen = inWindow as { line: Record<string, unknown> | null; before: string[][]; after: string[][] } | null;
  assert.ok(seen !== null, 'o dono parou entre o recibo e o CONFIRMED');
  assert.ok(seen.before[1]?.includes('d0003.json') && seen.before[2]?.includes('a0003.json'), `na janela a entrada e o recibo existem: ${JSON.stringify(seen.before)}`);
  assert.deepEqual(seen.line, { ok: false, code: 'PENDING_UNCONFIRMED' }, '§16.16: quem não é o autor recebe o 409 transitório');
  assert.deepEqual(seen.after, seen.before, 'quem não é o autor não gravou nada (livro, decisões, recibos)');
  assert.ok(done.ok, `o dono conclui: ${JSON.stringify(done).slice(0, 200)}`);
  const final = ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'INTENT:a', 'CONFIRMED:a', 'CHECKPOINT:b', 'INTENT:b', 'CONFIRMED:b'];
  assert.deepEqual(await kids(w), final, 'sem colisão: o dono gravou o PRÓPRIO CHECKPOINT antes da INTENT');
  const after = await runChild(w, null, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
  assert.deepEqual(after.line, { ok: true, code: null }, `depois do CONFIRMED o mesmo RECOVER conclui: ${after.stderr.slice(0, 200)}`);
  assert.deepEqual(await kids(w), final, 'a rotação já estava coberta: nada novo');
});

test('DURABILIDADE da rotação: se o fsync do diretório do livro falha, o RECOVER NÃO é sucesso; depois do reinício o CHECKPOINT já existe, mas o sucesso só vem DEPOIS de sincronizar o diretório de novo', async () => {
  const w = await worldWithOneDecision();
  const log = path.join(tmpDir('lad-synclog-'), 'sync.log');
  // o fsync falha exatamente na sincronização que torna o CHECKPOINT (l000004) durável: a prova do livro EXISTENTE (feita antes) passa, o registro é publicado e a durabilidade dele é que fica desconhecida
  const failed = await runChild(w, null, { task: 'recover', rotated: true, failSync: 'ledger', failSyncWhenExists: 'l000004.json', actor: 'ana@empresa.com' });
  assert.equal(failed.line?.ok, false, `não é sucesso: ${JSON.stringify(failed.line)}`);
  assert.ok((await ledgerEvents(w)).includes('CHECKPOINT'), 'o registro FOI publicado; o que faltou foi a prova de durabilidade');
  // reinício com o disco AINDA sem sincronizar: o registro já existe e NADA é gravado, mas o sucesso continua negado (R7-04)
  const stillBroken = await runChild(w, null, { task: 'recover', rotated: true, failSync: 'ledger', actor: 'ana@empresa.com' });
  assert.equal(stillBroken.line?.ok, false, `registro existente não prova durabilidade: ${JSON.stringify(stillBroken.line)}`);
  const resumed = await runChild(w, null, { task: 'recover', rotated: true, syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(resumed.line?.ok, true, JSON.stringify(resumed.line));
  const synced = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  assert.ok(synced.some((dir) => dir.startsWith(w.ledgerDir)), `o diretório do livro foi sincronizado na retomada: ${JSON.stringify(synced)}`);
  assert.equal(((await ledgerEvents(w)).filter((e) => e === 'CHECKPOINT')).length, 1);
});

test('chave antiga COMPROMETIDA: depois de revogada nem o CHECKPOINT da chave nova a reabilita — a auditoria fica KEY_REVOKED, nenhuma escrita passa e nada novo é gravado', async () => {
  const w = await worldWithOneDecision();
  assert.ok((await rotatedService(w).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock())).ok);
  const revoked = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: ledgerAuth({ current: LEDGER_KEY_B, revokedIds: ['lk-test-a'] }) }), knownHeads: NO_RESULTS });
  const before = (await ledgerRecords(w)).length;
  const view = await must(revoked.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'KEY_REVOKED', 0, false]);
  assert.ok(!(await revoked.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: view.head }, clock())).ok);
  assert.ok(!(await revoked.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock())).ok);
  assert.ok(!(await revoked.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock())).ok);
  assert.equal((await ledgerRecords(w)).length, before, 'nada novo no livro');
});
