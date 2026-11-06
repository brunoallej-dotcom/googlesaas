import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { LedgerPort } from '../src/lib/link-audit-decisions';
import { deriveCapacityPolicy, publishLedgerRecord, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, LEDGER_AUTH_A, makeRecord, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';
import { ledgerRecords } from './helpers/link-audit-ledger-fixtures';

/*
 * D1 (revisão independente nº 7c, 05/11/2026) — a reemissão de recibo "já registrada" era PULADA e devolvia sucesso sem sincronizar o livro: depois de uma falha de fsync na publicação do `RECEIPT_REISSUED` e
 * de um reinício, o reenvio concluía sem nunca provar o registro. Aqui: o cenário T3 do revisor (reinício REAL), a variante entre PROCESSOS (outro processo publicou a reemissão com fsync falho enquanto este
 * já tinha provado o livro), e MB2b — toda falha de fsync em RECOVER, replay, adoção e reemissão trava a base (nunca sucesso, nem na 2ª tentativa com o disco "saudável").
 */
registerCleanup();
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const logPath = (): string => path.join(tmpDir('lad-d1log-'), 'sync.log');
const auditDirOf = (w: LedgerWorld): string => path.join(w.ledgerDir, w.auditId);
/** FsOps que REGISTRA cada fsync de diretório bem-sucedido e, opcionalmente, falha (EIO) nos que `fail` escolher. */
const spyFs = (log: string[], fail: (dir: string) => boolean = () => false): FsOps =>
  faulty({
    async syncDirectory(dir) {
      if (fail(dir)) throw errno('EIO');
      await nodeFsOps.syncDirectory(dir);
      log.push(dir);
    },
  });

/** Auditoria com uma decisão confirmada cujo RECIBO foi removido (estado RECEIPT_REMOVED reemitível). */
async function receiptRemovedWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1));
  return w;
}

test('D1/T3 (reinício REAL): a reemissão é publicada mas o fsync do livro falha ⇒ sem sucesso; depois do reinício o reenvio só conclui DEPOIS de sincronizar o livro (pasta da auditoria E raiz), sem duplicar registro', async () => {
  const w = await receiptRemovedWorld();
  const failed = await runChild(w, null, { task: 'create', resend: true, failSync: 'ledger', failSyncWhenExists: 'l000004.json', actor: 'ana@empresa.com' });
  assert.equal(failed.line?.ok, false, `${JSON.stringify(failed.line)} ${failed.stderr.slice(0, 160)}`);
  assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RECEIPT_REISSUED'], 'a reemissão existe, a durabilidade dela é que é desconhecida');
  assert.ok(!fs.existsSync(anchorPath(w, 1)), 'o recibo NÃO foi regravado sobre um registro sem durabilidade');
  const log = logPath();
  const resumed = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(resumed.line?.ok, true, `${JSON.stringify(resumed.line)} ${resumed.stderr.slice(0, 200)}`);
  assert.ok(read(log).includes(auditDirOf(w)) && read(log).includes(w.ledgerDir), `a retomada sincronizou a pasta da auditoria e a raiz do livro (log: ${read(log).length} chamadas)`);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RECEIPT_REISSUED'], 'nenhum registro novo');
  assert.ok(fs.existsSync(anchorPath(w, 1)), 'o recibo foi recriado');
});

test('D1 entre PROCESSOS: OUTRO processo publicou o RECEIPT_REISSUED com o fsync falho enquanto este já tinha provado o livro — o reenvio daqui (caminho "já registrada") só tem sucesso DEPOIS de sincronizar o livro', async () => {
  const w = await receiptRemovedWorld();
  await must(w.rawProtected.list(BIA, w.auditId, clock())); // este processo já PROVOU o livro (leitura): nada mais o sincronizaria sozinho
  const other = await runChild(w, null, { task: 'create', resend: true, failSync: 'ledger', failSyncWhenExists: 'l000004.json', actor: 'ana@empresa.com' });
  assert.equal(other.line?.code, 'DECISIONS_DURABILITY_UNKNOWN');
  assert.equal((await ledgerEvents(w)).at(-1), 'RECEIPT_REISSUED');
  const log: string[] = [];
  const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: spyFs(log) }), knownHeads: NO_RESULTS });
  const result = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(result.ok, JSON.stringify(result).slice(0, 220));
  assert.ok(log.includes(auditDirOf(w)) && log.includes(w.ledgerDir), `o sucesso veio DEPOIS de sincronizar a pasta da auditoria e a raiz do livro (log: ${log.join(' | ')})`);
  assert.equal((await ledgerEvents(w)).filter((e) => e === 'RECEIPT_REISSUED').length, 1, 'sem duplicata');
});

test('D1: se o fsync do livro FALHA no caminho "reemissão já registrada", não há sucesso, o recibo não é regravado e a base trava (a 2ª tentativa, com o disco "saudável", também NÃO tem sucesso até reiniciar)', async () => {
  const w = await receiptRemovedWorld();
  await must(w.rawProtected.list(BIA, w.auditId, clock()));
  await runChild(w, null, { task: 'create', resend: true, failSync: 'ledger', failSyncWhenExists: 'l000004.json', actor: 'ana@empresa.com' });
  let fail = true;
  const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: spyFs([], (dir) => fail && dir === auditDirOf(w)) }), knownHeads: NO_RESULTS });
  const first = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(first).slice(0, 200));
  assert.ok(!fs.existsSync(anchorPath(w, 1)), 'o recibo não foi regravado');
  fail = false;
  const second = await svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `base travada: ${JSON.stringify(second).slice(0, 200)}`);
  clearStorageFatal(); // "reiniciar"
  const third = await decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(third.ok, JSON.stringify(third).slice(0, 200));
});

/* ============================================================================ MB2b — toda falha de fsync trava a base */
/** Mundo com UMA decisão confirmada, já PROVADO (uma leitura passou), e um FsOps que falha no fsync da pasta da auditoria do livro quando `armed`. */
async function armedWorld() {
  const state = { armed: false, log: [] as string[] };
  let auditDir = '';
  const ledgerFs = spyFs(state.log, (dir) => state.armed && dir === auditDir);
  const w = await ledgerWorld({ ledgerFs });
  auditDir = auditDirOf(w);
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.rawProtected.list(BIA, w.auditId, clock()));
  return { w, state };
}

test('MB2b/RECOVER: a falha de fsync trava a base — a 2ª chamada com o disco "saudável" NÃO tem sucesso; reiniciado, o RECOVER prova o livro de novo e conclui', async () => {
  const { w, state } = await armedWorld();
  state.armed = true;
  const first = await w.rawProtected.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(first).slice(0, 200));
  state.armed = false;
  const second = await w.rawProtected.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `2ª: ${JSON.stringify(second).slice(0, 200)}`);
  clearStorageFatal();
  state.log.length = 0;
  const third = await w.rawProtected.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock);
  assert.ok(third.ok, JSON.stringify(third).slice(0, 200));
  assert.ok(state.log.includes(auditDirOf(w)), 'reiniciado: o livro foi provado de novo');
});

test('MB2b/REPLAY de entrada já confirmada: a falha de fsync do livro trava a base — reenvio com o disco "saudável" NÃO tem sucesso; reiniciado, conclui sem duplicar', async () => {
  const { w, state } = await armedWorld();
  const body = { record: rec.c2(), expectedHead: null };
  state.armed = true;
  const first = await w.rawProtected.create(ANA, w.auditId, body, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(first).slice(0, 200));
  state.armed = false;
  const second = await w.rawProtected.create(ANA, w.auditId, body, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `2ª: ${JSON.stringify(second).slice(0, 200)}`);
  clearStorageFatal();
  const third = await w.rawProtected.create(ANA, w.auditId, body, clock);
  assert.ok(third.ok && third.value.replayed === true, JSON.stringify(third).slice(0, 200));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'sem duplicata');
});

test('MB2b/ADOÇÃO de CONFIRMED de outro processo: a falha de fsync do próprio dono trava a base — a 2ª tentativa NÃO tem sucesso', async () => {
  const state = { armed: false };
  let auditDir = '';
  const ledgerFs = spyFs([], (dir) => state.armed && dir === auditDir);
  const w = await ledgerWorld({ ledgerFs });
  auditDir = auditDirOf(w);
  const inner = ledgerFor(w, { guard: null, fs: ledgerFs });
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'confirmed'
        ? async (input: Parameters<LedgerPort['confirmed']>[0]) => {
            const records = await ledgerRecords(w);
            const intent = records[records.length - 1] as LedgerRecord;
            const op = intent.op as NonNullable<LedgerRecord['op']>;
            const concurrent = makeRecord(LEDGER_AUTH_A, w.auditId, intent, { event: 'CONFIRMED', recordedAt: intent.recordedAt, actor: 'bia@empresa.com', op: { ...op, intentSeq: intent.ledgerSeq, anchorRef: { name: 'a0001.json', headSha256: op.newDecisionsHead.sha256 } } });
            assert.ok((await publishLedgerRecord(w.ledgerDir, concurrent)).ok); // "outro processo" conclui o MESMO CONFIRMED
            state.armed = true;
            return target.confirmed(input);
          }
        : Reflect.get(target, key),
  });
  const owner = decisionsOver(w, { ledger: port, knownHeads: NO_RESULTS });
  const first = await owner.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', JSON.stringify(first).slice(0, 200));
  state.armed = false;
  const second = await owner.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `2ª: ${JSON.stringify(second).slice(0, 200)}`);
});

/* ============================================================================ item 4 — reinício NÃO é comprovação: a leitura revalida antes de voltar a PROTECTED */
test('REINÍCIO não é comprovação: depois de um fsync que falhou, o processo novo só lê o livro como PROTECTED DEPOIS de sincronizar a pasta da auditoria e a raiz (uma leitura sincroniza); se o fsync ainda falha, a leitura fica DURABILITY_UNKNOWN', async () => {
  const w = await ledgerWorld();
  const failed = await runChild(w, null, { task: 'create', failSync: 'ledger', failSyncWhenExists: 'l000003.json', actor: 'ana@empresa.com' });
  assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'o CONFIRMED existe; a durabilidade dele é desconhecida');
  // reinício com o disco AINDA sem sincronizar: a LEITURA não pode dizer PROTECTED
  const stillBroken = await runChild(w, null, { task: 'list', failSync: 'ledger', actor: 'ana@empresa.com' });
  assert.deepEqual([stillBroken.line?.ok, stillBroken.line?.state, stillBroken.line?.reason, stillBroken.line?.finalizable], [true, 'HISTORY_UNRESOLVED', 'DURABILITY_UNKNOWN', false], JSON.stringify(stillBroken.line));
  // reinício com o disco saudável: a leitura PROVA (sincroniza) e só então volta a PROTECTED
  const log = logPath();
  const healthy = await runChild(w, null, { task: 'list', syncLog: log, actor: 'ana@empresa.com' });
  assert.deepEqual([healthy.line?.state, healthy.line?.reason], ['PROTECTED', null], JSON.stringify(healthy.line));
  assert.ok(read(log).includes(auditDirOf(w)) && read(log).includes(w.ledgerDir), `a leitura sincronizou a pasta da auditoria e a raiz antes de declarar PROTECTED (log: ${read(log).length} chamadas)`);
});

test('a revalidação é UMA vez por processo e auditoria: o livro foi gravado por OUTRO processo, a primeira leitura daqui sincroniza (prova) e as seguintes não sincronizam de novo (custo); um reinício (esquecer as provas) exige provar de novo ANTES de ler como protegido', async () => {
  const w = await ledgerWorld();
  const created = await runChild(w, null, { task: 'create', actor: 'ana@empresa.com' }); // os registros foram publicados por outro processo: aqui NADA foi provado ainda
  assert.equal(created.line?.ok, true);
  clearStorageFatal(); // este processo (que inscreveu a auditoria) passa a valer como um processo NOVO: nenhuma prova de durabilidade
  const log: string[] = [];
  const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: spyFs(log) }), knownHeads: NO_RESULTS });
  const first = await must(svc.list(BIA, w.auditId, clock()));
  assert.equal(first.ledger.state, 'PROTECTED');
  assert.ok(log.includes(auditDirOf(w)) && log.includes(w.ledgerDir), `a primeira leitura provou o livro (log: ${log.length} chamadas)`);
  log.length = 0;
  await must(svc.list(BIA, w.auditId, clock()));
  await must(svc.list(BIA, w.auditId, clock()));
  assert.equal(log.length, 0, 'leituras seguintes não sincronizam');
  clearStorageFatal(); // "reiniciar": as provas são esquecidas
  await must(svc.list(BIA, w.auditId, clock()));
  assert.ok(log.includes(auditDirOf(w)) && log.includes(w.ledgerDir), 'depois do reinício a LEITURA prova de novo antes de dizer PROTECTED');
});

/* ============================================================================ D3 — reemissões de recibos DISTINTOS e a reserva de revogação */
test('D3: uma reemissão de recibo depois de CADA revogação (recibos distintos) não pode reduzir as revogações reservadas — as R revogações reservadas continuam executáveis mesmo sob esse ataque', async () => {
  const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
  const reserved = 5;
  const policy = deriveCapacityPolicy(72, reserved, 8);
  const w = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8 });
  const svc = w.protectedService;
  for (const record of [rec.c2(), rec.c3(), rec.p3(5), rec.naModel(), rec.naFeature()]) await must(svc.create(ANA, w.auditId, { record }, clock()));
  // enche com substituições até as decisões novas se esgotarem (sobra a reserva de revogação)
  for (let round = 0; round < 200; round += 1) {
    const view = await must(svc.list(BIA, w.auditId, clock()));
    if ((view.ledger.capacity?.decisionsAvailable ?? 0) === 0) break;
    const target = view.decisions.find((d) => d.record.kind === 'JUDGEMENT' && (d.record as { subcriterionId?: string }).subcriterionId === 'C2');
    if (!target) break;
    await must(svc.create(ANA, w.auditId, { record: rec.c2(round % 2 === 0 ? 'INCOMPATIBLE' : 'COMPATIBLE'), supersedes: target.decisionId, expectedHead: view.head }, clock()));
  }
  const atStart = await must(svc.list(BIA, w.auditId, clock()));
  assert.equal(atStart.ledger.capacity?.decisionsAvailable, 0, 'decisões novas encerradas');
  assert.ok((atStart.ledger.capacity?.revocationsAvailable ?? 0) >= reserved, `a vista anuncia ao menos as ${reserved} reservadas (${atStart.ledger.capacity?.revocationsAvailable})`);
  // ATAQUE: cada revogação é seguida da remoção do recibo dela e do reenvio do autor (RECEIPT_REISSUED), uma por revogação
  let completed = 0;
  for (let round = 0; round < reserved + 3; round += 1) {
    const view = await must(svc.list(BIA, w.auditId, clock()));
    const target = view.decisions[0];
    if (!target) break;
    const revoked = await svc.revoke(ANA, w.auditId, { revokes: target.decisionId, reason: REASON, expectedHead: view.head }, clock());
    if (!revoked.ok) break;
    completed += 1;
    const afterRevoke = await must(svc.list(BIA, w.auditId, clock()));
    fs.rmSync(anchorPath(w, afterRevoke.history.length));
    const pending = await must(svc.list(BIA, w.auditId, clock()));
    const resent = await svc.revoke(ANA, w.auditId, { revokes: target.decisionId, reason: REASON, expectedHead: pending.head }, clock());
    assert.ok(resent.ok, `reemissão ${completed}: ${JSON.stringify(resent).slice(0, 200)}`);
  }
  assert.ok(completed >= reserved, `${completed} revogações completas sob o ataque; as ${reserved} reservadas têm de caber (${(await ledgerEvents(w)).length} registros)`);
});
