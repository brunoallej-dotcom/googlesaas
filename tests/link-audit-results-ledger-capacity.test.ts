import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  CHECKPOINT_EVERY,
  deriveCapacityPolicy,
  evaluateProtection,
  LEDGER_CAPACITY_POLICY,
  ledgerCapacity,
  MAINTENANCE_RESERVE,
  MAX_LEDGER_RECORDS,
  operationCost,
  pendingClosings,
  RECORDS_PER_OPERATION,
  REISSUE_ALLOWANCE,
  replayLedger,
  REVOCATION_RESERVE_RECORDS,
  REVOCATIONS_RESERVED,
  RUN_CLOSING_ALLOWANCE,
  runIntentFits,
  runsAvailableOf,
  simulateOperations,
  verifyTags,
  type DecisionRef,
  type LedgerCapacityPolicy,
  type LedgerRecord,
} from '../src/lib/link-audit-ledger';
import { ANA, anchorPath, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, refOf, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { appendLedger, chainOf, plantWorld, runClosingMaker } from './helpers/link-audit-results-ledger-fixtures';

/*
 * R1.1 — CAPACIDADE com a classe RUN (spec §16.17.6): RUN = RECORD (D-9), `RUN_CLOSING_ALLOWANCE = 1` como termo próprio de `deriveCapacityPolicy` (D-24;
 * `REVOCATION_RESERVE_RECORDS` continua 307), `closing` dos DOIS slots na vista, na admissão de decisão e nos registros que não fecham operação
 * (`CHECKPOINT`, `RECEIPT_REISSUED`: `len + 1 + closing ≤ MAX`), `runsAvailable` anunciado = executado, e a prova por exaustão das 100 revogações com `openRun`
 * e `RUN_*` intercalados (RL-21; mutações M-R13, M-R14, M-R32).
 */
registerCleanup();
const AUD = 'auditoria-runs-0001';
const P = LEDGER_CAPACITY_POLICY;
const SMALL = deriveCapacityPolicy(60, 3, 8); // RECORD = RUN = 38, REVOKE = 52, MAX = 60
const EVERY = 8;
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const NO_RESULTS_EVIDENCE = { ok: true as const, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };
const at = (iso: string) => () => new Date(iso);
const rotatedAuth = () => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at('2026-11-03T12:00:00Z') });

/** Registros FALSOS só com o que a capacidade lê (evento, posição, chave): o modelo de capacidade não olha o resto. */
const fake = (events: readonly string[], kid = 'lk-test-a'): LedgerRecord[] => events.map((event, index) => ({ ledgerSeq: index + 1, event, origin: { kid } }) as unknown as LedgerRecord);
const genesisPlus = (fillers: number, tail: readonly string[] = []): LedgerRecord[] => fake(['GENESIS', ...Array.from({ length: fillers }, () => 'CHECKPOINT'), ...tail]);

test('RL-21 / M-R14: política real [MAX, RECORD, RUN, REVOKE, MANUTENÇÃO] = [4000, 3684, 3684, 3992, 4000]; a folga do fecho de resultado é termo PRÓPRIO (307 inalterado, D-24)', () => {
  assert.deepEqual([MAX_LEDGER_RECORDS, P.RECORD, P.RUN, P.REVOKE, P.MAINTENANCE], [4000, 3684, 3684, 3992, 4000]);
  assert.equal(REVOCATION_RESERVE_RECORDS, 307, 'a reserva de revogação continua sendo só a aritmética das 100 revogações');
  assert.equal(RUN_CLOSING_ALLOWANCE, 1);
  assert.equal(P.RECORD, MAX_LEDGER_RECORDS - MAINTENANCE_RESERVE - REVOCATION_RESERVE_RECORDS - RUN_CLOSING_ALLOWANCE);
  assert.equal(P.RUN, P.RECORD, 'D-9: resultados param no MESMO limite das decisões novas');
  assert.equal(P.REVOKE - P.RECORD, 308, 'região entre RECORD e REVOKE = 307 + RUN_CLOSING_ALLOWANCE');
  assert.deepEqual([SMALL.max, SMALL.RECORD, SMALL.RUN, SMALL.REVOKE, SMALL.MAINTENANCE], [60, 38, 38, 52, 60], 'política pequena dos testes de serviço');
});

test('RL-21: livro recém-inscrito anuncia ≥ 1209 decisões novas (eram 1210), 1311 entradas e 1841 resultados; depois de 500 resultados restam ≥ 881 decisões novas', () => {
  const fresh = ledgerCapacity(chainOf(AUD).genesis().records, LEDGER_AUTH_A.keyId);
  assert.deepEqual([fresh.decisionsAvailable, fresh.revocationsAvailable, fresh.runsAvailable, fresh.level], [1209, 1311, 1841, 'OK']);
  const after500 = ledgerCapacity(fake(['GENESIS', ...Array.from({ length: 500 }, () => ['RUN_INTENT', 'RUN_CONFIRMED']).flat()]), 'lk-test-a');
  assert.equal(after500.usedRecords, 1001);
  assert.ok(after500.decisionsAvailable >= 881, `decisões novas depois de 500 resultados: ${after500.decisionsAvailable}`);
  assert.equal(after500.decisionsAvailable, 881, 'pior caso exato (CHECKPOINT devido logo na primeira: os RUN_* contam em recordsSinceCheckpoint)');
});

test('RL-21 / M-R13: `closing` dos DOIS slots — a vista desconta o fecho da operação de decisão E o do resultado aberto; o anunciado antes do fecho é o mesmo depois dele', () => {
  const view = (records: readonly LedgerRecord[], confirmed: readonly DecisionRef[] = []) =>
    evaluateProtection({ configured: true, read: { kind: 'PRESENT', records, tagFailure: null }, auditId: AUD, decisions: { confirmed, pending: null }, entryOriginProven: () => true, results: NO_RESULTS_EVIDENCE, guard: { status: 'NOT_CONFIGURED' }, ageMsOf: () => 1_000, staleMs: 120_000, currentKeyId: LEDGER_AUTH_A.keyId }).view;
  const D1 = refOf(1, null, 'dec');
  const open = chainOf(AUD).genesis().decision(D1).runIntent();
  const openView = view(open.records, [D1]);
  assert.equal(openView.state, 'PROTECTED');
  assert.equal(openView.capacity?.runsAvailable, Math.floor((P.RUN - 4 - 1) / 2), 'resultado aberto: o fecho dele está reservado');
  assert.equal(openView.capacity?.runsAvailable, 1839);
  assert.equal(openView.capacity?.decisionsAvailable, simulateOperations(4 + 1, 4, false, CHECKPOINT_EVERY, P.RECORD), 'decisões: o fecho do resultado também é descontado');
  const closed = view(chainOf(AUD).genesis().decision(D1).run().records, [D1]);
  assert.equal(closed.capacity?.runsAvailable, openView.capacity?.runsAvailable, 'o anunciado não muda quando o fecho reservado acontece');
  const both = chainOf(AUD).genesis().runIntent().decision(D1, { open: true });
  assert.equal(pendingClosings(both.records), 2);
  const bothView = view(both.records);
  assert.deepEqual([bothView.state, bothView.openOperation?.phase], ['PROTECTED', 'A']);
  assert.equal(bothView.capacity?.runsAvailable, Math.floor((P.RUN - 3 - 2) / 2), 'as duas operações abertas reservam os dois fechos');
  assert.deepEqual([bothView.capacity?.usedRecords, bothView.capacity?.remainingRecords], [3, 3997], 'usado/restante descrevem o que EXISTE');
  assert.deepEqual([pendingClosings(chainOf(AUD).genesis().records), pendingClosings(open.records), pendingClosings(chainOf(AUD).genesis().decision(D1, { open: true }).records)], [0, 1, 1]);
});

test('RL-21 / M-R13: admissão do RUN_INTENT (`+ 2` na classe RUN, sem CHECKPOINT — D-7) e `runsAvailable` anunciado = executado', () => {
  // fronteira: RUN = 38 ⇒ cabe com 36 registros (36 + 2), não com 37
  assert.equal(runIntentFits(genesisPlus(35), SMALL), true, '36 + 2 ≤ 38');
  assert.equal(runIntentFits(genesisPlus(36), SMALL), false, '37 + 2 > 38');
  assert.equal(runIntentFits(genesisPlus(34, ['RUN_INTENT']), SMALL), false, 'com resultado aberto o fecho dele conta (e o passo 6 b já recusaria)');
  assert.equal(runIntentFits(genesisPlus(34, ['INTENT']), SMALL), false, 'com decisão aberta o fecho dela conta');
  // D-7: o resultado nunca paga CHECKPOINT — a rotação devida e os 64 registros não mudam a conta dele (mudam a das decisões)
  const records = genesisPlus(30, Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? 'RUN_INTENT' : 'RUN_CONFIRMED')));
  const asIs = ledgerCapacity(records, 'lk-test-a', CHECKPOINT_EVERY, P);
  const rotated = ledgerCapacity(records, 'lk-test-b', CHECKPOINT_EVERY, P);
  assert.equal(asIs.runsAvailable, rotated.runsAvailable);
  assert.equal(asIs.runsAvailable, Math.floor((P.RUN - records.length) / 2));
  // anunciado = executado: de cada tamanho, admitir RUN_INTENT + fecho enquanto couber executa exatamente o anunciado
  for (let size = 1; size <= 45; size += 1) {
    let current = genesisPlus(size - 1);
    const announced = ledgerCapacity(current, 'lk-test-a', EVERY, SMALL).runsAvailable;
    assert.equal(announced, runsAvailableOf(current.length, 0, SMALL));
    let executed = 0;
    while (runIntentFits(current, SMALL)) {
      current = fake([...current.map((r) => r.event), 'RUN_INTENT', 'RUN_CONFIRMED']);
      executed += 1;
      assert.ok(current.length <= SMALL.RUN, 'nenhum resultado passa do limite da classe');
    }
    assert.equal(executed, announced, `tamanho ${size}: anunciado ${announced}, executado ${executed}`);
  }
});

test('RL-21 / M-R13: a admissão de DECISÃO (operationCost) soma o fecho do resultado aberto — na classe RECORD e na REVOKE', () => {
  assert.notEqual(operationCost(genesisPlus(35), 'lk-test-a', CHECKPOINT_EVERY, 'RECORD', SMALL), null, 'controle: 36 + 2 ≤ 38');
  assert.equal(operationCost(genesisPlus(34, ['RUN_INTENT']), 'lk-test-a', CHECKPOINT_EVERY, 'RECORD', SMALL), null, '36 + 2 + 1 > 38');
  assert.notEqual(operationCost(genesisPlus(33, ['RUN_INTENT', 'RUN_CONFIRMED']), 'lk-test-a', CHECKPOINT_EVERY, 'RECORD', SMALL), null, 'controle: resultado já fechado');
  assert.notEqual(operationCost(genesisPlus(49), 'lk-test-a', CHECKPOINT_EVERY, 'REVOKE', SMALL), null, 'controle: 50 + 2 ≤ 52');
  assert.equal(operationCost(genesisPlus(48, ['RUN_INTENT']), 'lk-test-a', CHECKPOINT_EVERY, 'REVOKE', SMALL), null, '50 + 2 + 1 > 52');
});

/* ============================================================================ prova por exaustão com openRun e RUN_* intercalados */

/**
 * Pior caso de revogações COMPLETAS (cada uma seguida de 1 reemissão de recibo, D3) a partir de (usados, desde o último CHECKPOINT, rotação devida, resultado
 * aberto), com o ADVERSÁRIO escolhendo quando o fecho do resultado aberto entra (antes de qualquer revogação, ou nunca). Regras de admissão da emenda:
 * revogação ⇐ `u + CHECKPOINT devido + 2 + openRun ≤ REVOKE`; fecho do resultado ⇐ manutenção (o teste confere que SEMPRE cabe).
 */
function revocationTable(policy: LedgerCapacityPolicy, every: number): { value: (u: number, s: number, rot: boolean, open: boolean) => number; violates: (u: number, s: number, rot: boolean, open: boolean) => boolean } {
  const S = every + 1;
  const top = policy.max + 1;
  const index = (u: number, s: number, rot: boolean, open: boolean): number => ((u * S + Math.min(s, every)) * 2 + (rot ? 1 : 0)) * 2 + (open ? 1 : 0);
  const value = new Int16Array((top + 1) * S * 4);
  /** 1 = algum caminho a partir deste estado deixa um fecho sem lugar ou passa de MAX (o teste exige que nenhum estado de partida admitido chegue lá). */
  const bad = new Uint8Array((top + 1) * S * 4);
  for (let u = top; u >= 0; u -= 1) {
    for (let s = 0; s <= every; s += 1) {
      for (const rot of [false, true]) {
        for (const open of [false, true]) {
          const here = index(u, s, rot, open);
          if (u > policy.max || (open && u + 1 > policy.max)) {
            bad[here] = 1;
            continue;
          }
          const due = rot || s >= every;
          const need = (due ? 1 : 0) + RECORDS_PER_OPERATION;
          let result = 0;
          let violation = 0;
          if (u + need + (open ? 1 : 0) <= policy.REVOKE) {
            const next = index(u + need + REISSUE_ALLOWANCE, (due ? 0 : s) + RECORDS_PER_OPERATION + REISSUE_ALLOWANCE, false, open);
            result = 1 + (value[next] as number);
            violation = bad[next] as number;
          }
          if (open) {
            const closed = index(u + 1, s + 1, rot, false);
            result = Math.min(result, value[closed] as number);
            violation = violation || (bad[closed] as number);
          }
          value[here] = result;
          bad[here] = violation;
        }
      }
    }
  }
  return { value: (u, s, rot, open) => value[index(u, s, rot, open)] as number, violates: (u, s, rot, open) => bad[index(u, s, rot, open)] === 1 };
}

function exhaustive(policy: Required<LedgerCapacityPolicy>, every: number): { worst: number; states: number } {
  const after = revocationTable(policy, every);
  let worst = Number.POSITIVE_INFINITY;
  let states = 0;
  const visit = (u: number, s: number, rot: boolean, open: boolean): void => {
    if (after.violates(u, s, rot, open)) assert.fail(`estado admitido (${u}, ${s}, ${rot}, ${open}) chega a um fecho sem lugar`);
    worst = Math.min(worst, after.value(u, s, rot, open));
    states += 1;
  };
  for (let used = 1; used <= policy.max; used += 1) {
    for (let since = 0; since <= Math.min(used, 80); since += 1) {
      for (const rotation of [false, true]) {
        const due = rotation || since >= every;
        // (a) DECISÃO NOVA admitida, com ou sem resultado aberto; pior caso: seguida de 1 reemissão
        for (const open of [false, true]) {
          const cost = (due ? 1 : 0) + RECORDS_PER_OPERATION;
          if (used + cost + (open ? 1 : 0) > policy.RECORD) continue;
          visit(used + cost + REISSUE_ALLOWANCE, (due ? 0 : since) + RECORDS_PER_OPERATION + REISSUE_ALLOWANCE, false, open);
        }
        // (b) RUN_INTENT admitido (nenhuma operação aberta, passo 6 b/c): não paga CHECKPOINT nem limpa a rotação devida; o fecho fica para o adversário
        if (used + RECORDS_PER_OPERATION <= policy.RUN) visit(used + 1, since + 1, rotation, true);
      }
    }
  }
  return { worst, states };
}

test('RL-21: PROPRIEDADE POR EXAUSTÃO (~1 milhão de estados) — depois da última decisão nova OU do último resultado admitido restam ≥ 100 revogações completas, com 1 reemissão cada, com `openRun` e RUN_* intercalados em qualquer ponto; o fecho do resultado sempre cabe', () => {
  const { worst, states } = exhaustive(P, CHECKPOINT_EVERY);
  assert.ok(states > 500_000, `${states} estados`);
  assert.ok(worst >= REVOCATIONS_RESERVED, `pior caso: ${worst} revogações completas (alvo ${REVOCATIONS_RESERVED})`);
  assert.equal(worst, 101, 'o número exato da força bruta da revisão independente (§16.17.6)');
  const small = exhaustive(SMALL, EVERY);
  assert.ok(small.worst >= 3, `política pequena: ${small.worst} ≥ 3 revogações reservadas`);
});

/* ============================================================================ serviço REAL (política pequena) */

async function world(build: Parameters<typeof plantWorld>[2], n = 1): Promise<LedgerWorld> {
  const w = await ledgerWorld({ enroll: false, capacityPolicy: SMALL, checkpointEvery: EVERY });
  await plantWorld(w, n, build);
  return w;
}
const narrow = (w: LedgerWorld, over: Parameters<typeof ledgerFor>[1] = {}) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: SMALL, checkpointEvery: EVERY, ...over }), knownHeads: NO_RESULTS });
const files = (w: LedgerWorld): string[] => fs.readdirSync(`${w.ledgerDir}/${w.auditId}`).sort();

test('RL-21 / M-R13 (serviço): decisão nova com resultado aberto na fronteira RECORD é recusada ANTES de gravar; sem resultado aberto, cabe; a vista anuncia o mesmo', async () => {
  const blocked = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(35).runIntent()); // 36 registros, resultado aberto
  const view = await must(narrow(blocked).list(BIA, blocked.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.capacity?.usedRecords, view.ledger.capacity?.runsAvailable], ['PROTECTED', 36, 0]);
  assert.equal(view.ledger.capacity?.decisionsAvailable, 0, 'a vista não anuncia a decisão que o escritor recusaria');
  assert.equal(view.ledger.capacity?.level, 'REVOKE_ONLY');
  const before = files(blocked);
  const refused = await narrow(blocked).create(ANA, blocked.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(refused).slice(0, 200));
  assert.match(JSON.stringify(refused), /só cabem revogações/, 'o texto da recusa diz o mesmo nível que a vista anuncia (o fecho do resultado conta)');
  assert.deepEqual(files(blocked), before, 'nada gravado');

  const free = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(36)); // 36 registros, nada aberto
  const freeView = await must(narrow(free).list(BIA, free.auditId, clock()));
  assert.deepEqual([freeView.ledger.capacity?.decisionsAvailable, freeView.ledger.capacity?.runsAvailable], [1, 1]);
  const made = await narrow(free).create(ANA, free.auditId, { record: rec.c3(), expectedHead: freeView.head }, clock());
  assert.ok(made.ok, JSON.stringify(made).slice(0, 200));
  assert.equal((await ledgerRecords(free)).length, 38);
});

test('RL-21 / M-R13 (serviço): com CHECKPOINT devido, a recusa por resultado aberto acontece ANTES do CHECKPOINT (nada gravado); sem resultado aberto, CHECKPOINT + operação', async () => {
  const blocked = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(26).run().run().run().run().runIntent()); // 35 registros, 9 desde o CHECKPOINT
  const before = files(blocked);
  const view = await must(narrow(blocked).list(BIA, blocked.auditId, clock()));
  const refused = await narrow(blocked).create(ANA, blocked.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(files(blocked), before, 'nem o CHECKPOINT devido foi gravado');

  const free = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(25).run().run().run().run().run()); // 35 registros, 10 desde o CHECKPOINT
  const freeView = await must(narrow(free).list(BIA, free.auditId, clock()));
  const made = await narrow(free).create(ANA, free.auditId, { record: rec.c3(), expectedHead: freeView.head }, clock());
  assert.ok(made.ok, JSON.stringify(made).slice(0, 200));
  assert.deepEqual((await ledgerEvents(free)).slice(-3), ['CHECKPOINT', 'INTENT', 'CONFIRMED']);
});

test('RL-21 / M-R13 (serviço): revogação com resultado aberto na fronteira REVOKE é recusada; sem ele, cabe', async () => {
  const blocked = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(49).runIntent()); // 50 registros
  const view = await must(narrow(blocked).list(BIA, blocked.auditId, clock()));
  const before = files(blocked);
  const refused = await narrow(blocked).revoke(ANA, blocked.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(files(blocked), before);
  const free = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(50));
  const freeView = await must(narrow(free).list(BIA, free.auditId, clock()));
  const revoked = await narrow(free).revoke(ANA, free.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: freeView.head }, clock());
  assert.ok(revoked.ok, JSON.stringify(revoked).slice(0, 200));
  assert.equal((await ledgerRecords(free)).length, 52);
});

test('RL-21 / M-R13 (porta): o ponto AUTORITATIVO `intent()` também soma o fecho do resultado aberto (RECORD e REVOKE), sem depender do `prepare`', async () => {
  const cases: Array<[string, number, 'RECORD' | 'REVOKE']> = [
    ['RECORD', 35, 'RECORD'],
    ['REVOKE', 49, 'REVOKE'],
  ];
  for (const [label, fillTo, action] of cases) {
    for (const withRun of [true, false]) {
      const w = await world((c, refs) => (withRun ? c.decision(refs[0] as DecisionRef).fill(fillTo).runIntent() : c.decision(refs[0] as DecisionRef).fill(fillTo + 1)));
      const records = await ledgerRecords(w);
      const port = ledgerFor(w, { guard: null, capacityPolicy: SMALL, checkpointEvery: EVERY });
      const session = await port.begin(w.auditId);
      const prev = (records[2] as LedgerRecord).op?.newDecisionsHead.sha256 ?? null;
      const entry = action === 'RECORD' ? refOf(2, prev, 'nova') : refOf(2, prev, 'rev', { action: 'REVOKE', decisionId: null, revokes: 'op-0001', affectsPrior: true });
      const step = await port.intent({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), entry });
      if (withRun) {
        assert.ok(step.kind === 'REFUSED' && step.refusal.code === 'LEDGER_CAPACITY_EXHAUSTED', `${label} com resultado aberto: ${JSON.stringify(step).slice(0, 200)}`);
        assert.equal((await ledgerRecords(w)).length, records.length, `${label}: nada gravado`);
      } else {
        assert.equal(step.kind, 'OK', `${label} controle: ${JSON.stringify(step).slice(0, 200)}`);
        assert.equal((await ledgerEvents(w)).at(-1), 'INTENT');
      }
    }
  }
});

test('RL-21 / M-R32: com resultado aberto, o CHECKPOINT do RECOVER entra até MAX − 1 e deixa o fecho; a reemissão de recibo de DECISÃO em MAX − 1 é recusada e o RUN_CONFIRMED ainda cabe', async () => {
  const rotatedNarrow = (w: LedgerWorld) => narrow(w, { auth: rotatedAuth() });
  // 58 registros com resultado aberto: o CHECKPOINT da rotação cabe (58 + 1 + 1 ≤ 60)
  const w = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(57).runIntent());
  const recovered = await rotatedNarrow(w).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(recovered.ok, JSON.stringify(recovered).slice(0, 200));
  assert.deepEqual((await ledgerEvents(w)).slice(-2), ['RUN_INTENT', 'CHECKPOINT']);
  assert.equal((await ledgerRecords(w)).length, 59);
  // reemissão de recibo de DECISÃO em 59 com resultado aberto: 59 + 1 + 1 > 60 ⇒ recusada, nada gravado, recibo NÃO regravado
  fs.rmSync(anchorPath(w, 1));
  const removed = await must(rotatedNarrow(w).list(BIA, w.auditId, clock()));
  assert.deepEqual([removed.ledger.state, removed.ledger.reason, removed.ledger.receiptReissuable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', true]);
  const resend = await rotatedNarrow(w).create(ANA, w.auditId, { record: rec.c2(), expectedHead: removed.head }, clock);
  assert.ok(!resend.ok, `a reemissão não pode ocupar o fecho reservado: ${JSON.stringify(resend).slice(0, 200)}`);
  assert.match(JSON.stringify(resend), /LEDGER_CAPACITY_EXHAUSTED|ESGOTADA/);
  assert.equal((await ledgerRecords(w)).length, 59, 'nada gravado no livro');
  assert.ok(!fs.existsSync(anchorPath(w, 1)), 'o recibo não foi regravado sem o registro do livro');
  // o RUN_CONFIRMED (fecho reservado) ainda cabe na última posição
  const records = await appendLedger(w, rotatedAuth(), runClosingMaker('RUN_CONFIRMED'));
  assert.equal(records.length, SMALL.max);
  assert.ok(replayLedger(records, w.auditId).ok, 'cadeia válida com o fecho na posição 60');
  assert.equal(verifyTags(records, rotatedAuth()), null);

  // 59 registros com resultado aberto: o CHECKPOINT não cabe (59 + 1 + 1 > 60) ⇒ recusa sem gravar
  const full = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(58).runIntent());
  const before = files(full);
  const refused = await rotatedNarrow(full).ledgerAction(ANA, full.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(files(full), before);

  // controle: sem resultado aberto, a reemissão em 59 cabe (59 + 1 ≤ 60)
  const control = await world((c, refs) => c.decision(refs[0] as DecisionRef).fill(59));
  fs.rmSync(anchorPath(control, 1));
  const view = await must(narrow(control).list(BIA, control.auditId, clock()));
  const reissued = await narrow(control).create(ANA, control.auditId, { record: rec.c2(), expectedHead: view.head }, clock);
  assert.ok(reissued.ok, JSON.stringify(reissued).slice(0, 200));
  assert.equal((await ledgerEvents(control)).at(-1), 'RECEIPT_REISSUED');
  assert.ok(fs.existsSync(anchorPath(control, 1)));
});
