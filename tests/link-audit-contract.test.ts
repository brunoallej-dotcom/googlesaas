import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmIdentity,
  createDraftLinkAudit,
  deriveAuditState,
  identityFromParse,
  type LinkAudit,
} from '../src/lib/link-audit/audit';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import {
  CRITERIA,
  CRITERION_IDS,
  METHODOLOGY_STATUS,
  METHODOLOGY_VERSION,
  TOTAL_MAX_WEIGHT,
} from '../src/lib/link-audit/methodology';
import { validateLinkAudit } from '../src/lib/link-audit/validate';

/* Dados FICTÍCIOS de teste. */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const IDENTIFIED_LINK = `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}`;
const WHEN = '2026-10-20T12:00:00.000Z';
const CONFIRMATION = { confirmedBy: 'operador@exemplo.com', confirmedAt: WHEN };

function confirmedAudit(): LinkAudit {
  const parse = parseGoogleMapsLink(IDENTIFIED_LINK);
  const confirmed = confirmIdentity(parse, CONFIRMATION);
  assert.ok(confirmed.ok);
  const draft = createDraftLinkAudit(parse);
  return { ...draft, state: 'IDENTITY_CONFIRMED', identity: confirmed.value };
}

function withEvidence(audit: LinkAudit): LinkAudit {
  return {
    ...audit,
    evidences: [
      {
        id: 'ev-nap-1',
        attribute: 'official_phone',
        criterionId: 'NAP',
        claim: 'Telefone publicado no site oficial.',
        status: 'VERIFIED',
        origin: 'OFFICIAL_SITE',
        sourceUrl: 'https://www.padaria-exemplo.com.br/contato',
        consultedAt: WHEN,
      },
    ],
    criteria: audit.criteria.map((c) => (c.criterionId === 'NAP' ? { ...c, status: 'VERIFIED' as const, evidenceIds: ['ev-nap-1'] } : c)),
  };
}

test('metodologia: nove critérios, pesos 15,10,12,18,8,10,8,10,9 somando 100, versão reconstruída', () => {
  assert.equal(CRITERIA.length, 9);
  assert.deepEqual(CRITERIA.map((c) => c.maxWeight), [15, 10, 12, 18, 8, 10, 8, 10, 9]);
  assert.equal(TOTAL_MAX_WEIGHT, 100);
  assert.deepEqual(CRITERIA.map((c) => c.id), [...CRITERION_IDS]);
  assert.equal(METHODOLOGY_VERSION, 'lumos-reconstruida-v1');
  assert.match(METHODOLOGY_STATUS, /não é o prompt original/);
});

test('rascunho a partir de link com identificador: identidade ainda NÃO confirmada, critérios Não verificado', () => {
  const draft = createDraftLinkAudit(parseGoogleMapsLink(IDENTIFIED_LINK));
  assert.equal(draft.state, 'IDENTITY_PENDING_CONFIRMATION');
  assert.deepEqual(draft.identity?.identifiers, { featureId: FID });
  assert.equal(draft.identity?.confirmation, undefined);
  assert.ok(draft.criteria.every((c) => c.status === 'NOT_VERIFIED' && c.evidenceIds.length === 0));
  assert.equal(draft.indexStatus, 'PENDING_METHODOLOGY');
  assert.equal(validateLinkAudit(draft).ok, true, validateLinkAudit(draft).issues.join('; '));
});

test('estado derivado do parser cobre todos os desfechos do link', () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    ['', 'LINK_INVALID'],
    ['http://www.google.com/maps?cid=1', 'LINK_REJECTED'],
    ['https://example.com/', 'LINK_UNSUPPORTED'],
    ['https://maps.app.goo.gl/AbCd1234', 'RESOLUTION_PENDING'],
    ['https://www.google.com/maps/place/Padaria+Exemplo/@-16.68,-49.26,17z', 'IDENTITY_AMBIGUOUS'],
    [IDENTIFIED_LINK, 'IDENTITY_PENDING_CONFIRMATION'],
  ];
  for (const [link, expected] of cases) {
    const parse = parseGoogleMapsLink(link);
    assert.equal(deriveAuditState(parse, identityFromParse(parse)), expected, String(link));
    const draft = createDraftLinkAudit(parse);
    assert.equal(draft.state, expected);
    assert.equal(validateLinkAudit(draft).ok, true, `${String(link)}: ${validateLinkAudit(draft).issues.join('; ')}`);
  }
});

test('identidade só é confirmada por link com identificador e confirmação explícita do operador', () => {
  const identified = parseGoogleMapsLink(IDENTIFIED_LINK);
  const ok = confirmIdentity(identified, CONFIRMATION);
  assert.ok(ok.ok);
  assert.equal(ok.value.confirmation?.confirmedBy, 'operador@exemplo.com');
  assert.equal(deriveAuditState(identified, ok.value), 'IDENTITY_CONFIRMED');

  // Sem confirmação ou com confirmação incompleta, nada é confirmado.
  assert.equal(confirmIdentity(identified, undefined).ok, false);
  assert.equal(confirmIdentity(identified, { confirmedBy: '', confirmedAt: WHEN }).ok, false);
  assert.equal(confirmIdentity(identified, { confirmedBy: 'op', confirmedAt: 'ontem' }).ok, false);
  assert.equal(confirmIdentity(identified, { ...CONFIRMATION, extra: 1 }).ok, false);

  // Ambíguo, curto, inválido ou rejeitado nunca viram identidade confirmada (nome parecido não basta).
  for (const link of [
    'https://www.google.com/maps/place/Padaria+Exemplo/@-16.68,-49.26,17z',
    'https://maps.app.goo.gl/AbCd1234',
    'Padaria Exemplo',
    'javascript:alert(1)',
  ]) {
    const result = confirmIdentity(parseGoogleMapsLink(link), CONFIRMATION);
    assert.equal(result.ok, false, link);
  }
  // Identidade confirmada para outro identificador não confirma este link.
  const other = parseGoogleMapsLink('https://www.google.com/maps?cid=999');
  assert.equal(deriveAuditState(other, ok.value), 'IDENTITY_PENDING_CONFIRMATION');
});

test('auditoria confirmada com evidência verificada é válida', () => {
  const audit = withEvidence(confirmedAudit());
  const result = validateLinkAudit(audit);
  assert.equal(result.ok, true, result.issues.join('; '));
});

test('sem identidade confirmada não há evidências nem critérios além de Não verificado', () => {
  const pending = createDraftLinkAudit(parseGoogleMapsLink(IDENTIFIED_LINK));
  const withEv = withEvidence({ ...pending, state: 'IDENTITY_PENDING_CONFIRMATION' });
  const result = validateLinkAudit(withEv);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' | '), /identidade confirmada/);

  const ambiguous = createDraftLinkAudit(parseGoogleMapsLink('https://www.google.com/maps/search/padaria'));
  assert.equal(validateLinkAudit({ ...ambiguous, identity: { originalLink: 'x', identifiers: { cid: '1' } } }).ok, false);
  assert.equal(
    validateLinkAudit({ ...createDraftLinkAudit(parseGoogleMapsLink(IDENTIFIED_LINK)), state: 'IDENTITY_CONFIRMED' }).ok,
    false,
    'IDENTITY_CONFIRMED sem confirmation é inválido',
  );
});

test('Não verificado não significa zero: critério sem evidência é válido e continua sem nota', () => {
  const audit = confirmedAudit();
  const result = validateLinkAudit(audit);
  assert.equal(result.ok, true, result.issues.join('; '));
  assert.ok(audit.criteria.every((c) => c.status === 'NOT_VERIFIED'));
  assert.equal(JSON.stringify(audit).includes('"points"'), false);
});

test('status de critério nunca é mais forte que as evidências (nada é presumido)', () => {
  const audit = confirmedAudit();
  const claimsVerified: LinkAudit = {
    ...audit,
    criteria: audit.criteria.map((c) => (c.criterionId === 'REVIEWS' ? { ...c, status: 'VERIFIED' as const } : c)),
  };
  assert.match(validateLinkAudit(claimsVerified).issues.join(' | '), /REVIEWS: status VERIFIED sem evidência de suporte/);

  const partialOnly = withEvidence(audit);
  const evidence = partialOnly.evidences[0];
  assert.ok(evidence);
  const weaker: LinkAudit = {
    ...partialOnly,
    evidences: [{ ...evidence, status: 'PARTIAL', limitation: 'Só parte do site foi lida.' }],
  };
  assert.match(validateLinkAudit(weaker).issues.join(' | '), /NAP: status VERIFIED sem evidência de suporte/);
});

test('referências quebradas entre critérios e evidências são recusadas', () => {
  const audit = withEvidence(confirmedAudit());
  const wrongCriterion: LinkAudit = {
    ...audit,
    criteria: audit.criteria.map((c) => (c.criterionId === 'CONVERSION' ? { ...c, evidenceIds: ['ev-nap-1'] } : c)),
  };
  assert.match(validateLinkAudit(wrongCriterion).issues.join(' | '), /pertence ao critério NAP/);

  const missing: LinkAudit = {
    ...audit,
    criteria: audit.criteria.map((c) => (c.criterionId === 'CONVERSION' ? { ...c, evidenceIds: ['nao-existe'] } : c)),
  };
  assert.match(validateLinkAudit(missing).issues.join(' | '), /evidência inexistente/);

  const duplicate: LinkAudit = { ...audit, evidences: [...audit.evidences, ...audit.evidences] };
  assert.match(validateLinkAudit(duplicate).issues.join(' | '), /id duplicado/);
});

test('os nove critérios devem aparecer exatamente uma vez', () => {
  const audit = confirmedAudit();
  assert.equal(validateLinkAudit({ ...audit, criteria: audit.criteria.slice(1) }).ok, false);
  const repeated = { ...audit, criteria: [...audit.criteria.slice(1), audit.criteria[1]] };
  assert.match(validateLinkAudit(repeated).issues.join(' | '), /repetido|ausente/);
});

test('o contrato rejeita pontuação, índice, cobertura e classificação (D3 ainda não aprovada)', () => {
  const audit = confirmedAudit();
  const forbiddenTopLevel = { points: 80 };
  for (const extra of [
    forbiddenTopLevel,
    { index: 84 },
    { coverage: 65 },
    { classification: 'Forte' },
    { confidence: 'alta' },
    { baseObserved: '54,5/65' },
  ]) {
    assert.equal(validateLinkAudit({ ...audit, ...extra }).ok, false, JSON.stringify(extra));
  }
  const withPoints = { ...audit, criteria: audit.criteria.map((c) => ({ ...c, points: 5 })) };
  assert.equal(validateLinkAudit(withPoints).ok, false);
  assert.equal(validateLinkAudit({ ...audit, indexStatus: 'CALCULATED' }).ok, false);
  assert.equal(validateLinkAudit({ ...audit, methodologyVersion: 'juiz-21' }).ok, false);
  assert.equal(validateLinkAudit({ ...audit, schemaVersion: 2 }).ok, false);
});

test('entradas inválidas nunca lançam exceção', () => {
  for (const input of [null, undefined, 42, 'x', [], {}, { state: 'IDENTITY_CONFIRMED' }]) {
    const result = validateLinkAudit(input);
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
  }
});

test('o domínio novo não depende do Juiz: nenhum critério do Juiz entra na metodologia nova', () => {
  const ids = new Set<string>(CRITERION_IDS);
  assert.equal(ids.size, 9);
  assert.ok(!JSON.stringify(CRITERIA).includes('102'), 'o denominador 102 do Juiz não pode aparecer');
});

test('a identidade precisa ser coerente com o link original (nada de identidade sem link que a sustente)', () => {
  const audit = confirmedAudit();
  const identity = audit.identity;
  assert.ok(identity);
  for (const originalLink of ['javascript:alert(1)', 'https://evil.com/', 'Padaria Exemplo', 'https://www.google.com/maps?cid=999']) {
    const forged: LinkAudit = { ...audit, identity: { ...identity, originalLink } };
    assert.match(validateLinkAudit(forged).issues.join(' | '), /não correspondem ao originalLink/, originalLink);
  }
  const otherIds: LinkAudit = { ...audit, identity: { ...identity, identifiers: { ...identity.identifiers, cid: '999' } } };
  assert.equal(validateLinkAudit(otherIds).ok, false);
});

test('evidência nativa precisa ser do mesmo perfil auditado', () => {
  const audit = confirmedAudit(); // identificado por featureId
  const nativeEvidence = (sourceUrl: string) => ({
    id: 'ev-rev-1',
    attribute: 'google_reviews',
    criterionId: 'REVIEWS' as const,
    claim: 'Nota exibida no perfil.',
    status: 'VERIFIED' as const,
    origin: 'GOOGLE_NATIVE' as const,
    sourceUrl,
    consultedAt: WHEN,
  });
  const build = (sourceUrl: string): LinkAudit => ({
    ...audit,
    evidences: [nativeEvidence(sourceUrl)],
    criteria: audit.criteria.map((c) => (c.criterionId === 'REVIEWS' ? { ...c, status: 'VERIFIED' as const, evidenceIds: ['ev-rev-1'] } : c)),
  });
  // Mesmo perfil (mesmo featureId): aceito.
  assert.equal(validateLinkAudit(build(`https://www.google.com/maps?ftid=${FID}`)).ok, true);
  // Outro perfil, ou link que não permite comparar com a identidade: recusado.
  const otherFeature = validateLinkAudit(build('https://www.google.com/maps?ftid=0x1111111111111111:0x2222222222222222'));
  assert.match(otherFeature.issues.join(' | '), /não é do perfil auditado/);
  const noCommon = validateLinkAudit(build('https://www.google.com/maps?cid=999'));
  assert.match(noCommon.issues.join(' | '), /não é do perfil auditado/);
});

test('validação e funções do contrato nunca lançam, mesmo com objetos hostis ou entradas nulas', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'state', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(validateLinkAudit(hostile).ok, false);
  assert.equal(confirmIdentity(null as never, CONFIRMATION).ok, false);
  assert.equal(identityFromParse(null as never), null);
  assert.equal(deriveAuditState(null as never, null), 'LINK_INVALID');
});

test('evidenceIds repetidos em um critério são recusados', () => {
  const audit = withEvidence(confirmedAudit());
  const repeated: LinkAudit = {
    ...audit,
    criteria: audit.criteria.map((c) => (c.criterionId === 'NAP' ? { ...c, evidenceIds: ['ev-nap-1', 'ev-nap-1'] } : c)),
  };
  assert.match(validateLinkAudit(repeated).issues.join(' | '), /evidenceIds repetidos/);
});
