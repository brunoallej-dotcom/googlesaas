import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { KnownHeadsProvider, KnownHeadsRead, LedgerPort, LedgerStep } from '../src/lib/link-audit-decisions';
import { ledgerRefOf, ledgerSnapshotOf, readLog } from '../src/lib/link-audit-decisions/store';
import type { LedgerHead, ResultsEvidence } from '../src/lib/link-audit-ledger';
import { ANA, anchorPath, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { appendLedger, hashOf, runIntentMaker, runRefOf } from './helpers/link-audit-results-ledger-fixtures';

/*
 * Revisão independente da R1.2 (19/11/2026, `junin-02`, MAJOR) — a REEMISSÃO do recibo de uma decisão (`prepare` no ramo `HISTORY_UNRESOLVED`/`REISSUE_RECEIPT`)
 * devolvia `OK` sem a testemunha das DECISÕES (`witnessBlock`) e sem a releitura R2 dos resultados antes de gravar (`revalidate`; R7-06, §16.17.8). Os ramos
 * `COMPLETE_CONFIRMED` e `ABORT` já faziam as duas conferências. Desvio PREEXISTENTE desde a 6C; pesa mais na R1.2 porque, pela D-6 (§16.17.12), o `RECEIPT_REISSUED`
 * move a cabeça de decisões que uma finalização concorrente cita.
 *
 * Aqui: a mesma ordem do laço de gravação das decisões (`decisions/store.ts`: `begin` → `prepare` → só com `OK`/`RECEIPT_REMOVED`, `reissue`), dirigida pela porta real
 * do livro sobre pastas reais, e o cenário do revisor pelo serviço de decisões inteiro. Cada recusa prova que NADA foi gravado: registros do livro, recibos e decisões
 * inalterados. Sem processos filhos, sem relógio real (o `clock` dos fixtures), sem rede.
 */
registerCleanup();

/** Auditoria com uma decisão confirmada pelo livro cujo RECIBO foi removido (estado `RECEIPT_REMOVED`, reemitível pelo autor). */
async function receiptRemovedWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1));
  return w;
}

/** Tudo o que uma reemissão poderia gravar: o livro (arquivos e eventos), os recibos e as decisões. */
async function footprint(w: LedgerWorld): Promise<{ events: string[]; ledger: Record<string, string>; anchors: Record<string, string>; decisions: Record<string, string> }> {
  return { events: await ledgerEvents(w), ledger: hashTree(w.ledgerDir), anchors: hashTree(w.anchorDir), decisions: hashTree(w.decisionsDir) };
}
const BEFORE_REISSUE = ['GENESIS', 'INTENT', 'CONFIRMED'];

/** R1 vazia (legível, nenhum resultado): é o que a testemunha real entrega numa auditoria sem resultado selado. */
const EMPTY: ResultsEvidence = { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } };

interface Attempt {
  readonly step: LedgerStep;
  /** O passo `reissue` (só chamado, como no laço das decisões, quando o `prepare` liberou a reemissão). */
  readonly reissued: LedgerStep | null;
  /** Quantas vezes o `prepare` releu os resultados (R2). */
  readonly freshCalls: number;
}

/** UMA tentativa do laço de gravação das decisões (`decisions/store.ts`), na mesma ordem, sobre uma sessão NOVA do livro. */
async function attempt(w: LedgerWorld, port: LedgerPort, input: { r1: ResultsEvidence; fresh: () => Promise<ResultsEvidence>; decisionsWitness?: string | null; rechecks?: number; actor?: string }): Promise<Attempt> {
  const session = await port.begin(w.auditId);
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  assert.ok(log.ok && log.value.pending !== null, 'a decisão segue publicada e sem recibo (pendente)');
  const pending = log.value.pending;
  const actor = input.actor ?? ANA.email;
  let freshCalls = 0;
  const step = await port.prepare({
    session,
    auditId: w.auditId,
    snapshot: ledgerSnapshotOf(log.value.state.entries, pending),
    results: input.r1,
    freshResults: async () => {
      freshCalls += 1;
      return input.fresh();
    },
    decisionsWitness: input.decisionsWitness ?? null,
    entryOriginProven: () => true,
    nowIso: clock(),
    actor,
    rechecks: input.rechecks ?? 0,
    intended: 'RECORD',
  });
  const reissued = step.kind === 'OK' && step.pendingKind === 'RECEIPT_REMOVED' ? await port.reissue({ session, auditId: w.auditId, actor, nowIso: clock(), entry: ledgerRefOf(pending) }) : null;
  return { step, reissued, freshCalls };
}

const refusedWith = (step: LedgerStep, code: string): boolean => step.kind === 'REFUSED' && step.refusal.code === code;
const show = (value: unknown): string => JSON.stringify(value).slice(0, 260);

/** Citação válida do livro (o `CONFIRMED` da decisão) e uma que o CONTRADIZ (mesma posição, outro hash: livro truncado ou refeito). */
async function citations(w: LedgerWorld): Promise<{ cite: LedgerHead; contradicting: LedgerHead }> {
  const confirmed = (await ledgerRecords(w))[2];
  assert.ok(confirmed !== undefined && confirmed.event === 'CONFIRMED', 'o 3º registro é o CONFIRMED da decisão');
  return { cite: { ledgerSeq: 3, sha256: confirmed.contentSha256 }, contradicting: { ledgerSeq: 3, sha256: hashOf('livro-refeito') } };
}

test('REISSUE-W: testemunha das DECISÕES não resolvida ⇒ a reemissão é recusada (DECISIONS_HISTORY_UNRESOLVED) ANTES de reler os resultados, e nada é gravado (nenhum RECEIPT_REISSUED)', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const { cite } = await citations(w);
  const before = await footprint(w);
  assert.deepEqual(before.events, BEFORE_REISSUE);
  // a releitura, se fosse feita primeiro, mostraria um resultado novo (⇒ RETRY): a testemunha das decisões tem de decidir antes dela (mesma ordem de COMPLETE_CONFIRMED e ABORT)
  const grown: ResultsEvidence = { ...EMPTY, hasResults: true, ledgerHeads: [cite] };
  for (const status of ['HISTORY_DIVERGES', 'HISTORY_REGRESSED', 'UNTRUSTED', 'UNAVAILABLE', 'NOT_CONFIGURED']) {
    const run = await attempt(w, port, { r1: EMPTY, fresh: async () => grown, decisionsWitness: status });
    assert.ok(refusedWith(run.step, 'DECISIONS_HISTORY_UNRESOLVED'), `${status}: ${show(run.step)}`);
    assert.ok(run.step.kind === 'REFUSED' && run.step.refusal.issues.includes(`testemunha: ${status}`), `${status}: a recusa diz qual testemunha (${show(run.step)})`);
    assert.equal(run.freshCalls, 0, `${status}: a testemunha das decisões é conferida ANTES da releitura dos resultados`);
    assert.equal(run.reissued, null, `${status}: o reissue nem é chamado`);
  }
  assert.deepEqual(await footprint(w), before, 'nenhum registro no livro, nenhum recibo, nenhuma decisão');
});

test('REISSUE-R2: resultado, recibo, citação ou indício que a releitura R2 mostra e R1 não mostrava ⇒ RETRY transitório; esgotado ⇒ LEDGER_OPERATION_IN_PROGRESS; nada é gravado', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const { cite, contradicting } = await citations(w);
  const sha = hashOf('resultado-concorrente');
  // R1.5: a finalização concorrente gravou o RUN_INTENT dela ANTES de publicar (passo 6); sem ele, o resultado visto em R1 seria UNLEDGERED_RESULT
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker({ runSha256: sha }));
  const pendingRun: ResultsEvidence = { ...EMPTY, hasResults: true, ledgerHeads: [cite], runs: { anchored: [], pending: runRefOf(1, sha, { ledgerHead: cite }) } };
  const anchoredRun: ResultsEvidence = { ...EMPTY, hasResults: true, ledgerHeads: [cite], runs: { anchored: [runRefOf(1, sha, { ledgerHead: cite })], pending: null } };
  const legacy: ResultsEvidence = { ...EMPTY, hasResults: true };
  const grown: Array<[string, ResultsEvidence, ResultsEvidence]> = [
    ['resultado novo (finalização concorrente: RUN_INTENT + s0001)', EMPTY, pendingRun],
    ['só a primeira evidência de resultado (v1, sem citação)', EMPTY, legacy],
    ['só uma citação nova de testemunha', legacy, { ...legacy, ledgerHeads: [cite] }],
    // o cenário do revisor: um indício (pendente sem origem) que CONTRADIZ o livro aparece entre R1 e a gravação; a nova tentativa (R1 nova) é quem o julga
    ['indício novo que contradiz o livro (pendente sem origem)', legacy, { ...legacy, unverifiedLedgerHeads: [contradicting] }],
    ['recibo novo (pendente → ancorado)', pendingRun, anchoredRun],
  ];
  const before = await footprint(w);
  for (const [label, r1, r2] of grown) {
    const retry = await attempt(w, port, { r1, fresh: async () => r2 });
    assert.deepEqual(retry.step, { kind: 'RETRY', ms: 25, transient: true }, `${label}: relê tudo antes de gravar (${show(retry.step)})`);
    assert.equal(retry.freshCalls, 1, `${label}: a releitura R2 aconteceu`);
    assert.equal(retry.reissued, null, `${label}: o reissue nem é chamado`);
    const exhausted = await attempt(w, port, { r1, fresh: async () => r2, rechecks: 3 });
    assert.ok(refusedWith(exhausted.step, 'LEDGER_OPERATION_IN_PROGRESS'), `${label}: esgotado ⇒ recusa transitória, sem acusação (${show(exhausted.step)})`);
    assert.ok(exhausted.step.kind === 'REFUSED' && exhausted.step.refusal.issues.some((issue) => /resultados desta auditoria mudaram/.test(issue)), `${label}: texto da releitura esgotada`);
    assert.equal(exhausted.reissued, null, `${label}: esgotado, o reissue nem é chamado`);
  }
  assert.deepEqual(await footprint(w), before, 'nenhuma dessas tentativas gravou no livro, nos recibos ou nas decisões');
});

test('REISSUE-R2 (cenário do revisor, serviço inteiro): R1 não vê o resultado; antes da reemissão aparece um indício que contradiz o livro ⇒ nova tentativa, a R1 nova recusa (UNTRUSTED) e nada é gravado', async () => {
  const w = await receiptRemovedWorld();
  const { contradicting } = await citations(w);
  // pendente de resultado SEM origem comprovada citando a posição 3 com outro hash (indício de livro refeito): só aparece depois da R1 da 1ª tentativa
  const appeared: KnownHeadsRead = {
    ok: true,
    heads: [],
    unverifiedHeads: [],
    hasResults: true,
    ledgerHeads: [],
    unverifiedLedgerHeads: [contradicting],
    runs: { anchored: [], pending: runRefOf(1, hashOf('resultado-sem-origem'), { ledgerHead: contradicting, originProven: false }) },
  };
  let calls = 0;
  // leituras da gravação: 1 = inicial do serviço; 2 = R1 da 1ª tentativa; 3 = releitura do revalidate (R2) — é aí que o resultado aparece
  const witness: KnownHeadsProvider = async (auditId) => {
    calls += 1;
    return calls <= 2 ? NO_RESULTS(auditId) : appeared;
  };
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witness });
  const before = await footprint(w);
  const result = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!result.ok && result.code === 'DECISIONS_HISTORY_UNRESOLVED', `recusa (${show(result)})`);
  assert.ok(!result.ok && result.issues.includes('livro: UNTRUSTED'), `a recusa vem da R1 nova julgando o indício contra o livro (${show(result)})`);
  assert.ok(calls >= 4, `a releitura R2 fez reler tudo (leituras: ${calls})`);
  assert.ok(!fs.existsSync(anchorPath(w, 1)), 'o recibo NÃO foi reemitido');
  assert.deepEqual(await footprint(w), before, 'nenhum RECEIPT_REISSUED, nenhum recibo, nenhuma decisão');
});

test('REISSUE-R2: releitura dos resultados que FALHA (exceção ou { ok: false }) ⇒ a reemissão é recusada (RESULTS_EVIDENCE_UNAVAILABLE) e nada é gravado', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const failures: Array<[string, () => Promise<ResultsEvidence>]> = [
    ['a releitura lança', async () => Promise.reject(new Error('EIO simulado na releitura'))],
    ['a releitura devolve { ok: false }', async () => ({ ok: false })],
  ];
  const before = await footprint(w);
  for (const [label, fresh] of failures) {
    const run = await attempt(w, port, { r1: EMPTY, fresh });
    assert.ok(refusedWith(run.step, 'DECISIONS_HISTORY_UNRESOLVED'), `${label}: ${show(run.step)}`);
    assert.ok(run.step.kind === 'REFUSED' && run.step.refusal.reason === 'RESULTS_EVIDENCE_UNAVAILABLE', `${label}: testemunha dos resultados indisponível (${show(run.step)})`);
    assert.equal(run.freshCalls, 1, `${label}: a releitura foi tentada`);
    assert.equal(run.reissued, null, `${label}: o reissue nem é chamado`);
  }
  assert.deepEqual(await footprint(w), before, 'nenhum registro no livro, nenhum recibo, nenhuma decisão');
});

test('REISSUE [regressão]: nada mudou entre R1 e a gravação ⇒ a porta libera a reemissão e grava EXATAMENTE um RECEIPT_REISSUED, do autor', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const run = await attempt(w, port, { r1: EMPTY, fresh: async () => EMPTY });
  assert.deepEqual(run.step, { kind: 'OK', pendingKind: 'RECEIPT_REMOVED' }, show(run.step));
  assert.deepEqual(run.reissued, { kind: 'OK', pendingKind: null }, show(run.reissued));
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((record) => record.event), [...BEFORE_REISSUE, 'RECEIPT_REISSUED']);
  const reissued = records[3];
  assert.equal(reissued?.actor, ANA.email);
  assert.equal(reissued?.op?.opId, records[2]?.op?.opId, 'a reemissão cita a operação confirmada');
});

test('REISSUE [regressão, serviço inteiro]: quem não é o autor não reemite; o reenvio do autor recria o recibo com UM RECEIPT_REISSUED; reenviar de novo não grava outro', async () => {
  const w = await receiptRemovedWorld();
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });
  const before = await footprint(w);
  const other = await service.create(BIA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED', `só o autor conclui (${show(other)})`);
  assert.deepEqual(await footprint(w), before, 'quem não é o autor não grava nada');
  const done = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(done.ok, show(done));
  assert.ok(fs.existsSync(anchorPath(w, 1)), 'o recibo foi recriado');
  assert.deepEqual(await ledgerEvents(w), [...BEFORE_REISSUE, 'RECEIPT_REISSUED']);
  const again = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(again.ok, show(again));
  assert.deepEqual(await ledgerEvents(w), [...BEFORE_REISSUE, 'RECEIPT_REISSUED'], 'nenhum registro novo');
  const view = await must(service.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['PROTECTED', null]);
});
