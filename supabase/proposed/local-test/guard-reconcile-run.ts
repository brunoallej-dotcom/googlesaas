/*
 * Etapa 3 do teste local da guarda (chamada por `guard-run.sh`, fora do `npm test`; G1.b.2b): a RECONCILIAÇÃO EXTERNA de verdade — o CLI
 * (`runGuardReconcileCli`, com o SQL fixo do leitor em `reader.ts`) — contra a migração 004 APLICADA num PostgreSQL do Supabase descartável, sem rede.
 * As cabeças são publicadas pelo ADAPTADOR REAL (`createPostgresGuard`) como `gmn_guard_writer`; a reconciliação lê como `gmn_guard_reader`.
 *
 * Como o papel é assumido: a imagem só confia no `supabase_admin` pelo soquete Unix (os outros papéis entram por `peer`), e o login real pelo loopback
 * só existe DENTRO do contêiner (`--network none`). Então cada conexão entra como `supabase_admin`, lê os ajustes do papel gravados pela migração
 * (`pg_db_role_setting`: `default_transaction_read_only`, `statement_timeout`…) e faz `SET SESSION AUTHORIZATION <papel>` aplicando esses ajustes, como
 * um login aplicaria. Daí em diante `current_user`, os privilégios e o `has_function_privilege` são os do papel. O login REAL do leitor (sessão
 * somente leitura por padrão) é conferido em `guard-run.sh` (etapa 8). O TLS do conector de produção é provado nos testes do repositório.
 *
 * Também demonstra o LIMITE DECLARADO da G1.b.2a: o superusuário (o dono/administrador do projeto) desliga os gatilhos com
 * `session_replication_role = replica` e apaga uma cabeça; a aplicação não percebe, a reconciliação seguinte acusa `GUARD_REGRESSED`.
 *
 * Uso: node --require ./tests/register-typescript.cjs supabase/proposed/local-test/guard-reconcile-run.ts <pasta-do-soquete>
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { createPostgresGuard } from '../../../src/lib/link-audit-ledger/guard-postgres';
import { createGuardPseudonyms } from '../../../src/lib/link-audit-ledger/guard-pseudonym';
import type { GuardDbConnect } from '../../../src/lib/link-audit-ledger/guard-postgres';
import { runGuardReconcileCli } from '../../../src/lib/link-audit-guard-reconcile/cli';
import { READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL, READER_ROWS_SQL } from '../../../src/lib/link-audit-guard-reconcile/reader';
import { headAt, ledgerOf, writeRound } from '../../../tests/helpers/link-audit-guard-reconcile-fixtures';
import { testKeyMaterial, testKeySpec } from '../../../tests/helpers/link-audit-origin-fixtures';

const socketDir = process.argv[2];
if (!socketDir) throw new Error('uso: guard-reconcile-run.ts <pasta-do-soquete>');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const A = 'auditoria-reconc-01';
const B = 'auditoria-reconc-02';
const LEDGERS = { [A]: ledgerOf(A, 7), [B]: ledgerOf(B, 3) };
const PSEUDONYMS = createGuardPseudonyms({ id: 'gk-test-a', hex: testKeyMaterial('guard-a') });
const READER_SQL = new Set([READER_IDENTITY_SQL, READER_BEGIN_SQL, READER_HEADS_SQL, READER_ROWS_SQL, READER_END_SQL]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-guard-reconc-'));
const cleanup: string[] = [scratch];
let count = 0;
const ok = (label: string): void => {
  count += 1;
  console.log(`OK    reconciliação real: ${label}`);
};

const ROLES = { reader: 'gmn_guard_reader', writer: 'gmn_guard_writer' } as const;
const sent: string[] = [];
/** Conexão pelo soquete como `supabase_admin`, assumindo o papel com os AJUSTES dele (como um login). */
const connectAs = (role: (typeof ROLES)[keyof typeof ROLES]): GuardDbConnect => async () => {
  const client = new Client({ host: socketDir, port: 5432, user: 'supabase_admin', database: 'postgres' });
  client.on('error', () => undefined);
  await client.connect();
  const settings = (await client.query("select pg_catalog.unnest(s.setconfig) as kv from pg_catalog.pg_db_role_setting s join pg_catalog.pg_roles r on r.oid = s.setrole where r.rolname = $1 and s.setdatabase = 0", [role])).rows as Array<{ kv: string }>;
  await client.query(`set session authorization ${role}`); // nome fixo (ROLES), nunca entrada externa
  for (const { kv } of settings) {
    const at = kv.indexOf('=');
    await client.query('select pg_catalog.set_config($1, $2, false)', [kv.slice(0, at), kv.slice(at + 1)]);
  }
  return {
    async query(text, values) {
      if (role === ROLES.reader) sent.push(text);
      const result = await client.query({ text, values: [...values] });
      return { rows: result.rows };
    },
    end: () => client.end(),
  };
};

function makeCa(): string {
  const run = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(scratch, 'ca.priv.pem'), '-out', path.join(scratch, 'ca.pem'), '-days', '1', '-subj', '/CN=gmn-teste-ca'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`openssl: ${run.stderr}`);
  return fs.readFileSync(path.join(scratch, 'ca.pem'), 'utf8');
}

async function cli(argv: string[], role: (typeof ROLES)[keyof typeof ROLES]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const env = { GMN_LINK_AUDIT_GUARD_READER_DB_URL: 'postgresql://gmn_guard_reader:sentinela-local@127.0.0.1:5432/postgres?sslmode=verify-full', GMN_LINK_AUDIT_GUARD_READER_DB_CA: CA, GMN_LINK_AUDIT_GUARD_KEY: testKeySpec('gk-test-a', 'guard-a') };
  const code = await runGuardReconcileCli([...argv, '--json'], (line) => out.push(line), () => undefined, { env, projectRoot: ROOT, connectFor: () => connectAs(role) });
  return { code, json: JSON.parse(out.join('\n')) as Record<string, unknown> };
}

const CA = makeCa();

async function main(): Promise<void> {
  const writer = createPostgresGuard({ pseudonyms: PSEUDONYMS, connect: connectAs(ROLES.writer) });
  for (const [auditId, seqs] of [[A, [1, 5, 7]], [B, [1, 3]]] as const) {
    for (const seq of seqs) assert.deepEqual(await writer.publish({ auditId, ...headAt(LEDGERS[auditId], seq) }), { ok: true });
  }
  const round = writeRound(LEDGERS);
  cleanup.push(path.dirname(round));
  const records = path.join(scratch, 'registros');
  fs.mkdirSync(records, { mode: 0o700 });

  const first = await cli(['reconcile', '--backup', round, '--records-dir', records, '--first'], ROLES.reader);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.deepEqual(first.json.summary, { audits: 2, consistent: 2, behind: 0, noHead: 0, divergent: 0, headsOnRetiredKey: 0, guardHeads: 2, findings: 0 });
  assert.deepEqual(first.json.reader, { role: 'gmn_guard_reader', readOnly: true });
  assert.ok([...new Set(sent)].every((text) => READER_SQL.has(text)), 'só o SQL fixo do leitor');
  ok('o CLI lê como gmn_guard_reader (identidade, transação read only, cabeças) e concilia as cabeças publicadas pelo adaptador real com a rodada: 2 CONSISTENT, código 0, registro 1');

  const gate = await cli(['gate', '--backup', round], ROLES.reader);
  assert.deepEqual([gate.code, gate.json.operational, gate.json.code], [0, true, null]);
  ok('portão G-1 contra a guarda real: configuração, leitor e auditorias CONSISTENT ⇒ operante, código 0');

  const asWriter = await cli(['reconcile', '--backup', round, '--records-dir', records], ROLES.writer);
  assert.deepEqual([asWriter.code, asWriter.json.code], [3, 'NOT_READER_ROLE']);
  assert.deepEqual(fs.readdirSync(records), ['reconcile-000001.json']);
  ok('com a sessão do ESCRITOR (gmn_guard_writer, que publica) a reconciliação recusa sem ler cabeças e não grava registro (código 3)');

  // o LIMITE DECLARADO: o superusuário desliga os gatilhos e apaga a cabeça 7 de A
  const admin = new Client({ host: socketDir, port: 5432, user: 'supabase_admin', database: 'postgres' });
  await admin.connect();
  try {
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    const deleted = await admin.query('delete from gmn_link_audit_guard.ledger_heads where audit_ref = $1 and ledger_seq = 7', [PSEUDONYMS.current(A).auditRef]);
    await admin.query('commit');
    assert.equal(deleted.rowCount, 1, 'os gatilhos não barram com session_replication_role = replica');
  } finally {
    await admin.end();
  }
  const second = await cli(['reconcile', '--backup', round, '--records-dir', records], ROLES.reader);
  assert.equal(second.code, 2, JSON.stringify(second.json));
  assert.deepEqual(second.json.findings, [{ code: 'GUARD_REGRESSED', auditRef: PSEUDONYMS.current(A).auditRef, auditId: A, backupSeq: 7, guardSeq: 5, recordedSeq: 7 }]);
  assert.deepEqual(fs.readdirSync(records).sort(), ['reconcile-000001.json', 'reconcile-000002.json']);
  assert.ok(sent.includes(READER_ROWS_SQL), 'conferiu as linhas do registro anterior pela posição');
  ok('limite declarado da G1.b.2a: superusuário com session_replication_role = replica apaga uma cabeça; a reconciliação seguinte acusa GUARD_REGRESSED (código 2) e grava o registro 2 que continua cobrando a linha');

  const probe = new Client({ host: socketDir, port: 5432, user: 'supabase_admin', database: 'postgres' });
  await probe.connect();
  try {
    let open = -1;
    for (let attempt = 0; attempt < 20 && open !== 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      open = ((await probe.query("select count(*)::int as n from pg_stat_activity where usename = 'supabase_admin' and pid <> pg_backend_pid() and backend_type = 'client backend'")).rows[0] as { n: number }).n;
    }
    assert.equal(open, 0, 'nenhuma conexão da reconciliação ficou aberta');
  } finally {
    await probe.end();
  }
  ok('sem vazamento: todas as conexões do leitor e do escritor foram encerradas');
  console.log(`RECONCILIAÇÃO: ${count} verificações aprovadas`);
}

main()
  .catch((error: unknown) => {
    console.error(`FALHOU (reconciliação real): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });
