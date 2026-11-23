import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GUARD_READER_ROLE } from '../src/lib/link-audit-ledger/config';
import { GUARD_PUBLISH_SQL } from '../src/lib/link-audit-ledger/guard-postgres';
import { MAX_GUARD_HEADS, READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL, READER_ROLE, READER_ROWS_SQL, readGuard } from '../src/lib/link-audit-guard-reconcile/reader';
import type { GuardRow } from '../src/lib/link-audit-guard-reconcile/model';
import { PSEUDONYMS_A, type SimulatedHeadRow } from './helpers/link-audit-guard-db-fixtures';
import { manualTimer, READER_IDENTITY, simulatedReaderDb, WRITER_IDENTITY } from './helpers/link-audit-guard-reconcile-fixtures';

/*
 * G1.b.2b — LEITURA DA GUARDA pela reconciliação (GE-E5): SOMENTE LEITURA, uma conexão (sem pool), sempre encerrada, com prazo total. Antes de ler
 * qualquer cabeça, a sessão prova que é do papel de LEITURA (`gmn_guard_reader`), que a sessão é somente leitura por padrão (o ajuste do papel na
 * migração 004) e que NÃO pode executar a função de publicação: com a credencial do escritor nada é lido. As leituras correm numa transação
 * `read only` (repeatable read: as cabeças e as linhas do registro anterior são do mesmo instante). SQL fixo, dados só por parâmetro.
 */
const A = 'auditoria-leitor-a1';
const B = 'auditoria-leitor-b1';
const refA = PSEUDONYMS_A.current(A).auditRef;
const refB = PSEUDONYMS_A.current(B).auditRef;
const H = (c: string): string => c.repeat(64);
const ROWS = (): SimulatedHeadRow[] => [
  { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') },
  { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 4, sha256: H('4') },
  { audit_ref: refB, key_id: 'gk-test-a', ledger_seq: 2, sha256: H('2') },
];
const asRow = (row: SimulatedHeadRow): GuardRow => ({ auditRef: row.audit_ref, keyId: row.key_id, ledgerSeq: row.ledger_seq, sha256: row.sha256 });

test('G1.b.2b leitor: identidade conferida ANTES de ler; cabeças (a maior de cada pseudônimo) e as linhas do registro anterior lidas numa transação read only; SQL fixo; uma conexão, encerrada', async () => {
  const db = simulatedReaderDb(ROWS());
  const previous = [asRow({ audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') }), asRow({ audit_ref: refB, key_id: 'gk-test-a', ledger_seq: 3, sha256: H('3') })];
  const read = await readGuard(db.connect, previous);
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.value.role, 'gmn_guard_reader');
  assert.deepEqual(read.value.heads, [ROWS()[1], ROWS()[2]].map((row) => asRow(row as SimulatedHeadRow)).sort((x, y) => (x.auditRef < y.auditRef ? -1 : 1)));
  assert.deepEqual(read.value.previousNow, [asRow(ROWS()[0] as SimulatedHeadRow)], 'a posição 3 de B não existe na guarda');
  assert.deepEqual(db.queries.map((query) => query.text), [READER_IDENTITY_SQL, READER_BEGIN_SQL, READER_HEADS_SQL, READER_ROWS_SQL, READER_END_SQL]);
  assert.deepEqual(db.queries[2]?.values, [MAX_GUARD_HEADS + 1]);
  assert.deepEqual(db.queries[3]?.values, [[refA, refB], ['1', '3']]);
  assert.ok(!db.queries.some((query) => query.text === GUARD_PUBLISH_SQL || /publish_head\(\$/.test(query.text) || /\b(insert|update|delete|truncate)\b/i.test(query.text)), 'nada de escrita');
  assert.deepEqual([db.state.connects, db.state.ends, db.state.open], [1, 1, 0]);
  assert.match(READER_BEGIN_SQL, /read only/);
});

test('G1.b.2b leitor: sem registro anterior, a consulta das linhas antigas nem é feita', async () => {
  const db = simulatedReaderDb(ROWS());
  const read = await readGuard(db.connect, []);
  assert.ok(read.ok && read.value.previousNow.length === 0);
  assert.ok(!db.queries.some((query) => query.text === READER_ROWS_SQL));
});

test('G1.b.2b leitor: credencial do ESCRITOR (outro papel, sessão gravável, EXECUTE na publicação) ⇒ recusada sem ler NENHUMA cabeça; cada sinal sozinho também recusa', async () => {
  for (const [identity, code] of [
    [WRITER_IDENTITY, 'NOT_READER_ROLE'],
    [{ ...READER_IDENTITY, role_name: 'postgres' }, 'NOT_READER_ROLE'],
    [{ ...READER_IDENTITY, default_read_only: 'off' }, 'SESSION_NOT_READ_ONLY'],
    [{ ...READER_IDENTITY, can_publish: true }, 'READER_CAN_PUBLISH'],
  ] as const) {
    const db = simulatedReaderDb(ROWS(), identity);
    assert.deepEqual(await readGuard(db.connect, []), { ok: false, code }, JSON.stringify(identity));
    assert.deepEqual(db.queries.map((query) => query.text), [READER_IDENTITY_SQL], 'nada além da identidade');
    assert.equal(db.state.open, 0);
  }
});

test('G1.b.2b leitor: conexão recusada, consulta com erro ou resposta fora do esquema ⇒ GUARD_UNAVAILABLE / GUARD_RESPONSE_INVALID (nunca "guarda vazia"); conexão sempre encerrada', async () => {
  const refused = simulatedReaderDb(ROWS());
  refused.state.failConnect = true;
  assert.deepEqual(await readGuard(refused.connect, []), { ok: false, code: 'GUARD_UNAVAILABLE' });
  for (const text of [READER_IDENTITY_SQL, READER_BEGIN_SQL, READER_HEADS_SQL]) {
    const db = simulatedReaderDb(ROWS());
    db.state.failOn = text;
    assert.deepEqual(await readGuard(db.connect, []), { ok: false, code: 'GUARD_UNAVAILABLE' }, text);
    assert.equal(db.state.open, 0);
  }
  const rewrites: Array<(text: string, rows: readonly unknown[]) => readonly unknown[]> = [
    (text, rows) => (text === READER_HEADS_SQL ? [...rows, rows[0]] : rows), // pseudônimo repetido
    (text, rows) => (text === READER_HEADS_SQL ? rows.map((row) => ({ ...(row as object), ledger_seq: 0 })) : rows),
    (text, rows) => (text === READER_HEADS_SQL ? rows.map((row) => ({ ...(row as object), extra: 1 })) : rows),
    (text, rows) => (text === READER_IDENTITY_SQL ? [] : rows),
    (text, rows) => (text === READER_IDENTITY_SQL ? [{ ...(rows[0] as object), can_publish: 'f' }] : rows),
    (text, rows) => (text === READER_ROWS_SQL ? [{ audit_ref: H('9'), key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') }] : rows), // linha não pedida
  ];
  for (const rewrite of rewrites) {
    const db = simulatedReaderDb(ROWS());
    db.state.rewrite = rewrite;
    assert.deepEqual(await readGuard(db.connect, [asRow(ROWS()[0] as SimulatedHeadRow)]), { ok: false, code: 'GUARD_RESPONSE_INVALID' });
    assert.equal(db.state.open, 0);
  }
});

test(`G1.b.2b leitor: mais de ${MAX_GUARD_HEADS} pseudônimos ⇒ TOO_MANY_GUARD_HEADS (nunca uma leitura truncada em silêncio)`, async () => {
  const db = simulatedReaderDb([]);
  db.state.rewrite = (text, rows) => (text === READER_HEADS_SQL ? Array.from({ length: MAX_GUARD_HEADS + 1 }, (_, index) => ({ audit_ref: index.toString(16).padStart(64, '0'), key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') })) : rows);
  assert.deepEqual(await readGuard(db.connect, []), { ok: false, code: 'TOO_MANY_GUARD_HEADS' });
});

test('G1.b.2b leitor: PRAZO total esgotado (consulta que não responde) ⇒ GUARD_UNAVAILABLE e a conexão é encerrada; conexão que abre depois do prazo é encerrada sem consultar', async () => {
  const db = simulatedReaderDb(ROWS());
  db.state.hangOn = READER_HEADS_SQL;
  const clock = manualTimer();
  const pending = readGuard(db.connect, [], { timer: clock.timer });
  await new Promise((resolve) => setImmediate(resolve));
  clock.fire();
  assert.deepEqual(await pending, { ok: false, code: 'GUARD_UNAVAILABLE' });
  assert.equal(db.state.open, 0);

  let release: (value: void) => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = simulatedReaderDb(ROWS());
  const lateConnect = async () => {
    await gate;
    return slow.connect();
  };
  const late = manualTimer();
  const lateRead = readGuard(lateConnect, [], { timer: late.timer });
  late.fire();
  assert.deepEqual(await lateRead, { ok: false, code: 'GUARD_UNAVAILABLE' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([slow.state.connects, slow.state.open, slow.queries.length], [1, 0, 0]);
});

test('G1.b.2b leitor × migração 004 (estático): o SQL fixo do leitor cita só o esquema, a tabela, as colunas e a assinatura da função que a migração cria; o papel é o que ela cria com SELECT e sessão somente leitura; nada de `unnest` qualificado com vários argumentos', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'proposed', '004_link_audit_guard.sql'), 'utf8');
  assert.equal(READER_ROLE, GUARD_READER_ROLE);
  assert.match(migration, /create role gmn_guard_reader login/);
  assert.match(migration, /alter role gmn_guard_reader set default_transaction_read_only = on;/);
  assert.match(migration, /grant select on table gmn_link_audit_guard\.ledger_heads to gmn_guard_writer, gmn_guard_reader;/);
  assert.match(migration, /create or replace function gmn_link_audit_guard\.publish_head\(p_audit_ref text, p_key_id text, p_ledger_seq integer, p_sha256 text\)/);
  assert.match(READER_IDENTITY_SQL, /'gmn_link_audit_guard\.publish_head\(text, text, integer, text\)', 'EXECUTE'/);
  for (const column of ['audit_ref', 'key_id', 'ledger_seq', 'sha256']) assert.match(migration, new RegExp(`\\n  ${column} (text|integer) not null`), column);
  for (const sql of [READER_HEADS_SQL, READER_ROWS_SQL]) {
    assert.match(sql, /from gmn_link_audit_guard\.ledger_heads h /);
    assert.match(sql, /^select (distinct on \(h\.audit_ref\) )?h\.audit_ref, h\.key_id, h\.ledger_seq, h\.sha256 from /);
  }
  assert.ok(!/pg_catalog\.unnest\([^)]*,/.test(READER_ROWS_SQL), 'a forma unnest(a, b) só existe sem o esquema (o Postgres real recusa a qualificada)');
  assert.match(READER_ROWS_SQL, /rows from \(pg_catalog\.unnest\(\$1::text\[\]\), pg_catalog\.unnest\(\$2::text\[\]\)\)/);
});
