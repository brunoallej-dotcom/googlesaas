import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ledgerRefOf, readLog } from '../src/lib/link-audit-decisions/store';
import { serialize } from '../src/lib/link-audit-storage';
import { needsCheckpoint, type LedgerDraft, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { ANA, BIA, clock, must, rec, registerCleanup, writeAlternatingChain } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, isoAt, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_KEY_A, LEDGER_KEY_B, makeRecord, NO_RESULTS, opOf } from './helpers/link-audit-ledger-fixtures';

/*
 * ACHADOS DA REVISÃO INDEPENDENTE nº 6 (02/11/2026) corrigidos na árvore: R6-01 (limite de registros: INTENT no 4000 sem espaço para o CONFIRMED),
 * R6-02 (CHECKPOINT da chave nova não gravado quando o último CHECKPOINT é da chave antiga), R6-03 (caminho do disco na resposta 503).
 */
registerCleanup();

/** Livro REAL-assinado no disco com `total` registros, coerente com `n` decisões já gravadas. */
async function lopsided(n: number, total: number) {
  const w = await ledgerWorld({ enroll: false });
  writeAlternatingChain(w.decisionsDir, w.anchorDir, w.auditId, n);
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  assert.ok(log.ok);
  const records: LedgerRecord[] = [];
  const push = (draft: unknown) => { records.push(makeRecord(LEDGER_AUTH_A, w.auditId, records[records.length - 1] ?? null, { ...(draft as object), recordedAt: isoAt(records.length) } as LedgerDraft)); };
  const checkpoint = () => push({ event: 'CHECKPOINT', actor: 'system', checkpoint: { throughSeq: records.length, throughSha256: records[records.length - 1]?.contentSha256 } });
  push({ event: 'GENESIS', actor: 'ana@empresa.com', genesis: { mode: 'EMPTY' } });
  for (const [i, e] of log.value.state.entries.entries()) {
    const ref = ledgerRefOf(e);
    const op = opOf(ref, String(i + 1).padStart(32, '0'));
    push({ event: 'INTENT', actor: ref.author, op });
    push({ event: 'CONFIRMED', actor: ref.author, op: { ...op, intentSeq: records.length, anchorRef: { name: `a${String(ref.seq).padStart(4, '0')}.json`, headSha256: ref.sha256 } } });
    if ((i + 1) % 20 === 0 && records.length < total - 1) checkpoint();
  }
  while (records.length < total) checkpoint();
  const dir = path.join(w.ledgerDir, w.auditId);
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) fs.writeFileSync(path.join(dir, `l${String(r.ledgerSeq).padStart(6, '0')}.json`), serialize(r), { mode: 0o444 });
  return w;
}

test('R6-01: perto do limite de 4000 registros a escrita é recusada ANTES de publicar qualquer coisa (reserva para INTENT+CONFIRMED), nos dois lados da paridade, com razão LIMIT_REACHED e sem caminho', async () => {
  for (const total of [3998, 3999, 4000]) {
    const w = await lopsided(1950, total);
    const view0 = await must(w.rawProtected.list(BIA, w.auditId, clock()));
    assert.equal(view0.ledger.state, 'PROTECTED', `${total}`);
    const before = [fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, fs.readdirSync(path.join(w.anchorDir, w.auditId)).length, fs.readdirSync(path.join(w.ledgerDir, w.auditId)).length];
    const r = await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: view0.head }, clock);
    assert.ok(!r.ok, `${total}: recusada`);
    assert.ok(r.issues.some((i) => /LIMIT_REACHED/.test(i)), `${total}: ${JSON.stringify(r.issues)}`);
    const after = [fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, fs.readdirSync(path.join(w.anchorDir, w.auditId)).length, fs.readdirSync(path.join(w.ledgerDir, w.auditId)).length];
    assert.deepEqual(after, before, `${total}: NADA publicado (nem decisão, nem recibo, nem livro)`);
    const view1 = await must(w.rawProtected.list(BIA, w.auditId, clock()));
    assert.equal(view1.ledger.state, 'PROTECTED', `${total}: a auditoria segue legível e protegida (não congela por esta tentativa)`);
  }
});

test('R6-02: rotação planejada com o ÚLTIMO registro da chave antiga sendo um CHECKPOINT dela — o RECOVER e a escrita gravam o CHECKPOINT da chave nova e a auditoria sobrevive ao vencimento', async () => {
  const at = (iso: string) => () => new Date(iso);
  for (const useWrite of [false, true]) {
    const w = await ledgerWorld({ enroll: false });
    const k1 = decisionsOver(w, { ledger: ledgerFor(w, { auth: ledgerAuth({ current: LEDGER_KEY_A }), guard: null, checkpointEvery: 3 }), knownHeads: NO_RESULTS });
    await must(k1.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock));
    await must(k1.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
    // pedido REJEITADO (cabeça velha) depois de o CHECKPOINT automático ser gravado: deixa um CHECKPOINT da chave antiga como ÚLTIMO registro (o caso real do revisor)
    const rejected = await k1.create(ANA, w.auditId, { record: rec.c2(), expectedHead: { seq: 99, sha256: 'a'.repeat(64) } }, clock);
    assert.ok(!rejected.ok, 'precondição: pedido rejeitado');
    assert.equal((await ledgerEvents(w)).at(-1), 'CHECKPOINT');
    const rotated = (now: string) => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at(now) });
    const k2 = decisionsOver(w, { ledger: ledgerFor(w, { auth: rotated('2026-11-02T12:00:00Z'), guard: null, checkpointEvery: 3 }), knownHeads: NO_RESULTS });
    if (useWrite) {
      const head = (await must(k2.list(ANA, w.auditId, clock()))).head;
      await must(k2.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: head }, clock));
    } else {
      await must(k2.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock));
    }
    const kids = (await ledgerRecords(w)).filter((r) => r.event === 'CHECKPOINT').map((r) => r.origin.kid);
    assert.ok(kids.includes('lk-test-b'), `${useWrite}: há CHECKPOINT da chave nova (${kids.join()})`);
    const expired = decisionsOver(w, { ledger: ledgerFor(w, { auth: rotated('2026-12-10T12:00:00Z'), guard: null, checkpointEvery: 3 }), knownHeads: NO_RESULTS });
    const view = await must(expired.list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED', `${useWrite}: depois do vencimento da chave antiga`);
  }
});

test('R6-02 (modelo puro): needsCheckpoint — nada a cobrir ⇒ não; cauda longa ⇒ sim; registro de outra chave depois do último CHECKPOINT ⇒ sim; último CHECKPOINT é da chave antiga ⇒ sim; CHECKPOINT da chave atual cobrindo tudo ⇒ não', () => {
  const mk = (events: Array<[string, string]>): LedgerRecord[] => events.map(([event, kid], index) => ({ ledgerSeq: index + 1, event, origin: { kid } }) as unknown as LedgerRecord);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a']]), 'a', 64), false);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a'], ['INTENT', 'a'], ['CONFIRMED', 'a']]), 'a', 3), true);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a'], ['INTENT', 'a'], ['CONFIRMED', 'a'], ['CHECKPOINT', 'a'], ['INTENT', 'a']]), 'b', 64), true);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a'], ['INTENT', 'a'], ['CONFIRMED', 'a'], ['CHECKPOINT', 'a']]), 'b', 64), true);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a'], ['INTENT', 'a'], ['CONFIRMED', 'a'], ['CHECKPOINT', 'a'], ['CHECKPOINT', 'b']]), 'b', 64), false);
  assert.equal(needsCheckpoint(mk([['GENESIS', 'a'], ['CHECKPOINT', 'b'], ['INTENT', 'b'], ['CONFIRMED', 'b']]), 'b', 64), false);
});

test('R6-03: a falha de gravação do livro devolve mensagem FIXA — nenhum caminho do disco, errno ou nome de arquivo', async () => {
  const { faulty, errno } = await import('./helpers/link-audit-evidence-fixtures');
  const { nodeFsOps } = await import('../src/lib/link-audit/snapshot-store');
  const w = await ledgerWorld({ ledgerFs: faulty({ async link(from, to) { if (to.endsWith('l000002.json')) throw errno('EACCES', `EACCES: permission denied, link '${from}' -> '${to}'`); return nodeFsOps.link(from, to); } }) });
  const r = await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!r.ok);
  const text = JSON.stringify(r);
  for (const leak of [w.ledgerDir, w.decisionsDir, 'l000002', 'EACCES', '/tmp/']) assert.ok(!text.includes(leak), `vazou "${leak}"`);
});
