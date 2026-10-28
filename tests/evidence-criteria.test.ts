import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAllCriteria, assessCriterion, compareAddresses, CRITERIA_META, type CriteriaContext } from '../src/lib/evidence/criteria';
import { toPersistableEvidence } from '../src/lib/evidence/types';
import type { SiteCheckResult } from '../src/lib/site-check';
import { buildReportFixture, fixtureSiteCheck, buildReportFixtureLead } from '../src/dev/report-fixture';
import { legacyReputation, legacyVitrine } from '../src/dev/legacy-fixture';
import type { FrontierLead, VitrineMetrics } from '../src/types/gmn';

async function context(
  style: 'phase4' | 'phase4-live' = 'phase4',
  overrides: Omit<Partial<CriteriaContext>, 'lead'> & { lead?: Partial<FrontierLead> } = {}
): Promise<CriteriaContext> {
  const data = await buildReportFixture({ dataStyle: style });
  const { lead: leadOverrides, ...rest } = overrides;
  return {
    lead: leadOverrides ? buildReportFixtureLead(leadOverrides) : data.lead,
    reputation: data.reputation,
    vitrine: data.vitrine,
    battlefield: data.battlefield,
    rivals: data.rivals,
    siteCheck: style === 'phase4-live' ? await fixtureSiteCheck() : null,
    isAddressHidden: false,
    addressExceptionRuleTriggered: false,
    ...rest,
  };
}

const status = (ctx: CriteriaContext, n: number) => assessCriterion(n, ctx);

test('os 21 critérios e os pesos históricos (soma 102) estão todos presentes', () => {
  assert.equal(CRITERIA_META.length, 21);
  assert.deepEqual(CRITERIA_META.map((c) => c.itemNumber), Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(CRITERIA_META.reduce((sum, c) => sum + c.maxWeight, 0), 102);
});

test('toda avaliação traz evidência com status, explicação e limitações; nunca nota 0 ou 100 sem base', async () => {
  const outcomes = assessAllCriteria(await context('phase4'));
  assert.equal(outcomes.length, 21);
  for (const outcome of outcomes) {
    assert.ok(['VERIFIED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'SIMULATED'].includes(outcome.evidence.status));
    assert.ok(outcome.evidence.explanation.length > 10, `critério ${outcome.itemNumber}`);
    assert.equal(outcome.evidence.criterionId, outcome.itemNumber);
    if (outcome.evidence.status === 'NOT_VERIFIED' || outcome.evidence.status === 'SIMULATED') {
      assert.equal(outcome.score, null, `critério ${outcome.itemNumber} sem evidência não pode ter pontuação`);
      assert.equal(outcome.status, 'NOT_EVALUATED');
    }
    if (outcome.evidence.status === 'VERIFIED') {
      assert.ok(outcome.evidence.sourceProvider, `critério ${outcome.itemNumber} sem fonte`);
      assert.ok(outcome.evidence.collectedAt, `critério ${outcome.itemNumber} sem data de coleta`);
    }
  }
});

test('ausência de fonte: sem fontes de avaliações, vitrine e site, os critérios dependentes ficam não verificados', async () => {
  const ctx = await context('phase4');
  for (const n of [1, 2, 8, 12, 13, 14, 15, 16, 17, 18]) {
    assert.equal(status(ctx, n).evidence.status, 'NOT_VERIFIED', `critério ${n}`);
  }
  assert.equal(status(ctx, 5).evidence.status, 'PARTIALLY_VERIFIED', 'domínio informado, mas nada verificado no site');
  assert.equal(status(ctx, 5).score, null);
});

test('critério 1: nunca assume reivindicação; só com origem coletada e explícita', async () => {
  const unknown = await context('phase4', { lead: { claimedByOwner: true } });
  assert.equal(status(unknown, 1).evidence.status, 'NOT_VERIFIED');
  assert.equal(status(unknown, 1).score, null);
  const collected = await context('phase4', { lead: { claimedByOwner: false, provenance: { claimedByOwner: 'COLLECTED' } } });
  assert.equal(status(collected, 1).evidence.status, 'VERIFIED');
  assert.equal(status(collected, 1).status, 'FAIL');
});

test('critério 3: endereço público existente não comprova consistência', async () => {
  const noSite = await context('phase4');
  const alone = status(noSite, 3);
  assert.equal(alone.evidence.status, 'PARTIALLY_VERIFIED');
  assert.equal(alone.score, null);
  assert.ok(alone.evidence.limitations.some((l) => /não prova consistência/.test(l)));

  const withSite = await context('phase4-live');
  const matched = status(withSite, 3);
  // Coincidência entre dois canais não comprova a regra SAB nem a área de cobertura: parcial, sem pontuação.
  assert.equal(matched.evidence.status, 'PARTIALLY_VERIFIED', 'endereço da listagem coincide com o do site');
  assert.equal(matched.status, 'PARTIAL');
  assert.equal(matched.score, null);
  assert.match(matched.observed, /coincide com o endereço estruturado do site/);
  assert.ok(matched.evidence.limitations.some((l) => /regra SAB e a área de cobertura .* não foram avaliadas/.test(l)));
  assert.ok(matched.evidence.limitations.some((l) => /CNPJ/.test(l)));
  assert.equal((matched.evidence.value as { serviceAreaEvaluated: boolean }).serviceAreaEvaluated, false);

  const diverging: SiteCheckResult = {
    ...(await fixtureSiteCheck()),
    localBusiness: { types: ['Dentist'], name: 'X', telephone: null, hasGeo: false, address: { streetAddress: 'Avenida Outra, 999', locality: 'Outra Cidade', region: 'SP', postalCode: '01000-000' } },
  };
  const mismatch = status({ ...withSite, siteCheck: diverging }, 3);
  assert.equal(mismatch.evidence.status, 'PARTIALLY_VERIFIED');
  assert.equal(mismatch.status, 'PARTIAL');
});

test('critério 3: endereço oculto por inferência de SAB é parcial e sem pontuação (exceção registrada)', async () => {
  const sab = await context('phase4', { isAddressHidden: true, addressExceptionRuleTriggered: true, lead: { addressRaw: null, isAddressHidden: true } });
  const result = status(sab, 3);
  assert.equal(result.status, 'EXEMPT_BY_CONTEXT_RULE');
  assert.equal(result.evidence.status, 'PARTIALLY_VERIFIED');
  assert.equal(result.score, null);
  const missing = await context('phase4', { isAddressHidden: true, lead: { addressRaw: null, isAddressHidden: true } });
  assert.equal(status(missing, 3).evidence.status, 'NOT_VERIFIED', 'ausência na coleta não prova endereço oculto');
});

test('comparação de endereços: CEP, número e vocabulário; formatação diferente não vira divergência', () => {
  const listing = 'Rua Barão de Cotegipe, 245 - Centro, Anápolis - GO, 75020-000, Brasil';
  assert.equal(compareAddresses(listing, { streetAddress: 'R. Barão de Cotegipe, 245', locality: 'Anápolis', postalCode: '75020000' }), 'MATCH');
  assert.equal(compareAddresses(listing, { streetAddress: 'Rua Barão de Cotegipe, 245', locality: 'Anápolis', postalCode: null }), 'MATCH');
  assert.equal(compareAddresses(listing, { streetAddress: 'Avenida Brasil, 10', locality: 'Goiânia', postalCode: '74000-000' }), 'MISMATCH');
  assert.equal(compareAddresses(listing, { streetAddress: 'Rua Barão de Cotegipe, 999', locality: 'Anápolis', postalCode: null }), 'MISMATCH');
  assert.equal(compareAddresses(listing, { streetAddress: null, locality: 'Anápolis', postalCode: null }), 'INSUFFICIENT');
});

test('critério 4 (WhatsApp): formato de número ou link público nunca viram "verificado"', async () => {
  const mobile = await context('phase4', { lead: { whatsappStatus: 'LIKELY_MOBILE_WHATSAPP', whatsappUrl: 'https://wa.me/5562900000000' } });
  const probable = status(mobile, 4);
  assert.equal(probable.evidence.status, 'PARTIALLY_VERIFIED');
  assert.ok(probable.evidence.limitations.some((l) => /não prova que há WhatsApp ativo/.test(l)));

  const link = await context('phase4', { lead: { whatsappStatus: 'VERIFIED_WHATSAPP', whatsappUrl: 'https://wa.me/5562900000000' } });
  assert.equal(status(link, 4).evidence.status, 'PARTIALLY_VERIFIED');
  assert.ok(status(link, 4).evidence.limitations.some((l) => /não comprova uma conta ativa/.test(l)));

  const landline = await context('phase4', { lead: { whatsappStatus: 'LANDLINE_ONLY', whatsappUrl: null } });
  assert.equal(status(landline, 4).evidence.status, 'NOT_VERIFIED');
  assert.equal(status(landline, 4).score, null, 'telefone fixo não reprova o canal');

  // Link público no site também só vale como parcial
  const live = await context('phase4-live', { lead: { whatsappStatus: 'MISSING', whatsappUrl: null } });
  assert.equal(status(live, 4).evidence.status, 'PARTIALLY_VERIFIED');
});

test('critério 5: site sem schema, com noindex, inalcançável e rede social são tratados componente a componente', async () => {
  const base = await context('phase4-live');
  const site = await fixtureSiteCheck();
  assert.equal(status(base, 5).evidence.status, 'VERIFIED');
  assert.equal(status(base, 5).status, 'PASS');
  assert.ok(status(base, 5).evidence.limitations.some((l) => /indexação efetiva/.test(l)), 'não afirma indexação no Google');

  const noSchema = status({ ...base, siteCheck: { ...site, localBusiness: null } }, 5);
  assert.equal(noSchema.evidence.status, 'PARTIALLY_VERIFIED');
  assert.match(noSchema.observed, /nenhum dado estruturado LocalBusiness/);
  assert.notEqual(noSchema.status, 'PASS');

  const noindex = status({ ...base, siteCheck: { ...site, noindex: true } }, 5);
  assert.equal(noindex.evidence.status, 'VERIFIED');
  assert.equal(noindex.status, 'FAIL');

  const robotsBlocked = status({ ...base, siteCheck: { ...site, robotsTxt: 'DISALLOWED' } }, 5);
  assert.equal(robotsBlocked.status, 'FAIL');

  const down: SiteCheckResult = { ...site, status: 'UNREACHABLE', localBusiness: null, noindex: null, failureReason: 'ECONNREFUSED' };
  const unreachable = status({ ...base, siteCheck: down }, 5);
  assert.equal(unreachable.evidence.status, 'PARTIALLY_VERIFIED');
  assert.equal(unreachable.score, null, 'falha pontual não reprova o site');

  const social = status(await context('phase4', { lead: { websiteStatus: 'SOCIAL_LINK_ONLY', websiteUrl: 'https://instagram.com/x' } }), 5);
  assert.equal(social.evidence.status, 'VERIFIED');
  assert.equal(social.status, 'PARTIAL');
  const none = status(await context('phase4', { lead: { websiteStatus: 'MISSING', websiteUrl: null } }), 5);
  assert.equal(none.evidence.status, 'NOT_VERIFIED', 'ausência na coleta não prova ausência de site');
});

test('critérios 10 e 11: nota e volume só comprovam com valores reais, nunca com os padrões antigos', async () => {
  assert.equal(status(await context('phase4'), 10).evidence.status, 'VERIFIED');
  assert.equal(status(await context('phase4', { lead: { rating: 4.5, totalReviews: 15 } }), 10).evidence.status, 'NOT_VERIFIED');
  assert.equal(status(await context('phase4', { lead: { rating: 0, totalReviews: 0 } }), 10).evidence.status, 'NOT_VERIFIED');
  assert.equal(status(await context('phase4', { lead: { provenance: { rating: 'UNKNOWN' } } }), 10).evidence.status, 'NOT_VERIFIED');
  const base = await context('phase4');
  const defaultLeader = {
    ...base,
    rivals: { ...base.rivals, topDominators: base.rivals.topDominators.map((d) => ({ ...d, rating: 4.8, totalReviews: 140 })) },
  };
  assert.equal(status(defaultLeader, 11).evidence.status, 'NOT_VERIFIED');
  const nullLeader = { ...base, rivals: { ...base.rivals, topDominators: base.rivals.topDominators.map((d) => ({ ...d, rating: null, totalReviews: null })) } };
  assert.equal(status(nullLeader, 11).evidence.status, 'NOT_VERIFIED');
});

test('critério 6: compara a categoria com a dos líderes; sem líderes não há aprovação fixa', async () => {
  const base = await context('phase4');
  assert.equal(status(base, 6).evidence.status, 'VERIFIED');
  assert.equal(status(base, 6).status, 'PASS');
  const other = status({ ...base, lead: { ...base.lead, primaryCategory: 'Padaria' } }, 6);
  assert.equal(other.evidence.status, 'VERIFIED');
  assert.equal(other.status, 'FAIL');
  const noLeaders = status({ ...base, battlefield: { ...base.battlefield, points: base.battlefield.points.map((p) => ({ ...p, pointLeader: null })) } }, 6);
  assert.equal(noLeaders.evidence.status, 'NOT_VERIFIED');
});

test('critérios 12 a 14: avaliações com janela coberta, amostra parcial e sem fonte', async () => {
  const live = await context('phase4-live');
  assert.equal(status(live, 12).evidence.status, 'VERIFIED');
  assert.equal(status(live, 13).evidence.status, 'PARTIALLY_VERIFIED', 'taxa medida só na amostra');
  assert.equal(status(live, 14).evidence.status, 'PARTIALLY_VERIFIED');
  assert.ok(status(live, 13).evidence.limitations.some((l) => /não representam o total/.test(l)));

  const short = {
    ...live,
    reputation: {
      ...live.reputation,
      reviewsAvailability: live.reputation.reviewsAvailability && live.reputation.reviewsAvailability.analysis
        ? { ...live.reputation.reviewsAvailability, analysis: { ...live.reputation.reviewsAvailability.analysis, windowCovered: false, countLast30DaysIsLowerBound: true } }
        : live.reputation.reviewsAvailability,
    },
  };
  assert.equal(status(short, 12).evidence.status, 'NOT_VERIFIED', 'janela não coberta: o número seria só um mínimo');
});

test('avaliações e vitrine simuladas (formato antigo) viram SIMULADO e sem pontuação, nunca aprovação', async () => {
  const base = await context('phase4');
  const simulated: CriteriaContext = { ...base, reputation: legacyReputation(base.lead), vitrine: legacyVitrine(base.lead) };
  for (const n of [12, 13, 14, 15, 16, 17, 18]) {
    const result = status(simulated, n);
    assert.equal(result.evidence.status, 'SIMULATED', `critério ${n}`);
    assert.equal(result.score, null);
  }
  const persisted = toPersistableEvidence(assessAllCriteria(simulated).map((o) => o.evidence));
  assert.ok(persisted.every((e) => e.status !== 'SIMULATED'), 'evidência simulada nunca é persistida como evidência');
  assert.ok(persisted.length < 21);
});

test('critérios 15 a 18: só com o campo informado pela fonte', async () => {
  const live = await context('phase4-live');
  assert.equal(status(live, 15).evidence.status, 'VERIFIED');
  const partialVitrine: VitrineMetrics = { ...live.vitrine, availability: { ...(live.vitrine.availability as NonNullable<VitrineMetrics['availability']>), fieldsProvided: ['totalPhotosCount'] } };
  const partial = { ...live, vitrine: partialVitrine };
  assert.equal(status(partial, 15).evidence.status, 'VERIFIED');
  for (const n of [16, 17, 18]) assert.equal(status(partial, n).evidence.status, 'NOT_VERIFIED', `critério ${n}`);
  // Valor presente sem a declaração da fonte não é aceito
  const undeclared = { ...live, vitrine: { ...live.vitrine, availability: { ...(live.vitrine.availability as NonNullable<VitrineMetrics['availability']>), fieldsProvided: [] } } };
  assert.equal(status(undeclared, 15).evidence.status, 'NOT_VERIFIED');
});

test('critérios territoriais: grade completa verificada; parcial é parcial; sem leitura é não verificado; simulada é simulada', async () => {
  const base = await context('phase4');
  for (const n of [19, 20, 21]) assert.equal(status(base, n).evidence.status, 'VERIFIED', `critério ${n}`);
  const half = { ...base, battlefield: { ...base.battlefield, points: base.battlefield.points.map((p, i) => (i < 25 ? { ...p, readStatus: 'UNREADABLE' as const, targetRank: null } : p)) } };
  assert.equal(status(half, 19).evidence.status, 'PARTIALLY_VERIFIED');
  const none = { ...base, battlefield: { ...base.battlefield, points: base.battlefield.points.map((p) => ({ ...p, readStatus: 'UNREADABLE' as const, targetRank: null })) } };
  assert.equal(status(none, 19).evidence.status, 'NOT_VERIFIED');
  assert.equal(status(none, 19).score, null);
  const demo = { ...base, battlefield: { ...base.battlefield, dataOrigin: 'SIMULATED' as const } };
  assert.equal(status(demo, 19).evidence.status, 'SIMULATED');
});

test('a mesma entrada produz sempre o mesmo resultado (reprocessamento determinístico)', async () => {
  const ctx = await context('phase4-live');
  assert.deepEqual(assessAllCriteria(ctx), assessAllCriteria(ctx));
});
