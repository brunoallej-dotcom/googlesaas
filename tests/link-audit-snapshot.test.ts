import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import {
  buildSnapshot,
  HASH_DISCLAIMER,
  serializeSnapshot,
  snapshotContentHash,
  verifySnapshot,
  type LinkAuditSnapshot,
} from '../src/lib/link-audit/snapshot';
import {
  clone,
  directDraft,
  FID,
  FID_OTHER,
  RESOLVED_LINK,
  SHORT_LINK,
  shortLinkDraft,
  T_COLLECTED,
  T_CONFIRMED,
  T_FROZEN,
  type Mutable,
} from './helpers/link-audit-fixtures';

const FIRST = { version: 1, previous: null } as const;

function build(draft: unknown = directDraft(), chain: Parameters<typeof buildSnapshot>[1] = FIRST): LinkAuditSnapshot {
  const result = buildSnapshot(draft, chain);
  assert.ok(result.ok, result.ok ? '' : `${result.code}: ${result.issues.join(' | ')}`);
  return result.value;
}

function rejected(draft: unknown, chain: Parameters<typeof buildSnapshot>[1] = FIRST): string {
  const result = buildSnapshot(draft, chain);
  assert.equal(result.ok, false, 'deveria ter sido recusado');
  return result.ok ? '' : `${result.code}: ${result.issues.join(' | ')}`;
}

function resealed(snapshot: LinkAuditSnapshot, mutate: (content: Mutable) => void): unknown {
  const copy = clone(snapshot) as Mutable;
  mutate(copy.content);
  copy.hash.value = sha256Hex(canonicalJson(copy.content)); // adulteração "esperta": hash recalculado
  return copy;
}

test('congela e verifica; é um snapshot de evidências, não uma auditoria final', () => {
  const snapshot = build();
  assert.equal(snapshot.content.kind, 'EVIDENCE_SNAPSHOT');
  assert.equal(snapshot.content.version, 1);
  assert.equal(snapshot.content.previous, null);
  assert.equal(snapshot.content.methodologyVersion, 'lumos-reconstruida-v1');
  assert.equal(snapshot.content.indexStatus, 'PENDING_METHODOLOGY');
  assert.equal(snapshot.canonicalization, 'gmn-canonical-json-v1');
  assert.equal(snapshot.hash.algorithm, 'sha256');
  assert.match(snapshot.hash.value, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.hash.value, snapshotContentHash(snapshot.content));

  const verified = verifySnapshot(JSON.parse(serializeSnapshot(snapshot)));
  assert.ok(verified.ok, verified.ok ? '' : verified.issues.join(' | '));
  assert.deepEqual(verified.value, snapshot);
});

test('preserva identidade confirmada, link original, evidências, origens e fontes palavra por palavra', () => {
  const draft = directDraft();
  const snapshot = build(draft);
  assert.deepEqual(snapshot.content.identity, draft.identity);
  assert.deepEqual(snapshot.content.link, draft.link);
  assert.deepEqual(snapshot.content.evidences, draft.evidences);
  assert.deepEqual(snapshot.content.criteria, draft.criteria);
  assert.deepEqual(snapshot.content.limitations, draft.limitations);
  assert.equal(snapshot.content.collectedAt, draft.collectedAt);

  const origins = Object.fromEntries(snapshot.content.evidences.map((e) => [e.id, e.origin]));
  assert.deepEqual(origins, { 'ev-rev-1': 'GOOGLE_NATIVE', 'ev-nap-1': 'OFFICIAL_SITE', 'ev-posts-1': 'OFFICIAL_SOCIAL' });
  const posts = snapshot.content.evidences.find((e) => e.id === 'ev-posts-1');
  assert.equal(posts?.status, 'NOT_VERIFIED');
  assert.match(posts?.nativeContext ?? '', /não prova Google Posts/);
});

test('hash: igual para conteúdo equivalente, diferente para qualquer mudança', () => {
  const reference = build().hash.value;

  // Equivalente: ordem das chaves, texto em NFD e propriedade undefined.
  const reordered = directDraft();
  const reversed = Object.fromEntries(Object.entries(reordered).reverse());
  (reversed.identity as Mutable).name = 'Padaria Exemplo (fictícia)'.normalize('NFD');
  (reversed.identity as Mutable).address = undefined; // undefined equivale a ausente
  assert.equal(build(reversed).hash.value, reference);
  assert.equal(build(directDraft()).hash.value, reference, 'repetível');

  // Diferente: cada alteração isolada muda o hash.
  const mutations: Array<(d: Mutable) => void> = [
    (d) => (d.collectedAt = '2026-10-20T12:00:01.000Z'),
    (d) => (d.frozenAt = T_FROZEN.replace('13', '14')),
    (d) => (d.identity.name = 'Outra Padaria'),
    (d) => (d.identity.confirmation.confirmedBy = 'outro-operador'),
    (d) => (d.evidences[0].claim = 'Outra afirmação'),
    (d) => (d.evidences[1].sourceUrl = 'https://www.padaria-exemplo.example/outra'),
    (d) => (d.evidences[2].limitation = 'Outra limitação'),
    (d) => d.evidences.reverse(),
    (d) => (d.limitations = ['Outra limitação geral']),
    (d) => d.limitations.push('Mais uma limitação'),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const draft = directDraft();
    mutate(draft);
    if (index === 7) draft.criteria.reverse(); // a ordem dos itens também é conteúdo
    const result = buildSnapshot(draft, FIRST);
    assert.ok(result.ok, `mutação ${index}: ${result.ok ? '' : result.issues.join(' | ')}`);
    assert.notEqual(result.value.hash.value, reference, `mutação ${index} deveria mudar o hash`);
  }
  assert.notEqual(build(directDraft(), { version: 2, previous: { version: 1, hash: 'a'.repeat(64) } }).hash.value, reference);
});

test('adulteração com formato ainda válido é detectada pelo hash', () => {
  const snapshot = build();
  const tamperings: Array<(content: Mutable) => void> = [
    (c) => (c.evidences[0].claim = 'Nota alterada depois do fechamento'),
    (c) => (c.evidences[1].consultedAt = '2026-10-19T00:00:00.000Z'),
    (c) => (c.identity.name = 'Outra empresa'),
    (c) => (c.identity.confirmation.confirmedBy = 'outro'),
    (c) => (c.limitations = []),
    (c) => (c.collectedAt = '2026-10-20T12:00:01.000Z'),
    (c) => (c.link.originalLink = `${c.link.originalLink}?x=1`),
    (c) => (c.criteria[0].status = 'NOT_VERIFIED'),
  ];
  for (const [index, tamper] of tamperings.entries()) {
    const copy = clone(snapshot) as Mutable;
    tamper(copy.content);
    const result = verifySnapshot(copy);
    assert.equal(result.ok, false, `adulteração ${index} passou`);
    assert.equal(result.ok ? '' : result.code, 'HASH_MISMATCH', `adulteração ${index}`);
  }
  const wrongHash = clone(snapshot) as Mutable;
  wrongHash.hash.value = '0'.repeat(64);
  const mismatch = verifySnapshot(wrongHash);
  assert.ok(!mismatch.ok && mismatch.code === 'HASH_MISMATCH');
});

test('formato inválido do envelope é recusado (hash malformado, algoritmo, campos extras)', () => {
  const snapshot = build();
  const cases: Array<[string, (envelope: Mutable) => void]> = [
    ['hash maiúsculo', (e) => (e.hash.value = e.hash.value.toUpperCase())],
    ['hash curto', (e) => (e.hash.value = 'abc')],
    ['algoritmo', (e) => (e.hash.algorithm = 'md5')],
    ['canonicalization', (e) => (e.canonicalization = 'outra')],
    ['campo extra no envelope', (e) => (e.signature = 'x')],
    ['sem hash', (e) => delete e.hash],
    ['sem conteúdo', (e) => delete e.content],
  ];
  for (const [label, mutate] of cases) {
    const copy = clone(snapshot) as Mutable;
    mutate(copy);
    const result = verifySnapshot(copy);
    assert.ok(!result.ok && result.code === 'SCHEMA', label);
  }
  for (const input of [null, undefined, 42, 'texto', [], {}]) assert.equal(verifySnapshot(input).ok, false);
});

test('pontuação é impossível sem D3: campos de pontos, índice, cobertura, classificação e confiança são recusados', () => {
  const forbidden = { points: 80, score: 80, index: 84, coverage: 65, classification: 'Forte', confidence: 'alta', baseObserved: '54,5/65' };
  for (const [field, value] of Object.entries(forbidden)) {
    const where: Array<[string, (d: Mutable) => void]> = [
      ['rascunho', (d) => (d[field] = value)],
      ['link', (d) => (d.link[field] = value)],
      ['identidade', (d) => (d.identity[field] = value)],
      ['evidência', (d) => (d.evidences[0][field] = value)],
      ['critério', (d) => (d.criteria[0][field] = value)],
    ];
    for (const [label, mutate] of where) {
      const draft = directDraft();
      mutate(draft);
      assert.match(rejected(draft), /^SCHEMA/, `${field} em ${label}`);
    }
    const snapshot = clone(build()) as Mutable;
    snapshot.content[field] = value;
    snapshot.hash.value = sha256Hex(canonicalJson(snapshot.content));
    const result = verifySnapshot(snapshot);
    assert.ok(!result.ok && result.code === 'SCHEMA', `${field} no conteúdo selado`);
  }
  // Nem a versão da metodologia nem o status do índice podem ser trocados pelo rascunho.
  assert.match(rejected({ ...directDraft(), indexStatus: 'CALCULATED' }), /^SCHEMA/);
  assert.match(rejected({ ...directDraft(), methodologyVersion: 'juiz-21' }), /^SCHEMA/);
  const calculated = clone(build()) as Mutable;
  calculated.content.indexStatus = 'CALCULATED';
  assert.equal(verifySnapshot(calculated).ok, false);
});

test('identidade sem confirmação do operador não pode ser congelada', () => {
  const draft = directDraft();
  delete draft.identity.confirmation;
  assert.match(rejected(draft), /INVALID.*exige identidade confirmada/);
});

test('o link e a identidade precisam concordar', () => {
  assert.match(rejected(directDraft({ identity: { ...directDraft().identity, identifiers: { cid: '999' } } })), /não correspondem ao link efetivo/);
  const otherOriginal = directDraft();
  otherOriginal.identity.originalLink = 'https://www.google.com/maps?cid=999';
  assert.match(rejected(otherOriginal), /identity.originalLink: deve ser igual/);
  for (const originalLink of ['https://www.google.com/maps/search/padaria', 'http://www.google.com/maps?cid=1', 'Padaria Exemplo', 'https://example.com/']) {
    const draft = directDraft();
    draft.link.originalLink = originalLink;
    draft.identity.originalLink = originalLink;
    assert.match(rejected(draft), /INVALID|SCHEMA/, originalLink);
  }
});

test('link curto: vínculo entre link original, link resolvido, identidade e confirmação posterior', () => {
  const snapshot = build(shortLinkDraft());
  assert.equal(snapshot.content.link.originalLink, SHORT_LINK);
  assert.equal(snapshot.content.link.resolved?.url, RESOLVED_LINK);
  assert.equal(snapshot.content.identity.originalLink, SHORT_LINK);
  assert.deepEqual(snapshot.content.identity.identifiers, { featureId: FID });
  assert.ok(verifySnapshot(JSON.parse(serializeSnapshot(snapshot))).ok);

  assert.match(rejected(shortLinkDraft({ link: { originalLink: SHORT_LINK, resolved: null } })), /só pode ser congelado depois de resolvido/);

  const otherProfile = shortLinkDraft();
  otherProfile.link.resolved.url = `https://www.google.com/maps/place/Outra/data=!1s${FID_OTHER}`;
  assert.match(rejected(otherProfile), /não correspondem ao link efetivo/);

  const confirmedBefore = shortLinkDraft();
  confirmedBefore.identity.confirmation.confirmedAt = '2026-10-20T12:05:00.000Z';
  assert.match(rejected(confirmedBefore), /posterior à resolução/);

  const resolvedNotProfile = shortLinkDraft();
  resolvedNotProfile.link.resolved.url = 'https://www.google.com/maps/search/padaria';
  assert.match(rejected(resolvedNotProfile), /não identifica a empresa|em "AMBIGUOUS"/);

  const resolvedUnsafe = shortLinkDraft();
  resolvedUnsafe.link.resolved.url = 'http://127.0.0.1/maps?cid=1';
  assert.match(rejected(resolvedUnsafe), /REJECTED|não identifica a empresa/);

  const directWithResolved = directDraft();
  directWithResolved.link.resolved = { url: RESOLVED_LINK, resolvedAt: T_CONFIRMED.replace('12:30', '12:00'), method: 'REDIRECT_CHAIN' };
  assert.match(rejected(directWithResolved), /link direto .* não tem link resolvido/);

  const badMethod = shortLinkDraft();
  badMethod.link.resolved.method = 'MANUAL';
  assert.match(rejected(badMethod), /^SCHEMA/);
});

test('datas coerentes: consulta ≤ coleta ≤ fechamento; confirmação ≤ fechamento', () => {
  const lateEvidence = directDraft();
  lateEvidence.evidences[0].consultedAt = '2026-10-20T12:00:01.000Z';
  assert.match(rejected(lateEvidence), /consultedAt é posterior a collectedAt/);

  const frozenBeforeCollected = directDraft({ frozenAt: '2026-10-20T11:59:59.000Z' });
  assert.match(rejected(frozenBeforeCollected), /frozenAt: não pode ser anterior a collectedAt/);

  const frozenBeforeConfirmation = directDraft({ collectedAt: T_COLLECTED, frozenAt: '2026-10-20T12:20:00.000Z' });
  assert.match(rejected(frozenBeforeConfirmation), /frozenAt: não pode ser anterior à confirmação/);

  assert.match(rejected(directDraft({ collectedAt: '20/10/2026' })), /^SCHEMA/);
});

test('cadeia de versões: a primeira não tem anterior; as demais apontam para version − 1', () => {
  const hash = 'b'.repeat(64);
  assert.match(rejected(directDraft(), { version: 1, previous: { version: 0, hash } }), /previous/);
  assert.match(rejected(directDraft(), { version: 2, previous: null }), /previous: versões após a primeira exigem/);
  assert.match(rejected(directDraft(), { version: 3, previous: { version: 1, hash } }), /previous.version: deve ser version − 1/);
  assert.match(rejected(directDraft(), { version: 2, previous: { version: 1, hash: 'xyz' } }), /^SCHEMA/);
  assert.match(rejected(directDraft(), { version: 0, previous: null }), /^SCHEMA/);
  const second = build(directDraft(), { version: 2, previous: { version: 1, hash } });
  assert.equal(second.content.previous?.hash, hash);
});

test('as regras da Onda 1 continuam valendo dentro do snapshot', () => {
  // Fonte externa não prova atributo nativo.
  const external = directDraft();
  external.evidences[0].origin = 'OFFICIAL_SITE';
  external.evidences[0].sourceUrl = 'https://www.padaria-exemplo.example/avaliacoes';
  assert.match(rejected(external), /só pode ser comprovado pelo próprio perfil do Google/);

  // Evidência nativa de outro perfil.
  const otherProfile = directDraft();
  otherProfile.evidences[0].sourceUrl = `https://www.google.com/maps?ftid=${FID_OTHER}`;
  assert.match(rejected(otherProfile), /a fonte nativa não é do perfil auditado/);

  // Critério mais forte do que a evidência.
  const stronger = directDraft();
  stronger.criteria.find((c: Mutable) => c.criterionId === 'CONVERSION').status = 'VERIFIED';
  assert.match(rejected(stronger), /CONVERSION: status VERIFIED sem evidência de suporte/);

  // Evidência de um critério apontada por outro.
  const crossed = directDraft();
  crossed.criteria.find((c: Mutable) => c.criterionId === 'CONVERSION').evidenceIds = ['ev-nap-1'];
  assert.match(rejected(crossed), /pertence ao critério NAP/);

  // Menos de nove critérios.
  const missing = directDraft();
  missing.criteria = missing.criteria.slice(1);
  assert.match(rejected(missing), /^SCHEMA/);
});

test('adulteração com hash recalculado ainda é barrada pelas regras entre campos', () => {
  const snapshot = build();
  const forgedIdentity = resealed(snapshot, (c) => (c.identity.identifiers = { cid: '999' }));
  const forgedIdentityResult = verifySnapshot(forgedIdentity);
  assert.ok(!forgedIdentityResult.ok && forgedIdentityResult.code === 'INVALID');

  const forgedScope = resealed(snapshot, (c) => {
    c.evidences[0].origin = 'OFFICIAL_SITE';
    c.evidences[0].sourceUrl = 'https://www.padaria-exemplo.example/avaliacoes';
  });
  assert.equal(verifySnapshot(forgedScope).ok, false);

  const forgedUnconfirmed = resealed(snapshot, (c) => delete c.identity.confirmation);
  assert.equal(verifySnapshot(forgedUnconfirmed).ok, false);

  const harmless = resealed(snapshot, (c) => (c.limitations = ['Texto diferente, mas coerente']));
  assert.ok(verifySnapshot(harmless).ok, 'reselar com conteúdo coerente é possível: o hash não é assinatura');
});

test('o aviso sobre o hash não promete mais do que ele entrega', () => {
  assert.match(HASH_DISCLAIMER, /alteração acidental/);
  assert.match(HASH_DISCLAIMER, /Não é assinatura/);
  assert.match(HASH_DISCLAIMER, /não é criptografia|Não é assinatura, não é criptografia/);
  assert.match(HASH_DISCLAIMER, /pode recalcular o hash/);
});

test('rascunhos fora do contrato nunca lançam exceção', () => {
  for (const input of [null, undefined, 1, 'x', [], {}, { snapshotId: 5 }]) {
    const result = buildSnapshot(input, FIRST);
    assert.equal(result.ok, false);
  }
  const hostile = {};
  Object.defineProperty(hostile, 'snapshotId', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(buildSnapshot(hostile, FIRST).ok, false);
  assert.equal(verifySnapshot(hostile).ok, false);
});
