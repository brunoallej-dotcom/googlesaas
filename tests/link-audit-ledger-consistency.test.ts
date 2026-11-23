import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { ANA, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerFor, ledgerPath, ledgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild, sealResult, servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R7-05 — CONFLITOS ESPÚRIOS. As fontes só crescem e CITAM as anteriores (o resultado cita o livro e as decisões; a guarda é publicada depois do livro; o livro registra antes de a
 * decisão ser confirmada). Lendo na ordem resultados → guarda → livro → decisões, uma escrita + finalização concorrente nunca produz RESULT_LEDGER_MISMATCH nem GUARD_MISMATCH:
 * a fonte citada é lida ANTES da que a cita. Adulteração real e inconsistência persistente continuam bloqueando (falha fechada), sem mascarar com retentativas.
 */
registerCleanup();
type Point = 'beforeProvider' | 'afterProvider' | 'beforeGuard' | 'afterLedger';
const POINTS: Point[] = ['beforeProvider', 'afterProvider', 'beforeGuard', 'afterLedger'];

/** Mundo com um resultado selado; devolve o leitor que, num ponto da leitura, deixa OUTRO operador gravar uma decisão E finalizar um resultado novo (o pior caso para a ordem de leitura). */
async function raceWorld(withGuard: boolean, fireAt: Point | null) {
  const w = await ledgerWorld({ withGuard });
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await sealResult(w, e, { viaLedger: true });
  let fired = false;
  const fire = async (point: Point): Promise<void> => {
    if (fired || point !== fireAt) return;
    fired = true;
    await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
    await sealResult(w, e, { viaLedger: true }); // o resultado novo cita o livro DEPOIS dessa decisão (R1.5: pelo livro, com RUN_INTENT/RUN_CONFIRMED)
  };
  const realProvider = witnessOver(w, e);
  const provider: KnownHeadsProvider = async (auditId) => {
    await fire('beforeProvider');
    const read = await realProvider(auditId);
    await fire('afterProvider');
    return read;
  };
  // a guarda é lida DENTRO do `begin` do livro: o ponto `beforeGuard` deixa a corrida acontecer entre a leitura dos resultados e a da guarda
  const guardPort = { ...w.guard, async latest(auditId: string) { await fire('beforeGuard'); return w.guard.latest(auditId); } };
  const realLedger = ledgerFor(w, { guard: withGuard ? guardPort : null });
  const ledger = {
    ...realLedger,
    async begin(auditId: string) {
      const session = await realLedger.begin(auditId);
      await fire('afterLedger');
      return session;
    },
  };
  return { w, e, reader: decisionsOver(w, { ledger, knownHeads: provider }), wasFired: () => fired };
}

test('corrida injetada em CADA ponto da leitura (antes da testemunha, entre testemunha e livro, entre livro e decisões), com e sem guarda externa: a primeira consulta NUNCA acusa RESULT_LEDGER_MISMATCH nem GUARD_MISMATCH — fica PROTEGIDA', async () => {
  for (const withGuard of [false, true]) {
    for (const point of POINTS) {
      if (point === 'beforeGuard' && !withGuard) continue;
      const { w, reader, wasFired } = await raceWorld(withGuard, point);
      const view = await must(reader.list(BIA, w.auditId, clock()));
      const label = `${point}${withGuard ? ' + guarda' : ''}`;
      assert.ok(wasFired(), `${label}: a corrida foi realmente injetada`);
      assert.deepEqual([view.ledger.state, view.ledger.reason], ['PROTECTED', null], `${label}: ${JSON.stringify([view.ledger.state, view.ledger.reason, view.witness.status])}`);
      assert.ok(!['RESULT_LEDGER_MISMATCH', 'GUARD_MISMATCH', 'HISTORY_REGRESSED', 'HISTORY_DIVERGES'].includes(String(view.ledger.reason)));
      assert.ok(view.finalizable, `${label}: finalizável`);
      // a leitura seguinte (sem corrida) enxerga o estado novo inteiro
      const next = await must(reader.list(BIA, w.auditId, clock()));
      assert.deepEqual([next.ledger.state, next.decisions.length], ['PROTECTED', 2], `${label}: segunda consulta`);
    }
  }
});

test('o CAMINHO DE ESCRITA também lê na ordem consistente: uma decisão gravada com a corrida injetada em cada ponto conclui (nunca RESULT_LEDGER_MISMATCH/GUARD_MISMATCH espúrios)', async () => {
  for (const withGuard of [false, true]) {
    for (const point of POINTS) {
      if (point === 'beforeGuard' && !withGuard) continue;
      const { w, reader, wasFired } = await raceWorld(withGuard, point);
      const label = `${point}${withGuard ? ' + guarda' : ''}`;
      const head = (await must(reader.list(BIA, w.auditId, clock()))).head; // (a corrida dispara aqui, na 1ª leitura do leitor)
      assert.ok(wasFired());
      const written = await reader.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: (await must(reader.list(BIA, w.auditId, clock()))).head ?? head }, clock());
      assert.ok(written.ok, `${label}: ${JSON.stringify(written).slice(0, 200)}`);
    }
  }
});

test('inconsistência PERSISTENTE continua bloqueando em TODAS as consultas (nenhuma releitura a mascara): resultado que cita posição que o livro perdeu e guarda à frente do livro', async () => {
  // (a) resultado cita o livro, mas o livro perdeu a cauda
  const { w, e } = await raceWorld(false, null);
  const records = fs.readdirSync(`${w.ledgerDir}/${w.auditId}`).filter((n) => /^l\d{6}\.json$/.test(n));
  // R1.5: a cauda é o par RUN_INTENT + RUN_CONFIRMED da finalização; o resultado cita a cabeça de DECISÕES (cauda − 2), que sai junto
  for (const seq of [records.length, records.length - 1, records.length - 2]) fs.rmSync(ledgerPath(w, seq));
  const reader = servicesOver(w, e);
  for (let i = 0; i < 3; i += 1) {
    const view = await must(reader.list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', 0], `consulta ${i + 1}`);
  }
  // (b) a guarda tem uma cabeça que o livro não contém
  const g = await ledgerWorld({ withGuard: true });
  await must(g.protectedService.create(ANA, g.auditId, { record: rec.c2() }, clock()));
  assert.deepEqual(await g.guard.publish({ auditId: g.auditId, ledgerSeq: 4, sha256: 'e'.repeat(64) }), { ok: true }); // a guarda guarda uma posição que o livro (3 registros) NÃO tem
  const guarded = decisionsOver(g, { ledger: ledgerFor(g, { guard: g.guard }), knownHeads: witnessOver(g, resultsEnv()) });
  for (let i = 0; i < 3; i += 1) {
    const view = await must(guarded.list(BIA, g.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.reason], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH'], `guarda, consulta ${i + 1}`);
  }
});

test('PROCESSOS SEPARADOS: 4 processos gravam criação e revogação sem parar enquanto o leitor (resultados + guarda + livro + decisões reais) consulta 60 vezes — zero acusações espúrias de integridade e o estado final é íntegro', async () => {
  // G1.b.1: todos os escritores publicam na guarda (como em produção); sem isso o atraso passa de L_max e a leitura acusaria GUARD_LAGGING (regra 3)
  const w = await ledgerWorld({ withGuard: true });
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await sealResult(w, e, { viaLedger: true });
  const reader = decisionsOver(w, { ledger: ledgerFor(w, { guard: w.guard }), knownHeads: witnessOver(w, e) });
  const writers = Promise.all([1, 2, 3, 4].map((worker) => runChild(w, e, { task: 'workload', worker, rounds: 2, actor: 'ana@empresa.com', guardDir: w.guardDir })));
  const seen = new Map<string, number>();
  let done = false;
  void writers.then(() => (done = true));
  for (let i = 0; i < 60 && !done; i += 1) {
    const view = await must(reader.list(BIA, w.auditId, clock()));
    const key = `${view.ledger.state}/${view.ledger.reason}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const outcomes = await writers;
  for (const [index, o] of outcomes.entries()) assert.equal(o.status, 0, `processo ${index}: ${o.stderr.slice(0, 160)}`);
  for (const bad of ['RESULT_LEDGER_MISMATCH', 'GUARD_MISMATCH', 'GUARD_HEAD_MISSING', 'GUARD_LAGGING', 'HISTORY_REGRESSED', 'HISTORY_DIVERGES', 'UNTRUSTED', 'PUBLISHED_AFTER_ABORT']) {
    assert.ok(![...seen.keys()].some((key) => key.endsWith(`/${bad}`)), `acusação espúria ${bad} observada: ${JSON.stringify([...seen])}`);
  }
  const end = await must(reader.list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.ledger.openOperation], ['PROTECTED', null]);
});
