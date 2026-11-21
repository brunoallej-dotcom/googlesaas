import assert from 'node:assert/strict';
import test from 'node:test';
import { LEDGER_KEY_ENV, LEDGER_RETIRED_KEYS_ENV, phase6SecretKeyMaterials } from '../src/lib/link-audit-ledger';
import { ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV } from '../src/lib/link-audit-origin';
import { testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * G1.a, PG-L01: o livro (consumidor declarado do módulo de origem) monta a lista id/material das chaves SECRETAS de origem e do livro, atuais
 * e aposentadas, que a chave de LOG recebe para recusar reúso. O módulo de observabilidade não cita os nomes dessas variáveis.
 * Composição futura: `operatorRefSourceFromEnv(phase6SecretKeyMaterials(env), env)`.
 */
test('PG-L01 phase6SecretKeyMaterials: pares id/material de origem e livro, atuais e aposentadas, sem a data de validade', () => {
  const env = {
    [ORIGIN_KEY_ENV]: testKeySpec('ok-test-a', 'origin-a'),
    [ORIGIN_RETIRED_KEYS_ENV]: `${testKeySpec('ok-old-b', 'origin-old-b')}:2026-12-01,${testKeySpec('ok-old-c', 'origin-old-c')}:2026-12-02`,
    [LEDGER_KEY_ENV]: testKeySpec('lk-test-a', 'ledger-a'),
    [LEDGER_RETIRED_KEYS_ENV]: `${testKeySpec('lk-old-b', 'ledger-old-b')}:2026-12-03`,
    GMN_LINK_AUDIT_LOG_KEY: testKeySpec('lg-test-a', 'log-a'),
  };
  assert.deepEqual(phase6SecretKeyMaterials(env), [
    { id: 'ok-test-a', hex: testKeyMaterial('origin-a') },
    { id: 'ok-old-b', hex: testKeyMaterial('origin-old-b') },
    { id: 'ok-old-c', hex: testKeyMaterial('origin-old-c') },
    { id: 'lk-test-a', hex: testKeyMaterial('ledger-a') },
    { id: 'lk-old-b', hex: testKeyMaterial('ledger-old-b') },
  ], 'a chave de log não entra na lista (ela é a que será conferida)');
});

test('PG-L01 phase6SecretKeyMaterials: ambiente vazio ⇒ lista vazia; entradas malformadas ficam de fora (o módulo dono já as recusa)', () => {
  assert.deepEqual(phase6SecretKeyMaterials({}), []);
  assert.deepEqual(phase6SecretKeyMaterials({ [ORIGIN_KEY_ENV]: 'ok-test-a:curta', [LEDGER_RETIRED_KEYS_ENV]: `${testKeySpec('lk-old-b', 'ledger-old-b')}` }), [], 'sem data, a aposentada é malformada');
});
