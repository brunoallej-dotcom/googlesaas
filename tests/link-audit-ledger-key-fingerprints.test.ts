import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { KEY_FINGERPRINT_LABEL as LEDGER_LABEL, phase6KeyFingerprints } from '../src/lib/link-audit-ledger/config';
import * as ledgerBarrel from '../src/lib/link-audit-ledger';
import { KEY_FINGERPRINT_LABEL as OBSERVABILITY_LABEL } from '../src/lib/link-audit-observability';
import { ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV } from '../src/lib/link-audit-origin';
import { testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * G1.a, PG-L01: o livro (consumidor declarado do módulo de origem) entrega à chave de LOG só IMPRESSÕES DIGITAIS de mão única das chaves
 * secretas de origem e do livro (atuais e aposentadas): os ids públicos e o SHA-256, com separação de domínio, do material. Nunca o material.
 * O rótulo é duplicado nos dois módulos (nenhum importa o outro) e a igualdade é travada aqui.
 * Composição futura (import direto de `link-audit-ledger/config`, fora do barrel): `operatorRefSourceFromEnv(phase6KeyFingerprints(env), env)`.
 */
const { LEDGER_KEY_ENV, LEDGER_RETIRED_KEYS_ENV } = ledgerBarrel;
const digestOf = (label: string): string => createHash('sha256').update('gmn.link-audit.key-fingerprint.v1\n').update(Buffer.from(testKeyMaterial(label), 'hex')).digest('hex');

test('PG-L01 phase6KeyFingerprints: pares id/digest de origem e livro, atuais e aposentadas; a chave de log fica de fora', () => {
  const env = {
    [ORIGIN_KEY_ENV]: testKeySpec('ok-test-a', 'origin-a'),
    [ORIGIN_RETIRED_KEYS_ENV]: `${testKeySpec('ok-old-b', 'origin-old-b')}:2026-12-01,${testKeySpec('ok-old-c', 'origin-old-c')}:2026-12-02`,
    [LEDGER_KEY_ENV]: testKeySpec('lk-test-a', 'ledger-a'),
    [LEDGER_RETIRED_KEYS_ENV]: `${testKeySpec('lk-old-b', 'ledger-old-b')}:2026-12-03`,
    GMN_LINK_AUDIT_LOG_KEY: testKeySpec('lg-test-a', 'log-a'),
  };
  assert.deepEqual(phase6KeyFingerprints(env), [
    { id: 'ok-test-a', materialDigest: digestOf('origin-a') },
    { id: 'ok-old-b', materialDigest: digestOf('origin-old-b') },
    { id: 'ok-old-c', materialDigest: digestOf('origin-old-c') },
    { id: 'lk-test-a', materialDigest: digestOf('ledger-a') },
    { id: 'lk-old-b', materialDigest: digestOf('ledger-old-b') },
  ], 'um PAR por chave: id e digest nunca se separam');
});

test('PG-L01 phase6KeyFingerprints: nunca devolve o material (nem trecho dele) e não está no barrel público do livro', () => {
  const labels = ['origin-a', 'ledger-a'];
  const serialized = JSON.stringify(phase6KeyFingerprints({ [ORIGIN_KEY_ENV]: testKeySpec('ok-test-a', 'origin-a'), [LEDGER_KEY_ENV]: testKeySpec('lk-test-a', 'ledger-a') }));
  for (const label of labels) {
    const material = testKeyMaterial(label);
    for (const piece of [material, material.slice(0, 16), material.slice(-16)]) assert.ok(!serialized.includes(piece), `material de ${label} exposto`);
  }
  assert.ok(!('phase6KeyFingerprints' in ledgerBarrel), 'só por import direto de config.ts (acesso restrito)');
  assert.ok(!('phase6SecretKeyMaterials' in ledgerBarrel), 'a função antiga, que devolvia o material, não existe mais');
});

test('PG-L01 phase6KeyFingerprints: ambiente vazio ⇒ lista vazia; entradas malformadas ficam de fora', () => {
  assert.deepEqual(phase6KeyFingerprints({}), []);
  assert.deepEqual(phase6KeyFingerprints({ [ORIGIN_KEY_ENV]: 'ok-test-a:curta', [LEDGER_RETIRED_KEYS_ENV]: testKeySpec('lk-old-b', 'ledger-old-b') }), []);
});

test('PG-L01 o rótulo de separação de domínio é IGUAL no livro e na observabilidade (duplicado de propósito, sem import cruzado)', () => {
  assert.equal(LEDGER_LABEL, 'gmn.link-audit.key-fingerprint.v1');
  assert.equal(OBSERVABILITY_LABEL, LEDGER_LABEL);
});
