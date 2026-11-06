import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import test from 'node:test';
import { ledgerConfigFromEnv, createLedgerService } from '../src/lib/link-audit-ledger';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { createOriginAuthenticator, type OriginProof } from '../src/lib/link-audit-origin';
import { seal } from '../src/lib/link-audit-storage';
import { isoAt, refOf, syntheticLedger } from './helpers/link-audit-ledger-fixtures';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN, TEST_ORIGIN_KEY, testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * M25 — SEPARAÇÃO DAS CHAVES POR FINALIDADE (HKDF). Prova COMPUTACIONAL, não comparação de constantes:
 *  - o prefixo de domínio (`DECISION\n…` × `LEDGER\n…`) sozinho já impede trocar uma etiqueta por outra; o que a derivação por finalidade acrescenta é OUTRA propriedade:
 *    quem conhece a SUBCHAVE de uma finalidade (um vazamento do HMAC de origem, p. ex.) não consegue autenticar a outra, MESMO que o material-mestre fosse reutilizado;
 *  - a configuração recusa material repetido, mas esta prova vale sem depender dela (defesa em profundidade que o teste mantém viva).
 * O atacante aqui é modelado de verdade: ele calcula HMACs por conta própria com a subchave que "vazou" e tenta fazer o servidor aceitá-los.
 */
registerCleanup();
const AUD = 'auditoria-teste-0001';
const MATERIAL = testKeyMaterial('hkdf-kat'); // gerado a partir de um rótulo (convenção do projeto: nenhum segredo fixo no código)
const SAME_KEY = `lk-shared-test:${MATERIAL}`; // o MESMO id e material nas duas finalidades, só no nível criptográfico (a configuração real recusa isso)

/** Subchave que um atacante computaria a partir do material (HKDF-SHA-256 com sal e rótulo da finalidade). Reimplementação INDEPENDENTE do módulo. */
const subkey = (hex: string, purpose: 'origin' | 'ledger'): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.from(`gmn.link-audit.${purpose}.salt`), `gmn.link-audit.${purpose}.v1`, 32));
const hmac = (key: Buffer, domain: string, body: object): string => createHmac('sha256', key).update(`${domain}\n${canonicalJson(body)}`).digest('hex');
const proofWith = (kid: string, tag: string): OriginProof => ({ v: 1, kid, tag });

test('compatibilidade: as etiquetas de ORIGEM são exatamente as de antes do livro (valores conhecidos obtidos do módulo do checkpoint f3168e7) — a separação por finalidade não mudou nada que já foi gravado', () => {
  const origin = createOriginAuthenticator(`ok-kat-test:${MATERIAL}`);
  const body = { a: 1, b: 'x', c: [true, null] };
  assert.deepEqual(origin.sign('DECISION', body), { v: 1, kid: 'ok-kat-test', tag: '070cf4fb1d05b6c0f401970b6ad6159b80ae1ee41581331f4c776d3f9a2713d4' });
  assert.deepEqual(origin.sign('RUN', body), { v: 1, kid: 'ok-kat-test', tag: '42a6800701d0f5f58937750cbac81294ddcffb74c1b60fca3e36424167a64336' });
});

test('a etiqueta do LIVRO é a HMAC sobre a SUBCHAVE da finalidade `ledger` (cálculo independente) e difere da que a subchave de `origin` ou o material cru produziriam', () => {
  const ledger = createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' });
  const body = { schemaVersion: 1, x: 'corpo do registro' };
  const proof = ledger.sign('LEDGER', body);
  assert.equal(proof.tag, hmac(subkey(MATERIAL, 'ledger'), 'LEDGER', body), 'bate com o cálculo independente da subchave do livro');
  assert.notEqual(proof.tag, hmac(subkey(MATERIAL, 'origin'), 'LEDGER', body), 'a subchave de ORIGEM produziria outra etiqueta para a mesma entrada');
  assert.notEqual(proof.tag, hmac(Buffer.from(MATERIAL, 'hex'), 'LEDGER', body), 'o material cru (sem HKDF) também não é a chave de assinatura');
  assert.deepEqual(subkey(MATERIAL, 'origin').equals(subkey(MATERIAL, 'ledger')), false);
});

test('ATAQUE 1 — quem conhece a subchave de ORIGEM (vazamento do HMAC de origem) forja um registro do livro: o livro rejeita (etiqueta inválida), mesmo com o MESMO id e material', () => {
  const ledger = createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' });
  const chain = syntheticLedger(createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' }), AUD, [refOf(1, null, 'x')]);
  const tail = chain[chain.length - 1] as (typeof chain)[number];
  const unsigned = { schemaVersion: 1, kind: 'link-audit-decisions-ledger', auditId: AUD, ledgerSeq: tail.ledgerSeq + 1, prevSha256: tail.contentSha256, event: 'CHECKPOINT', recordedAt: isoAt(900), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } };
  const leaked = subkey(MATERIAL, 'origin'); // o que o atacante tem
  const forged = seal({ ...unsigned, origin: proofWith('lk-shared-test', hmac(leaked, 'LEDGER', unsigned)) });
  assert.equal(ledger.verify('LEDGER', forged), 'INVALID', 'a subchave de origem não autentica o livro');
  // controle: o MESMO corpo assinado de verdade pela subchave do livro verifica
  const honest = seal({ ...unsigned, origin: ledger.sign('LEDGER', unsigned) });
  assert.equal(ledger.verify('LEDGER', honest), 'PROVEN');
});

test('ATAQUE 2 — quem conhece a subchave do LIVRO forja uma decisão/resultado: a origem rejeita (INVALID), nos dois domínios', () => {
  const origin = createOriginAuthenticator({ current: SAME_KEY, purpose: 'origin' });
  const body = { schemaVersion: 1, auditId: AUD, seq: 1, autor: 'ana@empresa.com' };
  const leaked = subkey(MATERIAL, 'ledger');
  for (const domain of ['DECISION', 'RUN'] as const) {
    const forged = seal({ ...body, origin: proofWith('lk-shared-test', hmac(leaked, domain, body)) });
    assert.equal(origin.verify(domain, forged), 'INVALID', `${domain}: a subchave do livro não autentica origem`);
    assert.equal(origin.verify(domain, seal({ ...body, origin: origin.sign(domain, body) })), 'PROVEN', `${domain}: controle`);
  }
});

test('SUBSTITUIÇÃO ENTRE PROTOCOLOS — a prova (`origin`) autêntica de um lado enxertada no outro, e etiqueta calculada com o domínio errado, nunca valem', () => {
  const origin = createOriginAuthenticator({ current: SAME_KEY, purpose: 'origin' });
  const ledger = createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' });
  const body = { schemaVersion: 1, auditId: AUD, ledgerSeq: 1, prevSha256: null, event: 'GENESIS', recordedAt: isoAt(0), actor: 'ana@empresa.com', genesis: { mode: 'EMPTY' } };
  const realLedger = seal({ ...body, origin: ledger.sign('LEDGER', body) });
  const realDecision = seal({ ...body, origin: origin.sign('DECISION', body) });
  // a etiqueta de decisão enxertada num registro do livro, e vice-versa (mesmo corpo, mesmo id de chave, mesmo material)
  assert.equal(ledger.verify('LEDGER', realDecision), 'INVALID');
  assert.equal(origin.verify('DECISION', realLedger), 'INVALID');
  assert.equal(origin.verify('RUN', realDecision), 'INVALID', 'decisão ≠ resultado');
  // domínio não permitido para a finalidade: nem assina nem verifica
  assert.throws(() => origin.sign('LEDGER', body), /domínio/);
  assert.throws(() => ledger.sign('DECISION', body), /domínio/);
  assert.throws(() => ledger.sign('RUN', body), /domínio/);
  assert.equal(origin.verify('LEDGER', realLedger), 'INVALID', 'o autenticador de origem não verifica o domínio do livro, nem com a etiqueta certa');
  assert.equal(ledger.verify('DECISION', realDecision), 'INVALID');
  // e com chaves REAIS do projeto (ids e materiais diferentes): a entrada de decisão do mundo de teste não passa como registro do livro
  const w = TEST_ORIGIN.sign('DECISION', body);
  assert.notEqual(ledger.verify('LEDGER', seal({ ...body, origin: w })), 'PROVEN', 'id e material de origem não autenticam o livro');
});

test('IDENTIFICAÇÃO — finalidade e id da chave: o autenticador diz a que serve, o registro carrega o id, e um id desconhecido/forjado é KEY_MISMATCH (nunca confiado)', () => {
  const ledger = createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' });
  const origin = createOriginAuthenticator({ current: SAME_KEY, purpose: 'origin' });
  assert.deepEqual([ledger.purpose, origin.purpose, createOriginAuthenticator(SAME_KEY).purpose], ['ledger', 'origin', 'origin'], 'o padrão é origem; o livro precisa pedir a finalidade');
  const body = { x: 1 };
  const proof = ledger.sign('LEDGER', body);
  assert.equal(proof.kid, 'lk-shared-test');
  assert.equal(ledger.verify('LEDGER', seal({ ...body, origin: { ...proof, kid: 'lk-outro-id' } })), 'KEY_MISMATCH');
  assert.equal(ledger.verify('LEDGER', seal({ ...body, origin: { ...proof, tag: '0'.repeat(64) } })), 'INVALID');
  assert.equal(ledger.verify('LEDGER', seal(body)), 'MISSING');
  // o serviço do livro RECUSA um autenticador de origem
  assert.throws(() => createLedgerService({ dir: '/tmp/x', authenticator: TEST_ORIGIN, otherDirs: [] }), /finalidade ledger/);
});

test('ROTAÇÃO e REVOGAÇÃO são independentes entre as famílias: revogar o id na família do livro não toca a de origem (e vice-versa); a validade da aposentada é de cada uma', () => {
  const now = () => new Date('2026-11-02T12:00:00Z');
  const body = { x: 1 };
  const originSigner = createOriginAuthenticator({ current: SAME_KEY, purpose: 'origin' });
  const ledgerSigner = createOriginAuthenticator({ current: SAME_KEY, purpose: 'ledger' });
  const originEntry = seal({ ...body, origin: originSigner.sign('DECISION', body) });
  const ledgerEntry = seal({ ...body, origin: ledgerSigner.sign('LEDGER', body) });
  const next = testKeySpec('lk-next-test', 'rotacao-seguinte');
  // família do LIVRO revoga o id; a de ORIGEM continua verificando o que é dela
  const ledgerRevoked = createOriginAuthenticator({ current: next, revokedIds: ['lk-shared-test'], purpose: 'ledger' });
  const originStill = createOriginAuthenticator({ current: next, retired: [`${SAME_KEY}:2026-12-02`], now, purpose: 'origin' });
  assert.equal(ledgerRevoked.verify('LEDGER', ledgerEntry), 'KEY_REVOKED');
  assert.equal(originStill.verify('DECISION', originEntry), 'PROVEN');
  // o contrário
  const originRevoked = createOriginAuthenticator({ current: next, revokedIds: ['lk-shared-test'], purpose: 'origin' });
  const ledgerStill = createOriginAuthenticator({ current: next, retired: [`${SAME_KEY}:2026-12-02`], now, purpose: 'ledger' });
  assert.equal(originRevoked.verify('DECISION', originEntry), 'KEY_REVOKED');
  assert.equal(ledgerStill.verify('LEDGER', ledgerEntry), 'PROVEN');
  // aposentada vencida só na família que a venceu
  const late = () => new Date('2026-12-20T12:00:00Z');
  const lateLedger = createOriginAuthenticator({ current: next, retired: [`${SAME_KEY}:2026-12-02`], now: late, purpose: 'ledger' });
  assert.equal(lateLedger.verify('LEDGER', ledgerEntry), 'KEY_EXPIRED');
  assert.equal(originStill.verify('DECISION', originEntry), 'PROVEN');
});

test('a CONFIGURAÇÃO recusa reutilizar id ou material da origem no livro (e o inverso na lista de aposentadas): o livro fica NOT_CONFIGURED e nenhuma escrita é aceita', () => {
  const base = { GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR: '/tmp/ledger-config-test' };
  const origin = TEST_ORIGIN_KEY; // `<id>:<hex>` da chave de origem de teste
  const [originId, originHex] = origin.split(':') as [string, string];
  const other = testKeySpec('lk-config-test', 'livro-config');
  const otherHex = other.split(':')[1] as string;
  const ok = ledgerConfigFromEnv({ ...base, GMN_LINK_AUDIT_LEDGER_KEY: other, GMN_LINK_AUDIT_ORIGIN_KEY: origin });
  assert.equal(ok.ok, true, 'controle: chaves distintas');
  const cases: Array<[string, Record<string, string>]> = [
    ['mesmo id', { GMN_LINK_AUDIT_LEDGER_KEY: `${originId}:${otherHex}` }],
    ['mesmo material', { GMN_LINK_AUDIT_LEDGER_KEY: `lk-config-test:${originHex}` }],
    ['mesmo material sob outro id, na aposentada do livro', { GMN_LINK_AUDIT_LEDGER_KEY: other, GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS: `lk-old-test:${originHex}:2026-12-01` }],
    ['material do livro igual a uma aposentada de ORIGEM', { GMN_LINK_AUDIT_LEDGER_KEY: other, GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS: `ok-ret-test:${otherHex}:2026-12-01` }],
  ];
  for (const [label, extra] of cases) {
    const config = ledgerConfigFromEnv({ ...base, GMN_LINK_AUDIT_ORIGIN_KEY: origin, ...extra }, () => new Date('2026-11-02T12:00:00Z'));
    assert.equal(config.ok, false, label);
  }
});
