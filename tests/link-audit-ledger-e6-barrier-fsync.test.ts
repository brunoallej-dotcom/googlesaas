import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { LedgerPort } from '../src/lib/link-audit-decisions';
import { syncDecisionDirectories } from '../src/lib/link-audit-decisions/store';
import { clearStorageFatal, isStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { ANA, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerFor, ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * LACUNA E6 do relatório C3 (mutante `syncDecisionDirectories` sem `tripBase`). Uma falha de fsync (EIO) nas pastas de DECISÕES ou de RECIBOS da auditoria, ou nos diretórios-pai onde vivem os nomes
 * delas, DENTRO da barreira de durabilidade que antecede o selamento, precisa TRAVAR as bases de decisões e de recibos: "depois de um erro de fsync não se presume nada". Sem o travamento, uma 2ª finalização
 * com o disco "saudável" refaria o fsync, passaria e selaria citando uma cabeça cuja durabilidade foi posta em dúvida (efeito fsyncgate), e as escritas de decisões continuariam abertas.
 * O caso "BARREIRA com falha de fsync…" de `link-audit-ledger-seal-barrier.test.ts` injeta a falha só na porta do LIVRO (que trava a base do livro por outro caminho); aqui a falha é injetada
 * exclusivamente no `FsOps` do serviço de DECISÕES, que é o que `syncDecisionDirectories` usa.
 */
registerCleanup();

interface Stack {
  readonly w: LedgerWorld;
  readonly e: ResultsEnv;
}
/** Mesma fixture do caso de falha de fsync da barreira (seal-barrier): uma decisão gravada e o livro já PROVADO neste processo, então só a barreira sincroniza dali em diante. */
async function stack(): Promise<Stack> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.rawProtected.list(BIA, w.auditId, clock()));
  return { w, e };
}

/** `FsOps` de decisões cujo fsync de diretório falha com EIO SÓ para `target` e SÓ enquanto armado; registra as tentativas que falharam e os diretórios sincronizados com sucesso. */
function eioOn(target: string) {
  const state = { armed: false, hits: 0, synced: [] as string[] };
  const ops: FsOps = faulty({
    async syncDirectory(dir) {
      if (state.armed && dir === target) {
        state.hits += 1;
        throw errno('EIO');
      }
      await nodeFsOps.syncDirectory(dir);
      state.synced.push(dir);
    },
  });
  return { state, ops };
}

interface Target {
  readonly label: string;
  readonly dirOf: (w: LedgerWorld) => string;
}
const TARGETS: readonly Target[] = [
  { label: 'pasta de DECISÕES da auditoria', dirOf: (w) => path.join(w.decisionsDir, w.auditId) },
  { label: 'pasta de RECIBOS da auditoria', dirOf: (w) => path.join(w.anchorDir, w.auditId) },
  { label: 'diretório-pai das DECISÕES', dirOf: (w) => w.decisionsDir },
  { label: 'diretório-pai dos RECIBOS', dirOf: (w) => w.anchorDir },
];
const DIRECT_TARGETS = TARGETS.slice(0, 2);

/** Serviços novos ("outro processo" / nova requisição) sobre as MESMAS pastas; o `FsOps` de decisões é o injetado, o do livro e o dos resultados ficam saudáveis. */
function finalizer(s: Stack, decisionsFs: FsOps) {
  const ledger: LedgerPort = ledgerFor(s.w, { guard: null });
  const decisions = decisionsOver(s.w, { ledger, knownHeads: witnessOver(s.w, s.e), fs: decisionsFs });
  const preview = previewOver({ evidenceDir: s.w.evidenceDir, raw: decisions });
  const results = makeService(s.e, preview);
  return {
    decisions,
    async run() {
      const ev = await preview.evaluate(OP_A, s.w.auditId);
      if (!ev.ok) return { ok: false as const, code: ev.code, stage: 'evaluate' };
      const done = await results.finalize(OP_A, s.w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
      return done.ok ? { ok: true as const, code: null, stage: 'finalize' } : { ok: false as const, code: done.code, stage: 'finalize' };
    },
  };
}
const runsOf = async (s: Stack) => {
  const log = await readRunLog(s.e.base, s.w.auditId, { anchorDir: s.e.anchors });
  return log.ok ? log.value.runs : [];
};
const decisionFiles = (w: LedgerWorld): string[] => fs.readdirSync(path.join(w.decisionsDir, w.auditId)).sort();

for (const target of TARGETS) {
  test(`E6 BARREIRA com EIO no fsync (alvo: ${target.label}): nada é selado (RESULT_DURABILITY_UNKNOWN), a 2ª finalização com o disco "saudável" TAMBÉM não sela, as bases de decisões e de recibos ficam travadas, nova decisão é recusada e, restabelecidas as bases, o resultado sai citando a cabeça comprovada`, async () => {
    const s = await stack();
    const { w } = s;
    const dir = target.dirOf(w);
    const disk = eioOn(dir);
    const view = await must(w.rawProtected.list(BIA, w.auditId, clock())); // cabeça atual, para a gravação de controle mais abaixo
    const filesBefore = decisionFiles(w);

    // (1) 1ª finalização, com EIO no fsync de `dir` dentro da barreira: recusada e nada selado
    disk.state.armed = true;
    const first = await finalizer(s, disk.ops).run();
    disk.state.armed = false; // o disco volta a ser "saudável" daqui em diante
    assert.equal(disk.state.hits, 1, 'a falha de fsync foi de fato injetada (uma vez) no diretório alvo, dentro da barreira');
    assert.deepEqual([first.ok, first.stage, first.code], [false, 'finalize', 'RESULT_DURABILITY_UNKNOWN'], JSON.stringify(first));
    assert.deepEqual(await runsOf(s), [], 'nenhum resultado selado depois do fsync que falhou');

    // (2) com o `fs` saudável a 2ª finalização CONTINUA recusada: a falha não se contorna refazendo o fsync
    const second = await finalizer(s, disk.ops).run();
    assert.deepEqual([second.ok, second.stage, second.code], [false, 'finalize', 'RESULT_DURABILITY_UNKNOWN'], `base travada: ${JSON.stringify(second)}`);
    assert.deepEqual(await runsOf(s), [], 'nenhum resultado selado depois da falha, mesmo com o disco "saudável"');

    // (3) a falha travou as DUAS bases (decisões e recibos), mesmo sendo uma só pasta que falhou
    assert.equal(isStorageFatal(w.decisionsDir), true, 'base de DECISÕES travada');
    assert.equal(isStorageFatal(w.anchorDir), true, 'base de RECIBOS travada');

    // (4) com a base travada, uma gravação de decisão nova é recusada e nada é gravado
    const body = { record: rec.naModel(), expectedHead: view.head };
    const refused = await finalizer(s, disk.ops).decisions.create(ANA, w.auditId, body, clock);
    assert.deepEqual([refused.ok, refused.ok ? null : refused.code], [false, 'DECISIONS_STORAGE_UNAVAILABLE'], JSON.stringify(refused));
    assert.deepEqual(decisionFiles(w), filesBefore, 'nenhuma entrada de decisão foi gravada com a base travada');

    // (5) restabelecimento previsto (reiniciar o servidor == `clearStorageFatal` nas duas bases): a barreira sincroniza de novo a pasta que falhou e o resultado cita a cabeça comprovada
    clearStorageFatal(w.decisionsDir);
    clearStorageFatal(w.anchorDir);
    assert.equal(isStorageFatal(w.decisionsDir) || isStorageFatal(w.anchorDir), false, 'bases destravadas');
    const syncedBefore = disk.state.synced.length;
    const third = await finalizer(s, disk.ops).run();
    assert.deepEqual([third.ok, third.code], [true, null], JSON.stringify(third));
    assert.ok(disk.state.synced.slice(syncedBefore).includes(dir), 'depois de restabelecida, a barreira sincronizou de novo, com sucesso, o diretório cujo fsync tinha falhado');
    const [run] = await runsOf(s);
    const records = await ledgerRecords(w);
    assert.equal(run?.ledgerHead?.ledgerSeq, records.length, 'cita a cabeça atual do livro');
    assert.equal(run?.ledgerHead?.sha256, records[records.length - 1]?.contentSha256);

    // controle: o MESMO pedido de gravação recusado em (4) agora é aceito, então a recusa vinha só do travamento
    const accepted = await finalizer(s, disk.ops).decisions.create(ANA, w.auditId, body, clock);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  });
}

test('E6 chamada direta de syncDecisionDirectories: EIO em qualquer das pastas devolve STORAGE_FATAL e trava as bases de decisões e de recibos; com o disco saudável continua STORAGE_FATAL; só o restabelecimento libera (null)', async () => {
  for (const target of TARGETS) {
    const s = await stack();
    const { w } = s;
    const disk = eioOn(target.dirOf(w));
    const options = { fs: disk.ops, anchorDir: w.anchorDir };
    assert.equal(await syncDecisionDirectories(w.decisionsDir, w.auditId, options), null, `${target.label}: com o disco saudável a barreira de pastas passa`);
    assert.equal(isStorageFatal(w.decisionsDir) || isStorageFatal(w.anchorDir), false, `${target.label}: sem falha nada é travado`);
    disk.state.armed = true;
    const failed = await syncDecisionDirectories(w.decisionsDir, w.auditId, options);
    disk.state.armed = false;
    assert.equal(disk.state.hits, 1, `${target.label}: a falha foi injetada`);
    assert.equal(failed?.code, 'STORAGE_FATAL', `${target.label}: ${JSON.stringify(failed)}`);
    assert.equal(isStorageFatal(w.decisionsDir), true, `${target.label}: base de DECISÕES travada`);
    assert.equal(isStorageFatal(w.anchorDir), true, `${target.label}: base de RECIBOS travada`);
    const again = await syncDecisionDirectories(w.decisionsDir, w.auditId, options);
    assert.equal(again?.code, 'STORAGE_FATAL', `${target.label}: com o disco "saudável" a base continua travada até reiniciar`);
    clearStorageFatal(w.decisionsDir);
    clearStorageFatal(w.anchorDir);
    assert.equal(await syncDecisionDirectories(w.decisionsDir, w.auditId, options), null, `${target.label}: restabelecida a base, a barreira de pastas volta a passar`);
  }
});

test('E6 CONTRATO da barreira (chamada direta) com EIO no fsync das decisões ou dos recibos: DURABILITY_UNKNOWN (nunca ok), e com o disco "saudável" continua DURABILITY_UNKNOWN até reiniciar', async () => {
  for (const target of DIRECT_TARGETS) {
    const s = await stack();
    const { w } = s;
    const disk = eioOn(target.dirOf(w));
    const barrier = finalizer(s, disk.ops).decisions;
    disk.state.armed = true;
    const failed = await barrier.durabilityBarrier(OP_A, w.auditId, {});
    disk.state.armed = false;
    assert.equal(disk.state.hits, 1, `${target.label}: a falha foi injetada`);
    assert.deepEqual([failed.ok, failed.ok ? null : failed.code], [false, 'DURABILITY_UNKNOWN'], `${target.label}: ${JSON.stringify(failed)}`);
    const stillTripped = await barrier.durabilityBarrier(OP_A, w.auditId, {});
    assert.deepEqual([stillTripped.ok, stillTripped.ok ? null : stillTripped.code], [false, 'DURABILITY_UNKNOWN'], `${target.label}: com o disco "saudável" a base continua travada até reiniciar`);
    clearStorageFatal(w.decisionsDir);
    clearStorageFatal(w.anchorDir);
    assert.deepEqual(await barrier.durabilityBarrier(OP_A, w.auditId, {}), { ok: true }, `${target.label}: restabelecidas as bases, a barreira passa`);
  }
});
