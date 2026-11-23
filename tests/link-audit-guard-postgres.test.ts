import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import { boundGuard, MAX_LEDGER_RECORDS, type ExternalGuardPort } from '../src/lib/link-audit-ledger';
import { createPostgresGuard, GUARD_LATEST_SQL, GUARD_PUBLISH_SQL, type GuardDbSession } from '../src/lib/link-audit-ledger/guard-postgres';
import { createGuardPseudonyms, GUARD_PSEUDONYM_INFO, GUARD_PSEUDONYM_SALT } from '../src/lib/link-audit-ledger/guard-pseudonym';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir, withAutoHead } from './helpers/link-audit-decisions-fixtures';
import { GUARD_KEY_A, GUARD_KEY_B, GUARD_KEY_C, guardKey, PSEUDONYMS_A, PSEUDONYMS_B_AFTER_A, simulatedGuardDb, wireOf, type SimulatedGuardDb } from './helpers/link-audit-guard-db-fixtures';
import { EXPIRED_TIMER, manualTimer } from './helpers/link-audit-guard-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { finalizeAs, finalizerOver } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { OP_A, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { testKeyMaterial } from './helpers/link-audit-origin-fixtures';

/*
 * G1.b.2a — ADAPTADOR REAL da guarda externa (Supabase/Postgres, D-G0-1) atrás de `ExternalGuardPort`, com o cliente `pg` INJETADO: o provedor é o
 * simulado de `link-audit-guard-db-fixtures` (mesma regra 7 da função da migração 004). Nenhuma rede, nenhum banco. Pseudônimo `audit_ref` (D-G0-5),
 * rotação da chave do pseudônimo (§5.1.7), PG-G04 (rollback coordenado com a guarda real atrás da porta), PG-G05 (contrato da publicação no adaptador)
 * e PG-G06 (erro, resposta fora do esquema e prazo ⇒ indisponível, nunca "nenhuma cabeça").
 */
registerCleanup();
const H = (c: string): string => c.repeat(64);
const AUD = 'auditoria-guarda-07';
const AUD_OTHER = 'auditoria-guarda-08';
/** Vetores de referência calculados FORA do código (Python: HKDF-SHA-256 da RFC 5869 + HMAC-SHA-256), com o material de teste `guard-a`/`guard-b`. */
const GOLDEN_A_07 = '0ca8d3aa2c00bf8df774cd707f8a8c9d49951442ac5cc9b30129404e9a6f6fcc';
const GOLDEN_B_07 = '3b25a5d3bc1728897b5e85a1a4d3e89f670463232c1ce6bd609fd1a4ed049bc8';
const GOLDEN_A_08 = '800ad8cb1a1edc2edb9b0744717b9af59011bc705cd713fd620cbfa490eb8c3b';

const guardOver = (db: SimulatedGuardDb, pseudonyms = PSEUDONYMS_A, timer = manualTimer()): ExternalGuardPort => createPostgresGuard({ pseudonyms, connect: db.connect, timer });

/* ============================================================================ pseudônimo (D-G0-5) */

test('pseudônimo (D-G0-5): audit_ref = HMAC-SHA-256 do auditId com a chave derivada por HKDF (rótulo e sal da guarda) — vetores de referência calculados fora do código', () => {
  assert.equal(GUARD_PSEUDONYM_SALT, 'gmn.link-audit.guard.salt');
  assert.equal(GUARD_PSEUDONYM_INFO, 'gmn.link-audit.guard.audit-ref.v1');
  assert.deepEqual(PSEUDONYMS_A.current(AUD), { keyId: 'gk-test-a', auditRef: GOLDEN_A_07 });
  assert.deepEqual(PSEUDONYMS_A.current(AUD_OTHER), { keyId: 'gk-test-a', auditRef: GOLDEN_A_08 });
  assert.deepEqual(PSEUDONYMS_B_AFTER_A.current(AUD), { keyId: 'gk-test-b', auditRef: GOLDEN_B_07 });
  assert.deepEqual(PSEUDONYMS_B_AFTER_A.all(AUD), [{ keyId: 'gk-test-b', auditRef: GOLDEN_B_07 }, { keyId: 'gk-test-a', auditRef: GOLDEN_A_07 }], 'a atual primeiro, depois as aposentadas');
  assert.deepEqual(PSEUDONYMS_B_AFTER_A.keyIds, ['gk-test-b', 'gk-test-a']);
  assert.equal(PSEUDONYMS_B_AFTER_A.currentKeyId, 'gk-test-b');
});

test('pseudônimo: o objeto nunca expõe material (JSON, inspect, chaves) e a lista malformada é recusada sem citar material', () => {
  const ring = createGuardPseudonyms(GUARD_KEY_B, [GUARD_KEY_A, GUARD_KEY_C]);
  const shown = `${JSON.stringify(ring)} ${inspect(ring, { depth: 5, showHidden: true })} ${Object.keys(ring).join(',')}`;
  for (const key of [GUARD_KEY_A, GUARD_KEY_B, GUARD_KEY_C]) {
    for (const piece of [key.hex, key.hex.slice(0, 16), key.hex.slice(-16)]) assert.ok(!shown.includes(piece), `material de ${key.id} exposto`);
  }
  const cases: Array<[Parameters<typeof createGuardPseudonyms>[0], Parameters<typeof createGuardPseudonyms>[1]]> = [
    [{ id: 'GK', hex: GUARD_KEY_A.hex }, []],
    [{ id: 'gk-test-a', hex: 'curto' }, []],
    [GUARD_KEY_A, [{ id: 'gk-test-a', hex: GUARD_KEY_B.hex }]],
    [GUARD_KEY_A, [{ id: 'gk-test-z', hex: GUARD_KEY_A.hex }]],
  ];
  for (const [current, retired] of cases) {
    assert.throws(() => createGuardPseudonyms(current, retired), (error: unknown) => error instanceof Error && !error.message.includes(GUARD_KEY_A.hex) && !error.message.includes(GUARD_KEY_B.hex));
  }
});

/* ============================================================================ PG-G05 — contrato da publicação no adaptador (provedor simulado) */

test('PG-G05 (adaptador real, provedor simulado): mesmo trio ⇒ aceito sem registro novo, também abaixo do maior; mesmo ledgerSeq com outro sha256 ⇒ CONFLICT; ledgerSeq novo menor que o maior ⇒ STALE; maior ⇒ gravado; latest devolve o maior', async () => {
  const db = simulatedGuardDb();
  const guard = guardOver(db);
  assert.deepEqual(await guard.latest(AUD), { ok: true, head: null }, 'nenhuma cabeça publicada (resposta válida e vazia)');
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: true });
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('c') }), { ok: true }, 'maior que o maior ⇒ gravado');
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: true }, 'mesmo trio abaixo do maior ⇒ aceito (ALREADY_RECORDED)');
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('c') }), { ok: true }, 'mesmo trio na maior posição');
  assert.equal(db.rows.length, 2, 'nenhum registro novo pela republicação');
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('d') }), { ok: false, reason: 'CONFLICT' });
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('b') }), { ok: false, reason: 'CONFLICT' }, 'conflito também abaixo do maior');
  assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 2, sha256: H('b') }), { ok: false, reason: 'STALE' });
  assert.equal(db.rows.length, 2, 'recusas não gravam');
  assert.deepEqual(await guard.latest(AUD), { ok: true, head: { ledgerSeq: 3, sha256: H('c') } });
  assert.deepEqual(await guard.publish({ auditId: AUD_OTHER, ledgerSeq: 1, sha256: H('e') }), { ok: true }, 'outra auditoria, outro pseudônimo');
  assert.deepEqual(await guard.latest(AUD), { ok: true, head: { ledgerSeq: 3, sha256: H('c') } }, 'a outra auditoria não interfere');
  assert.deepEqual(db.queries.map((query) => query.text), [GUARD_LATEST_SQL, ...Array(7).fill(GUARD_PUBLISH_SQL), GUARD_LATEST_SQL, GUARD_PUBLISH_SQL, GUARD_LATEST_SQL], 'publish só chama a função de publicação; latest só lê');
});

test('PG-G05 (adaptador): o auditId em CLARO nunca sai do processo — só o audit_ref (HMAC) e o id público da chave; valores posicionais, nunca concatenados no SQL', async () => {
  const db = simulatedGuardDb();
  const guard = guardOver(db);
  await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') });
  await guard.latest(AUD);
  await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('b') });
  const wire = wireOf(db);
  assert.ok(!wire.includes(AUD) && !wire.includes('auditoria-'), 'nenhum auditId (nem prefixo) no que vai ao provedor');
  for (const query of db.queries) assert.ok(!query.text.includes(GOLDEN_A_07) && !/'[0-9a-f]{8,}'/.test(query.text), 'o SQL é fixo; os dados vão como parâmetros');
  assert.deepEqual(db.queries[0]?.values, [GOLDEN_A_07, 'gk-test-a', 1, H('a')]);
  assert.deepEqual(db.queries[1]?.values, [[GOLDEN_A_07]]);
  assert.deepEqual(db.rows, [{ audit_ref: GOLDEN_A_07, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('a') }], 'cada registro leva o id da chave que gerou o pseudônimo');
});

test('PG-G05 (adaptador): entrada fora do contrato (auditId, ledgerSeq fora de 1..MAX, sha256) ⇒ UNAVAILABLE / indisponível SEM abrir conexão', async () => {
  const db = simulatedGuardDb();
  const guard = guardOver(db);
  for (const bad of [{ auditId: '../fora', ledgerSeq: 1, sha256: H('a') }, { auditId: 'Maiuscula-0001', ledgerSeq: 1, sha256: H('a') }, { auditId: AUD, ledgerSeq: 0, sha256: H('a') }, { auditId: AUD, ledgerSeq: 1.5, sha256: H('a') }, { auditId: AUD, ledgerSeq: MAX_LEDGER_RECORDS + 1, sha256: H('a') }, { auditId: AUD, ledgerSeq: 1, sha256: 'curto' }, { auditId: AUD, ledgerSeq: 1, sha256: H('A') }]) {
    assert.deepEqual(await guard.publish(bad), { ok: false, reason: 'UNAVAILABLE' }, JSON.stringify(bad));
  }
  assert.deepEqual(await guard.latest('../fora'), { ok: false });
  assert.equal(db.state.connects, 0, 'nada foi ao provedor');
});

/* ============================================================================ rotação da chave do pseudônimo (§5.1.7) */

test('rotação (§5.1.7): a publicação usa SÓ a chave atual; o latest consulta o pseudônimo de CADA chave (atual e aposentadas) e fica com o maior ledgerSeq', async () => {
  const db = simulatedGuardDb();
  const before = guardOver(db, PSEUDONYMS_A);
  for (const seq of [1, 2, 7]) assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: seq, sha256: H(String(seq)) }), { ok: true });
  const rotated = guardOver(db, PSEUDONYMS_B_AFTER_A);
  assert.deepEqual(await rotated.latest(AUD), { ok: true, head: { ledgerSeq: 7, sha256: H('7') } }, 'depois da rotação, a cabeça publicada com a chave antiga continua achada');
  assert.deepEqual(db.queries.at(-1)?.values, [[GOLDEN_B_07, GOLDEN_A_07]], 'um pseudônimo por chave, a atual primeiro');
  assert.deepEqual(await rotated.publish({ auditId: AUD, ledgerSeq: 7, sha256: H('7') }), { ok: true }, 'a primeira publicação com a chave nova é a cabeça do livro naquele instante');
  assert.deepEqual(db.rows.at(-1), { audit_ref: GOLDEN_B_07, key_id: 'gk-test-b', ledger_seq: 7, sha256: H('7') }, 'gravada SÓ sob a chave atual');
  assert.equal(db.rows.filter((row) => row.audit_ref === GOLDEN_A_07).length, 3, 'nada novo sob a aposentada');
  assert.deepEqual(await rotated.publish({ auditId: AUD, ledgerSeq: 9, sha256: H('9') }), { ok: true });
  assert.deepEqual(await rotated.latest(AUD), { ok: true, head: { ledgerSeq: 9, sha256: H('9') } }, 'a maior entre os pseudônimos');
  // a aposentada à frente da atual (auditoria sem atividade depois da rotação, ou sequência falsa sob a antiga): o latest NÃO esconde a maior
  const ahead = simulatedGuardDb();
  await guardOver(ahead, PSEUDONYMS_A).publish({ auditId: AUD, ledgerSeq: 12, sha256: H('c') });
  await guardOver(ahead, PSEUDONYMS_B_AFTER_A).publish({ auditId: AUD, ledgerSeq: 5, sha256: H('5') });
  assert.deepEqual(await guardOver(ahead, PSEUDONYMS_B_AFTER_A).latest(AUD), { ok: true, head: { ledgerSeq: 12, sha256: H('c') } });
});

test('rotação (§5.1.7): a MESMA posição máxima com sha256 diferentes sob dois pseudônimos ⇒ indisponível (nunca escolhe uma: escolher poderia esconder o retrocesso)', async () => {
  const db = simulatedGuardDb();
  await guardOver(db, PSEUDONYMS_A).publish({ auditId: AUD, ledgerSeq: 4, sha256: H('a') });
  await guardOver(db, PSEUDONYMS_B_AFTER_A).publish({ auditId: AUD, ledgerSeq: 4, sha256: H('b') });
  assert.deepEqual(await guardOver(db, PSEUDONYMS_B_AFTER_A).latest(AUD), { ok: false });
  const same = simulatedGuardDb();
  await guardOver(same, PSEUDONYMS_A).publish({ auditId: AUD, ledgerSeq: 4, sha256: H('a') });
  await guardOver(same, PSEUDONYMS_B_AFTER_A).publish({ auditId: AUD, ledgerSeq: 4, sha256: H('a') });
  assert.deepEqual(await guardOver(same, PSEUDONYMS_B_AFTER_A).latest(AUD), { ok: true, head: { ledgerSeq: 4, sha256: H('a') } }, 'mesma cabeça sob as duas chaves: coerente');
});

/* ============================================================================ PG-G06 — erro, resposta fora do esquema e prazo ⇒ indisponível */

test('PG-G06 (adaptador): conexão ou consulta com erro ⇒ latest indisponível (nunca "nenhuma cabeça") e publish UNAVAILABLE', async () => {
  for (const fail of ['failConnect', 'failQuery'] as const) {
    const db = simulatedGuardDb();
    db.state[fail] = true;
    const guard = guardOver(db);
    assert.deepEqual(await guard.latest(AUD), { ok: false }, fail);
    assert.deepEqual(await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: false, reason: 'UNAVAILABLE' }, fail);
    assert.equal(db.state.open, 0, `${fail}: nenhuma conexão fica aberta`);
  }
});

test('PG-G06 (adaptador): resposta fora do esquema ⇒ indisponível — linhas a mais, pseudônimo não pedido, repetido, coluna extra, tipos errados, posição fora da faixa; publicação com desfecho desconhecido ou sem linha', async () => {
  const row = (over: Record<string, unknown> = {}) => ({ audit_ref: GOLDEN_A_07, key_id: 'gk-test-a', ledger_seq: 3, sha256: H('c'), ...over });
  const latestCases: Array<[string, unknown]> = [
    ['não é lista', { audit_ref: GOLDEN_A_07 }],
    ['duas linhas do mesmo pseudônimo', [row(), row({ ledger_seq: 2 })]],
    ['pseudônimo não pedido', [row({ audit_ref: GOLDEN_A_08 })]],
    ['coluna extra', [row({ recorded_at: '2026-11-22T00:00:00Z' })]],
    ['ledger_seq como texto (bigint)', [row({ ledger_seq: '3' })]],
    ['ledger_seq zero', [row({ ledger_seq: 0 })]],
    ['ledger_seq acima do máximo', [row({ ledger_seq: MAX_LEDGER_RECORDS + 1 })]],
    ['sha256 maiúsculo', [row({ sha256: H('C') })]],
    ['key_id fora do formato', [row({ key_id: 'X' })]],
    ['linha nula', [null]],
  ];
  for (const [label, rows] of latestCases) {
    const db = simulatedGuardDb();
    db.state.override = async () => ({ rows: rows as unknown[] });
    assert.deepEqual(await guardOver(db).latest(AUD), { ok: false }, label);
    assert.equal(db.state.open, 0, `${label}: conexão encerrada`);
  }
  const publishCases: Array<[string, unknown[]]> = [
    ['desfecho desconhecido', [{ outcome: 'OK' }]],
    ['sem linha', []],
    ['duas linhas', [{ outcome: 'RECORDED' }, { outcome: 'RECORDED' }]],
    ['coluna extra', [{ outcome: 'RECORDED', extra: 1 }]],
    ['minúsculas', [{ outcome: 'recorded' }]],
  ];
  for (const [label, rows] of publishCases) {
    const db = simulatedGuardDb();
    db.state.override = async () => ({ rows });
    assert.deepEqual(await guardOver(db).publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: false, reason: 'UNAVAILABLE' }, label);
  }
});

test('PG-G06 (adaptador): prazo de 3 s por chamada TAMBÉM no adaptador — consulta ou conexão penduradas ⇒ indisponível no prazo, e a conexão é encerrada (nunca fica aberta)', async () => {
  // consulta que nunca responde
  const hung = simulatedGuardDb();
  hung.state.override = () => new Promise(() => undefined);
  const timer = manualTimer();
  const pending = guardOver(hung, PSEUDONYMS_A, timer).latest(AUD);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timer.asked, [3_000], 'pede o prazo de 3 s');
  timer.fire();
  assert.deepEqual(await pending, { ok: false });
  assert.equal(hung.state.open, 0, 'a conexão pendurada é encerrada no prazo');
  // conexão que só abre DEPOIS do prazo: é encerrada assim que abre
  let release: (session: GuardDbSession) => void = () => undefined;
  const late = simulatedGuardDb();
  const slow = new Promise<GuardDbSession>((resolve) => {
    release = resolve;
  });
  const lateTimer = manualTimer();
  const guard = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect: () => slow, timer: lateTimer });
  const publishing = guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') });
  lateTimer.fire();
  assert.deepEqual(await publishing, { ok: false, reason: 'UNAVAILABLE' });
  release(await late.connect());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.state.open, 0, 'aberta depois do prazo ⇒ encerrada na hora, sem consulta');
  assert.equal(late.queries.length, 0);
  // e pela porta (boundGuard), como o serviço sempre a usa
  const bounded = boundGuard(guardOver(simulatedGuardDb()), EXPIRED_TIMER);
  assert.deepEqual(await bounded.latest(AUD), { ok: false });
});

test('sem vazamento de conexão: toda chamada abre UMA conexão e a encerra uma vez, com sucesso, recusa, erro ou resposta inválida; conexão que lança no encerramento não muda o desfecho', async () => {
  const db = simulatedGuardDb();
  const guard = guardOver(db);
  await guard.publish({ auditId: AUD, ledgerSeq: 2, sha256: H('b') });
  await guard.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') });
  await guard.latest(AUD);
  db.state.failQuery = true;
  await guard.latest(AUD);
  db.state.failQuery = false;
  db.state.override = async () => ({ rows: [{ nada: 1 }] });
  await guard.latest(AUD);
  assert.deepEqual([db.state.connects, db.state.ends, db.state.open], [5, 5, 0]);
  const throwing = createPostgresGuard({
    pseudonyms: PSEUDONYMS_A,
    timer: manualTimer(),
    connect: async () => ({
      query: async () => ({ rows: [{ outcome: 'RECORDED' }] }),
      end: () => {
        throw new Error('sentinela: falha ao encerrar');
      },
    }),
  });
  assert.deepEqual(await throwing.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: true });
});

/* ============================================================================ PG-G04 — rollback coordenado com a guarda REAL atrás da porta */

/** Cópia e restauração das pastas DA AUDITORIA (decisões, recibos, livro e, se houver, resultados e recibos de resultados): o atacante que escreve em todas. */
function volumesOf(w: LedgerWorld, e?: ResultsEnv): string[] {
  return [path.join(w.decisionsDir, w.auditId), path.join(w.anchorDir, w.auditId), path.join(w.ledgerDir, w.auditId), ...(e ? [path.join(e.base, w.auditId), path.join(e.anchors, w.auditId)] : [])];
}
function snapshot(dirs: readonly string[]): string {
  const copy = tmpDir('lad-pgsnap-');
  for (const [index, dir] of dirs.entries()) if (fs.existsSync(dir)) fs.cpSync(dir, path.join(copy, String(index)), { recursive: true });
  return copy;
}
function restore(dirs: readonly string[], copy: string): void {
  for (const [index, dir] of dirs.entries()) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(path.join(copy, String(index)))) fs.cpSync(path.join(copy, String(index)), dir, { recursive: true });
  }
}
/** Mundo do livro com a guarda REAL (adaptador Postgres + provedor simulado) ligada ANTES da inscrição (regra 1). */
async function postgresWorld(): Promise<{ w: LedgerWorld; db: SimulatedGuardDb; guard: ExternalGuardPort }> {
  const w = await ledgerWorld({ enroll: false });
  const db = simulatedGuardDb();
  const guard = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect: db.connect });
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard }), knownHeads: NO_RESULTS });
  await must(service.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock()));
  return { w, db, guard };
}
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

test('PG-G04: rollback COORDENADO de decisões + recibos + livro com a guarda real (adaptador Postgres) atrás da porta ⇒ GUARD_MISMATCH: nada vigente, nada finalizável, escrita recusada e o livro intacto', async () => {
  const { w, db, guard } = await postgresWorld();
  const service = withAutoHead(decisionsOver(w, { ledger: ledgerFor(w, { guard }), knownHeads: NO_RESULTS }));
  await must(service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const before = snapshot(volumesOf(w));
  await must(service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  const records = await ledgerRecords(w);
  assert.deepEqual(await guard.latest(w.auditId), { ok: true, head: { ledgerSeq: records.length, sha256: records.at(-1)?.contentSha256 } }, 'a guarda acompanhou o livro');
  assert.ok(db.rows.every((row) => row.audit_ref === PSEUDONYMS_A.current(w.auditId).auditRef), 'só o pseudônimo no provedor');
  assert.ok(!wireOf(db).includes(w.auditId));
  restore(volumesOf(w), before); // quem escreve nas TRÊS pastas devolve tudo ao instante anterior à revogação
  const fresh = decisionsOver(w, { ledger: ledgerFor(w, { guard }), knownHeads: NO_RESULTS });
  const view = await must(fresh.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH', 'MISMATCH', [], false], 'detectado: a revogação não volta a sumir');
  const events = await ledgerEvents(w);
  const write = await fresh.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED');
  assert.deepEqual(await ledgerEvents(w), events, 'o livro não foi alterado');
  assert.equal(db.state.open, 0, 'nenhuma conexão aberta ao fim');
});

test('PG-G04: rollback COORDENADO que inclui os RESULTADOS (decisões, recibos, resultados, recibos de resultados e livro) com a guarda real atrás da porta ⇒ GUARD_MISMATCH', async () => {
  const { w, guard } = await postgresWorld();
  const e = resultsEnv();
  await must(withAutoHead(decisionsOver(w, { ledger: ledgerFor(w, { guard }), knownHeads: NO_RESULTS })).create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const dirs = volumesOf(w, e);
  const before = snapshot(dirs);
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { guard } }), OP_A, w.auditId);
  assert.ok(done.ok, JSON.stringify(done).slice(0, 240));
  assert.ok((await ledgerEvents(w)).includes('RUN_CONFIRMED'), 'o resultado foi confirmado pelo livro');
  restore(dirs, before); // o resultado, o recibo dele e os RUN_* somem juntos
  const view = await must(finalizerOver(w, e, { ledger: { guard } }).decisions.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard, view.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH', 'MISMATCH', false]);
});

test('PG-G04 / §5.1.7: a rotação da chave do pseudônimo NÃO esconde retrocesso — rollback depois da rotação continua GUARD_MISMATCH (a cabeça da chave aposentada é lida)', async () => {
  const { w, db } = await postgresWorld();
  const guardA = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect: db.connect });
  const service = withAutoHead(decisionsOver(w, { ledger: ledgerFor(w, { guard: guardA }), knownHeads: NO_RESULTS }));
  await must(service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const before = snapshot(volumesOf(w));
  await must(service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  restore(volumesOf(w), before);
  const rotated = createPostgresGuard({ pseudonyms: PSEUDONYMS_B_AFTER_A, connect: db.connect });
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: rotated }), knownHeads: NO_RESULTS }).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH'], 'a chave nova não tem cabeça, mas a aposentada tem a maior');
  // sem o retrocesso, a rotação não produz GUARD_HEAD_MISSING: a auditoria ociosa continua protegida pela cabeça da aposentada
  const { w: idle, db: idleDb } = await postgresWorld();
  const idleGuardA = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect: idleDb.connect });
  await must(withAutoHead(decisionsOver(idle, { ledger: ledgerFor(idle, { guard: idleGuardA }), knownHeads: NO_RESULTS })).create(ANA, idle.auditId, { record: rec.c2() }, clock()));
  const idleRotated = createPostgresGuard({ pseudonyms: PSEUDONYMS_B_AFTER_A, connect: idleDb.connect });
  const idleView = await must(decisionsOver(idle, { ledger: ledgerFor(idle, { guard: idleRotated }), knownHeads: NO_RESULTS }).list(BIA, idle.auditId));
  assert.deepEqual([idleView.ledger.state, idleView.ledger.externalGuard], ['PROTECTED', 'CONSISTENT']);
  // e a primeira escrita depois da rotação publica sob a chave nova
  await must(withAutoHead(decisionsOver(idle, { ledger: ledgerFor(idle, { guard: idleRotated }), knownHeads: NO_RESULTS })).create(ANA, idle.auditId, { record: rec.c3() }, clock()));
  assert.ok(idleDb.rows.some((row) => row.key_id === 'gk-test-b' && row.audit_ref === PSEUDONYMS_B_AFTER_A.current(idle.auditId).auditRef));
  assert.ok(idleDb.rows.filter((row) => row.key_id === 'gk-test-a').every((row) => row.ledger_seq <= 3), 'nada novo sob a aposentada');
});

test('chaves de teste derivadas de rótulos (nenhum material fixo no repositório)', () => {
  assert.equal(guardKey('gk-x-test', 'rotulo').hex, testKeyMaterial('rotulo'));
});

/* ============================================================================ migração 004 ↔ adaptador (estático) */

test('migração 004 ↔ adaptador: a função e a tabela que o SQL fixo usa existem com os mesmos nomes e colunas; faixa 1..MAX_LEDGER_RECORDS igual à do livro; toda função com search_path vazio; nada em public', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'proposed', '004_link_audit_guard.sql'), 'utf8');
  const rollback = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'proposed', '004_link_audit_guard.rollback.sql'), 'utf8');
  assert.match(GUARD_PUBLISH_SQL, /^select gmn_link_audit_guard\.publish_head\(\$1, \$2, \$3, \$4\) as outcome$/);
  assert.match(sql, /create or replace function gmn_link_audit_guard\.publish_head\(p_audit_ref text, p_key_id text, p_ledger_seq integer, p_sha256 text\)\s+returns text/);
  for (const outcome of ['RECORDED', 'ALREADY_RECORDED', 'CONFLICT', 'STALE']) assert.match(sql, new RegExp(`return '${outcome}'`), outcome);
  for (const column of ['audit_ref', 'key_id', 'ledger_seq', 'sha256']) {
    assert.ok(GUARD_LATEST_SQL.includes(`h.${column}`), `o latest lê ${column}`);
    assert.match(sql, new RegExp(`\\n  ${column} (?:text|integer) not null`), `a tabela tem ${column}`);
  }
  assert.ok(GUARD_LATEST_SQL.includes('from gmn_link_audit_guard.ledger_heads h where h.audit_ref = any($1::text[])'));
  assert.equal(MAX_LEDGER_RECORDS, 4000);
  assert.match(sql, new RegExp(`ledger_seq between 1 and ${MAX_LEDGER_RECORDS}\\)`), 'CHECK da tabela');
  assert.match(sql, new RegExp(`p_ledger_seq > ${MAX_LEDGER_RECORDS} then`), 'validação da função');
  assert.equal((sql.match(/create or replace function/g) ?? []).length, 3);
  assert.equal((sql.match(/\n  set search_path = ''\n/g) ?? []).length, 4, 'as três funções da guarda e a do inventário (temporária) com search_path vazio');
  // revisão do PR #61: inventário FECHADO do esquema (função temporária desta sessão), chamado na pré-validação e na conferência final, e removido antes do COMMIT
  assert.match(sql, /create function pg_temp\.gmn_guard_inventory\(p_fase text\)/);
  assert.match(sql, /perform pg_temp\.gmn_guard_inventory\('pré'\);[\s\S]+perform pg_temp\.gmn_guard_inventory\('final'\);[\s\S]+drop function pg_temp\.gmn_guard_inventory\(text\);\s+commit;/);
  for (const catalog of ['pg_class', 'pg_proc', 'pg_type', 'pg_constraint', 'pg_operator', 'pg_default_acl', 'pg_policy', 'pg_rewrite', 'pg_inherits', 'pg_publication_rel', 'pg_publication_namespace']) assert.ok(sql.includes(`pg_catalog.${catalog}`), `inventário consulta ${catalog}`);
  assert.match(sql, /m\.grantor = 10 and m\.admin_option and not m\.set_option and not m\.inherit_option/, 'só a associação administrativa do criador');
  assert.equal((sql.match(/security definer/g) ?? []).length, 1, 'só a publicação é SECURITY DEFINER');
  assert.ok(!/\bpublic\.|schema public\b/i.test(sql.replace(/from public,/g, '').replace(/revoke all on [^;]+ from public/g, '')), 'nenhum objeto em public');
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.match(rollback, /APAGAR-CABECAS-DA-GUARDA/);
  for (const text of [sql, rollback]) assert.ok(!/password\s+'|\bpassword\s+"|[0-9a-f]{32,}/i.test(text), 'nenhuma senha nem material no SQL');
});

test('CI da migração (revisão do PR #61): workflow próprio, fora do ci.yml, só nos caminhos da guarda, só leitura, sem secrets, ações fixadas pelos MESMOS SHAs do ci.yml e a imagem do Postgres por digest igual à padrão do guard-run.sh, que falha (não pula) sem pg', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const workflow = read('.github/workflows/guard-migration.yml');
  const ci = read('.github/workflows/ci.yml');
  const harness = read('supabase/proposed/local-test/guard-run.sh');
  for (const filter of ["'supabase/proposed/004*'", "'supabase/proposed/local-test/**'", "'src/lib/link-audit-ledger/guard-*'"]) {
    assert.equal(workflow.split(`- ${filter}`).length - 1, 2, `${filter} em pull_request e em push`);
  }
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.ok(!/secrets\.|GITHUB_TOKEN|pull_request_target|write/.test(workflow.replace(/^#.*$/gm, '')), 'sem secrets, sem escrita');
  const uses = [...workflow.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((m) => m[1]);
  assert.deepEqual(uses.sort(), ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1']);
  for (const action of uses) assert.ok(ci.includes(`uses: ${action}`), `${action} igual ao do ci.yml`);
  assert.ok(!/uses: [^@\n]+@(?![0-9a-f]{40}\b)/.test(workflow), 'toda ação fixada por SHA');
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /run: npm ci/);
  const image = /GUARD_PG_IMAGE: (public\.ecr\.aws\/supabase\/postgres@sha256:[0-9a-f]{64})/.exec(workflow)?.[1];
  assert.ok(image, 'imagem por digest');
  assert.ok(harness.includes(`IMAGE="\${1:-${image}}"`), 'o guard-run.sh usa o mesmo digest por padrão');
  assert.match(workflow, /docker pull "\$GUARD_PG_IMAGE"/);
  assert.match(workflow, /bash supabase\/proposed\/local-test\/guard-run\.sh "\$GUARD_PG_IMAGE"/);
  assert.ok(!/guard-migration|guard-run/.test(ci), 'fora do ci.yml');
  assert.match(harness, /--pull never --network none/);
  assert.match(harness, /node_modules\/pg ausente \(rode npm ci; a etapa do adaptador real é obrigatória\)/);
  assert.ok(!/AVISO: .*pulada|etapa do adaptador real pulada/.test(harness), 'nenhuma etapa pulada');
});
