import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { replayLedger, verifyTags, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { createOriginAuthenticator, type OriginAuthenticator } from '../src/lib/link-audit-origin';
import type { KnownHeadsProvider, ResultsLedgerPort } from '../src/lib/link-audit-decisions';
import { createResultsKnownHeads } from '../src/lib/link-audit-scoring-runs';
import type { Evaluation } from '../src/lib/link-audit-scoring-runs/preview';
import type { PreviewEvaluator } from '../src/lib/link-audit-scoring-runs/results';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { clearStorageFatal, seal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { BIA, anchorPath, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { BLOCKING, makeService, OP_A, OP_B, receiptPath, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { appendLedger, hashOf, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';
import { bodyNow, everythingOf, finalizerOver, footprintOf, openRunWorld, plantForgedRunReceipt, protectedWorld, runsOf, spawnChild, type FinalizerOver } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R1.4 — CONCLUSÃO DAS FASES B E C SÓ PELO AUTOR (spec §16.17.4, tabela das fases; ADR-0002 (3); espelho da §16.16 das decisões). Uma finalização parada depois de publicar
 * `sk` (fase B: recibo ausente; fase C: recibo presente, RUN_CONFIRMED ausente) só é concluída pelo REENVIO IDÊNTICO do AUTOR (e-mail da sessão normalizado `=== run.author ===
 * finalizedBy`), com o objeto conferido contra o livro (passo 1b), origem `PROVEN`, TODAS as reconferências da conclusão (nenhuma dispensada por haver recibo), o recibo
 * GRAVADO na B e ADOTADO na C (nunca regravado), sync estrito das pastas da auditoria e dos diretórios-pai e, por fim, o RUN_CONFIRMED gravado pelo autor.
 * Quem não é o autor recebe RESULT_PENDING_UNCONFIRMED; origem não comprovada, RESULT_PENDING_ORIGIN_UNPROVEN; e as recusas da tabela. Nada é gravado em canal algum.
 * Cobre RL-01, RL-02, RL-04 (B/C), RL-05, RL-06, RL-07 e as mutações M-R07, M-R08, M-R09, M-R10, M-R17 (conclusão) e M-R18 (casamento R6-04 do lado do dono).
 * Pastas reais em diretórios temporários, chaves de TESTE, e-mails fictícios `@empresa.com`, nenhuma rede.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 320);
const BASE = ['GENESIS', 'INTENT', 'CONFIRMED'];
const eventsOf = async (w: LedgerWorld): Promise<string[]> => (await ledgerRecords(w)).map((record) => record.event);
const codeOf = (result: { ok: boolean }): string | null => (result.ok ? null : ((result as unknown as { code: string }).code ?? null));

/** O livro terminou com UM RUN_CONFIRMED gravado pelo autor, casando com o RUN_INTENT (âncora = o recibo do resultado), autêntico e com o replay válido. */
async function assertConcludedByAuthor(w: LedgerWorld, e: ResultsEnv, run: ScoreRun, label: string): Promise<void> {
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED'], `${label}: exatamente um par RUN_INTENT/RUN_CONFIRMED`);
  const closing = records[4] as LedgerRecord;
  assert.deepEqual([closing.actor, closing.run?.runSha256, closing.run?.intentSeq, closing.run?.anchorRef], ['ana@empresa.com', run.contentSha256, 4, { name: 'a0001.json', headSha256: run.contentSha256 }], `${label}: fecho do autor`);
  assert.ok(replayLedger(records, w.auditId).ok, `${label}: replay válido`);
  assert.equal(verifyTags(records, LEDGER_AUTH_A), null, `${label}: etiquetas válidas`);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open, view.ledger.runs?.confirmed], ['PROTECTED', null, [{ runSeq: 1, runSha256: run.contentSha256 }]], `${label}: vista`);
  const after = await runsOf(e, w.auditId);
  assert.deepEqual([after.all.length, after.runs.length, after.pending], [1, 1, null], `${label}: exatamente um resultado, com recibo`);
}

/** A operação continua aberta, PROTECTED, na mesma fase, e nada foi gravado em lugar nenhum. */
async function assertUntouched(w: LedgerWorld, e: ResultsEnv, before: Record<string, unknown>, phase: 'B' | 'C', label: string): Promise<void> {
  assert.deepEqual(await everythingOf(w, e), before, `${label}: nada gravado (livro, decisões, recibos, resultados, recibos de resultados)`);
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT'], `${label}: nenhum RUN_CONFIRMED`);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open?.phase], ['PROTECTED', phase], `${label}: operação aberta, PROTECTED`);
}

/* ============================================================================ RL-01 / RL-02 / RL-04: recibo forjado, outro operador e o autor */

test('RL-01 (espelho de RV3A-1): fase B + recibo FORJADO (só SHA-256) ⇒ parece fase C; Bia reenvia o pedido IDÊNTICO ⇒ RESULT_PENDING_UNCONFIRMED, nada gravado em canal algum; eventos [..., RUN_INTENT]', async () => {
  const { w, e, body, run } = await openRunWorld('B');
  plantForgedRunReceipt(e, w.auditId, run);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.runs?.open?.phase, 'C', 'o recibo forjado faz a operação parecer em fase C');
  const before = await everythingOf(w, e);
  const attack = await finalizerOver(w, e).results.finalize(OP_B, w.auditId, body);
  assert.equal(codeOf(attack), 'RESULT_PENDING_UNCONFIRMED', show(attack));
  // R1.5 (D-18): a pendente vai no corpo com o recibo PRESENTE (o livro não confirmou; nunca é confirmação)
  assert.equal((attack as { pending?: { receipt?: string } }).pending?.receipt, 'PRESENT', 'fase C: a pendente vai no corpo com receipt PRESENT');
  await assertUntouched(w, e, before, 'C', 'RL-01');
});

test('RL-02 (espelho, pedido NOVO de outro operador): com a operação de Ana em fase C (recibo forjado), Bia finaliza OUTRO estado ⇒ RESULT_PENDING_UNCONFIRMED e nada gravado; o mesmo vale para um pedido não idêntico da própria autora', async () => {
  const { w, e, run } = await openRunWorld('B');
  plantForgedRunReceipt(e, w.auditId, run);
  // outro estado: Bia grava uma decisão nova (decisões nunca esperam por resultado, D-8) e finaliza sobre a prévia nova
  await must(servicesOver(w, e).create(BIA, w.auditId, { record: rec.c3(), expectedHead: (await must(servicesOver(w, e).list(BIA, w.auditId, clock()))).head }, clock()));
  const before = await everythingOf(w, e);
  for (const actor of [OP_B, OP_A]) {
    const f = finalizerOver(w, e);
    const done = await f.results.finalize(actor, w.auditId, await bodyNow(f, actor, w.auditId));
    assert.equal(codeOf(done), 'RESULT_PENDING_UNCONFIRMED', `${actor.email}: ${show(done)}`);
  }
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT', 'INTENT', 'CONFIRMED'], 'só a decisão de Bia entrou; nenhum RUN_* novo');
});

for (const variant of ['B', 'C', 'C (recibo forjado)'] as const) {
  test(`RL-04 (conclusão pelo autor, ${variant}): Ana reenvia o MESMO pedido ⇒ 200 recoveredPending; RUN_CONFIRMED gravado por Ana com a âncora do recibo; ${variant === 'B' ? 'o recibo é GRAVADO' : 'o recibo existente é ADOTADO byte a byte (nunca regravado)'}; list confirma`, async () => {
    const phase = variant === 'B' ? 'B' : 'C';
    const { w, e, body, run } = await openRunWorld(variant === 'C' ? 'C' : 'B');
    if (variant === 'C (recibo forjado)') plantForgedRunReceipt(e, w.auditId, run);
    const anchorsBefore = (await footprintOf(w, e)).anchors;
    // o não autor primeiro: nada muda
    const before = await everythingOf(w, e);
    assert.equal(codeOf(await finalizerOver(w, e).results.finalize(OP_B, w.auditId, body)), 'RESULT_PENDING_UNCONFIRMED');
    await assertUntouched(w, e, before, phase, `${variant}/Bia`);
    const f = finalizerOver(w, e);
    const done = await f.results.finalize(OP_A, w.auditId, body);
    assert.ok(done.ok, show(done));
    assert.deepEqual([done.value.recoveredPending, done.value.replayed, done.value.head], [true, true, { seq: 1, sha256: run.contentSha256 }]);
    await assertConcludedByAuthor(w, e, run, variant);
    if (phase === 'C') assert.deepEqual((await footprintOf(w, e)).anchors, anchorsBefore, 'fase C: o recibo existente foi ADOTADO, nunca regravado');
    else assert.equal((JSON.parse(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8')) as { headSha256: string }).headSha256, run.contentSha256, 'fase B: o recibo foi gravado agora');
    const listed = await must(f.results.list(OP_A, w.auditId));
    assert.deepEqual([listed.results.map((r) => r.contentSha256), listed.pending], [[run.contentSha256], null], 'list confirma');
    // depois de concluído, o reenvio é um reenvio de confirmado (200 replayed, sem gravar)
    const settled = await everythingOf(w, e);
    const again = await finalizerOver(w, e).results.finalize(OP_B, w.auditId, body);
    assert.ok(again.ok && again.value.replayed && !again.value.recoveredPending, show(again));
    assert.deepEqual(await everythingOf(w, e), settled);
  });
}

test('pendente no corpo (R1.5): a recusa de quem não é o autor traz `pending` com receipt MISSING na B e PRESENT na C', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body } = await openRunWorld(phase);
    const refused = await finalizerOver(w, e).results.finalize(OP_B, w.auditId, body);
    assert.equal(codeOf(refused), 'RESULT_PENDING_UNCONFIRMED', show(refused));
    const pending = (refused as { pending?: { receipt: string; isMine: boolean } }).pending;
    assert.deepEqual([pending?.receipt, pending?.isMine], [phase === 'B' ? 'MISSING' : 'PRESENT', false], phase);
  }
});

/* ============================================================================ RL-06: identidade normalizada (M-R07) */

test('RL-06 / M-R07: " ANA@Empresa.com " conclui a fase C; " BIA@Empresa.com " recebe RESULT_PENDING_UNCONFIRMED e nada é gravado', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body, run } = await openRunWorld(phase);
    const before = await everythingOf(w, e);
    const other = await finalizerOver(w, e).results.finalize({ email: ' BIA@Empresa.com ' }, w.auditId, body);
    assert.equal(codeOf(other), 'RESULT_PENDING_UNCONFIRMED', `${phase}: ${show(other)}`);
    await assertUntouched(w, e, before, phase, `${phase}/Bia normalizada`);
    const own = await finalizerOver(w, e).results.finalize({ email: ' ANA@Empresa.com ' }, w.auditId, body);
    assert.ok(own.ok && own.value.recoveredPending, `${phase}: ${show(own)}`);
    await assertConcludedByAuthor(w, e, run, `${phase}/Ana normalizada`);
  }
});

/* ============================================================================ RL-05: reconferências, uma por vez (fases B e C) */

/** Avaliador que embrulha a prévia REAL e altera UMA coisa (só na conclusão: o pedido idêntico foi montado com a prévia real). */
function tampered(over: { evaluate?: (value: Evaluation) => Evaluation; failWith?: 'READ_INCONSISTENT' | 'DECISIONS_DURABILITY_UNKNOWN' | 'RESULT_INTEGRITY'; barrier?: Awaited<ReturnType<PreviewEvaluator['durabilityBarrier']>> }, calls: { evaluate: number; barrier: number } = { evaluate: 0, barrier: 0 }): NonNullable<FinalizerOver['evaluator']> {
  return (preview) => ({
    async evaluate(actor, auditId) {
      calls.evaluate += 1;
      // `RESULT_INTEGRITY` não é código da prévia (tipo); o caso força a regra por CÓDIGO de `CONCLUSION_WITHOUT_PENDING` (revisão da R1.5, lacuna apontada por `junin-01`)
      if (over.failWith) return { ok: false, code: over.failWith as 'READ_INCONSISTENT', issues: [] };
      const result = await preview.evaluate(actor, auditId);
      return result.ok && over.evaluate ? { ok: true, value: over.evaluate(result.value) } : result;
    },
    fingerprintNow: (actor, auditId) => preview.fingerprintNow(actor, auditId),
    async durabilityBarrier(actor, auditId, expected) {
      calls.barrier += 1;
      return over.barrier ?? preview.durabilityBarrier(actor, auditId, expected);
    },
  });
}
const withBlocker = (code: string) => (value: Evaluation): Evaluation => ({ ...value, payload: { ...value.payload, blockers: [...value.payload.blockers, BLOCKING(code)] } });
const withChangedEvidence = (value: Evaluation): Evaluation => {
  const mapped = value.mapped as NonNullable<Evaluation['mapped']>;
  return { ...value, mapped: { ...mapped, traceability: { ...mapped.traceability, evidences: mapped.traceability.evidences.map((item, index) => (index === 0 ? { ...item, contentSha256: hashOf('evidencia-trocada') } : item)) } } };
};
const withRegressedDecisions = (value: Evaluation): Evaluation => ({ ...value, decisions: { ...value.decisions, head: null } });

const RECHECKS: ReadonlyArray<{ readonly label: string; readonly code: string; readonly over: (calls: { evaluate: number; barrier: number }) => FinalizerOver }> = [
  { label: 'origem não comprovada pelo serviço de resultados (chave desconhecida, a testemunha comprova)', code: 'RESULT_PENDING_ORIGIN_UNPROVEN', over: () => ({ origin: createOriginAuthenticator(OTHER_ORIGIN_KEY) }) },
  { label: 'origem não comprovada pela testemunha do livro (o serviço de resultados comprova)', code: 'RESULT_PENDING_ORIGIN_UNPROVEN', over: () => ({ witnessOrigin: createOriginAuthenticator(OTHER_ORIGIN_KEY) }) },
  { label: 'sem prova de coleta', code: 'NOT_FINALIZABLE', over: (calls) => ({ evaluator: tampered({ evaluate: withBlocker('EVIDENCE_PROVENANCE_UNPROVEN') }, calls) }) },
  { label: 'histórico de decisões não resolvido na avaliação', code: 'NOT_FINALIZABLE', over: (calls) => ({ evaluator: tampered({ evaluate: withBlocker('DECISIONS_HISTORY_UNRESOLVED') }, calls) }) },
  { label: 'evidência fixada mudou de hash', code: 'EVIDENCE_HASH_CHANGED', over: (calls) => ({ evaluator: tampered({ evaluate: withChangedEvidence }, calls) }) },
  { label: 'decisões regredidas', code: 'HISTORY_REGRESSED', over: (calls) => ({ evaluator: tampered({ evaluate: withRegressedDecisions }, calls) }) },
  { label: 'fsync na barreira de durabilidade', code: 'RESULT_DURABILITY_UNKNOWN', over: (calls) => ({ evaluator: tampered({ barrier: { ok: false, code: 'DURABILITY_UNKNOWN', issues: ['fsync simulado'] } }, calls) }) },
  { label: 'estado mudou na barreira', code: 'INPUT_CHANGED', over: (calls) => ({ evaluator: tampered({ barrier: { ok: false, code: 'INPUT_CHANGED', issues: ['mudou'] } }, calls) }) },
  { label: 'a avaliação falha (leituras discordantes)', code: 'READ_INCONSISTENT', over: (calls) => ({ evaluator: tampered({ failWith: 'READ_INCONSISTENT' }, calls) }) },
  // R1.6 (lacuna da revisão da R1.5, `junin-01`): as duas exceções da regra "toda recusa leva a pendente" — integridade e durabilidade desconhecida das DECISÕES
  { label: 'a avaliação falha com durabilidade desconhecida das decisões', code: 'DECISIONS_DURABILITY_UNKNOWN', over: (calls) => ({ evaluator: tampered({ failWith: 'DECISIONS_DURABILITY_UNKNOWN' }, calls) }) },
  { label: 'a avaliação falha com integridade (defesa por código)', code: 'RESULT_INTEGRITY', over: (calls) => ({ evaluator: tampered({ failWith: 'RESULT_INTEGRITY' }, calls) }) },
];
/**
 * Revisão da R1.5 (`junin-01`, MINOR): toda recusa da conclusão leva a pendente com o recibo da fase (MISSING na B, PRESENT na C) — salvo integridade (nenhum dado de registro que não
 * se explica) e durabilidade desconhecida, dos resultados ou das decisões (nada se afirma com a base travada). R1.6: as três exceções passaram a ser conferidas.
 */
const NO_PENDING_CODES: ReadonlySet<string> = new Set(['RESULT_DURABILITY_UNKNOWN', 'DECISIONS_DURABILITY_UNKNOWN', 'RESULT_INTEGRITY']);

for (const phase of ['B', 'C'] as const) {
  for (const item of RECHECKS) {
    test(`RL-05 / M-R08 / M-R09 (fase ${phase}, autor): ${item.label} ⇒ ${item.code}; nenhum RUN_CONFIRMED, nenhuma pasta muda`, async () => {
      const { w, e, body } = await openRunWorld(phase);
      const before = await everythingOf(w, e);
      const done = await finalizerOver(w, e, item.over({ evaluate: 0, barrier: 0 })).results.finalize(OP_A, w.auditId, body);
      assert.equal(codeOf(done), item.code, show(done));
      // a recusa vem do SERVIÇO, antes do armazenamento, e leva a pendente com o recibo da fase (R1.5, D-18; revisão da R1.5): PRESENT na C, MISSING na B — salvo durabilidade
      const pending = (done as { pending?: { receipt?: string; seq?: number } }).pending;
      if (NO_PENDING_CODES.has(item.code)) assert.equal(pending, undefined, `${phase}/${item.label}: integridade e durabilidade desconhecida não afirmam nada (sem a pendente)`);
      else assert.deepEqual([pending?.seq, pending?.receipt], [1, phase === 'C' ? 'PRESENT' : 'MISSING'], `${phase}/${item.label}: a pendente vai no corpo`);
      await assertUntouched(w, e, before, phase, `${phase}/${item.label}`);
      // a recusa não é permanente: com tudo em ordem o autor conclui depois
      const own = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
      assert.ok(own.ok && own.value.recoveredPending, show(own));
    });
  }
}

test('M-R09 / M-R10: a conclusão da fase C passa pelas reconferências (avaliação e barreira chamadas) — nunca é tratada como reenvio de confirmado só por haver recibo', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body } = await openRunWorld(phase);
    const calls = { evaluate: 0, barrier: 0 };
    const done = await finalizerOver(w, e, { evaluator: tampered({}, calls) }).results.finalize(OP_A, w.auditId, body);
    assert.ok(done.ok && done.value.recoveredPending, `${phase}: ${show(done)}`);
    assert.ok(calls.evaluate >= 1 && calls.barrier >= 1, `${phase}: reconferências executadas ${show(calls)}`);
  }
});

/** Fase C PLANTADA sobre um resultado selado de verdade (com a chave de TESTE de origem), possivelmente alterado por `mutate`, e o RUN_INTENT que o amarra (chave de teste do livro). */
async function plantedPhaseC(mutate: (unsigned: Record<string, unknown>) => Record<string, unknown>): Promise<{ w: LedgerWorld; e: ResultsEnv; body: Awaited<ReturnType<typeof bodyNow>>; run: ScoreRun }> {
  const { w, e } = await protectedWorld();
  const legacy = finalizerOver(w, e, { port: false });
  const body = await bodyNow(legacy, OP_A, w.auditId);
  assert.ok((await legacy.results.finalize(OP_A, w.auditId, body)).ok);
  const sealed = (await runsOf(e, w.auditId)).runs[0] as ScoreRun;
  const { origin: _origin, contentSha256: _hash, ...unsigned } = sealed as unknown as Record<string, unknown>;
  void _origin;
  void _hash;
  const changed = mutate(structuredClone(unsigned));
  const run = seal({ ...changed, origin: TEST_ORIGIN.sign('RUN', changed) }) as unknown as ScoreRun;
  fs.rmSync(runPath(e, 1, w.auditId));
  fs.rmSync(receiptPath(e, 1, w.auditId));
  fs.writeFileSync(runPath(e, 1, w.auditId), serialize(run), { mode: 0o444 });
  plantForgedRunReceipt(e, w.auditId, run);
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker({ runSeq: 1, prevRunSha256: null, runSha256: run.contentSha256, author: run.finalizedBy, citedLedgerHead: run.ledgerHead as { ledgerSeq: number; sha256: string }, decisionsHead: run.decisions.head }));
  return { w, e, body, run };
}

test('RL-05 (fase C): registro que NÃO se explica (motor não o reproduz; origem e livro em ordem) ⇒ RESULT_INTEGRITY, nada gravado; o controle sem alteração conclui', async () => {
  const broken = await plantedPhaseC((unsigned) => ({ ...unsigned, resultSha256: hashOf('outro-resultado') }));
  assert.equal((await must(servicesOver(broken.w, broken.e).list(BIA, broken.w.auditId, clock()))).ledger.runs?.open?.recoverable, true, 'controle: a origem é comprovada e há receita');
  const before = await everythingOf(broken.w, broken.e);
  const refused = await finalizerOver(broken.w, broken.e).results.finalize(OP_A, broken.w.auditId, broken.body);
  assert.equal(codeOf(refused), 'RESULT_INTEGRITY', show(refused));
  // R1.6 (lacuna da revisão da R1.5, `junin-01`): integridade nunca leva a pendente (nenhum dado de um registro que não se explica)
  assert.equal((refused as { pending?: unknown }).pending, undefined, 'RESULT_INTEGRITY sem a pendente');
  await assertUntouched(broken.w, broken.e, before, 'C', 'não se explica');
  const fine = await plantedPhaseC((unsigned) => unsigned);
  const done = await finalizerOver(fine.w, fine.e).results.finalize(OP_A, fine.w.auditId, fine.body);
  assert.ok(done.ok && done.value.recoveredPending, show(done));
  await assertConcludedByAuthor(fine.w, fine.e, fine.run, 'controle');
});

/* ============================================================================ D-16 / D-R1-7: origem não comprovável em B/C */

const at = (iso: string) => () => new Date(iso);
const UNPROVABLE: ReadonlyArray<readonly [string, OriginAuthenticator]> = [
  ['KEY_EXPIRED (aposentada vencida)', createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [`${TEST_ORIGIN_KEY}:2026-11-01`], now: at('2026-12-15T12:00:00Z') })],
  ['KEY_REVOKED', createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, revokedIds: ['ok-test-a'] })],
];
for (const [label, origin] of UNPROVABLE) {
  test(`D-16 / D-R1-7: origem não comprovável em B/C (${label}) ⇒ a operação fica ABERTA, PROTECTED, sem receita (recoverable false); o autor recebe RESULT_PENDING_ORIGIN_UNPROVEN; nada gravado`, async () => {
    for (const phase of ['B', 'C'] as const) {
      const { w, e, body } = await openRunWorld(phase);
      const before = await everythingOf(w, e);
      const f = finalizerOver(w, e, { origin, witnessOrigin: origin });
      const refused = await f.results.finalize(OP_A, w.auditId, body);
      assert.equal(codeOf(refused), 'RESULT_PENDING_ORIGIN_UNPROVEN', `${phase}: ${show(refused)}`);
      assert.deepEqual(await everythingOf(w, e), before, `${phase}: nada gravado`);
      const view = await must(f.decisions.list(BIA, w.auditId, clock()));
      assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs?.state, view.ledger.runs?.open?.phase, view.ledger.runs?.open?.recoverable], ['PROTECTED', null, 'OK', phase, false], `${phase}: não é HISTORY_UNRESOLVED (D-16)`);
      assert.equal(view.finalizable, true, `${phase}: as decisões seguem vigentes (a operação de resultado aberta não as congela)`);
    }
  });
}

/* ============================================================================ recibo ADOTADO e sync estrito (M-R17 na conclusão) */

/** FsOps que anota cada publicação/temporário nas pastas de RECIBOS de resultados e cada fsync de diretório (em ordem), e pode falhar o fsync de `failDir`. */
function recorder(e: ResultsEnv, failDir?: string): { readonly log: string[]; readonly fs: FsOps } {
  const log: string[] = [];
  return {
    log,
    fs: {
      ...nodeFsOps,
      async writeExclusive(target, data, mode) {
        if (target.startsWith(e.anchors)) log.push(`write ${target}`);
        return nodeFsOps.writeExclusive(target, data, mode);
      },
      async link(from, to) {
        if (to.startsWith(e.anchors)) log.push(`link ${to}`);
        return nodeFsOps.link(from, to);
      },
      async syncDirectory(dir) {
        if (dir === failDir) throw Object.assign(new Error('fsync simulado'), { code: 'EIO' });
        await nodeFsOps.syncDirectory(dir);
        log.push(`sync ${dir}`);
      },
    },
  };
}

test('fase C: o recibo existente é ADOTADO — nenhuma gravação (nem temporário) na pasta de recibos de resultados durante a conclusão; a fase B grava o recibo uma vez', async () => {
  const c = await openRunWorld('C');
  const traceC = recorder(c.e);
  assert.ok((await finalizerOver(c.w, c.e, { resultsFs: traceC.fs }).results.finalize(OP_A, c.w.auditId, c.body)).ok);
  assert.deepEqual(traceC.log.filter((line) => !line.startsWith('sync ')), [], `fase C: nada escrito em recibos: ${show(traceC.log)}`);
  const b = await openRunWorld('B');
  const traceB = recorder(b.e);
  assert.ok((await finalizerOver(b.w, b.e, { resultsFs: traceB.fs }).results.finalize(OP_A, b.w.auditId, b.body)).ok);
  assert.deepEqual(traceB.log.filter((line) => line.startsWith('link ')), [`link ${receiptPath(b.e, 1, b.w.auditId)}`], `fase B: o recibo é gravado uma vez: ${show(traceB.log)}`);
});

test('M-R17 (conclusão B/C): as pastas da auditoria em resultados e em recibos e os diretórios-pai são sincronizados ESTRITAMENTE antes do RUN_CONFIRMED', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body } = await openRunWorld(phase);
    const trace = recorder(e);
    const order: string[] = [];
    const ledgerFs: FsOps = {
      ...nodeFsOps,
      async link(from, to) {
        await nodeFsOps.link(from, to);
        if (to === path.join(w.ledgerDir, w.auditId, 'l000005.json')) order.push(`run-confirmed@${trace.log.length}`);
      },
    };
    assert.ok((await finalizerOver(w, e, { resultsFs: trace.fs, ledger: { fs: ledgerFs } }).results.finalize(OP_A, w.auditId, body)).ok);
    const confirmedAt = Number(order[0]?.split('@')[1]);
    const synced = trace.log.slice(0, confirmedAt).filter((line) => line.startsWith('sync ')).map((line) => line.slice(5));
    for (const dir of [path.join(e.base, w.auditId), path.join(e.anchors, w.auditId), e.base, e.anchors]) assert.ok(synced.includes(dir), `${phase}: ${dir} sincronizado antes do RUN_CONFIRMED: ${show(trace.log)}`);
  }
});

for (const target of ['results-audit', 'anchors-audit', 'results-root', 'anchors-root'] as const) {
  test(`M-R17 / RL-20 (conclusão): fsync falho da ${target} ⇒ RESULT_DURABILITY_UNKNOWN, nenhum RUN_CONFIRMED; depois do reinício o MESMO pedido conclui sem duplicar`, async () => {
    for (const phase of ['B', 'C'] as const) {
      const { w, e, body, run } = await openRunWorld(phase);
      const dir = { 'results-audit': path.join(e.base, w.auditId), 'anchors-audit': path.join(e.anchors, w.auditId), 'results-root': e.base, 'anchors-root': e.anchors }[target];
      const failed = await finalizerOver(w, e, { resultsFs: recorder(e, dir).fs }).results.finalize(OP_A, w.auditId, body);
      assert.equal(codeOf(failed), 'RESULT_DURABILITY_UNKNOWN', `${phase}: ${show(failed)}`);
      assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT'], `${phase}: nenhum RUN_CONFIRMED sem a durabilidade comprovada`);
      clearStorageFatal();
      const done = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
      assert.ok(done.ok && done.value.recoveredPending, `${phase}: ${show(done)}`);
      await assertConcludedByAuthor(w, e, run, `${phase}/${target}`);
    }
  });
}

/* ============================================================================ porta: autorização de uso único da conclusão */

test('porta: a conclusão exige a autorização do passo 1 desta sessão, emitida SÓ ao autor com receita; é de uso único; o rascunho tem de ser o do RUN_INTENT aberto', async () => {
  const { w, e, run } = await openRunWorld('C');
  const port = finalizerOver(w, e).decisions.resultsLedger;
  assert.ok(port);
  const draft = { runSeq: 1, prevRunSha256: null, runSha256: run.contentSha256, author: 'ana@empresa.com', citedLedgerHead: run.ledgerHead as { ledgerSeq: number; sha256: string }, decisionsHead: run.decisions.head };
  const before = await eventsOf(w);
  // não autor: o passo 1 não autoriza, e a conclusão é recusada sem gravar
  const bia = await port.context({ auditId: w.auditId, actor: 'bia@empresa.com', nowIso: clock() });
  assert.ok(bia.kind === 'OK' && bia.concludable === false, show(bia));
  const byBia = await port.conclude({ session: bia.session, auditId: w.auditId, actor: 'bia@empresa.com', nowIso: clock(), run: { ...draft } });
  assert.ok(byBia.kind === 'REFUSED', show(byBia));
  // sessão do autor reaproveitada por OUTRA identidade: recusa (a autorização é do autor)
  const ana = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ana.kind === 'OK' && ana.concludable === true, show(ana));
  const hijack = await port.conclude({ session: ana.session, auditId: w.auditId, actor: 'bia@empresa.com', nowIso: clock(), run: draft });
  assert.ok(hijack.kind === 'REFUSED' && hijack.refusal.code === 'PENDING_UNCONFIRMED', `a porta recusa quem não é o autor ANTES de gravar (não depende do replay): ${show(hijack)}`);
  const afterHijack = await port.conclude({ session: ana.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(afterHijack.kind === 'REFUSED', `a autorização foi consumida pela tentativa recusada: ${show(afterHijack)}`);
  // a autorização da conclusão não sobrevive a outra gravação pedida na mesma sessão (uso único: qualquer gravação a consome)
  const reused = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(reused.kind === 'OK' && reused.concludable);
  const stray = await port.intent({ session: reused.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: { ...draft, runSeq: 2, prevRunSha256: run.contentSha256, runSha256: hashOf('outro') } });
  assert.ok(stray.kind === 'REFUSED', show(stray));
  const afterStray = await port.conclude({ session: reused.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(afterStray.kind === 'REFUSED', `autorização consumida por outra gravação: ${show(afterStray)}`);
  // rascunho que não é o do RUN_INTENT aberto
  const other = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(other.kind === 'OK');
  const wrong = await port.conclude({ session: other.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: { ...draft, runSha256: hashOf('outro') } });
  assert.ok(wrong.kind === 'REFUSED', show(wrong));
  assert.deepEqual(await eventsOf(w), before, 'nenhuma recusa gravou nada');
  // o autor, com a autorização da sessão dele: conclui (o recibo já é durável na fase C)
  const good = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(good.kind === 'OK' && good.concludable);
  const done = await port.conclude({ session: good.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.equal(done.kind, 'OK', show(done));
  const twice = await port.conclude({ session: good.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(twice.kind === 'REFUSED', `uso único: ${show(twice)}`);
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED']);
});

test('livro em HISTORY_UNRESOLVED (razão de decisão: recibo de decisão removido) com a operação de resultado em fase C ⇒ o autor NÃO conclui (nada é afirmado sobre um livro em dúvida); nada gravado', async () => {
  const { w, e, body } = await openRunWorld('C');
  fs.rmSync(anchorPath(w, 1));
  const before = await everythingOf(w, e);
  const refused = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
  assert.equal(codeOf(refused), 'DECISIONS_HISTORY_UNRESOLVED', show(refused));
  assert.deepEqual(await everythingOf(w, e), before);
});

test('porta: sem receita o passo 1 não autoriza a conclusão nem ao autor — origem não comprovável pela testemunha (D-16) ou testemunha das DECISÕES não resolvida', async () => {
  const { w, e } = await openRunWorld('C');
  const unprovable = finalizerOver(w, e, { witnessOrigin: createOriginAuthenticator(OTHER_ORIGIN_KEY) }).decisions.resultsLedger;
  assert.ok(unprovable);
  const noRecipe = await unprovable.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(noRecipe.kind === 'OK' && noRecipe.concludable === false && noRecipe.view.runs?.open?.recoverable === false, show(noRecipe));
  // testemunha das decisões que afirma OUTRA entrada na posição 1 (HISTORY_DIVERGES), com os resultados reais (a fase C continua visível)
  const real = createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir, w.ledgerDir], origin: TEST_ORIGIN });
  const lying: KnownHeadsProvider = async (auditId) => {
    const read = await real(auditId);
    return read.ok ? { ...read, heads: [{ seq: 1, sha256: hashOf('outra-entrada') }] } : read;
  };
  const port = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: lying }).resultsLedger;
  assert.ok(port);
  const witnessed = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(witnessed.kind === 'OK' && witnessed.view.runs?.open?.phase === 'C' && witnessed.concludable === false, show(witnessed));
});

/** A porta REAL com o `context` adulterado: o serviço de resultados não pode depender só da porta, nem a porta só do serviço (defesa em profundidade). */
function forcedConcludable(port: ResultsLedgerPort, value: boolean): ResultsLedgerPort {
  return { ...port, async context(input) {
    const ctx = await port.context(input);
    return ctx.kind === 'OK' ? { ...ctx, concludable: value } : ctx;
  } };
}

test('defesa em profundidade (M-R07): com uma porta que AFIRMA autorizar a conclusão a quem não é o autor, o serviço de resultados recusa (RESULT_PENDING_UNCONFIRMED) antes de gravar; o livro também recusaria', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body } = await openRunWorld(phase);
    const f = finalizerOver(w, e);
    const port = f.decisions.resultsLedger;
    assert.ok(port);
    const before = await everythingOf(w, e);
    const done = await makeService(e, f.preview, { ledger: forcedConcludable(port, true) }).finalize(OP_B, w.auditId, body);
    assert.equal(codeOf(done), 'RESULT_PENDING_UNCONFIRMED', `${phase}: ${show(done)}`);
    await assertUntouched(w, e, before, phase, `${phase}/porta permissiva`);
  }
});

test('defesa em profundidade: quando o livro NÃO autoriza a conclusão (porta que nega), o serviço de resultados recusa (RESULT_PENDING_UNCONFIRMED) depois das reconferências e ANTES de gravar — nem o recibo da fase B', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e, body } = await openRunWorld(phase);
    const f = finalizerOver(w, e);
    const port = f.decisions.resultsLedger;
    assert.ok(port);
    const before = await everythingOf(w, e);
    const done = await makeService(e, f.preview, { ledger: forcedConcludable(port, false) }).finalize(OP_A, w.auditId, body);
    assert.equal(codeOf(done), 'RESULT_PENDING_UNCONFIRMED', `${phase}: ${show(done)}`);
    await assertUntouched(w, e, before, phase, `${phase}/porta que nega`);
  }
});

/* ============================================================================ RL-07: R6-04 com processos reais */

/** FsOps de RESULTADOS do dono que, no passo 10 (fsync da pasta de recibos da auditoria com `a0001` presente), roda `pause` uma vez: o dono fica PARADO entre os passos 10 e 11. */
function pausedAfterReceipt(e: ResultsEnv, w: LedgerWorld, pause: () => Promise<void>): FsOps {
  let fired = false;
  return {
    ...nodeFsOps,
    async syncDirectory(dir) {
      await nodeFsOps.syncDirectory(dir);
      if (!fired && dir === path.join(e.anchors, w.auditId) && fs.existsSync(path.join(dir, 'a0001.json'))) {
        fired = true;
        await pause();
      }
    },
  };
}

test('RL-07 / R6-04 (processos reais): dono parado entre os passos 10 e 11; um filho do MESMO autor conclui (fase C); o dono relê e recebe SUCESSO; exatamente um RUN_CONFIRMED', async () => {
  const { w, e } = await protectedWorld();
  let child: Awaited<ReturnType<typeof spawnChild>> | null = null;
  const owner = finalizerOver(w, e, {
    resultsFs: pausedAfterReceipt(e, w, async () => {
      child = await spawnChild(w, e, { task: 'finalize', withPort: true, actor: 'ana@empresa.com' });
    }),
  });
  const done = await owner.results.finalize(OP_A, w.auditId, await bodyNow(owner, OP_A, w.auditId));
  const sibling = child as Awaited<ReturnType<typeof spawnChild>> | null;
  assert.deepEqual([sibling?.line?.ok, sibling?.line?.replayed], [true, true], `o filho do autor concluiu a fase C: ${show(sibling?.line)} ${sibling?.stderr.slice(0, 200)}`);
  assert.ok(done.ok && !done.value.replayed, `o dono recebe sucesso (adota o fecho do mesmo autor): ${show(done)}`);
  await assertConcludedByAuthor(w, e, (await runsOf(e, w.auditId)).runs[0] as ScoreRun, 'RL-07');
});

test('RL-07 / R6-04 (processos reais, EEXIST): o filho do MESMO autor conclui exatamente no instante do link() do RUN_CONFIRMED do dono; o dono adota (caso (ii)), sincroniza o livro e recebe sucesso', async () => {
  const { w, e } = await protectedWorld();
  let child: Awaited<ReturnType<typeof spawnChild>> | null = null;
  const closing = path.join(w.ledgerDir, w.auditId, 'l000005.json');
  const synced: string[] = [];
  const ledgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (to === closing && child === null && (JSON.parse(fs.readFileSync(from, 'utf8')) as LedgerRecord).event === 'RUN_CONFIRMED') child = await spawnChild(w, e, { task: 'finalize', withPort: true, actor: 'ana@empresa.com' });
      return nodeFsOps.link(from, to);
    },
    async syncDirectory(dir) {
      await nodeFsOps.syncDirectory(dir);
      if (fs.existsSync(closing)) synced.push(dir);
    },
  };
  const owner = finalizerOver(w, e, { ledger: { fs: ledgerFs } });
  const done = await owner.results.finalize(OP_A, w.auditId, await bodyNow(owner, OP_A, w.auditId));
  const sibling = child as Awaited<ReturnType<typeof spawnChild>> | null;
  assert.deepEqual([sibling?.line?.ok, sibling?.line?.replayed], [true, true], `${show(sibling?.line)} ${sibling?.stderr.slice(0, 200)}`);
  assert.ok(done.ok && !done.value.replayed, show(done));
  assert.ok(synced.includes(path.join(w.ledgerDir, w.auditId)), `R7-04: o fecho adotado foi sincronizado antes do sucesso: ${show(synced)}`);
  await assertConcludedByAuthor(w, e, (await runsOf(e, w.auditId)).runs[0] as ScoreRun, 'RL-07 EEXIST');
});

test('RL-07 (processos reais): no mesmo instante, um filho de OUTRO operador recebe RESULT_PENDING_UNCONFIRMED e não grava nada; o dono conclui normalmente', async () => {
  const { w, e } = await protectedWorld();
  let child: Awaited<ReturnType<typeof spawnChild>> | null = null;
  let during: Record<string, unknown> | null = null;
  let afterChild: Record<string, unknown> | null = null;
  const owner = finalizerOver(w, e, {
    resultsFs: pausedAfterReceipt(e, w, async () => {
      during = await everythingOf(w, e);
      child = await spawnChild(w, e, { task: 'finalize', withPort: true, actor: 'bia@empresa.com' });
      afterChild = await everythingOf(w, e);
    }),
  });
  const done = await owner.results.finalize(OP_A, w.auditId, await bodyNow(owner, OP_A, w.auditId));
  const other = child as Awaited<ReturnType<typeof spawnChild>> | null;
  assert.deepEqual([other?.line?.ok, other?.line?.code], [false, 'RESULT_PENDING_UNCONFIRMED'], `${show(other?.line)} ${other?.stderr.slice(0, 200)}`);
  assert.deepEqual(afterChild, during, 'o filho de outro operador não gravou nada');
  assert.ok(done.ok && !done.value.replayed, show(done));
  await assertConcludedByAuthor(w, e, (await runsOf(e, w.auditId)).runs[0] as ScoreRun, 'RL-07 outro operador');
});

test('R6-04 (porta, duas conclusões do MESMO autor): a segunda grava o RUN_CONFIRMED no instante do link() da primeira; a primeira recebe EEXIST, adota o fecho idêntico do autor (caso (ii)) e devolve sucesso; exatamente um RUN_CONFIRMED', async () => {
  const { w, e, run } = await openRunWorld('C');
  const draft = { runSeq: 1, prevRunSha256: null, runSha256: run.contentSha256, author: 'ana@empresa.com', citedLedgerHead: run.ledgerHead as { ledgerSeq: number; sha256: string }, decisionsHead: run.decisions.head };
  const second = finalizerOver(w, e).decisions.resultsLedger;
  assert.ok(second);
  const ctx2 = await second.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ctx2.kind === 'OK' && ctx2.concludable, show(ctx2));
  let inner: Awaited<ReturnType<typeof second.conclude>> | null = null;
  const ledgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (inner === null && to === path.join(w.ledgerDir, w.auditId, 'l000005.json')) inner = await second.conclude({ session: ctx2.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
      return nodeFsOps.link(from, to);
    },
  };
  const first = finalizerOver(w, e, { ledger: { fs: ledgerFs } }).decisions.resultsLedger;
  assert.ok(first);
  const ctx1 = await first.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ctx1.kind === 'OK' && ctx1.concludable, show(ctx1));
  const outer = await first.conclude({ session: ctx1.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.equal((inner as { kind: string } | null)?.kind, 'OK', show(inner));
  assert.equal(outer.kind, 'OK', show(outer));
  await assertConcludedByAuthor(w, e, run, 'R6-04 porta');
});
