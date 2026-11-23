import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { GUARD_DB_URL_ENV, GUARD_KEY_ENV, GUARD_READER_DB_CA_ENV, GUARD_READER_DB_URL_ENV, GUARD_READER_ROLE, GUARD_RETIRED_KEYS_ENV, guardReaderConfigFromEnv } from '../src/lib/link-audit-ledger/config';
import { GUARD_DB_APPLICATION_NAME, GUARD_READER_APPLICATION_NAME, GUARD_READER_TIMEOUT_MS, pgClientConfig, pgGuardReaderConnector, pgReaderClientConfig, type GuardDbTarget } from '../src/lib/link-audit-ledger/guard-pg';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { makeTestPki } from './helpers/link-audit-guard-pki-fixtures';
import { testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * G1.b.2b — CONFIGURAÇÃO DO LEITOR da guarda (reconciliação externa, GE-E5; spec §5.1.6: o papel `gmn_guard_reader`, cuja credencial NÃO fica na
 * VPS) e o CONECTOR de leitura (o mesmo TLS `verify-full` da G1.b.2a, com prazos e nome de aplicação próprios). Variáveis PRÓPRIAS do leitor, nunca
 * as do escritor: a presença da credencial de escrita no ambiente da reconciliação é recusada. Marcadores óbvios (`sentinela`, `127.0.0.1`).
 */
registerCleanup();
const PKI = makeTestPki();
const CA = PKI?.caPem ?? '';
const NEEDS_CA = { skip: PKI === null ? 'openssl ausente' : false };
const PASSWORD = 'sentinela-leitor';
const READER_URL = `postgresql://gmn_guard_reader:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full`;
const GUARD_A = testKeySpec('gk-test-a', 'guard-a');
const GUARD_B = testKeySpec('gk-test-b', 'guard-b');
const full = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ [GUARD_READER_DB_URL_ENV]: READER_URL, [GUARD_READER_DB_CA_ENV]: CA, [GUARD_KEY_ENV]: GUARD_A, ...over });
const codeOf = (env: Record<string, string | undefined>): string => {
  const config = guardReaderConfigFromEnv(env);
  return config.status === 'INVALID' ? config.code : config.status;
};

test('G1.b.2b leitor: nomes próprios das variáveis (nunca as do escritor) e o papel de leitura da migração 004', () => {
  assert.deepEqual([GUARD_READER_DB_URL_ENV, GUARD_READER_DB_CA_ENV, GUARD_READER_ROLE], ['GMN_LINK_AUDIT_GUARD_READER_DB_URL', 'GMN_LINK_AUDIT_GUARD_READER_DB_CA', 'gmn_guard_reader']);
  assert.notEqual(GUARD_READER_DB_URL_ENV, GUARD_DB_URL_ENV);
});

test('G1.b.2b leitor: sem nenhuma variável ⇒ NOT_CONFIGURED; parcial ⇒ GUARD_CONFIG_PARTIAL', () => {
  assert.deepEqual(guardReaderConfigFromEnv({}), { status: 'NOT_CONFIGURED' });
  assert.deepEqual(guardReaderConfigFromEnv({ [GUARD_READER_DB_URL_ENV]: '', [GUARD_KEY_ENV]: '' }), { status: 'NOT_CONFIGURED' }, 'vazio = ausente');
  for (const env of [{ [GUARD_READER_DB_URL_ENV]: READER_URL }, { [GUARD_KEY_ENV]: GUARD_A }, { [GUARD_READER_DB_CA_ENV]: 'x' }, { [GUARD_RETIRED_KEYS_ENV]: GUARD_B }, { [GUARD_READER_DB_URL_ENV]: READER_URL, [GUARD_KEY_ENV]: GUARD_A }]) {
    assert.equal(codeOf(env), 'GUARD_CONFIG_PARTIAL', JSON.stringify(Object.keys(env)));
  }
});

test('G1.b.2b leitor: configuração completa ⇒ READY com o destino TLS e os pseudônimos de TODAS as chaves (atual e aposentadas); nada de segredo serializado', NEEDS_CA, () => {
  const config = guardReaderConfigFromEnv(full({ [GUARD_RETIRED_KEYS_ENV]: GUARD_B }));
  assert.equal(config.status, 'READY');
  if (config.status !== 'READY') return;
  assert.deepEqual([config.settings.target.host, config.settings.target.port, config.settings.target.user, config.settings.target.password], ['127.0.0.1', 6543, 'gmn_guard_reader', PASSWORD]);
  assert.deepEqual(config.settings.pseudonyms.keyIds, ['gk-test-a', 'gk-test-b']);
  const shown = `${JSON.stringify(config)} ${inspect(config, { depth: 6 })}`;
  for (const secret of [PASSWORD, testKeyMaterial('guard-a'), testKeyMaterial('guard-b')]) assert.ok(!shown.includes(secret));
  // pooler do Supabase: usuário `<papel>.<ref do projeto>`
  const pooled = guardReaderConfigFromEnv(full({ [GUARD_READER_DB_URL_ENV]: `postgresql://gmn_guard_reader.projeto-sentinela:${PASSWORD}@127.0.0.1:5432/postgres?sslmode=verify-full` }));
  assert.equal(pooled.status, 'READY');
});

test('G1.b.2b leitor: NUNCA a credencial do escritor — a variável do escritor (valor ou arquivo) no mesmo ambiente ou outro papel na URL ⇒ recusado', NEEDS_CA, () => {
  assert.equal(codeOf(full({ [GUARD_DB_URL_ENV]: READER_URL })), 'GUARD_WRITER_CREDENTIAL_PRESENT');
  assert.equal(codeOf(full({ [`${GUARD_DB_URL_ENV}_FILE`]: '/run/secrets/sentinela' })), 'GUARD_WRITER_CREDENTIAL_PRESENT');
  assert.equal(codeOf({ [GUARD_DB_URL_ENV]: READER_URL }), 'GUARD_WRITER_CREDENTIAL_PRESENT', 'mesmo sem nada do leitor: a credencial de escrita não entra');
  for (const user of ['gmn_guard_writer', 'postgres', 'gmn_guard_readerx', 'gmn_guard_writer.gmn_guard_reader']) {
    assert.equal(codeOf(full({ [GUARD_READER_DB_URL_ENV]: `postgresql://${user}:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full` })), 'GUARD_READER_ROLE_REQUIRED', user);
  }
});

test('G1.b.2b leitor: mesma política da URL e da CA da G1.b.2a (verify-full obrigatório, nenhum outro parâmetro, CA X.509 sem chave privada) e chaves bem formadas', NEEDS_CA, () => {
  assert.equal(codeOf(full({ [GUARD_READER_DB_URL_ENV]: READER_URL.replace('verify-full', 'require') })), 'GUARD_DB_TLS_REQUIRED');
  assert.equal(codeOf(full({ [GUARD_READER_DB_URL_ENV]: `${READER_URL}&options=-c%20x` })), 'GUARD_DB_URL_INVALID');
  assert.equal(codeOf(full({ [GUARD_READER_DB_CA_ENV]: 'não é PEM' })), 'GUARD_DB_CA_INVALID');
  assert.equal(codeOf(full({ [GUARD_KEY_ENV]: 'gk-test-a:curta' })), 'GUARD_KEY_WEAK');
  assert.equal(codeOf(full({ [GUARD_RETIRED_KEYS_ENV]: `${GUARD_B}, ${GUARD_B}` })), 'GUARD_KEY_WEAK');
  assert.equal(codeOf(full({ [GUARD_RETIRED_KEYS_ENV]: GUARD_A })), 'GUARD_CONFIG_INVALID', 'a mesma chave duas vezes');
});

const targetOf = (caPem: string): GuardDbTarget => Object.defineProperty({ host: '127.0.0.1', port: 6543, database: 'postgres', user: GUARD_READER_ROLE, caPem }, 'password', { value: PASSWORD, enumerable: false }) as GuardDbTarget;

test('G1.b.2b conector de LEITURA: o mesmo TLS verificado do escritor (rejectUnauthorized + CA fornecida), prazos de leitura próprios e nome de aplicação próprio', () => {
  const reader = pgReaderClientConfig(targetOf('ca'));
  const writer = pgClientConfig(targetOf('ca'));
  assert.deepEqual(reader.ssl, writer.ssl);
  assert.deepEqual(reader.ssl, { rejectUnauthorized: true, ca: 'ca', minVersion: 'TLSv1.2' });
  assert.equal(reader.connectionTimeoutMillis, GUARD_READER_TIMEOUT_MS);
  assert.equal(reader.query_timeout, GUARD_READER_TIMEOUT_MS);
  assert.equal(reader.application_name, GUARD_READER_APPLICATION_NAME);
  assert.notEqual(GUARD_READER_APPLICATION_NAME, GUARD_DB_APPLICATION_NAME);
  assert.equal(reader.keepAlive, false);
  assert.ok(!('connectionString' in reader));
  assert.throws(() => pgGuardReaderConnector({ ...targetOf(''), password: PASSWORD } as GuardDbTarget), /CA/);
});

test('G1.b.2b conector de LEITURA: registra o ouvinte de erro antes de conectar e encerra o cliente que falhou', async () => {
  const calls: string[] = [];
  const fakeClient = {
    on(event: string) {
      calls.push(`on:${event}`);
      return fakeClient;
    },
    async connect() {
      calls.push('connect');
      throw new Error('sentinela: recusada');
    },
    async end() {
      calls.push('end');
    },
  };
  let seen: unknown = null;
  // o tipo do Client do pg é largo; o teste injeta só o que o conector usa
  const connect = pgGuardReaderConnector(targetOf('ca'), (config) => {
    seen = config;
    return fakeClient as unknown as import('pg').Client;
  });
  await assert.rejects(connect());
  assert.deepEqual(calls, ['on:error', 'connect', 'end']);
  assert.equal((seen as { application_name: string }).application_name, GUARD_READER_APPLICATION_NAME);
});
