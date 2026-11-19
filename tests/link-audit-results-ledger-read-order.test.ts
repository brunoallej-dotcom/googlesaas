import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { ledgerSnapshotOf, readLog } from '../src/lib/link-audit-decisions/store';
import type { ResultsEvidence } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { sealResult, servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { appendLedger, hashOf, hideFile, runMakersFor, runRefOf } from './helpers/link-audit-results-ledger-fixtures';
import { receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.2 — ORDEM DE LEITURA "SANDUÍCHE" (spec §16.17.8, D-13): R1 (resultados + recibos) → guarda → livro (L) → decisões → R2 (resultados de novo, SÓ quando o modelo pede).
 * O resultado cita o livro (julgado só sobre R1); o livro cita o resultado (`RUN_CONFIRMED` ⇒ julgado só sobre R2). Toda releitura feita DEPOIS de L é R2: o que só ela mostra
 * nunca é acusado — serve para a fase da operação aberta e, na gravação (`revalidate`), faz reler TUDO (limitado), nunca vira contradição (MINOR-1).
 * As intercalações são DETERMINÍSTICAS: a testemunha dos resultados é envolvida e publica no disco exatamente entre as leituras (RL-17, RL-34; mutações M-R15 e M-R33).
 */
registerCleanup();

/** Testemunha real envolvida: conta as leituras e roda `before[i]` antes e `after[i]` depois da i-ésima (1-based). */
function hooked(real: KnownHeadsProvider, hooks: { before?: Record<number, () => Promise<void> | void>; after?: Record<number, () => Promise<void> | void> }) {
  let calls = 0;
  const provider: KnownHeadsProvider = async (auditId) => {
    calls += 1;
    const n = calls;
    await hooks.before?.[n]?.();
    try {
      return await real(auditId);
    } finally {
      await hooks.after?.[n]?.();
    }
  };
  return { provider, calls: () => calls };
}

/** Auditoria protegida: uma decisão e o resultado s0001 selado sobre ela, ainda SEM nada de resultado no livro. */
async function withSealedRun(): Promise<{ w: LedgerWorld; e: ResultsEnv; run: ScoreRun; aside: string }> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  return { w, e, run: await sealResult(w, e), aside: tmpDir('lad-aside-') };
}

test('RL-17 (a): s0001 + a0001 + RUN_CONFIRMED publicados ENTRE R1 e L ⇒ R1 não basta, o R2 resolve — nada de RESULT_REGRESSED (M-R15: sem R2 seria acusado)', async () => {
  const { w, e, run, aside } = await withSealedRun();
  const [intent, confirm] = runMakersFor(run);
  await appendLedger(w, LEDGER_AUTH_A, intent); // RUN_INTENT antes de tudo (o passo 6 da finalização)
  const restoreRun = hideFile(runPath(e, 1, w.auditId), aside);
  const restoreReceipt = hideFile(receiptPath(e, 1, w.auditId), aside);
  const witness = hooked(witnessOver(w, e), {
    after: {
      1: async () => {
        // entre R1 e L: o resultado, o recibo e o RUN_CONFIRMED (passos 7–11)
        restoreRun();
        restoreReceipt();
        await appendLedger(w, LEDGER_AUTH_A, confirm);
      },
    },
  });
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witness.provider }).list(BIA, w.auditId, clock()));
  assert.equal(witness.calls(), 2, 'R1 e R2 (o modelo pediu a releitura)');
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['PROTECTED', null]);
  assert.deepEqual(view.ledger.runs, { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: run.contentSha256 }], open: null, receiptReissuable: false });
});

test('RL-17 (b): RUN_INTENT + s000k publicados ENTRE L e R2 ⇒ o que só R2 mostra nunca é acusado nem vira a operação aberta; na leitura seguinte ele é a fase B', async () => {
  const { w, e, run, aside } = await withSealedRun();
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  const second = await sealResult(w, e);
  assert.equal(second.seq, 2);
  fs.rmSync(receiptPath(e, 2, w.auditId)); // s0002 sem recibo: "RUN_INTENT + sk" (passos 6 e 7)
  const [secondIntent] = runMakersFor(second);
  const restoreSecond = hideFile(runPath(e, 2, w.auditId), aside);
  const restoreFirstReceipt = hideFile(receiptPath(e, 1, w.auditId), aside); // R1 vê s0001 sem recibo ⇒ o modelo pede R2
  const witness = hooked(witnessOver(w, e), {
    after: { 1: () => restoreFirstReceipt() },
    before: {
      2: async () => {
        // entre L (e as decisões) e R2: a finalização concorrente grava o RUN_INTENT de s0002 e publica s0002
        await appendLedger(w, LEDGER_AUTH_A, secondIntent);
        restoreSecond();
      },
    },
  });
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witness.provider }).list(BIA, w.auditId, clock()));
  assert.equal(witness.calls(), 2);
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['PROTECTED', null], 'nenhuma acusação');
  assert.deepEqual(view.ledger.runs, { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: run.contentSha256 }], open: null, receiptReissuable: false }, 'o RUN_INTENT posterior a L não é a operação aberta desta leitura');
  const next = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([next.ledger.state, next.ledger.runs?.open?.runSeq, next.ledger.runs?.open?.phase, next.ledger.runs?.open?.runSha256], ['PROTECTED', 2, 'B', second.contentSha256]);
});

test('RL-17 (b\'): um resultado selado ENTRE L e R2 citando uma posição POSTERIOR a L nunca é julgado contra L (R2 não é R1): nada de RESULT_LEDGER_MISMATCH espúrio', async () => {
  const { w, e, run, aside } = await withSealedRun();
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
  const restoreReceipt = hideFile(receiptPath(e, 1, w.auditId), aside);
  const witness = hooked(witnessOver(w, e), {
    after: { 1: () => restoreReceipt() },
    before: {
      2: async () => {
        // entre L e R2: outra decisão completa e um resultado novo sobre ela (cita a cabeça de decisões NOVA, além do que L leu)
        await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
        const sealed = await sealResult(w, e);
        assert.ok((sealed.ledgerHead?.ledgerSeq ?? 0) > 5, 'cita além das 5 posições que L leu');
      },
    },
  });
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witness.provider }).list(BIA, w.auditId, clock()));
  assert.equal(witness.calls(), 2);
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs?.state], ['PROTECTED', null, 'OK']);
});

test('RL-17: o R2 só é lido quando o modelo pede (nenhum RUN_CONFIRMED sem recibo em R1 ⇒ uma leitura); R2 pedido e ilegível ⇒ RESULTS_EVIDENCE_UNAVAILABLE (falha fechada, nunca "sem resultados")', async () => {
  const { w, e, run, aside } = await withSealedRun();
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
  const once = hooked(witnessOver(w, e), {});
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: once.provider }).list(BIA, w.auditId, clock()));
  assert.deepEqual([once.calls(), view.ledger.state, view.ledger.runs?.state], [1, 'PROTECTED', 'OK']);

  hideFile(receiptPath(e, 1, w.auditId), aside);
  let calls = 0;
  const real = witnessOver(w, e);
  const failingR2: KnownHeadsProvider = async (auditId) => {
    calls += 1;
    if (calls === 2) throw new Error('falha simulada da releitura');
    return real(auditId);
  };
  const failed = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: failingR2 }).list(BIA, w.auditId, clock()));
  assert.equal(calls, 2);
  assert.deepEqual([failed.ledger.state, failed.ledger.reason, failed.ledger.runs, failed.decisions], ['HISTORY_UNRESOLVED', 'RESULTS_EVIDENCE_UNAVAILABLE', undefined, []]);
});

/* ------------------------------------------------------------------ RL-34: a releitura do `revalidate` é R2 */

const R1_ONLY: ResultsEvidence = { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } };

test('RL-34 / M-R33: na gravação, resultado (ou citação, ou recibo) que a releitura do revalidate mostra e R1 não mostrava ⇒ RETRY limitado, nunca acusação; esgotado ⇒ recusa sem gravar; igual a R1 ⇒ segue', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  assert.ok(log.ok);
  const snapshot = ledgerSnapshotOf(log.value.state.entries, log.value.pending);
  const records = await ledgerRecords(w);
  const cite = { ledgerSeq: 3, sha256: (records[2] as { contentSha256: string }).contentSha256 };
  const sha = hashOf('resultado-concorrente');
  const grown: Array<[string, ResultsEvidence]> = [
    ['resultado novo (RUN_INTENT + sk concorrentes)', { ok: true, hasResults: true, ledgerHeads: [cite], unverifiedLedgerHeads: [], runs: { anchored: [], pending: runRefOf(1, sha, { ledgerHead: cite }) } }],
    ['só uma citação nova', { ...R1_ONLY, hasResults: true, ledgerHeads: [cite] }],
    ['só a primeira evidência de resultado (v1, sem citação)', { ...R1_ONLY, hasResults: true }],
  ];
  const port = ledgerFor(w, { guard: null });
  const prepare = async (r1: ResultsEvidence, r2: ResultsEvidence, rechecks: number) =>
    port.prepare({ session: await port.begin(w.auditId), auditId: w.auditId, snapshot, results: r1, freshResults: async () => r2, entryOriginProven: () => true, nowIso: clock(), actor: 'ana@empresa.com', rechecks, intended: 'REVOKE', decisionsWitness: null });
  const before = hashTree(w.ledgerDir);
  for (const [label, r2] of grown) {
    assert.deepEqual(await prepare(R1_ONLY, r2, 0), { kind: 'RETRY', ms: 25, transient: true }, `${label}: relê tudo (R2 nunca é julgado como R1)`);
    const exhausted = await prepare(R1_ONLY, r2, 3);
    assert.ok(exhausted.kind === 'REFUSED' && exhausted.refusal.code === 'LEDGER_OPERATION_IN_PROGRESS', `${label}: esgotado ⇒ recusa transitória, não acusação (${JSON.stringify(exhausted).slice(0, 160)})`);
  }
  // o recibo que aparece (pendente → ancorado) também é novidade da releitura
  const pending = { ...R1_ONLY, hasResults: true, ledgerHeads: [cite], runs: { anchored: [], pending: runRefOf(1, sha, { ledgerHead: cite }) } };
  const anchored = { ...pending, runs: { anchored: [runRefOf(1, sha, { ledgerHead: cite })], pending: null } };
  assert.deepEqual(await prepare(pending, anchored, 0), { kind: 'RETRY', ms: 25, transient: true });
  // nada novo ⇒ segue (a mesma leitura do livro, com R1 + R2)
  assert.deepEqual(await prepare(pending, pending, 0), { kind: 'OK', pendingKind: null });
  assert.deepEqual(await prepare(anchored, pending, 0), { kind: 'OK', pendingKind: null }, 'R2 menor que R1 não é novidade (o que R1 mostrou já foi julgado)');
  assert.deepEqual(hashTree(w.ledgerDir), before, 'nenhuma dessas preparações gravou no livro');
});

test('RL-34: revogação cujo revalidate relê os resultados DEPOIS de uma finalização concorrente ter gravado RUN_INTENT + s0001 ⇒ relê tudo (sem tentar gravar sobre a posição alheia) e conclui; o resultado vira a fase B', async () => {
  const { w, e, run, aside } = await withSealedRun();
  const [intent] = runMakersFor(run);
  const restoreRun = hideFile(runPath(e, 1, w.auditId), aside);
  hideFile(receiptPath(e, 1, w.auditId), aside); // o recibo não chega a existir: fase B
  // leituras da revogação: 1 = inicial do serviço; 2 = R1 da 1ª tentativa; 3 = releitura do revalidate (R2)
  const witness = hooked(witnessOver(w, e), {
    before: {
      3: async () => {
        await appendLedger(w, LEDGER_AUTH_A, intent);
        restoreRun();
      },
    },
  });
  const collisions: string[] = [];
  const ledgerFs = faulty({
    async link(from, to) {
      try {
        return await nodeFsOps.link(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') collisions.push(path.basename(to));
        throw error;
      }
    },
  });
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: ledgerFs }), knownHeads: witness.provider });
  const head = (await must(servicesOver(w, e).list(BIA, w.auditId, clock()))).head;
  const revoked = await service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: head }, clock);
  assert.ok(revoked.ok, JSON.stringify(revoked).slice(0, 240));
  assert.ok(witness.calls() >= 5, `a releitura do revalidate fez reler tudo (leituras: ${witness.calls()})`);
  assert.deepEqual(collisions, [], 'a revogação NÃO tentou gravar a INTENT na posição já ocupada pelo RUN_INTENT (R2 ⇒ releitura antes de gravar)');
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'INTENT', 'CONFIRMED']);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs?.open?.phase, view.decisions.length], ['PROTECTED', null, 'B', 0]);
});

test('RL-17 (c) [regressão]: carga — decisões, finalizações e leituras concorrentes sobre um livro com RUN_* ⇒ zero razões de resultado espúrias e nenhuma acusação nas leituras', async () => {
  const { w, e, run } = await withSealedRun();
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
  const reads: Array<{ state: string; reason: string | null; runs: string | undefined; runsReason: string | null | undefined }> = [];
  const writer = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
      await must(w.protectedService.revoke(ANA, w.auditId, { revokes: `op-${String(2 + round * 2).padStart(4, '0')}`, reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.' }, clock()));
    }
  };
  const finalizer = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await sealResult(w, e).catch(() => undefined); // corrida com as decisões: INPUT_CHANGED/HEAD_MISMATCH são desfechos legítimos
  };
  const reader = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) {
      const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
      reads.push({ state: view.ledger.state, reason: view.ledger.reason, runs: view.ledger.runs?.state, runsReason: view.ledger.runs?.reason });
    }
  };
  await Promise.all([writer(), finalizer(), reader(), reader()]);
  const spurious = reads.filter((read) => read.runs !== 'OK' || read.runsReason !== null || /RESULT|RESULTS_EVIDENCE|UNTRUSTED|GUARD/.test(read.reason ?? ''));
  assert.deepEqual(spurious, [], `leituras com razão de resultado ou acusação de testemunha: ${JSON.stringify(spurious.slice(0, 3))}`);
  assert.equal(reads.length, 24);
  const final = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([final.ledger.state, final.ledger.runs?.state], ['PROTECTED', 'OK']);
});
