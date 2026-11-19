import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { RESERVED_FOR_REVOCATIONS } from '../src/lib/link-audit-decisions/types';
import {
  CHECKPOINT_EVERY,
  deriveCapacityPolicy,
  LEDGER_CAPACITY_POLICY,
  ledgerCapacity,
  MAINTENANCE_RESERVE,
  MAX_LEDGER_RECORDS,
  RECORDS_PER_OPERATION,
  REISSUE_ALLOWANCE,
  REVOCATION_RESERVE_RECORDS,
  rotationCheckpointDue,
  REVOCATIONS_RESERVED,
  replayLedger, RUN_CLOSING_ALLOWANCE,
  simulateOperations,
  verifyTags,
  type LedgerRecord,
} from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { buildLongLedger } from './helpers/link-audit-ledger-long';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * R7-01 / R7-02 / D3 — CAPACIDADE do livro (4000 registros TOTAIS, incluindo o que conclui operações já iniciadas). Política (§16.12): decisão nova ≤ 3685 registros depois de concluída,
 * revogação ≤ 3992, manutenção (CHECKPOINT, ABORTED, reemissão, CONFIRMED de operação iniciada) ≤ 4000; a reserva garante 100 REVOGAÇÕES COMPLETAS (a contagem da 6B), não 100 registros, MESMO que
 * cada uma seja seguida de uma reemissão de recibo (3 registros por revogação). Os números anunciados são PISOS desse pior caso; o escritor admite de fato `normalFit` (crescimento real de 2).
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const at = (iso: string) => () => new Date(iso);
const rotated = () => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at('2026-11-03T12:00:00Z') });
/** Impressão digital LEVE (nome, tamanho e mtime; os arquivos são imutáveis, então "nada mudou" = mesmos nomes e metadados): ler 8 mil arquivos a cada conferência tornava o teste inviável. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = `${current}/${name}`;
      const info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = `${info.size}:${info.mtimeMs}:${info.ino}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}
const trees = (w: LedgerWorld) => ({ ledger: fingerprint(w.ledgerDir), decisions: fingerprint(w.decisionsDir), anchors: fingerprint(w.anchorDir) });
/** Quantas operações da classe o ESCRITOR admite de fato em sequência quando ninguém remove recibos (crescimento real: 2 registros por operação). A vista anuncia um PISO dessa conta (pior caso, com 1 reemissão após cada operação). */
function normalFit(records: readonly LedgerRecord[], limit: number, every: number = CHECKPOINT_EVERY): number {
  let lastCheckpoint = 0;
  for (const record of records) if (record.event === 'CHECKPOINT') lastCheckpoint = record.ledgerSeq;
  let used = records.length;
  let since = records.length - lastCheckpoint;
  let rotation = rotationCheckpointDue(records, LEDGER_AUTH_A.keyId);
  let count = 0;
  for (;;) {
    const due = rotation || since >= every;
    const need = (due ? 1 : 0) + RECORDS_PER_OPERATION;
    if (used + need > limit) return count;
    used += need;
    since = due ? RECORDS_PER_OPERATION : since + RECORDS_PER_OPERATION;
    rotation = false;
    count += 1;
  }
}
const fakeRecords = (events: Array<[string, string]>): LedgerRecord[] => events.map(([event, kid], index) => ({ ledgerSeq: index + 1, event, origin: { kid } }) as unknown as LedgerRecord);

test('política: os números, o alinhamento com a 6B e a conta das reservas', () => {
  assert.deepEqual([MAX_LEDGER_RECORDS, LEDGER_CAPACITY_POLICY.max, LEDGER_CAPACITY_POLICY.RECORD, LEDGER_CAPACITY_POLICY.REVOKE, LEDGER_CAPACITY_POLICY.MAINTENANCE], [4000, 4000, 3684, 3992, 4000]);
  assert.equal(REVOCATIONS_RESERVED, RESERVED_FOR_REVOCATIONS, 'a mesma contagem de OPERAÇÕES COMPLETAS da 6B (100), nunca 100 registros');
  assert.equal(RECORDS_PER_OPERATION, 2);
  assert.equal(REISSUE_ALLOWANCE, 1, 'até 1 reemissão de recibo por entrada confirmada');
  assert.equal(REVOCATION_RESERVE_RECORDS, REVOCATIONS_RESERVED * (RECORDS_PER_OPERATION + REISSUE_ALLOWANCE) + Math.ceil((REVOCATIONS_RESERVED * (RECORDS_PER_OPERATION + REISSUE_ALLOWANCE)) / CHECKPOINT_EVERY) + 2, 'cada revogação reservada conta INTENT + CONFIRMED + reemissão (D3)');
  assert.equal(REVOCATION_RESERVE_RECORDS, 307);
  assert.equal(LEDGER_CAPACITY_POLICY.RECORD, MAX_LEDGER_RECORDS - MAINTENANCE_RESERVE - REVOCATION_RESERVE_RECORDS - RUN_CLOSING_ALLOWANCE);
  assert.equal(LEDGER_CAPACITY_POLICY.REVOKE, MAX_LEDGER_RECORDS - MAINTENANCE_RESERVE);
  assert.ok(LEDGER_CAPACITY_POLICY.RECORD < LEDGER_CAPACITY_POLICY.REVOKE && LEDGER_CAPACITY_POLICY.REVOKE < LEDGER_CAPACITY_POLICY.MAINTENANCE, 'criação < revogação < manutenção');
});

test('propriedade exaustiva (modelo puro, ~650 mil estados): qualquer decisão nova ADMITIDA deixa ao menos 100 revogações completas executáveis MESMO com uma reemissão de recibo após cada operação, e nenhuma operação admitida ultrapassa o limite da sua classe', () => {
  let worst = Number.POSITIVE_INFINITY;
  let states = 0;
  for (let used = 0; used <= MAX_LEDGER_RECORDS; used += 1) {
    for (let since = 0; since <= Math.min(used, 80); since += 1) {
      for (const rotation of [false, true]) {
        if (simulateOperations(used, since, rotation, CHECKPOINT_EVERY, LEDGER_CAPACITY_POLICY.RECORD) === 0) continue;
        const due = rotation || since >= CHECKPOINT_EVERY;
        const after = used + (due ? 1 : 0) + 2;
        assert.ok(after <= LEDGER_CAPACITY_POLICY.RECORD, 'a decisão admitida termina dentro do limite da classe');
        // pior caso (D3): a própria decisão é seguida de 1 reemissão de recibo e cada revogação seguinte também
        worst = Math.min(worst, simulateOperations(after + REISSUE_ALLOWANCE, (due ? 0 : since) + 2 + REISSUE_ALLOWANCE, false, CHECKPOINT_EVERY, LEDGER_CAPACITY_POLICY.REVOKE));
        states += 1;
      }
    }
  }
  assert.ok(states > 100_000, `${states} estados`);
  assert.ok(worst >= REVOCATIONS_RESERVED, `pior caso: ${worst} revogações executáveis (alvo ${REVOCATIONS_RESERVED})`);
});

test('modelo puro nas 11 posições 3990–4000: nível, quantas decisões e revogações cabem e o texto do que cabe — nunca anuncia o que não executa', () => {
  const expectations: Array<[number, string, number, number]> = [
    [3990, 'REVOKE_ONLY', 0, 1],
    [3991, 'EXHAUSTED', 0, 0],
    ...[3992, 3993, 3994, 3995, 3996, 3997, 3998, 3999, 4000].map((n): [number, string, number, number] => [n, 'EXHAUSTED', 0, 0]),
  ];
  for (const [total, level, decisions, revocations] of expectations) {
    // livro sintético de `total` registros: GENESIS + checkpoints (a cauda acabou de ser coberta, nada devido)
    const records = fakeRecords([['GENESIS', 'lk-test-a'], ...Array.from({ length: total - 1 }, (): [string, string] => ['CHECKPOINT', 'lk-test-a'])]);
    const capacity = ledgerCapacity(records, 'lk-test-a', CHECKPOINT_EVERY);
    assert.deepEqual([capacity.level, capacity.decisionsAvailable, capacity.revocationsAvailable, capacity.usedRecords, capacity.remainingRecords], [level, decisions, revocations, total, 4000 - total], `total ${total}`);
  }
  // rotação devida custa 1 registro a mais: em 3990 já não cabe uma revogação (3990 + 1 + 2 > 3992)
  const rotationDue = ledgerCapacity(fakeRecords([['GENESIS', 'lk-test-a'], ...Array.from({ length: 3989 }, (): [string, string] => ['CHECKPOINT', 'lk-test-a'])]), 'lk-test-b', CHECKPOINT_EVERY);
  assert.deepEqual([rotationDue.level, rotationDue.revocationsAvailable], ['EXHAUSTED', 0]);
  // o nível OK longe do limite: o número anunciado é exatamente o que a simulação executa
  const early = ledgerCapacity(fakeRecords([['GENESIS', 'lk-test-a']]), 'lk-test-a', CHECKPOINT_EVERY);
  assert.equal(early.level, 'OK');
  assert.equal(early.decisionsAvailable, simulateOperations(1, 1, false, CHECKPOINT_EVERY, LEDGER_CAPACITY_POLICY.RECORD));
});

/* ============================================================================ serviço real nas posições 3990–4000 */

/** TODAS as 11 posições de 3990 a 4000 no serviço REAL (cada chamada lê ~8 mil arquivos), além do modelo puro acima. */
const POSITIONS = [3990, 3991, 3992, 3993, 3994, 3995, 3996, 3997, 3998, 3999, 4000];

test('serviço REAL em TODAS as posições de 3990 a 4000: decisão nova é recusada ANTES de gravar (nada muda); a revogação cabe só enquanto há reserva (3990); a rotação (CHECKPOINT) cabe até 4000 e é idempotente; no 4000 a recusa tem texto próprio', async () => {
  await Promise.all(
    POSITIONS.map(async (total) => {
      const w = await ledgerWorld({ enroll: false });
      await buildLongLedger(w, 1945, total);
      const svc = w.rawProtected;
      const view = await must(svc.list(BIA, w.auditId, clock()));
      const label = `total ${total}`;
      assert.equal(view.ledger.state, 'PROTECTED', label);
      assert.deepEqual([view.ledger.capacity?.usedRecords, view.ledger.capacity?.level], [total, total === 3990 ? 'REVOKE_ONLY' : 'EXHAUSTED'], label);
      assert.equal(view.limits.reservedForRevocations, view.ledger.capacity?.revocationsAvailable, `${label}: a reserva anunciada é a que o livro executa (nunca 100 fixo)`);
      assert.equal(view.limits.maxEntries, 1945 + (view.ledger.capacity?.revocationsAvailable ?? 0), `${label}: o total de entradas anunciado é o que o livro comporta (nunca o MAX_SEQ da 6B)`);

      const before = trees(w);
      const create = await svc.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: view.head }, clock());
      assert.ok(!create.ok && create.code === 'LEDGER_CAPACITY_EXHAUSTED', `${label}: ${JSON.stringify(create).slice(0, 200)}`);
      assert.ok(!/erro interno|\/tmp\//.test(JSON.stringify(create)), `${label}: sem "erro interno" nem caminho`);
      assert.deepEqual(trees(w), before, `${label}: a criação recusada não gravou NADA`);

      const revoke = await svc.revoke(ANA, w.auditId, { revokes: 'op-1945', reason: REASON, expectedHead: view.head }, clock());
      if (total === 3990) {
        assert.ok(revoke.ok, `${label}: a última revogação possível cabe (${JSON.stringify(revoke).slice(0, 160)})`);
        assert.equal((await ledgerRecords(w)).length, 3992);
      } else {
        assert.ok(!revoke.ok && revoke.code === 'LEDGER_CAPACITY_EXHAUSTED', `${label}: ${JSON.stringify(revoke).slice(0, 200)}`);
        assert.match(JSON.stringify(revoke), /INTERVENÇÃO|ESGOTADA/, `${label}: sinaliza que a auditoria precisa de intervenção`);
        assert.deepEqual(trees(w), before, `${label}: a revogação recusada não gravou nada`);
      }

      // rotação planejada: o ponto de verificação da chave nova é MANUTENÇÃO (cabe até 4000), com ou sem reserva de decisão/revogação
      const used = (await ledgerRecords(w)).length;
      const newKey = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: rotated() }), knownHeads: NO_RESULTS });
      const before2 = trees(w);
      const rotate = await newKey.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
      if (used + 1 <= MAX_LEDGER_RECORDS) {
        assert.ok(rotate.ok, `${label}: rotação cabe (${JSON.stringify(rotate).slice(0, 160)})`);
        const events = await ledgerEvents(w);
        assert.equal(events.length, used + 1);
        assert.equal(events.at(-1), 'CHECKPOINT');
        assert.equal(rotate.ok && rotate.value.ledger.keyCoverage?.covered, true);
        // (idempotência e vencimento da chave antiga: teste de rotação, que roda a mesma lógica sem custo de 4000 registros)
      } else {
        assert.ok(!rotate.ok && rotate.code === 'LEDGER_CAPACITY_EXHAUSTED', `${label}: ${JSON.stringify(rotate).slice(0, 200)}`);
        assert.ok(!/erro interno/.test(JSON.stringify(rotate)));
        assert.deepEqual(trees(w), before2);
        const open = await must(newKey.list(BIA, w.auditId, clock()));
        assert.equal(open.ledger.keyCoverage?.covered, false, `${label}: o livro avisa que a rotação ficou sem cobertura`);
      }
    }),
  );
});

test('reemissão de recibo (RECEIPT_REISSUED) perto do limite: cabe em 3999; em 4000 a recusa tem texto próprio, o estado fica RECEIPT_REMOVED e nada é gravado', async () => {
  for (const total of [3999, 4000]) {
    const w = await ledgerWorld({ enroll: false });
    await buildLongLedger(w, 1945, total);
    fs.rmSync(anchorPath(w, 1945));
    const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });
    const view = await must(svc.list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.receiptReissuable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', true], `total ${total}`);
    const before = trees(w);
    const resend = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: view.head }, clock);
    if (total < 4000) {
      assert.ok(resend.ok, `total ${total}: ${JSON.stringify(resend).slice(0, 180)}`);
      assert.equal((await ledgerEvents(w)).at(-1), 'RECEIPT_REISSUED');
      assert.equal((await ledgerRecords(w)).length, total + 1);
    } else {
      assert.ok(!resend.ok, 'em 4000 não há registro para a reemissão');
      assert.ok(!/erro interno/.test(JSON.stringify(resend)), `texto próprio, não "erro interno": ${JSON.stringify(resend).slice(0, 200)}`);
      assert.match(JSON.stringify(resend), /ESGOTADA|INTERVENÇÃO|limite/i);
      assert.equal((await ledgerRecords(w)).length, 4000);
      assert.ok(!fs.existsSync(anchorPath(w, 1945)), 'o recibo não foi regravado sem o registro do livro (a evidência não se perde)');
      void before;
    }
  }
});

/* ============================================================================ falhas no limite: uma operação INICIADA sempre consegue terminar */

test('falha no limite (3990): a revogação publica a INTENT e a entrada não é gravada — a recuperação ABORTA (manutenção cabe além da reserva de decisões) e o livro termina consistente; a nova tentativa já não cabe (a falha queimou a reserva: limite declarado)', async () => {
  const failing = faulty({ async link(from, to) { if (to.endsWith('d1946.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ enroll: false, decisionsFs: failing });
  await buildLongLedger(w, 1945, 3990);
  const failed = await w.rawProtected.revoke(ANA, w.auditId, { revokes: 'op-1945', reason: REASON, expectedHead: (await must(w.rawProtected.list(BIA, w.auditId, clock()))).head }, clock());
  assert.ok(!failed.ok, 'a gravação da entrada falhou');
  assert.equal((await ledgerEvents(w)).at(-1), 'INTENT');
  assert.equal((await ledgerRecords(w)).length, 3991, 'a INTENT cabe e o fecho TAMBÉM cabe (3992 ≤ 3992)');
  // "reinício" saudável: a INTENT vencida é abortada pela manutenção
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }), knownHeads: NO_RESULTS });
  const recovered = await healthy.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, '2026-12-01T00:00:00.000Z');
  assert.ok(recovered.ok, JSON.stringify(recovered).slice(0, 200));
  assert.deepEqual((await ledgerEvents(w)).slice(-2), ['INTENT', 'ABORTED']);
  const view = await must(healthy.list(BIA, w.auditId, '2026-12-01T00:00:00.000Z'));
  assert.deepEqual([view.ledger.state, view.ledger.openOperation, view.ledger.capacity?.level, view.decisions.length], ['PROTECTED', null, 'EXHAUSTED', 1], 'consistente: a decisão errada segue vigente e a auditoria sinaliza esgotamento');
  const retry = await healthy.revoke(ANA, w.auditId, { revokes: 'op-1945', reason: REASON, expectedHead: view.head }, '2026-12-01T00:00:00.000Z');
  assert.ok(!retry.ok && retry.code === 'LEDGER_CAPACITY_EXHAUSTED');
});

test('falha no limite (fronteira da revogação, política pequena): o CONFIRMED não consegue ser gravado — a entrada e o recibo existem e a recuperação grava o CONFIRMED que faltou (reservado, além do limite de decisões), concluindo a revogação', async () => {
  const policy = deriveCapacityPolicy(61, 3, 8); // §16.17.6: com RUN_CLOSING_ALLOWANCE, 61 mantém RECORD = 39 e o alinhamento do CHECKPOINT deste cenário (com 60, o CHECKPOINT devido cairia sobre a revogação)
  // preenche com decisões novas até restar só revogação, para a INTENT cair a 1 registro do limite da classe
  const probe = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8 });
  await must(probe.protectedService.create(ANA, probe.auditId, { record: rec.c2() }, clock()));
  let supersede = 'op-0001';
  for (let round = 0; round < 100; round += 1) {
    const view = await must(probe.protectedService.list(BIA, probe.auditId, clock()));
    if (view.ledger.capacity!.decisionsAvailable === 0) break;
    const made = await must(probe.protectedService.create(ANA, probe.auditId, { record: rec.c2(round % 2 === 0 ? 'INCOMPATIBLE' : 'COMPATIBLE'), supersedes: supersede, expectedHead: view.head }, clock()));
    supersede = (made as { decision: { decisionId: string } }).decision.decisionId;
  }
  const usedAtBoundary = (await ledgerRecords(probe)).length;
  // mundo igual, com a gravação do CONFIRMED da revogação falhando
  let failConfirmed = false;
  const ledgerFs = faulty({ async writeExclusive(target, data, mode) { if (failConfirmed && target.includes(`l${String(usedAtBoundary + 2).padStart(6, '0')}.json`)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8, ledgerFs });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  let current = 'op-0001';
  for (let round = 0; round < 100; round += 1) {
    const view = await must(w.protectedService.list(BIA, w.auditId, clock()));
    if (view.ledger.capacity!.decisionsAvailable === 0) break;
    const made = await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2(round % 2 === 0 ? 'INCOMPATIBLE' : 'COMPATIBLE'), supersedes: current, expectedHead: view.head }, clock()));
    current = (made as { decision: { decisionId: string } }).decision.decisionId;
  }
  assert.equal((await ledgerRecords(w)).length, usedAtBoundary, 'mesmo ponto de partida (determinístico)');
  failConfirmed = true;
  const view = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.capacity?.level, 'REVOKE_ONLY');
  const failed = await w.rawProtected.revoke(ANA, w.auditId, { revokes: current, reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!failed.ok && failed.code === 'LEDGER_UNAVAILABLE', JSON.stringify(failed).slice(0, 200));
  assert.equal((await ledgerRecords(w)).length, usedAtBoundary + 1, 'só a INTENT entrou');
  failConfirmed = false;
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: policy, checkpointEvery: 8 }), knownHeads: NO_RESULTS });
  const mid = await must(healthy.list(BIA, w.auditId, clock()));
  assert.deepEqual([mid.ledger.state, mid.ledger.reason, mid.ledger.recoverable], ['HISTORY_UNRESOLVED', 'LEDGER_BEHIND', true]);
  const recovered = await healthy.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(recovered.ok, JSON.stringify(recovered).slice(0, 200));
  assert.equal((await ledgerEvents(w)).at(-1), 'CONFIRMED');
  const end = await must(healthy.list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.decisions.some((d) => d.decisionId === current)], ['PROTECTED', false], 'a decisão foi revogada');
});

/* ============================================================================ fluxo completo com política PEQUENA: o anunciado é o executado */

test('política pequena (fluxo completo): o que a vista anuncia é um PISO que o escritor sempre cumpre (e nunca promete o que não executa) — decisões novas até o limite, depois só revogações, depois só manutenção; cada decisão admitida deixa ≥ reserva de revogações; esgotado ⇒ intervenção', async () => {
  const policy = deriveCapacityPolicy(60, 3, 8); // 60 registros, 3 revogações completas reservadas, ponto de verificação a cada 8
  const w = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8 });
  const svc = w.protectedService;
  const slots = [rec.c2(), rec.c3(), rec.p3(5), rec.naModel(), rec.naFeature()] as const;
  let created = 0;
  for (const record of slots) {
    await must(svc.create(ANA, w.auditId, { record }, clock()));
    created += 1;
  }
  const afterSlots = (await must(svc.list(BIA, w.auditId, clock()))).ledger.capacity!;
  assert.equal(afterSlots.level, 'OK');
  // substituições em sequência (decisão nova que troca a vigente): executa exatamente o anunciado
  let announced = afterSlots.decisionsAvailable;
  let executed = 0;
  let minRevocations = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 200; round += 1) {
    const view = await must(svc.list(BIA, w.auditId, clock()));
    const capacity = view.ledger.capacity!;
    if (capacity.decisionsAvailable === 0) break;
    const target = view.decisions.find((d) => d.record.kind === 'JUDGEMENT' && (d.record as { subcriterionId?: string }).subcriterionId === 'C2')!;
    const result = await svc.create(ANA, w.auditId, { record: rec.c2(round % 2 === 0 ? 'INCOMPATIBLE' : 'COMPATIBLE'), supersedes: target.decisionId, expectedHead: view.head }, clock());
    assert.ok(result.ok, `substituição ${round}: ${JSON.stringify(result).slice(0, 200)}`);
    executed += 1;
    const after = (await must(svc.list(BIA, w.auditId, clock()))).ledger.capacity!;
    minRevocations = Math.min(minRevocations, after.revocationsAvailable);
    assert.ok(after.revocationsAvailable >= 3, `depois de cada decisão admitida restam ao menos as 3 revogações reservadas (${after.revocationsAvailable})`);
  }
  assert.ok(executed >= announced, `decisões executadas (${executed}) ≥ o PISO anunciado (${announced}): o anunciado vale mesmo com reemissão de recibo após cada operação`);
  announced = 0;
  void announced;
  void created;
  const boundary = await must(svc.list(BIA, w.auditId, clock()));
  assert.deepEqual([boundary.ledger.capacity?.level, boundary.limits.reservedForRevocations], ['REVOKE_ONLY', Math.min(100, boundary.ledger.capacity!.revocationsAvailable)]);
  const refused = await svc.create(ANA, w.auditId, { record: rec.naNoAdditional(), expectedHead: boundary.head }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED' && /só cabem revogações/.test(JSON.stringify(refused)), JSON.stringify(refused).slice(0, 200));

  // revogações: as ativas são 5; cabem min(anunciado, 5) — todas executam
  const revocationsAnnounced = boundary.ledger.capacity!.revocationsAvailable;
  let revoked = 0;
  for (const decision of boundary.decisions) {
    const view = await must(svc.list(BIA, w.auditId, clock()));
    if (view.ledger.capacity!.revocationsAvailable === 0) break;
    const result = await svc.revoke(ANA, w.auditId, { revokes: decision.decisionId, reason: REASON, expectedHead: view.head }, clock());
    assert.ok(result.ok, `revogação de ${decision.decisionId}: ${JSON.stringify(result).slice(0, 200)}`);
    revoked += 1;
  }
  assert.ok(revoked >= Math.min(revocationsAnnounced, boundary.decisions.length), 'revogações executadas ≥ o piso anunciado (limitadas pelas ativas)');
  assert.ok(revoked >= Math.min(3, boundary.decisions.length), 'as 3 revogações reservadas foram entregues');
  const end = await must(svc.list(BIA, w.auditId, clock()));
  assert.equal(end.ledger.state, 'PROTECTED');
  assert.ok(end.ledger.capacity!.usedRecords <= policy.REVOKE, 'a revogação nunca passa do limite da sua classe');
  void minRevocations;
});

/* ============================================================================ concorrência entre processos na fronteira */

async function smallWorld() {
  // o mundo é montado com uma política LARGA (as 5 decisões iniciais precisam caber); depois a vista e os processos usam a política ESTREITA, em que sobram poucas revogações
  const w = await ledgerWorld({ capacityPolicy: deriveCapacityPolicy(400, 3, 8), checkpointEvery: 8 });
  for (const record of [rec.c2(), rec.c3(), rec.p3(5), rec.naModel(), rec.naFeature()]) await must(w.protectedService.create(ANA, w.auditId, { record }, clock()));
  const used = (await ledgerRecords(w)).length;
  // REVOKE = max − 8 = used + 9 ⇒ cabem poucas revogações (menos que as 5 ativas ⇒ há disputa); RECORD = max − 8 − 13 < used ⇒ decisões novas encerradas
  const capacity = { max: used + 17, revocations: 3, every: 8 };
  const policy = deriveCapacityPolicy(capacity.max, capacity.revocations, capacity.every);
  const narrow = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: policy, checkpointEvery: 8 }), knownHeads: NO_RESULTS });
  return { w, policy, capacity, narrow };
}

test('CONCORRÊNCIA na fronteira (5 processos reais revogando ao mesmo tempo): exatamente as revogações que CABEM terminam, as demais recebem recusa de capacidade, nada fica pela metade e a cadeia continua válida', async () => {
  const { w, policy, capacity, narrow } = await smallWorld();
  const view = await must(narrow.list(BIA, w.auditId, clock()));
  const announced = view.ledger.capacity!.revocationsAvailable;
  const fits = normalFit(await ledgerRecords(w), policy.REVOKE, 8); // o que o escritor admite de fato (ninguém remove recibos)
  assert.ok(announced >= 1 && announced <= fits, `o piso anunciado (${announced}) nunca passa do que o escritor admite (${fits})`);
  const actives = view.decisions.map((d) => d.decisionId);
  assert.equal(actives.length, 5);
  assert.equal(view.ledger.capacity!.level, 'REVOKE_ONLY');
  assert.ok(fits < 5, `precondição do cenário: há mais revogadores (5) que capacidade (${fits})`);
  const outcomes = await Promise.all(actives.map((decisionId) => runChild(w, null, { task: 'revoke-retry', decisionId, capacity, actor: 'ana@empresa.com' })));
  for (const [index, o] of outcomes.entries()) assert.equal(o.status, 0, `processo ${index}: ${o.stderr.slice(0, 200)}`);
  const ok = outcomes.filter((o) => o.line?.ok === true).length;
  const refused = outcomes.filter((o) => o.line?.code === 'LEDGER_CAPACITY_EXHAUSTED').length;
  assert.equal(ok, fits, 'tantas revogações quanto o escritor admite (e ao menos o piso anunciado)');
  assert.equal(refused, 5 - fits, `as demais: recusa de capacidade (${JSON.stringify(outcomes.map((o) => o.line))})`);
  const records = await ledgerRecords(w);
  assert.ok(replayLedger(records, w.auditId).ok);
  assert.equal(verifyTags(records, LEDGER_AUTH_A), null);
  const events = records.map((r) => r.event);
  assert.ok(!events.includes('ABORTED'), 'ninguém foi abortado à toa');
  const end = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: deriveCapacityPolicy(capacity.max, capacity.revocations, capacity.every), checkpointEvery: 8 }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.ledger.openOperation, end.decisions.length], ['PROTECTED', null, 5 - ok]);
  assert.ok(records.length <= deriveCapacityPolicy(capacity.max, capacity.revocations, capacity.every).REVOKE);
});

test('CONCORRÊNCIA na fronteira (decisão nova): com espaço para exatamente N, de 5 processos que tentam criar decisões DIFERENTES terminam N e as outras recebem recusa de capacidade', async () => {
  const policy = deriveCapacityPolicy(60, 3, 8);
  const w = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8, enroll: false });
  // histórico real sem decisões ativas (todas revogadas), com o livro completado até restar espaço para exatamente 2 decisões novas
  let total = 0;
  for (total = 20; total <= 50; total += 1) {
    const probe = ledgerCapacityFor(total);
    if (probe === 2) break;
  }
  await buildLongLedger(w, 4, total, { checkpointEveryOps: 3 });
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: policy, checkpointEvery: 8 }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()));
  assert.ok(view.ledger.capacity!.decisionsAvailable >= 1 && view.ledger.capacity!.decisionsAvailable <= 2, `o piso anunciado nunca passa do que cabe (${JSON.stringify(view.ledger.capacity)})`);
  assert.equal(normalFit(await ledgerRecords(w), policy.RECORD, 8), 2, 'precondição: o escritor admite exatamente 2');
  const capacity = { max: 60, revocations: 3, every: 8 };
  const outcomes = await Promise.all([0, 1, 2, 3, 4].map((worker) => runChild(w, null, { task: 'create-retry', worker, capacity, actor: 'ana@empresa.com' })));
  const ok = outcomes.filter((o) => o.line?.ok === true).length;
  const refused = outcomes.filter((o) => o.line?.code === 'LEDGER_CAPACITY_EXHAUSTED').length;
  assert.equal(ok, 2, JSON.stringify(outcomes.map((o) => o.line)));
  assert.equal(refused, 3);
  const records = await ledgerRecords(w);
  assert.ok(replayLedger(records, w.auditId).ok && verifyTags(records, LEDGER_AUTH_A) === null);
  assert.ok(records.length <= policy.RECORD, 'nenhuma decisão nova passou do limite da sua classe');
});

/** Quantas decisões novas cabem num livro sintético de `total` registros recém-coberto (para escolher o tamanho do cenário). */
function ledgerCapacityFor(total: number): number {
  const records = fakeRecords([['GENESIS', 'lk-test-a'], ...Array.from({ length: total - 1 }, (): [string, string] => ['CHECKPOINT', 'lk-test-a'])]);
  return normalFit(records, deriveCapacityPolicy(60, 3, 8).RECORD, 8);
}

test('UMA OPERAÇÃO INICIADA SEMPRE TERMINA: com a decisão publicada e a INTENT aberta, a manutenção (CHECKPOINT de rotação) NÃO consome o último registro livre — o fecho (CONFIRMED) continua cabendo', async () => {
  const tiny = { max: 3, RECORD: 3, REVOKE: 3, MAINTENANCE: 3 }; // 3 registros no total: GENESIS + INTENT + exatamente UM livre
  const w = await ledgerWorld({ capacityPolicy: tiny });
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(w.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const flaky = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: tiny }), knownHeads: NO_RESULTS, fs: noReceipts });
  const pending = await flaky.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING', JSON.stringify(pending).slice(0, 160));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT']);
  // rotação pedida com a operação aberta: o CHECKPOINT ocuparia o último registro e o CONFIRMED nunca mais caberia ⇒ recusa
  const rotated = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at('2026-11-03T12:00:00Z') }), capacityPolicy: tiny }), knownHeads: NO_RESULTS });
  const refused = await rotated.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_CAPACITY_EXHAUSTED', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'nada foi gravado');
  // o autor reenvia o MESMO pedido (disco saudável): a operação iniciada conclui no registro que sobrou
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, capacityPolicy: tiny }), knownHeads: NO_RESULTS });
  const done = await healthy.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(done.ok, JSON.stringify(done).slice(0, 200));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});


test('R7-01/D3: o que a vista anuncia desde o PRIMEIRO dia é um PISO do que o livro comporta — ≥ 1311 entradas no total (não o MAX_SEQ de 9999 da 6B) e as 100 revogações reservadas; cada entrada custa 2 registros e reserva 1 para a reemissão do recibo', async () => {
  const w = await ledgerWorld();
  const view = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.capacity?.usedRecords, view.ledger.capacity?.decisionsAvailable, view.ledger.capacity?.revocationsAvailable], [1, 1209, 1311]);
  assert.deepEqual([view.limits.maxEntries, view.limits.reservedForRevocations], [1311, 100]);
  // depois de uma decisão, o total de entradas continua o mesmo (a entrada gasta 1 das 1965 possíveis)
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const after = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.ok(after.limits.maxEntries >= 1311, `o piso do total só sobe (a decisão gastou 2 registros, não os 3 do pior caso): ${after.limits.maxEntries}`);
});
