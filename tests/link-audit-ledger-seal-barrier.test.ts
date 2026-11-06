import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { LedgerPort } from '../src/lib/link-audit-decisions';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A } from './helpers/link-audit-results-fixtures';
import { resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * BARREIRA DE DURABILIDADE ANTES DE SELAR um resultado que cita `ledgerHead` (aprovada em 05/11/2026). A finalização só sela quando: o livro está PROTEGIDO e a cabeça citada é a avaliada; o livro (pasta da
 * auditoria e raiz), as decisões, os recibos e os diretórios-pai foram sincronizados DEPOIS de lidas as cabeças; e uma releitura mostra EXATAMENTE as mesmas cabeças (nenhuma gravação concorrente mudou o estado
 * nem travou a base entre a verificação e o selamento). Qualquer dúvida ⇒ nada é selado. Aqui: sincronização, falha, TOCTOU construído, reinício real e processos concorrentes.
 */
registerCleanup();
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const logPath = (): string => path.join(tmpDir('lad-seal-'), 'sync.log');
const auditDirOf = (w: LedgerWorld): string => path.join(w.ledgerDir, w.auditId);
const spyFs = (log: string[], fail: (dir: string) => boolean = () => false): FsOps =>
  faulty({
    async syncDirectory(dir) {
      if (fail(dir)) throw errno('EIO');
      await nodeFsOps.syncDirectory(dir);
      log.push(dir);
    },
  });

interface Stack {
  readonly w: LedgerWorld;
  readonly e: ResultsEnv;
}
async function stack(): Promise<Stack> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.rawProtected.list(BIA, w.auditId, clock())); // livro já PROVADO neste processo: só a barreira sincroniza dali em diante
  return { w, e };
}
/** Serviços de decisões, prévia e resultados sobre as pastas do mundo, com `FsOps` e porta do livro à escolha; devolve a finalização pronta para rodar. */
function finalizer(s: Stack, over: { ledgerFs?: FsOps; decisionsFs?: FsOps; port?: LedgerPort; resultsFs?: FsOps } = {}) {
  const ledger = over.port ?? ledgerFor(s.w, { guard: null, ...(over.ledgerFs ? { fs: over.ledgerFs } : {}) });
  const decisions = decisionsOver(s.w, { ledger, knownHeads: witnessOver(s.w, s.e), ...(over.decisionsFs ? { fs: over.decisionsFs } : {}) });
  const preview = previewOver({ evidenceDir: s.w.evidenceDir, raw: decisions });
  const results = makeService(s.e, preview, over.resultsFs ? { fs: over.resultsFs } : {});
  return {
    preview,
    results,
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

test('BARREIRA: antes de selar, o livro (pasta da auditoria E raiz), as decisões, os recibos e os diretórios-pai são sincronizados — e o resultado selado cita a cabeça que foi sincronizada', async () => {
  const s = await stack();
  const log: string[] = [];
  const spy = spyFs(log);
  const outcome = await finalizer(s, { ledgerFs: spy, decisionsFs: spy }).run();
  assert.deepEqual([outcome.ok, outcome.code], [true, null], JSON.stringify(outcome));
  const expected = [auditDirOf(s.w), s.w.ledgerDir, path.join(s.w.decisionsDir, s.w.auditId), path.join(s.w.anchorDir, s.w.auditId), s.w.decisionsDir, s.w.anchorDir];
  for (const dir of expected) assert.ok(log.includes(dir), `a barreira sincronizou ${path.basename(dir)} (log: ${log.map((d) => path.basename(d)).join(', ')})`);
  const [run] = await runsOf(s);
  const records = await ledgerRecords(s.w);
  assert.equal(run?.ledgerHead?.ledgerSeq, records.length, 'cita a cabeça atual do livro');
  assert.equal(run?.ledgerHead?.sha256, records[records.length - 1]?.contentSha256);
});

test('BARREIRA com falha de fsync: nada é selado (RESULT_DURABILITY_UNKNOWN), a 2ª finalização com o disco "saudável" TAMBÉM não sela (base travada), e reiniciado o resultado sai citando a cabeça comprovada', async () => {
  const s = await stack();
  let armed = false;
  const ledgerFs = spyFs([], (dir) => armed && dir === auditDirOf(s.w));
  const f = finalizer(s, { ledgerFs });
  armed = true;
  const first = await f.run();
  assert.deepEqual([first.ok, first.code], [false, 'RESULT_DURABILITY_UNKNOWN'], JSON.stringify(first));
  assert.deepEqual(await runsOf(s), [], 'nenhum resultado selado');
  armed = false;
  const second = await finalizer(s, { ledgerFs }).run();
  assert.equal(second.ok, false, `base travada: ${JSON.stringify(second)}`);
  assert.deepEqual(await runsOf(s), [], 'nenhum resultado selado depois da falha, mesmo com o disco "saudável"');
  clearStorageFatal(); // "reiniciar"
  const third = await finalizer(s).run();
  assert.equal(third.ok, true, JSON.stringify(third));
  const [run] = await runsOf(s);
  assert.ok(run?.ledgerHead, 'o resultado cita o livro');
});

test('BARREIRA sem janela TOCTOU: uma gravação CONCORRENTE entre a primeira leitura e a releitura da barreira muda a cabeça ⇒ nada é selado (INPUT_CHANGED); a nova finalização sela citando a cabeça NOVA', async () => {
  const s = await stack();
  let fired = false;
  const inner = ledgerFor(s.w, { guard: null });
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'sync'
        ? async (auditId: string) => {
            if (!fired) {
              fired = true;
              await must(s.w.protectedService.create(ANA, s.w.auditId, { record: rec.naModel() }, clock())); // "outro processo" grava no meio da barreira
            }
            return target.sync(auditId);
          }
        : Reflect.get(target, key),
  });
  const first = await finalizer(s, { port }).run();
  assert.deepEqual([first.ok, first.code], [false, 'INPUT_CHANGED'], JSON.stringify(first));
  assert.deepEqual(await runsOf(s), [], 'nenhum resultado selado sobre um estado que mudou durante a barreira');
  assert.equal(fired, true);
  const second = await finalizer(s).run();
  assert.equal(second.ok, true, JSON.stringify(second));
  const [run] = await runsOf(s);
  const records = await ledgerRecords(s.w);
  assert.equal(run?.ledgerHead?.ledgerSeq, records.length, 'a cabeça citada é a nova');
  assert.equal(run?.decisions.count, 2, 'e as duas decisões estão no resultado');
});

test('CONCLUIR um resultado PENDENTE que cita o livro também passa pela barreira: com a durabilidade do livro não comprovada o recibo NÃO é dado; saudável, é concluído', async () => {
  const s = await stack();
  let failReceipts = true;
  const resultsFs = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.startsWith(s.e.anchors)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const pending = await finalizer(s, { resultsFs }).run();
  assert.deepEqual([pending.ok, pending.code], [false, 'RESULT_ANCHOR_PENDING'], JSON.stringify(pending));
  failReceipts = false;
  let armed = true;
  const ledgerFs = spyFs([], (dir) => armed && dir === auditDirOf(s.w));
  const blocked = await finalizer(s, { resultsFs, ledgerFs }).run();
  assert.deepEqual([blocked.ok, blocked.code], [false, 'RESULT_DURABILITY_UNKNOWN'], JSON.stringify(blocked));
  assert.equal((await runsOf(s)).length, 0, 'o recibo não foi dado');
  armed = false;
  clearStorageFatal();
  const concluded = await finalizer(s, { resultsFs }).run();
  assert.equal(concluded.ok, true, JSON.stringify(concluded));
  assert.equal((await runsOf(s)).length, 1);
});

test('REINÍCIO REAL: o CONFIRMED foi publicado com o fsync falho; o processo novo só sela um resultado DEPOIS de provar o livro (log de fsync) — e com o fsync ainda falhando NADA é selado', async () => {
  for (const stillFailing of [false, true]) {
    const w = await ledgerWorld();
    const e = resultsEnv();
    const failed = await runChild(w, e, { task: 'create', failSync: 'ledger', failSyncWhenExists: 'l000003.json', actor: 'ana@empresa.com', nowIso: clock() }); // hora da fixture: a decisão não pode ser "do futuro" para a prévia (relógio fixo)
    assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(failed.line));
    assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'o CONFIRMED existe; a durabilidade dele é desconhecida');
    const log = logPath();
    const sealed = await runChild(w, e, { task: 'finalize', actor: 'ana@empresa.com', ...(stillFailing ? { failSync: 'ledger' } : { syncLog: log }) });
    const runs = await runsOf({ w, e });
    if (stillFailing) {
      assert.equal(sealed.line?.ok, false, `com o fsync ainda falhando nada é selado: ${JSON.stringify(sealed.line)} ${sealed.stderr.slice(0, 160)}`);
      assert.equal(runs.length, 0, 'nenhum resultado selado');
    } else {
      assert.equal(sealed.line?.ok, true, `${JSON.stringify(sealed.line)} ${sealed.stderr.slice(0, 200)}`);
      assert.ok(read(log).includes(auditDirOf(w)) && read(log).includes(w.ledgerDir), `o livro foi provado (pasta da auditoria e raiz) antes do selamento (log: ${read(log).length} chamadas)`);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.ledgerHead?.ledgerSeq, 3, 'cita o CONFIRMED que foi provado');
    }
  }
});

test('PROCESSOS concorrentes: dois gravadores (criar + revogar) e a finalização rodando juntos — todo resultado selado cita uma cabeça que existe na cadeia do livro e a relação ledgerHead × decisionsHead × resultado é consistente', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const s: Stack = { w, e };
  const TRANSIENT = new Set(['HEAD_MISMATCH', 'INPUT_CHANGED', 'NOT_FINALIZABLE', 'READ_INCONSISTENT', 'RESULT_WRITE_CONFLICT', 'RESULT_PENDING_UNCONFIRMED', 'DECISIONS_HISTORY_UNRESOLVED']);
  const writers = [1, 2].map((worker) => runChild(w, e, { task: 'workload', worker, rounds: 3, actor: worker === 1 ? 'ana@empresa.com' : 'bia@empresa.com', nowIso: clock() }));
  const finalizeLoop = async (): Promise<string[]> => {
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const outcome = await finalizer(s).run();
      outcomes.push(outcome.ok ? 'ok' : String(outcome.code));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return outcomes;
  };
  const [first, second, outcomes] = await Promise.all([writers[0] as Promise<Awaited<ReturnType<typeof runChild>>>, writers[1] as Promise<Awaited<ReturnType<typeof runChild>>>, finalizeLoop()]);
  for (const writer of [first, second]) assert.deepEqual((writer.line as { fatal?: string[] } | null)?.fatal ?? ['sem resposta'], [], `gravador: ${JSON.stringify(writer.line)} ${writer.stderr.slice(0, 160)}`);
  for (const outcome of outcomes) assert.ok(outcome === 'ok' || TRANSIENT.has(outcome), `finalização com resposta inesperada: ${outcome}`);
  const settled = await finalizer(s).run();
  assert.ok(settled.ok || settled.code === 'HEAD_MISMATCH' || settled.code === 'INPUT_CHANGED' || settled.code === 'NOT_FINALIZABLE', JSON.stringify(settled));
  const runs = await runsOf(s);
  assert.ok(runs.length >= 1, `ao menos um resultado selado (resultados das tentativas: ${outcomes.join(',')})`);
  const records = await ledgerRecords(w);
  for (const run of runs) {
    const head = run.ledgerHead;
    assert.ok(head, `resultado ${run.seq} cita o livro`);
    assert.equal(records[head.ledgerSeq - 1]?.contentSha256, head.sha256, `a cabeça citada (${head.ledgerSeq}) existe na cadeia do livro`);
    const confirmed = records.slice(0, head.ledgerSeq).filter((record) => record.event === 'CONFIRMED').at(-1);
    assert.deepEqual(run.decisions.head === null ? null : { seq: run.decisions.head.seq, sha256: run.decisions.head.sha256 }, confirmed?.op ? { seq: confirmed.op.newDecisionsHead.seq, sha256: confirmed.op.newDecisionsHead.sha256 } : null, `resultado ${run.seq}: decisionsHead = última decisão confirmada até a cabeça citada`);
  }
});

test('CONTRATO da barreira (chamada direta): só `ok` com exatamente as cabeças avaliadas; cabeça de decisões ou do livro diferente, operação aberta ou base travada ⇒ nunca `ok`', async () => {
  const s = await stack();
  const decisions = decisionsOver(s.w, { ledger: ledgerFor(s.w, { guard: null }), knownHeads: witnessOver(s.w, s.e) });
  const view = await must(decisions.list(BIA, s.w.auditId, clock()));
  const ledgerHead = { ledgerSeq: view.ledger.head!.ledgerSeq, sha256: view.ledger.head!.sha256 };
  const exact = await decisions.durabilityBarrier(OP_A, s.w.auditId, { decisionsHead: view.head, ledgerHead });
  assert.deepEqual(exact, { ok: true });
  assert.deepEqual(await decisions.durabilityBarrier(OP_A, s.w.auditId, {}), { ok: true }, 'sem cabeças esperadas só prova a durabilidade e a proteção (conclusão de pendente)');
  const wrongDecisions = await decisions.durabilityBarrier(OP_A, s.w.auditId, { decisionsHead: { seq: 99, sha256: 'a'.repeat(64) }, ledgerHead });
  assert.deepEqual([wrongDecisions.ok, wrongDecisions.ok ? null : wrongDecisions.code], [false, 'INPUT_CHANGED']);
  const wrongLedger = await decisions.durabilityBarrier(OP_A, s.w.auditId, { decisionsHead: view.head, ledgerHead: { ledgerSeq: ledgerHead.ledgerSeq, sha256: 'b'.repeat(64) } });
  assert.deepEqual([wrongLedger.ok, wrongLedger.ok ? null : wrongLedger.code], [false, 'INPUT_CHANGED'], 'mesma cabeça de decisões, cabeça do livro diferente');
  const nullLedger = await decisions.durabilityBarrier(OP_A, s.w.auditId, { decisionsHead: view.head, ledgerHead: null });
  assert.equal(nullLedger.ok, false, 'esperar "nenhuma cabeça" num livro que tem cabeça não é consistente');
  // operação aberta (decisão publicada sem recibo) ⇒ o livro não está em estado de selar
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(s.w.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  await decisionsOver(s.w, { ledger: ledgerFor(s.w, { guard: null }), knownHeads: witnessOver(s.w, s.e), fs: noReceipts }).create(ANA, s.w.auditId, { record: rec.naModel(), expectedHead: view.head }, clock);
  const open = await decisions.durabilityBarrier(OP_A, s.w.auditId, { decisionsHead: view.head, ledgerHead });
  assert.deepEqual([open.ok, open.ok ? null : open.code], [false, 'INPUT_CHANGED'], 'com operação aberta nada é selado');
  const openAnyHead = await decisions.durabilityBarrier(OP_A, s.w.auditId, {});
  assert.deepEqual([openAnyHead.ok, openAnyHead.ok ? null : openAnyHead.code], [false, 'INPUT_CHANGED'], 'mesmo sem cabeças esperadas, operação aberta/pendente nunca passa na barreira (conclusão de pendente)');
});

test('CONTRATO da barreira com a base TRAVADA: DURABILITY_UNKNOWN (nunca ok, nunca INPUT_CHANGED), com a causa dita', async () => {
  const s = await stack();
  let armed = false;
  const ledgerFs = spyFs([], (dir) => armed && dir === auditDirOf(s.w));
  const decisions = decisionsOver(s.w, { ledger: ledgerFor(s.w, { guard: null, fs: ledgerFs }), knownHeads: witnessOver(s.w, s.e) });
  armed = true;
  const failed = await decisions.durabilityBarrier(OP_A, s.w.auditId, {});
  assert.deepEqual([failed.ok, failed.ok ? null : failed.code], [false, 'DURABILITY_UNKNOWN']);
  armed = false;
  const stillTripped = await decisions.durabilityBarrier(OP_A, s.w.auditId, {});
  assert.deepEqual([stillTripped.ok, stillTripped.ok ? null : stillTripped.code], [false, 'DURABILITY_UNKNOWN'], 'com o disco "saudável" a base continua travada até reiniciar');
});
