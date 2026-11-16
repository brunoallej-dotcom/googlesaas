import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { KnownHeadsProvider, LedgerPort } from '../src/lib/link-audit-decisions';
import { isDecisionsPayload } from '../src/components/link-audit/audit-page/validators';
import { deriveCapacityPolicy, ledgerCapacity, operationCost } from '../src/lib/link-audit-ledger';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, LEDGER_AUTH_A, NO_RESULTS, refOf, syntheticLedger, makeRecord, opOf } from './helpers/link-audit-ledger-fixtures';
import { runChild, sealResult, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * Revisão independente nº 7 (04/11/2026) — provas do revisor transformadas em REGRESSÃO (as provas dele passavam quando o defeito existia; aqui afirmam o comportamento corrigido):
 *  R1 (M1) o dono que ADOTA o CONFIRMED de outro processo só tem sucesso depois de sincronizar o livro; R2 (M3) citação de resultado além da cabeça lida é corrida legítima (relê);
 *  R3/R3b (M2) pai de pasta cujo fsync falhou é sincronizado de novo na retomada; R4 (m1) a vista não anuncia o espaço que a operação aberta vai ocupar;
 *  R6 (B1) INTENT do futuro com o relógio monotônico REAL: a idade observada é inteira e o ABORTED é gravado.
 */
registerCleanup();
const readLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

test('R1: confirmed() adota o CONFIRMED de OUTRO processo (CONFLICT) e devolve SUCESSO sem sincronizar a pasta do livro, mesmo quando o outro processo falhou no fsync', async () => {
  const w = await ledgerWorld();
  let armed = false;
  const syncedAfter: string[] = [];
  const recordingFs: FsOps = {
    ...nodeFsOps,
    async syncDirectory(dir) {
      await nodeFsOps.syncDirectory(dir);
      if (armed) syncedAfter.push(dir);
    },
  };
  const inner = ledgerFor(w, { guard: null, fs: recordingFs });
  let child: Awaited<ReturnType<typeof runChild>> | null = null;
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'confirmed'
        ? async (input: Parameters<LedgerPort['confirmed']>[0]) => {
            // entrada e recibo do dono JÁ existem (fase C). Outro processo (filho REAL) roda RECOVER e grava o CONFIRMED, mas o fsync da pasta do livro FALHA nele.
            child = await runChild(w, null, { task: 'recover', failSync: 'ledger', actor: 'bia@empresa.com' });
            armed = true;
            return target.confirmed(input);
          }
        : Reflect.get(target, key),
  });
  const owner = decisionsOver(w, { ledger: port, knownHeads: NO_RESULTS });
  const result = await owner.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  const ledgerAudit = path.join(w.ledgerDir, w.auditId);
  // O defeito: sucesso do dono SEM nenhum fsync da pasta do livro depois de adotar o CONFIRMED cuja durabilidade o outro processo NÃO comprovou
  assert.equal((child as unknown as { line: { ok: boolean } }).line.ok, false, 'o outro processo falhou (durabilidade desconhecida)');
  assert.equal(result.ok, true, 'o dono recebeu sucesso (o disco dele sincroniza)');
  assert.ok(syncedAfter.includes(ledgerAudit), 'o dono sincronizou a pasta do livro antes de devolver sucesso');
});

test('R2: releitura FRESCA dos resultados (revalidate) acusa RESULT_LEDGER_MISMATCH espúrio quando um resultado legítimo cita uma cabeça do livro POSTERIOR à leitura (corrida legítima entre processos)', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  const real = witnessOver(w, e);
  // 1ª decisão (o intervalo de pontos de verificação pequeno faz a próxima escrita precisar de CHECKPOINT ⇒ passa pelo `revalidate`)
  await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null, checkpointEvery: 2 }), knownHeads: real }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  let inPrepare = false;
  let fired = false;
  const provider: KnownHeadsProvider = async (auditId) => {
    if (inPrepare && !fired) {
      fired = true;
      // ENQUANTO A está no prepare (livro já lido): B (processo real) grava uma decisão completa; depois um resultado é selado sobre o estado novo (cita a cabeça nova)
      const b = await runChild(w, e, { task: 'create-retry', worker: 3, actor: 'bia@empresa.com', nowIso: clock() });
      void b;
      await sealResult(w, e);
      const r = await real(auditId);
      return r;
    }
    return real(auditId);
  };
  const inner = ledgerFor(w, { guard: null, checkpointEvery: 2 });
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'prepare'
        ? async (input: Parameters<LedgerPort['prepare']>[0]) => {
            inPrepare = true;
            try {
              return await target.prepare(input);
            } finally {
              inPrepare = false;
            }
          }
        : Reflect.get(target, key),
  });
  const a = decisionsOver(w, { ledger: port, knownHeads: provider });
  const head = (await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: real }).list(BIA, w.auditId, clock()))).head;
  const result = await a.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: head }, clock);
  const after = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: real }).list(BIA, w.auditId, clock()));
  // A escreve com a visão antiga (B gravou antes): o desfecho legítimo é HEAD_MISMATCH; o que NUNCA pode sair é acusação de integridade
  assert.ok(!/RESULT_LEDGER_MISMATCH|GUARD_MISMATCH|DECISIONS_HISTORY_UNRESOLVED/.test(JSON.stringify(result)), `corrida legítima: sem acusação de integridade (${JSON.stringify(result).slice(0, 200)})`);
  assert.equal(after.ledger.state, 'PROTECTED', 'nada estava errado: o livro e os resultados concordam');
});

test('R3: a RAIZ do livro com fsync falho na inscrição: nada é dado como feito e, depois do reinício, a inscrição só conclui DEPOIS de sincronizar a raiz de novo; criação e RECOVER também a sincronizam', async () => {
  const w = await ledgerWorld({ enroll: false });
  const failed = await runChild(w, null, { task: 'enroll', failSync: 'ledger', failSyncParents: true, actor: 'ana@empresa.com' });
  assert.equal(failed.line?.ok, false, 'sem a raiz comprovada a inscrição NÃO é sucesso');
  const log = path.join(tmpDir('rv7-sync-'), 'sync.log');
  const enrolled = await runChild(w, null, { task: 'enroll', syncLog: log, actor: 'ana@empresa.com' });
  const created = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com' });
  const recovered = await runChild(w, null, { task: 'recover', syncLog: log, actor: 'ana@empresa.com' });
  const synced = readLines(log);
  assert.equal(enrolled.line?.ok, true, JSON.stringify(enrolled.line));
  assert.equal(created.line?.ok, true);
  assert.equal(recovered.line?.ok, true);
  assert.ok(synced.filter((dir) => dir === w.ledgerDir).length >= 4, 'o pai do livro (onde vive o NOME da pasta da auditoria) foi sincronizado em cada publicação (GENESIS, INTENT, CONFIRMED) e no RECOVER');
});

test('R3b: idem para a pasta de DECISÕES: pai com fsync falho na criação nunca é ressincronizado depois do reinício', async () => {
  const w = await ledgerWorld();
  await runChild(w, null, { task: 'create', failSync: 'decisions', failSyncParents: true, actor: 'ana@empresa.com' });
  const log = path.join(tmpDir('rv7-sync-'), 'sync.log');
  const resumed = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com' });
  const synced = readLines(log);
  assert.equal(resumed.line?.ok, true);
  assert.ok(synced.includes(w.decisionsDir), 'pai das decisões ressincronizado');
});

test('R4: com operação ABERTA a vista anuncia uma decisão nova que o livro NÃO executa depois que a operação fechar', () => {
  const policy = deriveCapacityPolicy(39, 2, 1000); // RECORD = 39 - 8 - 7 = 24
  const refs = [] as ReturnType<typeof refOf>[];
  let prev: string | null = null;
  for (let seq = 1; seq <= 11; seq += 1) {
    const ref = refOf(seq, prev, 'r');
    refs.push(ref);
    prev = ref.sha256;
  }
  const open = syntheticLedger(LEDGER_AUTH_A, 'audit-cap-0001', refs, { open: true }); // GENESIS + 11×2 + INTENT = 24
  const view = ledgerCapacity(open, LEDGER_AUTH_A.keyId, 1000, policy, 1);
  // fecha a operação aberta (CONFIRMED) e vê o que realmente cabe
  const last = open[open.length - 1]!;
  const closed = [...open, makeRecord(LEDGER_AUTH_A, 'audit-cap-0001', last, { event: 'CONFIRMED', recordedAt: last.recordedAt, actor: 'ana@empresa.com', op: { ...opOf(refs[10]!, String(11).padStart(32, '0')), intentSeq: last.ledgerSeq, anchorRef: { name: 'a0011.json', headSha256: refs[10]!.sha256 } } })];
  const real = operationCost(closed, LEDGER_AUTH_A.keyId, 1000, 'RECORD', policy);
  assert.equal(real, null, 'depois de fechar, a decisão nova não cabe');
  assert.equal(view.decisionsAvailable, 0, 'a vista com a operação aberta já diz 0 (o fecho ocupa o último espaço)');
  assert.equal(view.level, 'REVOKE_ONLY');
});

test('R6: INTENT do FUTURO com o relógio monotônico REAL (performance.now, frações de ms): o ABORTED viola o esquema (ageMs inteiro) e a recuperação NUNCA grava', async () => {
  const { createOpenObservations } = await import('../src/lib/link-audit-ledger');
  const { errno, faulty } = await import('./helpers/link-audit-evidence-fixtures');
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ decisionsFs: failingEntry });
  const FUTURE = '2027-06-01T00:00:00.000Z';
  const NOW = '2026-11-03T12:00:00.000Z';
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, () => FUTURE);
  assert.ok(!failed.ok);
  const observations = createOpenObservations(); // o PADRÃO de produção: performance.now()
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 30, pollMs: 1, observations }), knownHeads: NO_RESULTS });
  await must(service.list(BIA, w.auditId, () => NOW));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stale = await must(service.list(BIA, w.auditId, () => NOW));
  const recovered = await service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW);
  const written = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, () => NOW);
  assert.ok(stale.ledger.openOperation?.stale === true && Number.isInteger(stale.ledger.openOperation?.ageMs), 'idade observada inteira e vencida');
  assert.ok(recovered.ok, JSON.stringify(recovered).slice(0, 200));
  assert.ok((await ledgerEvents(w)).includes('ABORTED'), 'o ABORTED é gravado com o relógio monotônico real');
  assert.ok(written.ok, JSON.stringify(written).slice(0, 200));
});

test('R1c: o dono que adota o CONFIRMED de outro processo NÃO tem sucesso se o PRÓPRIO fsync do livro falha depois do conflito (nunca sucesso com durabilidade incerta)', async () => {
  const w = await ledgerWorld();
  let armed = false;
  const flakyFs: FsOps = {
    ...nodeFsOps,
    async syncDirectory(dir) {
      // só a PASTA DA AUDITORIA falha (a raiz passa): a publicação chega ao conflito e o caminho de ADOÇÃO precisa provar a durabilidade por conta própria
      if (armed && dir === path.join(w.ledgerDir, w.auditId)) throw Object.assign(new Error('EIO simulado'), { code: 'EIO' });
      await nodeFsOps.syncDirectory(dir);
    },
  };
  const inner = ledgerFor(w, { guard: null, fs: flakyFs });
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'confirmed'
        ? async (input: Parameters<LedgerPort['confirmed']>[0]) => {
            const other = await runChild(w, null, { task: 'recover', actor: 'ana@empresa.com' }); // outro processo do MESMO autor conclui o MESMO CONFIRMED (disco saudável; §16.16)
            assert.equal(other.line?.ok, true);
            armed = true;
            return target.confirmed(input);
          }
        : Reflect.get(target, key),
  });
  const result = await decisionsOver(w, { ledger: port, knownHeads: NO_RESULTS }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!result.ok && result.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(result).slice(0, 220));
});

test('m1 pelo SERVIÇO: com a INTENT aberta a vista já desconta o registro que a fecha — não anuncia a decisão que o livro não executaria depois', async () => {
  const { errno, faulty } = await import('./helpers/link-audit-evidence-fixtures');
  const policy = deriveCapacityPolicy(19, 2, 64, 2); // RECORD ≤ 8 (reserva de 2 revogações = 2×3 + 1 + 2 = 9)
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0003.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ capacityPolicy: policy, decisionsFs: failingEntry });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  const closed = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.equal(closed.ledger.capacity?.decisionsAvailable, 1, 'sem operação aberta cabe 1 decisão nova (5 + 2 ≤ 8)');
  assert.ok(!(await w.protectedService.create(ANA, w.auditId, { record: rec.p3(5) }, clock())).ok, 'a 3ª falha e deixa a INTENT aberta');
  const open = await must(w.rawProtected.list(BIA, w.auditId, clock()));
  assert.equal(open.ledger.openOperation?.phase, 'A');
  assert.equal(open.ledger.capacity?.decisionsAvailable, 0, 'com a INTENT aberta o fecho ocupa o espaço: 0 decisões novas');
});

test('CONTRATO com o cliente: o payload REAL do servidor com operação aberta (fase A e B) e idade observada passa no validador estrito da tela — `used + remaining = max` e `ageMs` inteiro', async () => {
  const { errno, faulty } = await import('./helpers/link-audit-evidence-fixtures');
  // fase B: decisão publicada, recibo não gravado
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(w0.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w0 = await ledgerWorld();
  await decisionsOver(w0, { ledger: ledgerFor(w0, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts }).create(ANA, w0.auditId, { record: rec.c2(), expectedHead: null }, clock);
  const phaseB = await must(decisionsOver(w0, { ledger: ledgerFor(w0, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w0.auditId, clock()));
  assert.equal(phaseB.ledger.openOperation?.phase, 'B');
  assert.ok(isDecisionsPayload(JSON.parse(JSON.stringify(phaseB)), w0.auditId), 'fase B: a tela aceita o payload');
  // fase A com hora do futuro (idade vinda da observação monotônica real)
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w1 = await ledgerWorld({ decisionsFs: failingEntry });
  await w1.protectedService.create(ANA, w1.auditId, { record: rec.c2() }, () => '2027-06-01T00:00:00.000Z');
  const phaseA = await must(decisionsOver(w1, { ledger: ledgerFor(w1, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w1.auditId, () => '2026-11-03T12:00:00.000Z'));
  assert.equal(phaseA.ledger.openOperation?.phase, 'A');
  assert.ok(isDecisionsPayload(JSON.parse(JSON.stringify(phaseA)), w1.auditId), 'fase A com hora do futuro: a tela aceita o payload');
});
