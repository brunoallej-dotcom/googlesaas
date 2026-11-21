import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  LOG_KEY_ENV,
  OPERATOR_REF_HEX_CHARS,
  OPERATOR_REF_UNAVAILABLE,
  operatorRefSourceFromEnv,
} from '../src/lib/link-audit-observability';
import { phase6KeyFingerprints } from '../src/lib/link-audit-ledger/config';
import { testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * G1.a, PG-L01 (spec dos portões §5.3.4; spec de observabilidade §7.2, Q1 decidida em 16/11/2026: opção A).
 * `operatorRef` = `<id da chave>:<12 hex do HMAC-SHA-256 do e-mail normalizado>`, com a chave EXCLUSIVA `GMN_LINK_AUDIT_LOG_KEY`
 * (`<id>:<64 hex>`). Sem chave, chave fraca ou chave repetida de outra finalidade ⇒ `UNAVAILABLE`: nunca hash sem chave, nunca o e-mail.
 * As chaves aqui são derivadas de rótulos de teste (helper de origem): nenhum material fixo parecido com um real no repositório.
 */
const LOG_KEY_A = testKeySpec('lg-test-a', 'log-a');
const LOG_KEY_B = testKeySpec('lg-test-b', 'log-b');
const ORIGIN_KEY = testKeySpec('ok-test-a', 'origin-a');
const LEDGER_KEY = testKeySpec('lk-test-a', 'ledger-a');
const EMAIL = 'operador.teste@exemplo.com';
const OTHER_EMAIL = 'outra.pessoa@exemplo.com';
const REF_PATTERN = /^[a-z0-9][a-z0-9-]{3,31}:[0-9a-f]{12}$/;

type Env = Record<string, string | undefined>;
const withLogKey = (logKey: string | undefined, extra: Env = {}): Env => ({ [LOG_KEY_ENV]: logKey, GMN_LINK_AUDIT_ORIGIN_KEY: ORIGIN_KEY, GMN_LINK_AUDIT_LEDGER_KEY: LEDGER_KEY, ...extra });
/** Composição prevista (spec dos portões §5.3.4): o livro entrega as impressões digitais das outras chaves; a observabilidade só compara. */
const sourceOf = (env: Env) => operatorRefSourceFromEnv(phase6KeyFingerprints(env), env);
/** Impressão digital de mão única do material (mesma regra dos dois módulos), calculada aqui de forma independente. */
const digestOf = (label: string): string => createHash('sha256').update('gmn.link-audit.key-fingerprint.v1\n').update(Buffer.from(testKeyMaterial(label), 'hex')).digest('hex');
const refOf = (env: Env, email: unknown = EMAIL): string => sourceOf(env).operatorRef(email);

/** Material de 32 bytes montado por função (sem literal hexadecimal no arquivo). */
const hexOf = (bytes: readonly number[]): string => Buffer.from(bytes).toString('hex');
const repeatedBlock = (block: readonly number[]): string => hexOf(Array.from({ length: 32 }, (_, index) => block[index % block.length] as number));

test('PG-L01 operatorRef determinístico com GMN_LINK_AUDIT_LOG_KEY: o mesmo e-mail (maiúsculas, espaços) dá o mesmo valor, prefixado pelo id da chave', () => {
  const source = sourceOf(withLogKey(LOG_KEY_A));
  assert.equal(source.status, 'READY');
  assert.equal(source.keyId, 'lg-test-a');
  const ref = source.operatorRef(EMAIL);
  assert.match(ref, REF_PATTERN);
  assert.ok(ref.startsWith('lg-test-a:'));
  assert.equal(ref.length, 'lg-test-a:'.length + OPERATOR_REF_HEX_CHARS);
  assert.equal(source.operatorRef(`  ${EMAIL.toUpperCase()} \n`), ref, 'normalizado como a sessão (trim + minúsculas)');
  assert.equal(sourceOf(withLogKey(LOG_KEY_A)).operatorRef(EMAIL), ref, 'estável entre leituras do ambiente (rotas e CLI)');
});

test('PG-L01 operatorRef: HMAC-SHA-256 com a chave derivada por HKDF de finalidade própria (log), truncado em 12 hex (referência fixada)', () => {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(testKeyMaterial('log-a'), 'hex'), 'gmn.link-audit.log.salt', 'gmn.link-audit.log.v1', 32));
  const expected = `lg-test-a:${createHmac('sha256', derived).update(EMAIL).digest('hex').slice(0, OPERATOR_REF_HEX_CHARS)}`;
  assert.equal(refOf(withLogKey(LOG_KEY_A)), expected, 'mudar a derivação muda todos os pseudônimos: só com chave nova (id novo)');
  const plain = createHmac('sha256', Buffer.from(testKeyMaterial('log-a'), 'hex')).update(EMAIL).digest('hex').slice(0, OPERATOR_REF_HEX_CHARS);
  assert.notEqual(refOf(withLogKey(LOG_KEY_A)).split(':')[1], plain, 'o material bruto não é usado direto (separação de domínio)');
});

test('PG-L01 operatorRef: e-mails diferentes e chaves diferentes dão valores diferentes', () => {
  const a = refOf(withLogKey(LOG_KEY_A));
  assert.notEqual(refOf(withLogKey(LOG_KEY_A), OTHER_EMAIL), a);
  const b = refOf(withLogKey(LOG_KEY_B));
  assert.notEqual(b.split(':')[1], a.split(':')[1]);
  assert.ok(b.startsWith('lg-test-b:'), 'a rotação aparece no prefixo: a linha diz qual chave a gerou');
});

test('PG-L01 chave ausente ou vazia ⇒ UNAVAILABLE (falha fechada para PII: nunca hash sem chave nem o e-mail)', () => {
  for (const env of [withLogKey(undefined), withLogKey(''), {}]) {
    const source = sourceOf(env);
    assert.equal(source.status, 'LOG_KEY_NOT_CONFIGURED');
    assert.equal(source.keyId, null);
    assert.equal(source.operatorRef(EMAIL), OPERATOR_REF_UNAVAILABLE);
  }
});

test('PG-L01 chave fraca ou malformada ⇒ UNAVAILABLE (mesma política das chaves de origem e do livro)', () => {
  const material = testKeyMaterial('log-a');
  const weak: Readonly<Record<string, string>> = {
    'maiúsculas': `lg-test-a:${material.toUpperCase()}`,
    '63 hex': `lg-test-a:${material.slice(1)}`,
    '65 hex': `lg-test-a:${material}0`,
    'base64': `lg-test-a:${Buffer.from(material, 'hex').toString('base64')}`,
    'quebra de linha': `${LOG_KEY_A}\n`,
    'CRLF': `${LOG_KEY_A}\r\n`,
    'espaço': ` ${LOG_KEY_A}`,
    'sem id': material,
    'id curto': `lg:${material}`,
    'id com maiúscula': `Lg-test-a:${material}`,
    'parte extra': `${LOG_KEY_A}:2026-12-31`,
    'senha humana': 'lg-test-a:minha-senha-de-log',
    'bloco repetido': `lg-test-a:${repeatedBlock([0x2a])}`,
    'bloco de 16 repetido': `lg-test-a:${repeatedBlock(Array.from({ length: 16 }, (_, index) => index * 7 + 3))}`,
    'progressão': `lg-test-a:${hexOf(Array.from({ length: 32 }, (_, index) => index))}`,
    'poucos bytes distintos': `lg-test-a:${hexOf(Array.from({ length: 32 }, (_, index) => (index * 5) % 15))}`,
  };
  for (const [label, spec] of Object.entries(weak)) {
    const source = sourceOf(withLogKey(spec));
    assert.equal(source.status, 'LOG_KEY_WEAK', label);
    assert.equal(source.keyId, null, label);
    assert.equal(source.operatorRef(EMAIL), OPERATOR_REF_UNAVAILABLE, label);
  }
});

test('PG-L01 chave igual à de origem ou à do livro (id ou material, atual ou aposentada) ⇒ recusada', () => {
  const material = testKeyMaterial('log-a');
  const reused: Readonly<Record<string, Env>> = {
    'mesmo material da origem': withLogKey(LOG_KEY_A, { GMN_LINK_AUDIT_ORIGIN_KEY: `ok-test-z:${material}` }),
    'mesmo id da origem': withLogKey(`ok-test-a:${material}`),
    'mesmo material do livro': withLogKey(LOG_KEY_A, { GMN_LINK_AUDIT_LEDGER_KEY: `lk-test-z:${material}` }),
    'mesmo id do livro': withLogKey(`lk-test-a:${material}`),
    'material de origem aposentada': withLogKey(LOG_KEY_A, { GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS: `${testKeySpec('ok-old-b', 'origin-old')}:2026-12-01,ok-old-c:${material}:2026-12-02` }),
    'id do livro aposentado': withLogKey(LOG_KEY_A, { GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS: `lg-test-a:${testKeyMaterial('ledger-old')}:2026-12-01` }),
    'chave idêntica à de origem': withLogKey(ORIGIN_KEY),
    'chave idêntica à do livro': withLogKey(LEDGER_KEY),
  };
  for (const [label, env] of Object.entries(reused)) {
    const source = sourceOf(env);
    assert.equal(source.status, 'LOG_KEY_REUSED', label);
    assert.equal(source.keyId, null, label);
    assert.equal(source.operatorRef(EMAIL), OPERATOR_REF_UNAVAILABLE, label);
  }
  assert.equal(sourceOf({ [LOG_KEY_ENV]: LOG_KEY_A }).status, 'READY', 'sem as outras chaves no ambiente não há o que comparar');
});

test('PG-L01 e-mail nunca no log: o valor não contém parte do e-mail, o módulo não escreve nada e o objeto não expõe a chave', (t) => {
  const written: string[] = [];
  const capture = (...args: unknown[]): void => void written.push(args.map(String).join(' '));
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, capture);
  t.mock.method(process.stdout, 'write', (chunk: unknown) => (written.push(String(chunk)), true));
  t.mock.method(process.stderr, 'write', (chunk: unknown) => (written.push(String(chunk)), true));

  const material = testKeyMaterial('log-a');
  const sources = [withLogKey(LOG_KEY_A), withLogKey(undefined), withLogKey(`lg-test-a:${material.toUpperCase()}`), withLogKey(ORIGIN_KEY)].map((env) => sourceOf(env));
  const refs = sources.flatMap((source) => [EMAIL, EMAIL.toUpperCase(), encodeURIComponent(EMAIL), 'dev@localhost'].map((email) => source.operatorRef(email)));
  t.mock.restoreAll();

  const forbidden = ['operador', 'teste', 'exemplo', 'localhost', '@', '%40', material, material.slice(0, 16)];
  const serialized = [JSON.stringify(refs), ...sources.map((source) => JSON.stringify(source)), ...sources.map((source) => inspect(source, { depth: 5, showHidden: true }))].join('\n');
  for (const needle of forbidden) assert.ok(!serialized.toLowerCase().includes(needle.toLowerCase()), `vazou "${needle.slice(0, 12)}" no valor ou no objeto`);
  assert.deepEqual(written, [], 'o módulo é puro: não escreve em console, stdout nem stderr');
});

test('PG-L01 dev@localhost (bypass de desenvolvimento) tem o mesmo tratamento: pseudônimo com chave, UNAVAILABLE sem ela', () => {
  assert.match(refOf(withLogKey(LOG_KEY_A), 'dev@localhost'), REF_PATTERN);
  assert.equal(refOf(withLogKey(undefined), 'dev@localhost'), OPERATOR_REF_UNAVAILABLE);
});

test('PG-L01 identidade inválida (não texto, vazia, gigante, sem @, com controle) ⇒ UNAVAILABLE, sem lançar', () => {
  const source = sourceOf(withLogKey(LOG_KEY_A));
  for (const invalid of [undefined, null, 42, {}, ['a@b.co'], '', '   ', 'sem-arroba', 'a@b@c', `${'a'.repeat(320)}@exemplo.com`, 'a\u0000b@exemplo.com', 'a b@exemplo.com']) {
    assert.equal(source.operatorRef(invalid), OPERATOR_REF_UNAVAILABLE, `entrada: ${JSON.stringify(invalid)}`);
  }
});

test('PG-L01 sem a lista das outras chaves não há READY: ausente, inválida, truncada ou sem par ⇒ LOG_KEY_UNVERIFIED e UNAVAILABLE', () => {
  const env = withLogKey(LOG_KEY_A);
  const digest = digestOf('origin-a');
  const invalid: Readonly<Record<string, unknown>> = {
    ausente: undefined,
    nula: null,
    texto: 'lista',
    'objeto de listas paralelas (forma antiga)': { ids: ['ok-test-a'], materialDigests: [digest] },
    'par sem digest (lista truncada)': [{ id: 'ok-test-a', materialDigest: digest }, { id: 'ok-old-c' }],
    'par sem id': [{ materialDigest: digest }],
    'par com material em vez de digest': [{ id: 'ok-test-a', hex: testKeyMaterial('origin-a') }],
    'campo extra no par': [{ id: 'ok-test-a', materialDigest: digest, hex: testKeyMaterial('origin-a') }],
    'id fora do padrão': [{ id: 'OK test', materialDigest: digest }],
    'digest em maiúsculas': [{ id: 'ok-test-a', materialDigest: digest.toUpperCase() }],
    'digest curto': [{ id: 'ok-test-a', materialDigest: digest.slice(1) }],
    'digest com espaço': [{ id: 'ok-test-a', materialDigest: ` ${digest}` }],
    'item nulo': [null],
  };
  for (const [label, list] of Object.entries(invalid)) {
    const source = operatorRefSourceFromEnv(list as never, env);
    assert.equal(source.status, 'LOG_KEY_UNVERIFIED', label);
    assert.equal(source.keyId, null, label);
    assert.equal(source.operatorRef(EMAIL), OPERATOR_REF_UNAVAILABLE, label);
  }
  assert.equal(operatorRefSourceFromEnv([], env).status, 'READY', 'lista vazia EXPLÍCITA: nenhuma outra chave configurada');
});

test('PG-L01 reúso pelas impressões digitais injetadas (pares): id igual OU digest igual ⇒ recusada; id e digest são consultados', () => {
  const env = { [LOG_KEY_ENV]: LOG_KEY_A };
  const reused: Readonly<Record<string, ReadonlyArray<{ id: string; materialDigest: string }>>> = {
    'mesmo id': [{ id: 'lg-test-a', materialDigest: digestOf('outra') }],
    'mesmo material (digest)': [{ id: 'ok-test-z', materialDigest: digestOf('log-a') }],
    'digest no meio da lista (aposentada)': [{ id: 'ok-test-a', materialDigest: digestOf('origin-a') }, { id: 'ok-old-c', materialDigest: digestOf('log-a') }],
  };
  for (const [label, list] of Object.entries(reused)) {
    const source = operatorRefSourceFromEnv(list, env);
    assert.equal(source.status, 'LOG_KEY_REUSED', label);
    assert.equal(source.operatorRef(EMAIL), OPERATOR_REF_UNAVAILABLE, label);
  }
  assert.equal(operatorRefSourceFromEnv([{ id: 'ok-test-a', materialDigest: digestOf('origin-a') }], env).status, 'READY', 'outras chaves distintas: aceita');
});
