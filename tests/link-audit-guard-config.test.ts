import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { ledgerForRoutes } from '../src/app/api/link-audit/decisions/ledger-wiring';
import { HTTP_STATUS } from '../src/lib/link-audit-decisions';
import { guardAlarmLogEntry, ledgerConfigFromEnv, LEDGER_DIR_ENV, LEDGER_KEY_ENV, LEDGER_RETIRED_KEYS_ENV, type GuardAlarm } from '../src/lib/link-audit-ledger';
import { GUARD_DB_CA_ENV, GUARD_DB_URL_ENV, GUARD_KEY_ENV, GUARD_RETIRED_KEYS_ENV, guardConfigFromEnv, LOG_KEY_ENV_NAME, phase6KeyFingerprints } from '../src/lib/link-audit-ledger/config';
import { LOG_KEY_ENV, operatorRefSourceFromEnv } from '../src/lib/link-audit-observability';
import { ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV } from '../src/lib/link-audit-origin';
import { ANA, BIA, clock, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { makeTestPki } from './helpers/link-audit-guard-pki-fixtures';
import { applyLedgerEnv, decisionsOver, LEDGER_KEY_A, ledgerWorld, NO_RESULTS } from './helpers/link-audit-ledger-fixtures';
import { testKeyMaterial, testKeySpec, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';

/*
 * G1.b.2a — CONFIGURAÇÃO E LIGAÇÃO DA GUARDA (GE-E2, PG-G07; spec §5.1.3, §5.1.7, §5.3.1). Só o módulo do livro lê a credencial, a CA e a chave do
 * pseudônimo (como as chaves do livro). Sem nada da guarda ⇒ `externalGuard: NOT_CONFIGURED` (como hoje). Configuração PARCIAL ou INVÁLIDA ⇒ falha
 * FECHADA do livro inteiro (`LEDGER_NOT_CONFIGURED`, 503 nas escritas): rodar sem a guarda quando ela foi pedida esconderia a falta de proteção.
 * URL de conexão de teste com marcadores óbvios (`sentinela`, `127.0.0.1`); chaves derivadas de rótulos; CA gerada na hora (`openssl`, pasta temporária).
 */
registerCleanup();
const PKI = makeTestPki();
const CA = PKI?.caPem ?? '';
const NEEDS_CA = { skip: PKI === null ? 'openssl ausente' : false };
const PASSWORD = 'sentinela-senha';
const URL_OK = `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres?sslmode=verify-full`;
const GUARD_A = testKeySpec('gk-test-a', 'guard-a');
const GUARD_B = testKeySpec('gk-test-b', 'guard-b');
const DIR = '/data/gmn-link-audit-ledger';
const full = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ [GUARD_DB_URL_ENV]: URL_OK, [GUARD_DB_CA_ENV]: CA, [GUARD_KEY_ENV]: GUARD_A, ...over });
const codeOf = (env: Record<string, string | undefined>): string => {
  const config = guardConfigFromEnv(env);
  return config.status === 'INVALID' ? config.code : config.status;
};

/* ============================================================================ nomes e leitura */

test('GE-E2: nomes das variáveis da guarda (spec §5.3.1) e o nome da chave de log DUPLICADO de propósito (sem import cruzado) igual ao da observabilidade', () => {
  assert.deepEqual([GUARD_DB_URL_ENV, GUARD_DB_CA_ENV, GUARD_KEY_ENV, GUARD_RETIRED_KEYS_ENV], ['GMN_LINK_AUDIT_GUARD_DB_URL', 'GMN_LINK_AUDIT_GUARD_DB_CA', 'GMN_LINK_AUDIT_GUARD_KEY', 'GMN_LINK_AUDIT_GUARD_RETIRED_KEYS']);
  assert.equal(LOG_KEY_ENV_NAME, LOG_KEY_ENV);
});

test('PG-G07 (configuração): sem NENHUMA variável da guarda ⇒ NOT_CONFIGURED e o livro segue configurado sem guarda (comportamento de antes)', () => {
  assert.deepEqual(guardConfigFromEnv({}), { status: 'NOT_CONFIGURED' });
  assert.deepEqual(guardConfigFromEnv({ [GUARD_DB_URL_ENV]: '', [GUARD_KEY_ENV]: '' }), { status: 'NOT_CONFIGURED' }, 'vazio = ausente');
  const ledger = ledgerConfigFromEnv({ [LEDGER_DIR_ENV]: DIR, [LEDGER_KEY_ENV]: LEDGER_KEY_A });
  assert.ok(ledger.ok && ledger.guard === null);
});

test('configuração COMPLETA ⇒ READY: destino com TLS, pseudônimos da chave atual (e das aposentadas); a senha e o material nunca aparecem em JSON nem inspect', NEEDS_CA, () => {
  const config = guardConfigFromEnv(full({ [GUARD_RETIRED_KEYS_ENV]: GUARD_B }));
  assert.equal(config.status, 'READY');
  if (config.status !== 'READY') return;
  const { target, pseudonyms } = config.settings;
  assert.deepEqual([target.host, target.port, target.database, target.user, target.password, target.caPem], ['127.0.0.1', 6543, 'postgres', 'gmn_guard_writer', PASSWORD, CA]);
  assert.deepEqual([pseudonyms.currentKeyId, pseudonyms.keyIds], ['gk-test-a', ['gk-test-a', 'gk-test-b']]);
  const ledger = ledgerConfigFromEnv({ [LEDGER_DIR_ENV]: DIR, [LEDGER_KEY_ENV]: LEDGER_KEY_A, ...full() });
  assert.ok(ledger.ok && ledger.guard !== null && ledger.guard.pseudonyms.currentKeyId === 'gk-test-a');
  const shown = `${JSON.stringify(config)} ${inspect(config, { depth: 6 })} ${JSON.stringify(ledger)}`;
  for (const secret of [PASSWORD, testKeyMaterial('guard-a'), testKeyMaterial('guard-b')]) assert.ok(!shown.includes(secret), 'nada de segredo serializado');
  // porta padrão 5432; IPv6 sem colchetes; usuário e senha com escape de URL
  const v6 = guardConfigFromEnv(full({ [GUARD_DB_URL_ENV]: 'postgres://gmn_guard_writer.projeto%2Dsentinela:sen%40tinela@[::1]/postgres?sslmode=verify-full' }));
  assert.ok(v6.status === 'READY' && v6.settings.target.host === '::1' && v6.settings.target.port === 5432 && v6.settings.target.user === 'gmn_guard_writer.projeto-sentinela' && v6.settings.target.password === 'sen@tinela');
});

/* ============================================================================ falha fechada: parcial e inválida */

test('configuração PARCIAL (alguma variável da guarda sem as outras) ⇒ INVALID (GUARD_CONFIG_PARTIAL) e o livro inteiro falha fechado (LEDGER_GUARD_CONFIG_INVALID)', () => {
  const partials: Array<Record<string, string>> = [
    { [GUARD_DB_URL_ENV]: URL_OK },
    { [GUARD_KEY_ENV]: GUARD_A },
    { [GUARD_DB_CA_ENV]: 'qualquer' },
    { [GUARD_RETIRED_KEYS_ENV]: GUARD_B },
    { [GUARD_DB_URL_ENV]: URL_OK, [GUARD_KEY_ENV]: GUARD_A },
    { [GUARD_DB_URL_ENV]: URL_OK, [GUARD_DB_CA_ENV]: 'qualquer' },
    { [GUARD_KEY_ENV]: GUARD_A, [GUARD_DB_CA_ENV]: 'qualquer', [GUARD_RETIRED_KEYS_ENV]: GUARD_B },
  ];
  for (const env of partials) {
    assert.equal(codeOf(env), 'GUARD_CONFIG_PARTIAL', JSON.stringify(Object.keys(env)));
    const ledger = ledgerConfigFromEnv({ [LEDGER_DIR_ENV]: DIR, [LEDGER_KEY_ENV]: LEDGER_KEY_A, ...env });
    assert.ok(!ledger.ok && ledger.code === 'LEDGER_GUARD_CONFIG_INVALID' && ledger.guardCode === 'GUARD_CONFIG_PARTIAL');
  }
});

test('TLS obrigatório na URL: sem sslmode ou com qualquer modo diferente de verify-full (disable, allow, prefer, require, verify-ca, no-verify) ⇒ GUARD_DB_TLS_REQUIRED', NEEDS_CA, () => {
  const base = `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres`;
  assert.equal(codeOf(full({ [GUARD_DB_URL_ENV]: base })), 'GUARD_DB_TLS_REQUIRED');
  for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify', 'VERIFY-FULL', '']) {
    assert.equal(codeOf(full({ [GUARD_DB_URL_ENV]: `${base}?sslmode=${mode}` })), 'GUARD_DB_TLS_REQUIRED', mode);
  }
  assert.equal(codeOf(full({ [GUARD_DB_URL_ENV]: `${base}?sslmode=verify-full` })), 'READY');
});

test('URL inválida ⇒ GUARD_DB_URL_INVALID: esquema, host, soquete Unix, banco, usuário, senha, porta, fragmento, parâmetros além do sslmode (options, sslrootcert, host…) e sslmode repetido', NEEDS_CA, () => {
  const q = '?sslmode=verify-full';
  const bad = [
    'não é url',
    `https://gmn_guard_writer:${PASSWORD}@127.0.0.1/postgres${q}`,
    `mysql://gmn_guard_writer:${PASSWORD}@127.0.0.1/postgres${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@/postgres${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@%2Fvar%2Frun%2Fpostgresql/postgres${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/pg/extra${q}`,
    `postgresql://:${PASSWORD}@127.0.0.1:6543/postgres${q}`,
    `postgresql://gmn_guard_writer@127.0.0.1:6543/postgres${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:0/postgres${q}`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres${q}#frag`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres${q}&options=-c%20search_path%3Dpublic`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres${q}&sslrootcert=system`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres${q}&host=outro`,
    `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:6543/postgres${q}&sslmode=verify-full`,
    `postgresql://gmn_guard_writer:%E0%A4%A@127.0.0.1:6543/postgres${q}`,
  ];
  for (const url of bad) assert.equal(codeOf(full({ [GUARD_DB_URL_ENV]: url })), 'GUARD_DB_URL_INVALID', url.replace(PASSWORD, '***'));
  for (const url of bad) assert.ok(!JSON.stringify(guardConfigFromEnv(full({ [GUARD_DB_URL_ENV]: url }))).includes(PASSWORD), 'a resposta nunca cita a senha');
});

test('CA inválida ⇒ GUARD_DB_CA_INVALID: texto que não é certificado, PEM com chave privada junto, bloco corrompido', NEEDS_CA, () => {
  const begin = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
  const end = ['-----END', 'CERTIFICATE-----'].join(' ');
  const privateMarker = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  for (const ca of ['sentinela', `${begin}\nbm90LWEtY2VydA==\n${end}\n`, `${CA}\n${privateMarker}\nc2VudGluZWxh\n`]) {
    assert.equal(codeOf(full({ [GUARD_DB_CA_ENV]: ca })), 'GUARD_DB_CA_INVALID');
  }
  assert.equal(codeOf(full({ [GUARD_DB_CA_ENV]: `${CA}${PKI?.otherCaPem ?? ''}` })), 'READY', 'um pacote com mais de uma CA é aceito');
});

test('chave do pseudônimo: mesma política de formato e sanidade das outras chaves da Fase 6 — fraca, malformada, aposentada com data ou com espaço ⇒ GUARD_KEY_WEAK; id ou material repetido na própria guarda ⇒ GUARD_CONFIG_INVALID', NEEDS_CA, () => {
  for (const key of [`gk-fraca-a:${'0'.repeat(64)}`, 'senha-humana', `GK:${testKeyMaterial('guard-a')}`, `gk-test-a:${testKeyMaterial('guard-a').toUpperCase()}`]) {
    assert.equal(codeOf(full({ [GUARD_KEY_ENV]: key })), 'GUARD_KEY_WEAK', key.slice(0, 10));
  }
  for (const retired of [`${GUARD_B}:2026-12-01`, ` ${GUARD_B}`, `${GUARD_B},`, 'curta']) {
    assert.equal(codeOf(full({ [GUARD_RETIRED_KEYS_ENV]: retired })), 'GUARD_KEY_WEAK', retired.slice(0, 12));
  }
  assert.equal(codeOf(full({ [GUARD_RETIRED_KEYS_ENV]: testKeySpec('gk-test-a', 'guard-z') })), 'GUARD_CONFIG_INVALID', 'id repetido');
  assert.equal(codeOf(full({ [GUARD_RETIRED_KEYS_ENV]: testKeySpec('gk-test-z', 'guard-a') })), 'GUARD_CONFIG_INVALID', 'mesmo material sob outro id');
  assert.ok(!JSON.stringify(guardConfigFromEnv(full({ [GUARD_KEY_ENV]: 'senha-humana' }))).includes('senha-humana'));
});

test('chave do pseudônimo EXCLUSIVA (padrão de impressões digitais da G1.a): id ou material igual ao de uma chave de origem, do livro (atuais e aposentadas) ou de log ⇒ GUARD_KEY_REUSED', NEEDS_CA, () => {
  const reuse = (spec: string, label: string): string => `${spec.split(':')[0]}:${testKeyMaterial(label)}`;
  const cases: Array<[string, Record<string, string>]> = [
    ['material da origem atual', { [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY, [GUARD_KEY_ENV]: `gk-test-a:${TEST_ORIGIN_KEY.split(':')[1]}` }],
    ['id da origem atual', { [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY, [GUARD_KEY_ENV]: testKeySpec('ok-test-a', 'guard-a') }],
    ['material de uma aposentada da origem', { [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY, [ORIGIN_RETIRED_KEYS_ENV]: `${testKeySpec('ok-old-b', 'guard-a')}:2026-12-01` }],
    ['material do livro', { [LEDGER_KEY_ENV]: testKeySpec('lk-test-x', 'guard-a') }],
    ['id de uma aposentada do livro', { [LEDGER_KEY_ENV]: LEDGER_KEY_A, [LEDGER_RETIRED_KEYS_ENV]: `${testKeySpec('gk-test-a', 'ledger-old')}:2026-12-01` }],
    ['material da chave de log', { [LOG_KEY_ENV]: testKeySpec('lg-test-a', 'guard-a') }],
    ['id da chave de log', { [LOG_KEY_ENV]: testKeySpec('gk-test-a', 'log-a') }],
    ['aposentada da guarda igual à do livro', { [LEDGER_KEY_ENV]: LEDGER_KEY_A, [GUARD_RETIRED_KEYS_ENV]: reuse('gk-test-r', 'ledger-a') }],
  ];
  for (const [label, extra] of cases) assert.equal(codeOf(full(extra)), 'GUARD_KEY_REUSED', label);
  assert.equal(codeOf(full({ [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY, [LEDGER_KEY_ENV]: LEDGER_KEY_A, [LOG_KEY_ENV]: testKeySpec('lg-test-a', 'log-a') })), 'READY', 'controle: todas distintas');
});

test('PG-L01 estendido: as impressões digitais da Fase 6 incluem a guarda (atual e aposentadas), e a chave de LOG recusa reúso da chave da guarda', () => {
  const env = { [GUARD_KEY_ENV]: GUARD_A, [GUARD_RETIRED_KEYS_ENV]: GUARD_B };
  assert.deepEqual(phase6KeyFingerprints(env).map((pair) => pair.id), ['gk-test-a', 'gk-test-b']);
  assert.ok(!JSON.stringify(phase6KeyFingerprints(env)).includes(testKeyMaterial('guard-a')));
  const logEnv = { ...env, [LOG_KEY_ENV]: testKeySpec('lg-test-a', 'guard-b') };
  assert.equal(operatorRefSourceFromEnv(phase6KeyFingerprints(logEnv), logEnv).status, 'LOG_KEY_REUSED');
});

/* ============================================================================ ligação nas rotas (GE-E2, PG-G07) */

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const GUARD_VARS_OFF = { [GUARD_DB_URL_ENV]: undefined, [GUARD_DB_CA_ENV]: undefined, [GUARD_KEY_ENV]: undefined, [GUARD_RETIRED_KEYS_ENV]: undefined };

test('PG-G07 (rotas): sem credencial da guarda, ledgerForRoutes monta o livro SEM guarda ⇒ externalGuard: NOT_CONFIGURED (o que o portão G-1 acusa: a tela diz "Guarda externa NÃO configurada")', async () => {
  const w = await ledgerWorld();
  applyLedgerEnv(process.env, w);
  try {
    const view = await withEnv(GUARD_VARS_OFF, async () => {
      const listed = await decisionsOver(w, { ledger: ledgerForRoutes(w.otherDirs), knownHeads: NO_RESULTS }).list(BIA, w.auditId);
      assert.ok(listed.ok);
      return listed.value.ledger;
    });
    assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'NOT_CONFIGURED']);
  } finally {
    applyLedgerEnv(process.env, null);
  }
});

test('GE-E2 (rotas): configuração PARCIAL ⇒ o livro das rotas falha FECHADO (NOT_CONFIGURED, escrita LEDGER_NOT_CONFIGURED/503), com o motivo da guarda nas pendências', async () => {
  const w = await ledgerWorld();
  applyLedgerEnv(process.env, w);
  try {
    await withEnv({ ...GUARD_VARS_OFF, [GUARD_KEY_ENV]: GUARD_A }, async () => {
      const service = decisionsOver(w, { ledger: ledgerForRoutes(w.otherDirs), knownHeads: NO_RESULTS });
      const listed = await service.list(BIA, w.auditId);
      assert.ok(listed.ok);
      assert.deepEqual([listed.value.ledger.state, listed.value.ledger.reason, listed.value.ledger.externalGuard], ['HISTORY_UNRESOLVED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
      const write = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: listed.value.head }, clock());
      assert.ok(!write.ok && write.code === 'LEDGER_NOT_CONFIGURED' && HTTP_STATUS[write.code] === 503, JSON.stringify(write).slice(0, 200));
      assert.ok(!write.ok && write.issues.some((issue) => issue.includes('GUARD_CONFIG_PARTIAL')), 'o motivo (código, sem segredo) aparece');
      assert.ok(!JSON.stringify(write).includes(testKeyMaterial('guard-a')));
    });
  } finally {
    applyLedgerEnv(process.env, null);
  }
});

test('GE-E2 (rotas): configuração COMPLETA ⇒ a guarda REAL é ligada (o estado deixa de ser NOT_CONFIGURED); com o provedor inalcançável ⇒ GUARD_UNAVAILABLE, falha fechada, e o alarme vai ao logger sem PII', NEEDS_CA, async () => {
  const w = await ledgerWorld();
  applyLedgerEnv(process.env, w);
  const logged: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  try {
    await withEnv({ ...GUARD_VARS_OFF, ...full({ [GUARD_DB_URL_ENV]: `postgresql://gmn_guard_writer:${PASSWORD}@127.0.0.1:9/postgres?sslmode=verify-full` }) }, async () => {
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
      console.warn = console.error;
      const listed = await decisionsOver(w, { ledger: ledgerForRoutes(w.otherDirs), knownHeads: NO_RESULTS }).list(BIA, w.auditId);
      assert.ok(listed.ok);
      assert.deepEqual([listed.value.ledger.state, listed.value.ledger.reason, listed.value.ledger.externalGuard], ['HISTORY_UNRESOLVED', 'GUARD_UNAVAILABLE', 'UNAVAILABLE']);
    });
  } finally {
    Object.assign(console, original);
    applyLedgerEnv(process.env, null);
  }
  const events = logged.map((line) => JSON.parse(line) as { message: string; agent: string; level: string; metadata?: Record<string, unknown> });
  assert.ok(events.some((event) => event.message === 'link_audit.guard.unavailable' && event.agent === 'SYSTEM' && event.level === 'ERROR' && event.metadata?.call === 'LATEST'), JSON.stringify(events));
  const all = logged.join('\n');
  for (const leak of [w.auditId, PASSWORD, testKeyMaterial('guard-a'), '127.0.0.1', '@empresa.com']) assert.ok(!all.includes(leak), `o log não cita ${leak === PASSWORD ? 'a senha' : leak}`);
});

/* ============================================================================ GE-E6: alarmes → logger (envelope da observabilidade, sem PII) */

test('GE-E6: cada alarme vira um evento do envelope da observabilidade (message = nome do evento, só enums e inteiros no metadata, nível pela gravidade); nunca auditId, e-mail, caminho ou hash', () => {
  const alarms: GuardAlarm[] = [
    { kind: 'GUARD_UNAVAILABLE', call: 'PUBLISH' },
    { kind: 'GUARD_MISMATCH' },
    { kind: 'GUARD_HEAD_MISSING', ledgerSeq: 3 },
    { kind: 'GUARD_LAGGING', lag: 6, maxLag: 5 },
    { kind: 'GUARD_BEHIND_PROLONGED', lag: 2, ageMs: 901_000 },
    { kind: 'GUARD_PUBLISH_FAILED_AFTER_RECORD', point: 'S8', cause: 'STALE_UNCOVERED', ledgerSeq: 5 },
    { kind: 'GUARD_CONFLICT', ledgerSeq: 5 },
  ];
  assert.deepEqual(alarms.map(guardAlarmLogEntry), [
    { level: 'ERROR', event: 'link_audit.guard.unavailable', metadata: { code: 'GUARD_UNAVAILABLE', call: 'PUBLISH' } },
    { level: 'ERROR', event: 'link_audit.guard.mismatch', metadata: { code: 'GUARD_MISMATCH' } },
    { level: 'ERROR', event: 'link_audit.guard.head_missing', metadata: { code: 'GUARD_HEAD_MISSING', seq: 3 } },
    { level: 'ERROR', event: 'link_audit.guard.lagging', metadata: { code: 'GUARD_LAGGING', lag: 6, maxLag: 5 } },
    { level: 'WARN', event: 'link_audit.guard.behind_prolonged', metadata: { code: 'GUARD_BEHIND_PROLONGED', lag: 2, ageSeconds: 901 } },
    { level: 'WARN', event: 'link_audit.guard.publish_failed_after_record', metadata: { code: 'GUARD_PUBLISH_FAILED_AFTER_RECORD', point: 'S8', cause: 'STALE_UNCOVERED', seq: 5 } },
    { level: 'ERROR', event: 'link_audit.guard.conflict', metadata: { code: 'GUARD_CONFLICT', seq: 5 } },
  ]);
  for (const entry of alarms.map(guardAlarmLogEntry)) {
    for (const value of Object.values(entry.metadata)) assert.ok(typeof value === 'number' || /^[A-Z0-9_]{2,40}$/.test(String(value)), `${entry.event}: só enums e inteiros`);
  }
});
