import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { replayLedger } from '../src/lib/link-audit-ledger';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFiles, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * QUEDA (SIGKILL de VERDADE, em processo filho) antes e depois de CADA etapa de escrita, mais falhas de disco. Para cada ponto: o que sobra no disco,
 * o que é bloqueado até a recuperação, a recuperação VERIFICÁVEL e o estado final (uma só decisão, livro encadeado, nada duplicado). Nada é
 * recuperado "no escuro": só o que o livro, a decisão e o recibo provam juntos.
 */
registerCleanup();
const ROOT = path.resolve(__dirname, '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'ledger-child.ts');
const T_SERVER = '2026-10-21T12:00:00.000Z';

interface ChildResult {
  readonly killed: boolean;
  readonly status: number | null;
  readonly line: Record<string, unknown> | null;
  readonly stderr: string;
}
function runChild(w: LedgerWorld, config: Record<string, unknown>): ChildResult {
  const payload = { decisionsDir: w.decisionsDir, anchorDir: w.anchorDir, evidenceDir: w.evidenceDir, ledgerDir: w.ledgerDir, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: T_SERVER, ...config };
  const run = spawnSync(process.execPath, ['--require', REGISTER, CHILD], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LEDGER_CHILD: JSON.stringify(payload) } as unknown as NodeJS.ProcessEnv });
  const last = run.stdout?.trim().split('\n').pop() ?? '';
  return { killed: run.signal === 'SIGKILL', status: run.status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: run.stderr ?? '' };
}
const fresh = (w: LedgerWorld, over: Parameters<typeof ledgerFor>[1] = {}) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, pollMs: 1, ...over }), knownHeads: NO_RESULTS });

interface Point {
  readonly label: string;
  readonly crash: { at: 'before' | 'after' | 'after-temp'; match: string };
  /** O que sobra: eventos do livro, entrada publicada, recibo, e o estado visto por quem lê. */
  readonly events: readonly string[];
  readonly entry: boolean;
  readonly receipt: boolean;
  readonly state: 'PROTECTED' | 'HISTORY_UNRESOLVED';
  readonly reason: string | null;
  readonly phase: 'A' | 'B' | 'C' | null;
  readonly vigente: boolean;
  /** Eventos finais depois da recuperação pelo AUTOR (reenvio do mesmo pedido). */
  readonly finalEvents: readonly string[];
}
const CLEAN = ['GENESIS', 'INTENT', 'CONFIRMED'];
const POINTS: readonly Point[] = [
  { label: 'ANTES do INTENT', crash: { at: 'before', match: '/l000002.json' }, events: ['GENESIS'], entry: false, receipt: false, state: 'PROTECTED', reason: null, phase: null, vigente: false, finalEvents: CLEAN },
  { label: 'INTENT só no temporário (nunca publicado)', crash: { at: 'after-temp', match: 'l000002.json' }, events: ['GENESIS'], entry: false, receipt: false, state: 'PROTECTED', reason: null, phase: null, vigente: false, finalEvents: CLEAN },
  { label: 'DEPOIS do INTENT, antes da decisão', crash: { at: 'after', match: '/l000002.json' }, events: ['GENESIS', 'INTENT'], entry: false, receipt: false, state: 'PROTECTED', reason: null, phase: 'A', vigente: false, finalEvents: ['GENESIS', 'INTENT', 'ABORTED', 'INTENT', 'CONFIRMED'] },
  { label: 'ANTES de publicar a decisão', crash: { at: 'before', match: '/d0001.json' }, events: ['GENESIS', 'INTENT'], entry: false, receipt: false, state: 'PROTECTED', reason: null, phase: 'A', vigente: false, finalEvents: ['GENESIS', 'INTENT', 'ABORTED', 'INTENT', 'CONFIRMED'] },
  { label: 'DEPOIS da decisão, antes do recibo', crash: { at: 'after', match: '/d0001.json' }, events: ['GENESIS', 'INTENT'], entry: true, receipt: false, state: 'PROTECTED', reason: null, phase: 'B', vigente: false, finalEvents: CLEAN },
  { label: 'ANTES do recibo', crash: { at: 'before', match: '/a0001.json' }, events: ['GENESIS', 'INTENT'], entry: true, receipt: false, state: 'PROTECTED', reason: null, phase: 'B', vigente: false, finalEvents: CLEAN },
  { label: 'DEPOIS do recibo, antes do CONFIRMED', crash: { at: 'after', match: '/a0001.json' }, events: ['GENESIS', 'INTENT'], entry: true, receipt: true, state: 'HISTORY_UNRESOLVED', reason: 'LEDGER_BEHIND', phase: 'C', vigente: false, finalEvents: CLEAN },
  { label: 'ANTES do CONFIRMED', crash: { at: 'before', match: '/l000003.json' }, events: ['GENESIS', 'INTENT'], entry: true, receipt: true, state: 'HISTORY_UNRESOLVED', reason: 'LEDGER_BEHIND', phase: 'C', vigente: false, finalEvents: CLEAN },
  { label: 'DEPOIS do CONFIRMED, antes da resposta', crash: { at: 'after', match: '/l000003.json' }, events: CLEAN, entry: true, receipt: true, state: 'PROTECTED', reason: null, phase: null, vigente: true, finalEvents: CLEAN },
];

for (const point of POINTS) {
  test(`SIGKILL ${point.label}: o que sobra, o que fica bloqueado, a recuperação verificável e o estado final sem duplicar`, async () => {
    const w = await ledgerWorld();
    const run = runChild(w, { task: 'create', crash: point.crash });
    assert.ok(run.killed && run.status === null, `o filho tem de morrer por SIGKILL (status ${run.status}, stderr ${run.stderr.slice(0, 200)})`);
    // 1) o que sobrou no disco
    assert.deepEqual(await ledgerEvents(w), point.events, 'livro');
    assert.equal(fs.existsSync(entryPath(w, 1)), point.entry, 'decisão publicada');
    assert.equal(fs.existsSync(anchorPath(w, 1)), point.receipt, 'recibo');
    // 2) o que um leitor (outro processo, reinício) enxerga: nunca vigente por engano
    const view = await must(fresh(w).list(BIA, w.auditId, T_SERVER));
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.openOperation?.phase ?? null], [point.state, point.reason, point.phase]);
    assert.equal(view.decisions.length === 1, point.vigente, 'só é vigente o que está COMPLETO (INTENT, decisão, recibo e CONFIRMED)');
    assert.equal(view.finalizable, point.state === 'PROTECTED' && point.phase === null, 'finalizável só sem operação aberta, pendente nem livro atrasado');
    // 3) uma operação incompatível de OUTRO operador não passa por cima do que ficou no meio
    if (point.phase === 'A') {
      const other = await fresh(w, { staleOperationMs: 3_600_000 }).create(BIA, w.auditId, { record: rec.c3(), expectedHead: view.head }, T_SERVER);
      assert.ok(!other.ok && other.code === 'LEDGER_OPERATION_IN_PROGRESS', JSON.stringify(other).slice(0, 160));
    }
    if (point.phase === 'B') {
      const other = await fresh(w).create(BIA, w.auditId, { record: rec.c3(), expectedHead: view.head }, T_SERVER);
      assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED', JSON.stringify(other).slice(0, 160));
    }
    // 4) recuperação pelo AUTOR: reenvia o MESMO pedido (a fase A só depois de a operação aberta VENCER)
    let clockNow = T_SERVER;
    if (point.phase === 'A') clockNow = '2026-10-21T12:10:00.000Z';
    const again = await must(fresh(w, { staleOperationMs: 60_000 }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clockNow));
    assert.equal(again.decision.decisionId, 'op-0001');
    // 5) estado final: uma só decisão, livro encadeado e coerente, nada duplicado
    const done = await must(fresh(w).list(BIA, w.auditId, clockNow));
    assert.deepEqual([done.ledger.state, done.ledger.confirmedDecisions, done.decisions.map((d) => d.decisionId), done.finalizable], ['PROTECTED', 1, ['op-0001'], true]);
    assert.deepEqual(await ledgerEvents(w), point.finalEvents);
    assert.equal(replayLedger(await ledgerRecords(w), w.auditId).ok, true);
    assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).filter((n) => /^d\d{4}\.json$/.test(n)).length, 1);
  });
}

test('SIGKILL durante a INSCRIÇÃO: antes do GENESIS a auditoria segue pedindo inscrição; depois, está protegida; reexecutar é seguro', async () => {
  const before = await ledgerWorld({ enroll: false });
  assert.ok(runChild(before, { task: 'enroll', crash: { at: 'before', match: '/l000001.json' } }).killed);
  assert.equal((await must(fresh(before).list(ANA, before.auditId))).ledger.state, 'ENROLLMENT_PENDING');
  assert.equal(runChild(before, { task: 'enroll' }).line?.ok, true);
  assert.deepEqual(await ledgerEvents(before), ['GENESIS']);
  const after = await ledgerWorld({ enroll: false });
  assert.ok(runChild(after, { task: 'enroll', crash: { at: 'after', match: '/l000001.json' } }).killed);
  assert.equal((await must(fresh(after).list(ANA, after.auditId))).ledger.state, 'PROTECTED');
  const twice = await fresh(after).ledgerAction(ANA, after.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!twice.ok && twice.code === 'LEDGER_ACTION_INVALID', 'não duplica o GENESIS');
  assert.deepEqual(await ledgerEvents(after), ['GENESIS']);
});

test('SIGKILL DURANTE a recuperação: a recuperação é idempotente — morrer antes ou depois de gravar o CONFIRMED/ABORTED e repetir converge para o mesmo estado', async () => {
  // (a) fase C: o CONFIRMED que faltou é gravado pela recuperação
  const c = await ledgerWorld();
  assert.ok(runChild(c, { task: 'create', crash: { at: 'before', match: '/l000003.json' } }).killed);
  assert.ok(runChild(c, { task: 'recover', crash: { at: 'before', match: '/l000003.json' } }).killed);
  assert.deepEqual(await ledgerEvents(c), ['GENESIS', 'INTENT'], 'morreu antes de gravar: nada mudou');
  assert.ok(runChild(c, { task: 'recover', crash: { at: 'after', match: '/l000003.json' } }).killed);
  assert.deepEqual(await ledgerEvents(c), CLEAN, 'morreu depois de gravar: já está feito');
  assert.equal(runChild(c, { task: 'recover' }).line?.ok, true, 'repetir não faz nada de novo');
  assert.deepEqual(await ledgerEvents(c), CLEAN);
  assert.equal((await must(fresh(c).list(BIA, c.auditId))).ledger.state, 'PROTECTED');
  // (b) fase A vencida: o ABORTED é gravado pela recuperação
  const a = await ledgerWorld();
  assert.ok(runChild(a, { task: 'create', crash: { at: 'after', match: '/l000002.json' } }).killed);
  const late = '2026-10-21T12:30:00.000Z';
  assert.ok(runChild(a, { task: 'recover', staleOperationMs: 60_000, nowIso: late, crash: { at: 'after', match: '/l000003.json' } }).killed);
  assert.deepEqual(await ledgerEvents(a), ['GENESIS', 'INTENT', 'ABORTED']);
  assert.equal(runChild(a, { task: 'recover', staleOperationMs: 60_000, nowIso: late }).line?.ok, true);
  assert.deepEqual(await ledgerEvents(a), ['GENESIS', 'INTENT', 'ABORTED'], 'idempotente');
  assert.equal((await must(fresh(a).list(BIA, a.auditId))).ledger.state, 'PROTECTED');
  const ledgerAborted = (await ledgerRecords(a)).find((record) => record.event === 'ABORTED');
  assert.deepEqual(ledgerAborted?.op?.observed?.entryPresent === false && ledgerAborted?.op?.observed?.receiptPresent === false, true, 'o ABORTED registra o que a recuperação OBSERVOU');
});

test('FALHAS DE DISCO no livro: ENOSPC é transitório (nada publicado, depois funciona); EIO/EROFS travam as escritas até reiniciar e o livro passa a ser lido como DURABILIDADE DESCONHECIDA (nunca como protegido nem como vazio)', async () => {
  const eio = faulty({ async writeExclusive(target, data, mode) { if (target.includes('l000002.json')) throw errno('EIO'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w = await ledgerWorld({ ledgerFs: eio });
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!failed.ok && failed.code === 'LEDGER_UNAVAILABLE');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, 'nada publicado quando o INTENT falha');
  const second = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `EIO trava as escritas do livro (fatal) até reiniciar: ${JSON.stringify(second).slice(0, 160)}`);
  // M2: a leitura RESPONDE, mas o livro não é "protegido" enquanto a base estiver travada (nada vigente, nada finalizável) — e também não é "vazio"
  const view = await must(w.rawProtected.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable, view.decisions.length], ['HISTORY_UNRESOLVED', 'DURABILITY_UNKNOWN', false, 0]);
  assert.notEqual(view.ledger.state, 'ENROLLMENT_PENDING', 'nunca confundido com livro vazio');
  clearStorageFatal(); // "reiniciar o servidor"
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });
  assert.ok((await healthy.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  assert.deepEqual(ledgerFiles(w).filter((name) => name.startsWith('l')), ['l000001.json', 'l000002.json', 'l000003.json']);
});
