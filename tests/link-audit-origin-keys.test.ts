import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createOriginAuthenticator, isStrongKeyMaterial, KEY_ID_PATTERN, originConfigFromEnv, ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV, ORIGIN_REVOKED_IDS_ENV, type OriginAuthenticator } from '../src/lib/link-audit-origin';
import { testKeyMaterial, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * POLÍTICA DE CHAVES da prova de origem (2ª revisão independente, R2-MINOR-4; decisão do responsável): material de alta entropia em formato
 * estrito, identificador INDEPENDENTE do segredo, rotação PLANEJADA (aposentada com validade, só verifica) distinta da rotação por
 * COMPROMETIMENTO (chave removida e id revogado: nunca mais comprova nada).
 */
const body = { auditId: 'auditoria-chaves-01', seq: 1, prevSha256: null, who: 'ana@empresa.com' };
const entryOf = (auth: OriginAuthenticator) => ({ ...body, origin: auth.sign('DECISION', body), contentSha256: 'a'.repeat(64) });
const A = testKeySpec('ok-chave-a');
const B = testKeySpec('ok-chave-b');
const C = testKeySpec('ok-chave-c');
const NOW = (iso: string) => () => new Date(iso);

test('chave fraca ou mal formada é rejeitada (senha humana, curta, base64, maiúsculas, espaço, quebra de linha, repetição, sequência)', () => {
  const good = testKeyMaterial('x');
  assert.equal(isStrongKeyMaterial(good), true);
  const random = randomBytes(32).toString('hex'); // CSPRNG: o formato de produção
  assert.equal(isStrongKeyMaterial(random), true);
  const weak: Array<[string, unknown]> = [
    ['vazia', ''],
    ['senha humana', 'minha-senha-super-secreta-da-empresa-2026-xyz'],
    ['curta', 'abcdef0123456789'],
    ['63 hex', good.slice(1)],
    ['65 hex', `${good}0`],
    ['maiúsculas', good.toUpperCase()],
    ['base64 de 32 bytes', randomBytes(32).toString('base64')],
    ['com espaço no fim', `${good} `],
    ['com quebra de linha no fim', `${good}\n`],
    ['com CRLF', `${good}\r\n`],
    ['64 zeros', '0'.repeat(64)],
    ['um byte repetido', 'ab'.repeat(32)],
    ['bloco curto repetido', '0123456789abcdef'.repeat(4)],
    ['sequência 00 01 02…', Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex')],
    ['progressão de passo 7', Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)).toString('hex')],
    ['poucos bytes distintos', Buffer.from(Array.from({ length: 32 }, (_, i) => [1, 9, 77, 200][(i * 7 + (i >> 2)) % 4] ?? 0)).toString('hex')],
    ['não é texto', 12345],
  ];
  for (const [name, value] of weak) assert.equal(isStrongKeyMaterial(value), false, name);
  for (const [name, value] of weak) {
    if (typeof value !== 'string') continue;
    assert.throws(() => createOriginAuthenticator(`ok-chave-fraca:${value}`), Error, name);
  }
});

test('o identificador da chave é um rótulo PÚBLICO independente do segredo: o mesmo material com outro id dá outro rótulo, o rótulo nada diz do segredo', () => {
  const material = testKeyMaterial('independente');
  const one = createOriginAuthenticator(`ok-um-aaaa:${material}`);
  const two = createOriginAuthenticator(`ok-dois-bbbb:${material}`);
  assert.equal(one.keyId, 'ok-um-aaaa');
  assert.equal(two.keyId, 'ok-dois-bbbb');
  assert.equal(KEY_ID_PATTERN.test(one.keyId), true);
  assert.ok(!one.keyId.includes(material.slice(0, 8)), 'o rótulo não contém parte do segredo');
  const proof = one.sign('DECISION', body);
  assert.equal(proof.kid, 'ok-um-aaaa');
  assert.ok(!JSON.stringify(proof).includes(material.slice(0, 16)), 'a etiqueta gravada não expõe o segredo');
  // nada no arquivo funciona como "verificador" de palpites: um palpite errado com o mesmo id não confere
  const wrongGuess = createOriginAuthenticator(`ok-um-aaaa:${testKeyMaterial('palpite')}`);
  assert.equal(wrongGuess.verify('DECISION', { ...body, origin: proof }), 'INVALID');
  for (const bad of ['', 'AB', 'ok', 'Ok-Maiusculo', 'ok chave', 'ok/chave', 'ok-' + 'x'.repeat(40), '-ok-inicial']) {
    assert.throws(() => createOriginAuthenticator(`${bad}:${material}`), Error, `id inválido: ${bad}`);
  }
});

test('ROTAÇÃO PLANEJADA: a aposentada só verifica, só até a validade; a nova assina; nada se perde em silêncio', () => {
  const old = createOriginAuthenticator(A);
  const legit = entryOf(old); // pendente legítima assinada antes da rotação
  const during = createOriginAuthenticator({ current: B, retired: [`${A}:2026-12-31`], now: NOW('2026-12-31T23:59:59.999Z') });
  assert.equal(during.verify('DECISION', legit), 'PROVEN', 'dentro da validade a pendente legítima ainda é comprovada');
  assert.equal(during.sign('DECISION', body).kid, 'ok-chave-b', 'quem assina é a chave NOVA');
  const after = createOriginAuthenticator({ current: B, retired: [`${A}:2026-12-31`], now: NOW('2027-01-01T00:00:00.000Z') });
  assert.equal(after.verify('DECISION', legit), 'KEY_EXPIRED', 'vencida: não comprova mais (falha explícita, não silenciosa)');
  // a aposentada nunca assina: o autenticador novo não produz etiquetas com o id antigo
  assert.notEqual(during.sign('DECISION', body).kid, 'ok-chave-a');
  // sem declarar a antiga, a pendente deixa de ser reconhecida (e isso aparece como chave desconhecida)
  assert.equal(createOriginAuthenticator(B).verify('DECISION', legit), 'KEY_MISMATCH');
  // data inválida, ausente ou inexistente
  for (const bad of [`${A}`, `${A}:2026-13-01`, `${A}:2026-02-30`, `${A}:amanhã`, `${A}:2026-12-31:extra`]) {
    assert.throws(() => createOriginAuthenticator({ current: B, retired: [bad], now: NOW('2026-11-01T00:00:00.000Z') }), Error, bad);
  }
});

test('ROTAÇÃO POR COMPROMETIMENTO: a chave vazada é removida e seu id revogado; nada assinado por ela (nem por quem a roubou) comprova', () => {
  const leaked = createOriginAuthenticator(A);
  const legitBeforeLeak = entryOf(leaked);
  // o invasor tem a chave vazada e FORJA uma pendência assinada com ela
  const forged = { ...body, who: 'invasor-em-nome-de-ana@empresa.com', origin: leaked.sign('DECISION', { ...body, who: 'invasor-em-nome-de-ana@empresa.com' }), contentSha256: 'b'.repeat(64) };
  assert.equal(leaked.verify('DECISION', forged), 'PROVEN', 'ANTES da rotação a forja com a chave vazada passa (é justamente o risco)');
  const emergency = createOriginAuthenticator({ current: B, revokedIds: ['ok-chave-a'] });
  assert.equal(emergency.verify('DECISION', forged), 'KEY_REVOKED', 'DEPOIS: a forja assinada com a chave vazada é recusada');
  assert.equal(emergency.verify('DECISION', legitBeforeLeak), 'KEY_REVOKED', 'e a pendente legítima da mesma chave também vai para quarentena (custo declarado)');
  assert.notEqual(emergency.sign('DECISION', body).kid, 'ok-chave-a', 'a chave revogada não assina novas operações');
  // manter a chave vazada na configuração (como atual, aposentada ou "anterior") é erro de configuração: falha fechada
  assert.throws(() => createOriginAuthenticator({ current: A, revokedIds: ['ok-chave-a'] }));
  assert.throws(() => createOriginAuthenticator({ current: B, retired: [`${A}:2026-12-31`], revokedIds: ['ok-chave-a'], now: NOW('2026-11-01T00:00:00.000Z') }));
  // o MESMO material sob outro id não escapa da regra "um material, um id"
  assert.throws(() => createOriginAuthenticator({ current: B, retired: [`ok-outro-id-a:${A.split(':')[1]}:2026-12-31`, `${A}:2026-12-31`], now: NOW('2026-11-01T00:00:00.000Z') }));
  assert.throws(() => createOriginAuthenticator({ current: B, retired: [`ok-outro-id-b:${B.split(':')[1]}:2026-12-31`], now: NOW('2026-11-01T00:00:00.000Z') }));
  // revogar mais de uma
  const two = createOriginAuthenticator({ current: C, revokedIds: ['ok-chave-a', 'ok-chave-b'] });
  assert.equal(two.verify('DECISION', entryOf(createOriginAuthenticator(B))), 'KEY_REVOKED');
});

test('ambiente: formato estrito de cada variável e falha fechada em qualquer contradição (nunca revela material)', () => {
  const env = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({ [ORIGIN_KEY_ENV]: A, ...extra });
  const clock = NOW('2026-11-01T00:00:00.000Z');
  const ok = originConfigFromEnv(env({ [ORIGIN_RETIRED_KEYS_ENV]: `${B}:2026-12-31`, [ORIGIN_REVOKED_IDS_ENV]: 'ok-chave-c' }), clock);
  assert.deepEqual(originConfigFromEnv(env({ [ORIGIN_RETIRED_KEYS_ENV]: `${B}:2026-12-31` })), { ok: false, code: 'ORIGIN_CONFIG_INVALID' }, 'aposentada sem o relógio de quem chama: falha fechada');
  assert.ok(ok.ok && ok.authenticator.keyId === 'ok-chave-a');
  assert.deepEqual(originConfigFromEnv({}), { ok: false, code: 'ORIGIN_KEY_NOT_CONFIGURED' });
  assert.deepEqual(originConfigFromEnv({ [ORIGIN_KEY_ENV]: '' }), { ok: false, code: 'ORIGIN_KEY_NOT_CONFIGURED' });
  for (const bad of ['senha-humana', testKeyMaterial('so-material'), `${A}\n`, ` ${A}`, `${A} `, `${A}:`, `${A}:extra`, `ok-chave-a:${'ab'.repeat(32)}`, `OK-CHAVE-A:${testKeyMaterial('a')}`]) {
    assert.deepEqual(originConfigFromEnv({ [ORIGIN_KEY_ENV]: bad }), { ok: false, code: 'ORIGIN_KEY_WEAK' }, JSON.stringify(bad).slice(0, 30));
  }
  for (const bad of [`${B}`, `${B}:2099-99-99`, `${B}:2026-12-31,`, `${B}:2026-12-31, ${C}:2026-12-31`]) {
    const r = originConfigFromEnv(env({ [ORIGIN_RETIRED_KEYS_ENV]: bad }), clock);
    assert.equal(r.ok, false, bad);
  }
  assert.deepEqual(originConfigFromEnv(env({ [ORIGIN_REVOKED_IDS_ENV]: 'ok-chave-a' })), { ok: false, code: 'ORIGIN_CONFIG_INVALID' }, 'a chave ATUAL revogada');
  assert.deepEqual(originConfigFromEnv(env({ [ORIGIN_RETIRED_KEYS_ENV]: `${A}:2026-12-31` }), clock), { ok: false, code: 'ORIGIN_CONFIG_INVALID' }, 'id repetido');
  assert.deepEqual(originConfigFromEnv(env({ [ORIGIN_REVOKED_IDS_ENV]: 'ok-chave-b,' })), { ok: false, code: 'ORIGIN_CONFIG_INVALID' }, 'lista com item vazio');
  assert.deepEqual(originConfigFromEnv(env({ [ORIGIN_REVOKED_IDS_ENV]: 'ok-chave-b, ok-chave-c' })), { ok: false, code: 'ORIGIN_CONFIG_INVALID' }, 'espaço na lista');
  // a variável antiga "…_PREVIOUS" (aceitava a chave vazada indiscriminadamente) NÃO existe mais: é ignorada, nunca vira chave aceita
  const legacy = originConfigFromEnv(env({ GMN_LINK_AUDIT_ORIGIN_KEY_PREVIOUS: B }));
  assert.ok(legacy.ok);
  assert.equal(legacy.authenticator.verify('DECISION', entryOf(createOriginAuthenticator(B))), 'KEY_MISMATCH');
  assert.ok(!JSON.stringify(ok).includes(A.split(':')[1] as string));
  const failed = originConfigFromEnv({ [ORIGIN_KEY_ENV]: `ok-chave-a:${'ab'.repeat(32)}` });
  assert.ok(!JSON.stringify(failed).includes('abab'));
});

test('reassinar um registro antigo NÃO o torna confiável: a etiqueta nova só atesta o corpo que o servidor de hoje recebeu', () => {
  const legacyForged = { ...body, who: 'invasor@x.com', contentSha256: 'c'.repeat(64) }; // sem etiqueta, forjado
  const server = createOriginAuthenticator(A);
  assert.equal(server.verify('DECISION', legacyForged), 'MISSING');
  const resigned = { ...legacyForged, origin: server.sign('DECISION', body) }; // etiqueta do corpo LEGÍTIMO colada em corpo forjado
  assert.equal(server.verify('DECISION', resigned), 'INVALID', 'a etiqueta de outro corpo não cobre o corpo forjado');
  // e se o servidor assinasse o corpo forjado, ele seria "comprovado": por isso NÃO existe ferramenta de reassinatura no sistema (ver ADR)
  const wouldBe = { ...legacyForged, origin: server.sign('DECISION', { auditId: body.auditId, seq: body.seq, prevSha256: body.prevSha256, who: 'invasor@x.com' }) };
  assert.equal(server.verify('DECISION', wouldBe), 'PROVEN', 'reassinar é equivalente a testemunhar sem fonte independente — proibido por procedimento');
});

test('R3-INFO-4: a chave aposentada tem TETO de validade (rotação planejada é curta) e um relógio inválido nunca lança nem autentica', () => {
  const now = '2026-11-01T12:00:00.000Z';
  const day = (daysAhead: number): string => new Date(Date.parse(now) + daysAhead * 86_400_000).toISOString().slice(0, 10);
  assert.doesNotThrow(() => createOriginAuthenticator({ current: B, retired: [`${A}:${day(93)}`], now: NOW(now) }), 'no limite de 93 dias');
  assert.throws(() => createOriginAuthenticator({ current: B, retired: [`${A}:${day(94)}`], now: NOW(now) }), Error, 'acima do teto');
  assert.throws(() => createOriginAuthenticator({ current: B, retired: [`${A}:9999-12-31`], now: NOW(now) }), Error, 'a aposentada "para sempre"');
  assert.deepEqual(originConfigFromEnv({ [ORIGIN_KEY_ENV]: B, [ORIGIN_RETIRED_KEYS_ENV]: `${A}:9999-12-31` }, NOW(now)), { ok: false, code: 'ORIGIN_CONFIG_INVALID' });
  // relógio inválido: não lança; a aposentada conta como VENCIDA (falha fechada)
  const auth = createOriginAuthenticator({ current: B, retired: [`${A}:${day(10)}`], now: NOW(now) });
  const legit = entryOf(createOriginAuthenticator(A));
  assert.equal(auth.verify('DECISION', legit), 'PROVEN');
  let broken = false;
  const flaky = createOriginAuthenticator({ current: B, retired: [`${A}:${day(10)}`], now: () => (broken ? new Date(Number.NaN) : new Date(now)) });
  broken = true;
  assert.doesNotThrow(() => flaky.verify('DECISION', legit));
  assert.equal(flaky.verify('DECISION', legit), 'KEY_EXPIRED');
});
