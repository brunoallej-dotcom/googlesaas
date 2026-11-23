/*
 * Etapa 2 do teste local da guarda (chamada por `guard-run.sh`, fora do `npm test`): o ADAPTADOR REAL (`createPostgresGuard`, as duas consultas fixas
 * `GUARD_PUBLISH_SQL` e `GUARD_LATEST_SQL`, o mapeamento dos desfechos e a leitura por pseudônimos) contra a migração 004 APLICADA num PostgreSQL do
 * Supabase descartável, sem rede: a conexão é pelo soquete Unix montado do contêiner, como `supabase_admin` (confiança local da imagem) e, antes de
 * qualquer consulta, `SET ROLE gmn_guard_writer` — então cada consulta roda com os privilégios do papel de escrita. O TLS e os prazos do conector de
 * produção (`guard-pg.ts`) não entram aqui (soquete local); são provados em `tests/link-audit-guard-pg.test.ts`.
 *
 * Uso: node --require ./tests/register-typescript.cjs supabase/proposed/local-test/guard-adapter-run.ts <pasta-do-soquete>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { createPostgresGuard, type GuardDbConnect } from '../../../src/lib/link-audit-ledger/guard-postgres';
import { createGuardPseudonyms } from '../../../src/lib/link-audit-ledger/guard-pseudonym';

const socketDir = process.argv[2];
if (!socketDir) throw new Error('uso: guard-adapter-run.ts <pasta-do-soquete>');
const material = (label: string): string => createHash('sha256').update(`gmn-test-only/origin/${label}`).digest('hex');
const KEY_A = { id: 'gk-test-a', hex: material('guard-a') };
const KEY_B = { id: 'gk-test-b', hex: material('guard-b') };
const AUD = 'auditoria-local-01';
const H = (c: string): string => c.repeat(64);
let count = 0;
const ok = (label: string): void => {
  count += 1;
  console.log(`OK    adaptador real: ${label}`);
};

const sent: string[] = [];
const connect: GuardDbConnect = async () => {
  const client = new Client({ host: socketDir, port: 5432, user: 'supabase_admin', database: 'postgres' });
  client.on('error', () => undefined);
  await client.connect();
  await client.query('set role gmn_guard_writer');
  return {
    async query(text, values) {
      sent.push(JSON.stringify([text, values]));
      const result = await client.query({ text, values: [...values] });
      return { rows: result.rows };
    },
    end: () => client.end(),
  };
};

async function main(): Promise<void> {
  const before = createPostgresGuard({ pseudonyms: createGuardPseudonyms(KEY_A), connect });
  assert.deepEqual(await before.latest(AUD), { ok: true, head: null });
  assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: true });
  assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('c') }), { ok: true });
  assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: 1, sha256: H('a') }), { ok: true }, 'ALREADY_RECORDED');
  assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('d') }), { ok: false, reason: 'CONFLICT' });
  assert.deepEqual(await before.publish({ auditId: AUD, ledgerSeq: 2, sha256: H('b') }), { ok: false, reason: 'STALE' });
  assert.deepEqual(await before.latest(AUD), { ok: true, head: { ledgerSeq: 3, sha256: H('c') } });
  ok('regra 7 pela função de publicação (RECORDED, ALREADY_RECORDED ⇒ ok; CONFLICT; STALE) e latest = a maior, com o SQL fixo do adaptador');

  const rotated = createPostgresGuard({ pseudonyms: createGuardPseudonyms(KEY_B, [KEY_A]), connect });
  assert.deepEqual(await rotated.latest(AUD), { ok: true, head: { ledgerSeq: 3, sha256: H('c') } }, 'a cabeça da aposentada é achada');
  assert.deepEqual(await rotated.publish({ auditId: AUD, ledgerSeq: 3, sha256: H('c') }), { ok: true }, 'a primeira com a chave nova');
  assert.deepEqual(await rotated.publish({ auditId: AUD, ledgerSeq: 5, sha256: H('e') }), { ok: true });
  assert.deepEqual(await rotated.latest(AUD), { ok: true, head: { ledgerSeq: 5, sha256: H('e') } });
  ok('rotação: publica só com a chave atual; latest lê os pseudônimos das duas chaves e fica com a maior');

  const admin = new Client({ host: socketDir, port: 5432, user: 'supabase_admin', database: 'postgres' });
  await admin.connect();
  try {
    const rows = (await admin.query('select audit_ref, key_id, ledger_seq from gmn_link_audit_guard.ledger_heads order by key_id, ledger_seq')).rows as Array<{ audit_ref: string; key_id: string; ledger_seq: number }>;
    const refA = createGuardPseudonyms(KEY_A).current(AUD).auditRef;
    const refB = createGuardPseudonyms(KEY_B).current(AUD).auditRef;
    assert.deepEqual(rows, [
      { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1 },
      { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 3 },
      { audit_ref: refB, key_id: 'gk-test-b', ledger_seq: 3 },
      { audit_ref: refB, key_id: 'gk-test-b', ledger_seq: 5 },
    ]);
    const stored = JSON.stringify((await admin.query('select * from gmn_link_audit_guard.ledger_heads')).rows);
    assert.ok(!stored.includes(AUD) && !sent.join('\n').includes(AUD), 'o auditId nunca chegou ao banco');
    ok('no banco só o pseudônimo HMAC e o id da chave de cada registro; o auditId em claro nunca saiu do processo');
    let open = -1;
    for (let attempt = 0; attempt < 20 && open !== 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100)); // o processo do servidor sai logo depois do fim do soquete
      open = ((await admin.query("select count(*)::int as n from pg_stat_activity where usename = 'supabase_admin' and pid <> pg_backend_pid() and backend_type = 'client backend'")).rows[0] as { n: number }).n;
    }
    assert.equal(open, 0, 'nenhuma conexão do adaptador ficou aberta');
    ok('sem vazamento: todas as conexões do adaptador foram encerradas');
  } finally {
    await admin.end();
  }
  console.log(`ADAPTADOR: ${count} verificações aprovadas`);
}

main().catch((error: unknown) => {
  console.error(`FALHOU (adaptador real): ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
