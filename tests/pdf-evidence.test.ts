import assert from 'node:assert/strict';
import test from 'node:test';
import { toBattlefieldMapModel } from '../src/lib/battlefield-map-adapter';
import {
  assessCriteria,
  detectBattlefieldOrigin,
  detectOrigins,
  detectReputationOrigin,
  detectVitrineOrigin,
  leadRatingIsDefault,
  leaderValuesAreDefault,
} from '../src/lib/pdf/report-evidence';
import { buildReportFixture, buildReportFixtureLead } from '../src/dev/report-fixture';

async function classify(options?: Parameters<typeof buildReportFixture>[0]) {
  const data = await buildReportFixture(options);
  const model = toBattlefieldMapModel({ battlefield: data.battlefield, lead: data.lead, auditId: data.auditId });
  return { data, model, criteria: assessCriteria(data, model) };
}

const byCode = (criteria: Awaited<ReturnType<typeof classify>>['criteria'], code: string) => {
  const found = criteria.find((c) => c.code === code);
  assert.ok(found, `critério ${code} não encontrado`);
  return found;
};

test('reconhece o fallback simulado de reputação e vitrine pelos marcadores reais', async () => {
  const { data } = await classify();
  assert.equal(detectReputationOrigin(data.reputation, data.lead.placeId), 'SIMULATED');
  assert.equal(detectVitrineOrigin(data.vitrine, data.lead.placeId), 'SIMULATED');
  assert.equal(detectBattlefieldOrigin(data.battlefield), 'COLLECTED');
});

test('Fase 4: reputação e vitrine vindas de fonte real não são marcadas como simuladas', async () => {
  const { data } = await classify({ dataStyle: 'phase4-live' });
  assert.equal(data.reputation.reviewsAvailability?.state, 'FETCHED');
  assert.equal(data.vitrine.availability?.state, 'FETCHED');
  // A Fase 4 não guarda textos nem nomes de clientes: sem amostra, a origem é "não verificado", nunca "simulado".
  assert.notEqual(detectReputationOrigin(data.reputation, data.lead.placeId), 'SIMULATED');
  assert.notEqual(detectVitrineOrigin(data.vitrine, data.lead.placeId), 'SIMULATED');
});

test('reputação ou vitrine sem amostra: não verificado (nunca coletado)', async () => {
  const { data } = await classify();
  assert.equal(
    detectReputationOrigin({ ...data.reputation, recentReviewsSample: [] }, data.lead.placeId),
    'NOT_VERIFIED'
  );
  assert.equal(
    detectVitrineOrigin({ ...data.vitrine, mediaGallerySample: [] }, data.lead.placeId),
    'NOT_VERIFIED'
  );
});

test('líderes do fallback do Battlefield marcam o território como simulado', async () => {
  const { data } = await classify();
  const tampered = {
    ...data.battlefield,
    points: data.battlefield.points.map((pt, index) =>
      index === 0 && pt.pointLeader
        ? { ...pt, pointLeader: { ...pt.pointLeader, placeId: 'ChIJ_RIVAL_DOMINATOR_ALPHA' } }
        : pt
    ),
  };
  assert.equal(detectBattlefieldOrigin(tampered), 'SIMULATED');
  assert.equal(detectBattlefieldOrigin({ ...data.battlefield, points: [] }), 'NOT_VERIFIED');
});

test('valores padrão dos prospectores e do Battlefield são reconhecidos', () => {
  assert.equal(leadRatingIsDefault(buildReportFixtureLead({ rating: 4.5, totalReviews: 15 })), true);
  assert.equal(leadRatingIsDefault(buildReportFixtureLead({ rating: 4.4, totalReviews: 18 })), true);
  assert.equal(leadRatingIsDefault(buildReportFixtureLead({ rating: 4.5, totalReviews: 16 })), false);
  assert.equal(leaderValuesAreDefault(4.8, 140), true);
  assert.equal(leaderValuesAreDefault(4.8, 141), false);
});

test('auditoria anterior à Fase 4: 5 comprovados, 2 parciais, 6 simulados e 8 não verificados', async () => {
  const { criteria } = await classify();
  assert.equal(criteria.length, 21);

  const ids = (cls: string): number[] => criteria.filter((c) => c.evidenceClass === cls).map((c) => c.itemNumber);

  // Endereço (3) e site (5) deixam de ser "comprovados": só existem na listagem, sem cruzamento nem verificação do site.
  assert.deepEqual(ids('VERIFIED'), [10, 11, 19, 20, 21]);
  assert.deepEqual(ids('PARTIAL'), [3, 5]);
  assert.deepEqual(ids('SIMULATED'), [12, 13, 15, 16, 17, 18]);
  assert.deepEqual(ids('NOT_VERIFIED'), [1, 2, 4, 6, 7, 8, 9, 14]);
});

test('reavaliar uma auditoria antiga nunca promove critério a verificado nem altera a pontuação gravada', async () => {
  const { data, criteria } = await classify();
  const stored = new Map(data.judge.checklist21Items.map((i) => [i.itemNumber, i.scoreAwarded]));
  for (const c of criteria) assert.equal(c.agentScore, stored.get(c.itemNumber), c.code);
  // Item 6 era um PASS fixo; a reavaliação atual o verificaria, mas a classe antiga (não verificado) prevalece.
  assert.equal(byCode(criteria, 'CAT_06_PRIMARY_MATCH').evidenceClass, 'NOT_VERIFIED');
});

test('critério sem comprovação nunca vira aprovado nem reprovado e não traz evidência', async () => {
  const { criteria } = await classify();
  for (const c of criteria.filter((x) => x.evidenceClass === 'NOT_VERIFIED' || x.evidenceClass === 'SIMULATED')) {
    assert.ok(c.displayStatus === 'UNVERIFIED' || c.displayStatus === 'SIMULATED', c.code);
    assert.equal(c.evidence, null, c.code);
    assert.ok(c.reason && c.reason.length > 10, c.code);
  }
  // Parcialmente verificado: aparece à parte, nunca como aprovado, parcial ou crítico.
  for (const c of criteria.filter((x) => x.evidenceClass === 'PARTIAL')) {
    assert.equal(c.displayStatus, 'PARTIAL_EVIDENCE', c.code);
    assert.ok(c.limitations.length > 0, c.code);
  }
  // O resultado fixo do agente nos itens 6 e 14 não é aprovado nem parcial no relatório.
  assert.equal(byCode(criteria, 'CAT_06_PRIMARY_MATCH').displayStatus, 'UNVERIFIED');
  assert.equal(byCode(criteria, 'REP_14_KEYWORD_RICHTEXT_REVIEWS').displayStatus, 'UNVERIFIED');
});

test('reputação simulada: itens 12 e 13 ficam SIMULADO mesmo com pontuação do agente', async () => {
  const { criteria } = await classify();
  const response = byCode(criteria, 'REP_13_OWNER_RESPONSE_RATE');
  assert.equal(response.evidenceClass, 'SIMULATED');
  assert.equal(response.displayStatus, 'SIMULATED');
  assert.ok((response.agentScore ?? 0) <= 100);
});

test('com fontes reais (fixtures de teste) os itens passam a ser comprovados, cada um no seu nível', async () => {
  const { criteria } = await classify({ dataStyle: 'phase4-live' });
  for (const code of ['REP_12_VELOCITY_30D', 'VIT_15_PHOTO_VOLUME', 'VIT_16_VIDEO_ASSETS', 'VIT_17_MEDIA_FRESHNESS', 'VIT_18_GOOGLE_POSTS_CADENCE', 'NAP_05_OWN_WEBSITE']) {
    assert.equal(byCode(criteria, code).evidenceClass, 'VERIFIED', code);
  }
  // Endereço coincidente entre site e listagem NÃO comprova a regra SAB/área de cobertura: parcial.
  assert.equal(byCode(criteria, 'NAP_03_ADDRESS_CONTEXT').evidenceClass, 'PARTIAL');
  // Amostra de avaliações não representa o total do perfil: taxa de resposta e termos ficam parciais.
  assert.equal(byCode(criteria, 'REP_13_OWNER_RESPONSE_RATE').evidenceClass, 'PARTIAL');
  assert.equal(byCode(criteria, 'REP_14_KEYWORD_RICHTEXT_REVIEWS').evidenceClass, 'PARTIAL');
  // Sem fonte para reivindicação, serviços e nome: continuam não verificados.
  for (const code of ['NAP_01_CLAIMED', 'NAP_02_NAME_SEMANTICS', 'CAT_08_SERVICES_CATALOG']) {
    assert.equal(byCode(criteria, code).evidenceClass, 'NOT_VERIFIED', code);
  }
});

test('nota padrão do prospector não é comprovada', async () => {
  const { criteria } = await classify({ lead: { rating: 4.5, totalReviews: 15 } });
  assert.equal(byCode(criteria, 'REP_10_RATING_HEALTH').evidenceClass, 'NOT_VERIFIED');
  assert.equal(byCode(criteria, 'REP_11_VOLUME_VS_LEADER').evidenceClass, 'NOT_VERIFIED');
});

test('endereço ausente: ausência de dado não vira aprovação nem reprovação', async () => {
  const { criteria } = await classify({ lead: { addressRaw: null, isAddressHidden: true } });
  const address = byCode(criteria, 'NAP_03_ADDRESS_CONTEXT');
  assert.equal(address.evidenceClass, 'NOT_VERIFIED');
  assert.equal(address.displayStatus, 'UNVERIFIED');
});

test('recomendação coerente: critério aprovado vira "manter", nunca "elevar a nota acima de 4,7"', async () => {
  const { criteria, data } = await classify();
  assert.equal(data.lead.rating, 4.9);
  const rating = byCode(criteria, 'REP_10_RATING_HEALTH');
  assert.equal(rating.displayStatus, 'APPROVED');
  assert.doesNotMatch(rating.recommendation, /elevar|4[.,]7|acima de 4/i);
  assert.match(rating.recommendation, /manter/i);
});

test('critério sem comprovação recebe uma orientação de validação, não uma ação sobre o problema', async () => {
  const { criteria } = await classify();
  const posts = byCode(criteria, 'VIT_18_GOOGLE_POSTS_CADENCE');
  assert.match(posts.recommendation, /conferir/i);
  assert.doesNotMatch(posts.recommendation, /publicar 2/i);
});

test('detectOrigins resume as origens usadas pelo relatório', async () => {
  const { data } = await classify();
  const origins = detectOrigins(data);
  assert.deepEqual(origins, {
    reputation: 'SIMULATED',
    vitrine: 'SIMULATED',
    battlefield: 'COLLECTED',
    leadRatingIsDefault: false,
  });
});
