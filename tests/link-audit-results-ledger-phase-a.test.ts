import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { createOpenObservations, evaluateProtection, verifyTags, type LedgerRecord, type ProtectionInput } from '../src/lib/link-audit-ledger';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import { ANA, anchorPath, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { appendLedger, chainOf, hashOf, runIntentMaker, runRefOf, signRecord, writeLedger } from './helpers/link-audit-results-ledger-fixtures';
import { AGED_OTHERS, finalizeAs, finalizerOver, footprintOf, protectedWorld, publishedRunFiles, runsOf, spawnChild } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { OP_A, OP_B, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.3 — FASE A do resultado (spec §16.17.4) e PRAZO DO DONO (passo 7, D-22). Operação de resultado aberta sem `sk` nem `ak`:
 *  - recente ⇒ outra finalização espera (limitada) e recebe `LEDGER_OPERATION_IN_PROGRESS`; vencida ⇒ QUALQUER operador a aborta (`RUN_ABORTED` com o observado) pela próxima
 *    finalização ou pelo `RECOVER`, DEPOIS de reler os resultados (TOCTOU: `sk`/`ak` ainda ausentes) e com as testemunhas conferidas antes (RL-18, M-R16, R6-05);
 *  - só em `PROTECTED` (M-R30); hora gravada no futuro vence pela idade OBSERVADA (R7-09); escritas de decisão nunca aplicam receita de resultado;
 *  - o dono não publica depois de `staleOperationMs / 2` monotônicos (grava o próprio `RUN_ABORTED`, RL-37, M-R36) nem depois de ver a operação fechada por outro processo
 *    (RL-11, a parte "não publica"; a razão `RESULT_PUBLISHED_AFTER_ABORT` é da R1.5).
 * Processos reais (SIGKILL) onde a queda importa; relógio monotônico injetado; nenhuma espera de tempo real além de milissegundos.
 */
registerCleanup();

const show = (value: unknown): string => JSON.stringify(value).slice(0, 280);
const eventsOf = async (w: LedgerWorld): Promise<string[]> => (await ledgerRecords(w)).map((record) => record.event);
/** Bem depois de qualquer hora gravada pelos testes: a idade de parede de qualquer `RUN_INTENT` passa do limite. */
const FAR = '2027-03-01T12:00:00.000Z';
const BASE = ['GENESIS', 'INTENT', 'CONFIRMED'];

/** Finalização REAL de Ana, em processo à parte, derrubada por SIGKILL logo DEPOIS de publicar o RUN_INTENT (fase A: sem resultado, sem recibo). */
async function ownerKilledAfterIntent(): Promise<{ w: LedgerWorld; e: ResultsEnv; intent: LedgerRecord }> {
  const { w, e } = await protectedWorld();
  const child = await spawnChild(w, e, { task: 'finalize', withPort: true, crash: { at: 'after', match: '/l000004.json' } });
  assert.ok(child.killed, `o dono tem de morrer por SIGKILL (status ${child.status}, ${child.stderr.slice(0, 200)})`);
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT']);
  assert.deepEqual(publishedRunFiles(e), [], 'fase A: nem resultado nem recibo');
  return { w, e, intent: (await ledgerRecords(w)).at(-1) as LedgerRecord };
}

/* ------------------------------------------------------------------ RL-18 */

test('RL-18 (SIGKILL depois do RUN_INTENT): recente ⇒ outra finalização espera e recebe LEDGER_OPERATION_IN_PROGRESS sem gravar; vencida ⇒ a finalização de OUTRO operador grava RUN_ABORTED (observado: sem resultado, sem recibo) e segue até o RUN_CONFIRMED', async () => {
  const { w, e, intent } = await ownerKilledAfterIntent();
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, () => intent.recordedAt));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open?.phase, view.ledger.runs?.open?.stale], ['PROTECTED', 'A', false]);
  assert.equal(view.finalizable, true, 'a operação de resultado aberta não torna as decisões não finalizáveis (só bloqueia outra finalização)');

  const before = await footprintOf(w, e);
  const waited = await finalizeAs(finalizerOver(w, e), OP_B, w.auditId);
  assert.ok(!waited.ok && waited.code === 'LEDGER_OPERATION_IN_PROGRESS', show(waited));
  assert.deepEqual(await footprintOf(w, e), before, 'recente: nada gravado');

  const done = await finalizeAs(finalizerOver(w, e, { ledger: AGED_OTHERS }), OP_B, w.auditId);
  assert.ok(done.ok, show(done));
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_ABORTED', 'RUN_INTENT', 'RUN_CONFIRMED']);
  const aborted = records[4] as LedgerRecord;
  assert.equal(aborted.actor, 'bia@empresa.com', 'qualquer operador aborta a fase A vencida');
  assert.equal(aborted.run?.intentSeq, 4);
  assert.deepEqual({ ...aborted.run?.observed, ageMs: 0 }, { resultPresent: false, receiptPresent: false, ageMs: 0 });
  assert.ok(Number.isInteger(aborted.run?.observed?.ageMs) && (aborted.run?.observed?.ageMs ?? -1) >= 0);
  assert.deepEqual([records[5]?.run?.author, records[5]?.run?.runSeq], ['bia@empresa.com', 1], 'a nova tentativa usa o MESMO número (o abortado não conta)');
  const { runs } = await runsOf(e, w.auditId);
  assert.deepEqual(runs.map((run) => [run.seq, run.finalizedBy]), [[1, 'bia@empresa.com']]);
});

test('RL-18 (SIGKILL depois do RUN_INTENT): o RECOVER de outro operador aborta a fase A vencida (RUN_ABORTED) e a auditoria volta a finalizar', async () => {
  const { w, e } = await ownerKilledAfterIntent();
  const recovered = await must(servicesOver(w, e).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR));
  assert.equal(recovered.ledger.runs?.open, null, show(recovered.ledger.runs));
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_ABORTED']);
  assert.equal(records[4]?.actor, 'bia@empresa.com');
  assert.deepEqual([records[4]?.run?.observed?.resultPresent, records[4]?.run?.observed?.receiptPresent], [false, false]);
  const done = await finalizeAs(finalizerOver(w, e), OP_A, w.auditId);
  assert.ok(done.ok, show(done));
  assert.deepEqual((await eventsOf(w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);
});

/** Auditoria protegida com um `RUN_INTENT` aberto VENCIDO (montado com a chave de teste) e o que ele cita. */
async function staleIntentWorld(): Promise<{ w: LedgerWorld; e: ResultsEnv; intent: LedgerRecord }> {
  const { w, e } = await protectedWorld();
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker());
  return { w, e, intent: (await ledgerRecords(w)).at(-1) as LedgerRecord };
}

/** Testemunha dos resultados que mostra o `sk` da operação aberta só a partir da leitura `from` (o dono publicou entre a avaliação e o RUN_ABORTED). */
function appearingResult(intent: LedgerRecord, from: number): { provider: KnownHeadsProvider; calls: () => number } {
  let calls = 0;
  const run = intent.run as NonNullable<LedgerRecord['run']>;
  return {
    calls: () => calls,
    provider: async () => {
      calls += 1;
      if (calls < from) return { ok: true, heads: [], unverifiedHeads: [], hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } };
      return {
        ok: true,
        heads: run.decisionsHead ? [run.decisionsHead] : [],
        unverifiedHeads: [],
        hasResults: true,
        ledgerHeads: [run.citedLedgerHead],
        unverifiedLedgerHeads: [],
        runs: { anchored: [], pending: runRefOf(1, run.runSha256, { ledgerHead: run.citedLedgerHead, finalizedBy: run.author, originProven: true }) },
      };
    },
  };
}

test('RL-18 / M-R16 (TOCTOU): o sk aparece entre a avaliação e o RUN_ABORTED ⇒ nenhum RUN_ABORTED (nem pela finalização, nem pelo RECOVER); a releitura seguinte vê a fase B', async () => {
  for (const via of ['finalização', 'RECOVER'] as const) {
    const { w, intent } = await staleIntentWorld();
    // leituras da testemunha ANTES da releitura R2 do RUN_ABORTED: a finalização lê R1 uma vez; o RECOVER lê a inicial do serviço e a R1 do laço de gravação
    const witness = appearingResult(intent, via === 'finalização' ? 2 : 3);
    const decisions = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, pollMs: 1 }), knownHeads: witness.provider });
    if (via === 'finalização') {
      const port = decisions.resultsLedger;
      assert.ok(port);
      const ctx = await port.context({ auditId: w.auditId, actor: 'bia@empresa.com', nowIso: FAR });
      assert.ok(ctx.kind === 'OK' && ctx.view.runs?.open?.phase === 'B', `${via}: ${show(ctx)}`);
    } else {
      const recovered = await must(decisions.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR));
      assert.equal(recovered.ledger.runs?.open?.phase, 'B', `${via}: ${show(recovered.ledger.runs)}`);
    }
    assert.ok(witness.calls() >= (via === 'finalização' ? 3 : 4), `${via}: os resultados foram RELIDOS antes de gravar e de novo na tentativa seguinte (${witness.calls()})`);
    assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT'], `${via}: nenhum RUN_ABORTED`);
  }
});

test('RL-18 / R7-09: RUN_INTENT gravado com hora no FUTURO vence pela idade OBSERVADA (monotônica) — antes do limite o RECOVER não aborta; no limite aborta, com a idade observada', async () => {
  const { w, e } = await protectedWorld();
  const records = await ledgerRecords(w);
  const future = signRecord(LEDGER_AUTH_A, w.auditId, records.at(-1) as LedgerRecord, { ...runIntentMaker()(records), recordedAt: '2027-06-01T00:00:00.000Z' });
  writeLedger(w, [future]);
  let now = 5_000;
  const observations = createOpenObservations(() => now);
  const STALE = 60_000;
  const decisions = servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, staleOperationMs: STALE, observations }) });
  const NOW = '2026-11-03T12:00:00.000Z';
  const first = await must(decisions.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW));
  assert.deepEqual([first.ledger.runs?.open?.phase, first.ledger.runs?.open?.stale], ['A', false], 'primeira observação: ainda não vencida');
  now += STALE - 1;
  await must(decisions.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW));
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT'], 'um instante antes do limite: nada abortado');
  now += 1;
  const recovered = await must(decisions.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW));
  assert.equal(recovered.ledger.runs?.open, null);
  const after = await ledgerRecords(w);
  assert.equal(after.at(-1)?.event, 'RUN_ABORTED');
  assert.ok((after.at(-1)?.run?.observed?.ageMs ?? 0) >= STALE, 'o RUN_ABORTED registra a idade observada (nunca negativa)');
});

test('RL-18 / M-R30: em HISTORY_UNRESOLVED (razão de decisão: recibo removido) nenhum RUN_ABORTED é gravado — nem pelo RECOVER, nem pela finalização', async () => {
  const { w, e } = await staleIntentWorld();
  fs.rmSync(anchorPath(w, 1));
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, () => FAR));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs?.open?.phase, view.ledger.runs?.open?.stale, view.ledger.runs?.open?.recoverable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', 'A', true, false]);
  const before = await eventsOf(w);
  await servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }) }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR);
  const done = await finalizeAs(finalizerOver(w, e, { ledger: AGED_OTHERS }), OP_B, w.auditId);
  assert.ok(!done.ok && done.code === 'NOT_FINALIZABLE', `a finalização é recusada pelo bloqueio do livro: ${show(done)}`);
  assert.deepEqual(await eventsOf(w), before, 'nenhum RUN_ABORTED');
  assert.deepEqual(publishedRunFiles(e), []);
});

test('M-R30 (modelo puro): a receita da fase A vencida (ABORT_RUN) só existe em PROTECTED com a família de resultados resolvida; recente ⇒ WAIT_RUN', () => {
  const AUD = 'auditoria-runs-0013';
  const D1 = { seq: 1, sha256: hashOf('d1'), prevSha256: null, action: 'RECORD' as const, author: 'ana@empresa.com', decisionId: 'op-0001', revokes: null, supersedes: null, affectsPrior: false };
  const records = chainOf(AUD).genesis().decision(D1).runIntent().records;
  const input = (over: Partial<ProtectionInput>): ProtectionInput => ({
    configured: true,
    read: { kind: 'PRESENT', records, tagFailure: verifyTags(records, LEDGER_AUTH_A) },
    auditId: AUD,
    decisions: { confirmed: [D1], pending: null },
    entryOriginProven: () => true,
    results: { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } },
    guard: { status: 'NOT_CONFIGURED' },
    ageMsOf: () => 200_000,
    staleMs: 120_000,
    currentKeyId: LEDGER_AUTH_A.keyId,
    ...over,
  });
  assert.equal(evaluateProtection(input({})).runPlan.kind, 'ABORT_RUN');
  assert.equal(evaluateProtection(input({ ageMsOf: () => 1_000 })).runPlan.kind, 'WAIT_RUN');
  // a mesma operação com as decisões em contradição (decisão confirmada que o livro não registrou): nenhuma receita de resultado
  const unresolved = evaluateProtection(input({ decisions: { confirmed: [D1, { ...D1, seq: 2, sha256: hashOf('d2'), prevSha256: D1.sha256, decisionId: 'op-0002' }], pending: null } }));
  assert.equal(unresolved.view.state, 'HISTORY_UNRESOLVED');
  assert.equal(unresolved.runPlan.kind, 'NONE');
});

test('RL-24 (testemunhas antes da receita): resultado que cita uma posição do livro que não confere + fase A vencida ⇒ nenhum RUN_ABORTED, nem pela finalização nem pelo RECOVER', async () => {
  const { w, intent } = await staleIntentWorld();
  const run = intent.run as NonNullable<LedgerRecord['run']>;
  const contradicting: KnownHeadsProvider = async () => ({ ok: true, heads: [], unverifiedHeads: [], hasResults: true, ledgerHeads: [{ ledgerSeq: run.citedLedgerHead.ledgerSeq, sha256: hashOf('livro-refeito') }], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } });
  const decisions = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1, pollMs: 1 }), knownHeads: contradicting });
  const port = decisions.resultsLedger;
  assert.ok(port);
  const ctx = await port.context({ auditId: w.auditId, actor: 'bia@empresa.com', nowIso: FAR });
  // estado não PROTECTED: o passo 1 não aplica receita nem autoriza RUN_INTENT (a avaliação da finalização recusa adiante)
  assert.ok(ctx.kind === 'OK' && ctx.view.state === 'HISTORY_UNRESOLVED' && ctx.view.reason === 'RESULT_LEDGER_MISMATCH', show(ctx));
  const draft = { runSeq: 1, prevRunSha256: null, runSha256: hashOf('qualquer'), author: 'bia@empresa.com', citedLedgerHead: run.citedLedgerHead, decisionsHead: run.decisionsHead };
  const refused = await port.intent({ session: ctx.session, auditId: w.auditId, actor: 'bia@empresa.com', nowIso: FAR, run: draft });
  assert.ok(refused.kind === 'REFUSED', `sem autorização de RUN_INTENT: ${show(refused)}`);
  const recovered = await decisions.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR);
  assert.ok(!recovered.ok, show(recovered));
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT'], 'nenhum RUN_ABORTED');
});

test('escritas de DECISÃO não aplicam receita de resultado: com fase A vencida a decisão é gravada e o RUN_INTENT continua aberto', async () => {
  const { w, e } = await staleIntentWorld();
  const decisions = servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }) });
  const view = await must(decisions.list(ANA, w.auditId, () => FAR));
  await must(decisions.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: view.head }, () => FAR));
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT', 'INTENT', 'CONFIRMED']);
});

/* ------------------------------------------------------------------ RL-37: prazo do dono (staleOperationMs / 2, relógio monotônico injetado) */

/** FsOps do livro que chama `after()` logo DEPOIS do `link()` do arquivo `name` (o RUN_INTENT do dono já é durável no disco). */
function afterLink(w: LedgerWorld, name: string, after: () => Promise<void> | void): FsOps {
  const target = path.join(w.ledgerDir, w.auditId, name);
  return {
    ...nodeFsOps,
    async link(from, to) {
      await nodeFsOps.link(from, to);
      if (to === target) await after();
    },
  };
}

test('RL-37 / M-R36: passado MAIS de staleOperationMs / 2 monotônicos desde o RUN_INTENT, o dono NÃO publica o resultado: grava o próprio RUN_ABORTED e responde RESULT_WRITE_CONFLICT; exatamente no meio ele ainda publica', async () => {
  const STALE = 1_000;
  for (const [advance, publishes] of [[STALE / 2 + 1, false], [STALE / 2, true]] as const) {
    const { w, e } = await protectedWorld();
    let now = 10_000;
    const f = finalizerOver(w, e, { ledger: { staleOperationMs: STALE, monotonicMs: () => now, fs: afterLink(w, 'l000004.json', () => void (now += advance)) } });
    const done = await finalizeAs(f, OP_A, w.auditId);
    if (publishes) {
      assert.ok(done.ok, `${advance} ms: ${show(done)}`);
      assert.deepEqual((await eventsOf(w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);
      continue;
    }
    assert.ok(!done.ok && done.code === 'RESULT_WRITE_CONFLICT', `${advance} ms: ${show(done)}`);
    const records = await ledgerRecords(w);
    assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_ABORTED']);
    assert.equal(records[4]?.actor, 'ana@empresa.com', 'o próprio dono aborta');
    assert.deepEqual(records[4]?.run?.observed, { resultPresent: false, receiptPresent: false, ageMs: advance });
    assert.deepEqual(publishedRunFiles(e), [], 'nenhum resultado publicado');
    assert.match(RESULTS_MESSAGE.RESULT_WRITE_CONFLICT, /nada foi publicado/);
    // a auditoria segue finalizável: a próxima tentativa paga de novo (2 registros) e conclui
    const again = await finalizeAs(finalizerOver(w, e), OP_A, w.auditId);
    assert.ok(again.ok, show(again));
    assert.deepEqual((await eventsOf(w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);
  }
});

test('RL-37 / RL-11 (no mesmo processo): o RECOVER aborta a fase A do dono entre o RUN_INTENT e a publicação ⇒ o dono relê, vê a operação fechada e NÃO publica (RESULT_WRITE_CONFLICT); nada de resultado depois do aborto', async () => {
  const { w, e } = await protectedWorld();
  const recover = async (): Promise<void> => {
    await must(servicesOver(w, e, { ledger: ledgerFor(w, { guard: null }) }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR));
  };
  // o relógio monotônico do dono NÃO anda: só a releitura do livro antes de publicar o protege aqui
  const f = finalizerOver(w, e, { ledger: { monotonicMs: () => 0, fs: afterLink(w, 'l000004.json', recover) } });
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.ok(!done.ok && done.code === 'RESULT_WRITE_CONFLICT', show(done));
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_ABORTED']);
  assert.equal(records[4]?.actor, 'bia@empresa.com');
  assert.deepEqual(publishedRunFiles(e), [], 'o dono lento não publicou depois do aborto');
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open], ['PROTECTED', null]);
});

test('RL-11 (processos reais): outro PROCESSO aborta a fase A vencida enquanto o dono está entre o RUN_INTENT e a publicação ⇒ o dono não publica', async () => {
  const { w, e } = await protectedWorld();
  let child: Awaited<ReturnType<typeof spawnChild>> | null = null;
  const f = finalizerOver(w, e, {
    ledger: {
      monotonicMs: () => 0,
      fs: afterLink(w, 'l000004.json', async () => {
        child = await spawnChild(w, e, { task: 'recover', actor: 'bia@empresa.com', nowIso: FAR });
      }),
    },
  });
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.deepEqual((child as Awaited<ReturnType<typeof spawnChild>> | null)?.line, { ok: true, code: null }, show(child));
  assert.ok(!done.ok && done.code === 'RESULT_WRITE_CONFLICT', show(done));
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT', 'RUN_ABORTED']);
  assert.deepEqual(publishedRunFiles(e), []);
});
