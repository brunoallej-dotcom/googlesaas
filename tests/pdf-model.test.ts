import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportModel, NO_HISTORY_TEXT, parseCityState } from '../src/lib/pdf/report-model';
import { containsPromise } from '../src/lib/pdf/report-plan';
import { runQualityChecks } from '../src/lib/pdf/report-validation';
import { buildReportFixture } from '../src/dev/report-fixture';
import type { BattlefieldMetrics } from '../src/types/gmn';

const GENERATED_AT = '2026-10-16T12:00:00.000Z';

async function model(options?: Parameters<typeof buildReportFixture>[0], extra?: Partial<Parameters<typeof buildReportModel>[0]>) {
  const source = await buildReportFixture(options);
  return buildReportModel({ source, generatedAt: GENERATED_AT, ...extra });
}

test('capa: selo PARCIALMENTE VERIFICADA com a cobertura calculada (5 de 21, 26% do peso; 2 em parte à parte)', async () => {
  const m = await model();
  assert.equal(m.coverage.status, 'PARTIAL');
  assert.equal(m.coverage.stamp, 'AUDITORIA PARCIALMENTE VERIFICADA');
  assert.equal(m.coverage.summary, '5 de 21 critérios verificados · 26% do peso total');
  assert.equal(m.coverage.partialCriteria, 2);
  assert.match(m.coverage.partialSummary ?? '', /2 parcialmente verificados · 12% do peso \(contados à parte\)/);
});

test('o número em destaque se chama "Desempenho nos critérios verificados" e "Score Global" nunca aparece', async () => {
  const m = await model();
  assert.equal(m.kpis[0]?.label, 'Desempenho nos critérios verificados');
  assert.doesNotMatch(JSON.stringify(m), /score global/i);
});

test('seis indicadores na capa, com origem comprovada nos dados coletados', async () => {
  const m = await model();
  assert.equal(m.kpis.length, 6);
  assert.deepEqual(m.kpis.map((k) => k.label), [
    'Desempenho nos critérios verificados',
    'Nota média do Google',
    'Avaliações',
    'Índice de posição',
    'Presença no Top 3',
    'Presença no Top 7',
  ]);
  assert.ok(m.kpis.every((k) => k.origin === 'VERIFIED'));
});

test('indicadores do território batem com o adaptador da Fase 2 (denominador = leituras válidas)', async () => {
  const m = await model();
  const map = m.territory.map;
  const byLabel = new Map(m.territory.kpis.map((k) => [k.label, k]));
  assert.equal(byLabel.get('Pontos no Top 3')?.value, String(map.counts.top3));
  assert.equal(byLabel.get('Pontos válidos')?.value, `${map.coverage.valid} de 49`);
  assert.equal(map.coverage.valid + map.coverage.unreadable, map.coverage.collected);
});

test('território parcial: só os pontos coletados, ausentes informados', async () => {
  const m = await model({ territory: 'partial' });
  assert.equal(m.territory.map.coverage.collected, 30);
  assert.equal(m.territory.map.coverage.missing, 19);
  const valid = m.territory.kpis.find((k) => k.label === 'Pontos válidos');
  assert.equal(valid?.value, '30 de 49');
  assert.match(valid?.caption ?? '', /19 ausentes da coleta/);
});

test('pontos sem leitura ficam fora da média e aparecem à parte', async () => {
  const m = await model({ territory: 'unreadable' });
  assert.equal(m.territory.map.coverage.unreadable, 2);
  assert.equal(m.territory.map.coverage.valid, 47);
  const valid = m.territory.kpis.find((k) => k.label === 'Pontos válidos');
  assert.equal(valid?.value, '47 de 49');
  assert.match(valid?.caption ?? '', /2 sem leitura \(fora de todas as médias\)/);
});

test('coordenada inválida: o relatório é gerado e informa o ponto descartado', async () => {
  const source = await buildReportFixture();
  const broken: BattlefieldMetrics = {
    ...source.battlefield,
    points: source.battlefield.points.map((pt) => (pt.pointIndex === 3 ? { ...pt, latitude: Number.NaN } : pt)),
  };
  const m = buildReportModel({ source: { ...source, battlefield: broken }, generatedAt: GENERATED_AT });
  assert.equal(m.territory.map.coverage.invalid, 1);
  assert.equal(m.territory.map.markers.length, 48);
});

test('território simulado: indicadores viram "Simulado" e não sustentam conclusões', async () => {
  const source = await buildReportFixture();
  const simulated: BattlefieldMetrics = {
    ...source.battlefield,
    points: source.battlefield.points.map((pt) =>
      pt.pointLeader ? { ...pt, pointLeader: { ...pt.pointLeader, placeId: 'ChIJ_RIVAL_DOMINATOR_ALPHA' } } : pt
    ),
  };
  const m = buildReportModel({ source: { ...source, battlefield: simulated }, generatedAt: GENERATED_AT });
  assert.equal(m.territory.origin, 'SIMULATED');
  assert.equal(m.kpis[3]?.value, 'Simulado');
  assert.equal(m.kpis[3]?.origin, 'SIMULATED');
  assert.match(m.diagnosis.situation.join(' '), /simulados e não sustentam conclusões/);
});

test('sem histórico: texto exato exigido; baseline sem rodada anterior real continua oculto', async () => {
  const m = await model();
  assert.equal(m.competition.historyText, NO_HISTORY_TEXT);
  assert.equal(m.competition.hasRealHistory, false);

  const source = await buildReportFixture();
  const fabricated: BattlefieldMetrics = {
    ...source.battlefield,
    historicalEvolution: {
      ...source.battlefield.historicalEvolution,
      hasPreviousRound: true,
      previousRoundId: null,
      previousGreenTop3Count: 1,
      greenPointsDelta: 3,
      averagePositionDelta: -2.4,
      evolutionSummaryText: 'baseline inventado',
    },
  };
  const m2 = buildReportModel({ source: { ...source, battlefield: fabricated }, generatedAt: GENERATED_AT });
  assert.equal(m2.competition.historyText, NO_HISTORY_TEXT);
});

test('histórico real: comparação com a auditoria anterior, com as datas e variações', async () => {
  const source = await buildReportFixture();
  const real: BattlefieldMetrics = {
    ...source.battlefield,
    historicalEvolution: {
      ...source.battlefield.historicalEvolution,
      hasPreviousRound: true,
      previousRoundId: '11111111-1111-4111-8111-111111111111',
      previousExecutedAt: '2026-09-10T12:00:00.000Z',
      previousGreenTop3Count: 1,
      greenPointsDelta: 3,
      averagePositionDelta: -2.4,
    },
  };
  const m = buildReportModel({ source: { ...source, battlefield: real }, generatedAt: GENERATED_AT });
  assert.equal(m.competition.hasRealHistory, true);
  assert.match(m.competition.historyText, /auditoria anterior de 10\/09\/2026/);
  assert.match(m.competition.historyText, /de 1 para 4/);
  assert.match(m.competition.historyText, /-2,4/);
});

test('datas separadas: coleta (do Battlefield) e geração (do documento)', async () => {
  const m = await model(undefined, { regenerated: true });
  assert.equal(m.meta.collectedAt, '2026-01-01T12:00:00.000Z');
  assert.equal(m.meta.generatedAt, GENERATED_AT);
  assert.equal(m.meta.regenerated, true);
});

test('cidade e UF: da campanha quando existe; senão do endereço; nunca inventadas', async () => {
  assert.deepEqual(parseCityState('R. Leopoldo de Bulhões, 39 - Centro, Anápolis - GO, 75040-500, Brasil'), {
    city: 'Anápolis',
    state: 'GO',
  });
  assert.deepEqual(parseCityState(null), { city: null, state: null });
  assert.deepEqual(parseCityState('Sem formato conhecido'), { city: null, state: null });

  const fromCampaign = await model(undefined, { campaign: { city: 'Goiânia', stateCode: 'GO', nicheKeyword: 'x' } });
  assert.equal(fromCampaign.company.city, 'Goiânia');
  const fromAddress = await model();
  assert.equal(fromAddress.company.city, 'Cidade Teste');
  assert.equal(fromAddress.company.state, 'GO');
  const none = await model({ lead: { addressRaw: null } });
  assert.equal(none.company.city, null);
});

/** Trata a fixture como se fosse o resultado persistido de uma auditoria (sem o marcador de teste). */
async function asAudit(options?: Parameters<typeof buildReportFixture>[0], extra?: Partial<Parameters<typeof buildReportModel>[0]>) {
  const source = await buildReportFixture(options);
  const { testFixture: _ignored, ...rest } = source;
  void _ignored;
  return buildReportModel({ source: rest, generatedAt: GENERATED_AT, ...extra });
}

test('provedores: só afirma Serper.dev quando está configurado e o dado não é simulado', async () => {
  const off = await asAudit();
  assert.match(off.methodology.providers[1]?.statement ?? '', /não pôde ser identificado/);
  const on = await asAudit(undefined, { environment: { serperConfigured: true, dataForSeoConfigured: false } });
  assert.match(on.methodology.providers[1]?.statement ?? '', /Serper\.dev/);
  assert.match(on.methodology.providers[2]?.statement ?? '', /simulado/);
  assert.match(on.methodology.providers[3]?.statement ?? '', /simulado/);
  assert.match(on.methodology.providers[2]?.statement ?? '', /anterior à Fase 4/);
  assert.ok(on.methodology.limitations.some((l) => /API oficial do Google Business Profile/.test(l)));
  assert.doesNotMatch(JSON.stringify(on.methodology.providers), /Google Business Profile.*acesso direto/);
});

test('fixtures: nenhum provedor real é atribuído, mesmo com o Serper configurado no ambiente', async () => {
  const fixture = await model(undefined, { environment: { serperConfigured: true, dataForSeoConfigured: true } });
  assert.equal(fixture.meta.testFixture, true);
  for (const provider of fixture.methodology.providers) {
    assert.equal(provider.origin, 'SIMULATED');
    assert.match(provider.statement, /Dados sintéticos de teste \(fixture\)\. Nenhuma consulta foi feita ao Serper/);
  }
  assert.ok(fixture.methodology.limitations[0]?.startsWith('DOCUMENTO DE TESTE'));
  for (const criterion of fixture.judge.criteria) {
    assert.doesNotMatch(criterion.source ?? '', /Serper|Verificação técnica do site/);
  }
});

/* ---------------------------- plano de ação ---------------------------- */

test('plano: quatro ondas com título, objetivo, justificativa, prioridade, prazo e indicador em cada ação', async () => {
  const m = await model();
  assert.deepEqual(m.plan.map((w) => [w.wave, w.timeframe]), [
    ['P0', 'Dias 1 a 7'],
    ['P1', 'Dias 8 a 30'],
    ['P2', 'Dias 31 a 60'],
    ['P3', 'Dias 61 a 90'],
  ]);
  const actions = m.plan.flatMap((w) => w.actions);
  assert.ok(actions.length >= 6);
  for (const a of actions) {
    for (const field of [a.title, a.objective, a.justification, a.priority, a.timeframe, a.indicator]) {
      assert.ok(field.trim().length > 3, `${a.code} com campo vazio`);
    }
  }
});

test('plano: dado simulado ou ausente gera HIPÓTESE (validar antes), nunca ação direta', async () => {
  const m = await model();
  const byCode = new Map(m.plan.flatMap((w) => w.actions).map((a) => [a.code, a]));
  for (const code of ['P0_ACT_01', 'P0_ACT_03', 'P1_ACT_02']) {
    const action = byCode.get(code);
    assert.equal(action?.kind, 'HYPOTHESIS', code);
    assert.match(action?.justification ?? '', /não pôde ser comprovad|Conferir|Confirmar/i, code);
  }
});

test('plano: taxa de resposta medida só em amostra parcial vira hipótese a validar, com a evidência citada', async () => {
  const m = await model({ dataStyle: 'phase4-live' });
  const action = m.plan.flatMap((w) => w.actions).find((a) => a.code === 'P0_ACT_01');
  assert.equal(action?.kind, 'HYPOTHESIS');
  assert.equal(action?.evidenceClass, 'PARTIAL');
  assert.match(action?.justification ?? '', /25% das 24 avaliações da amostra/);
  // A mesma frase não se repete na justificativa.
  assert.equal((action?.justification.match(/25% das 24 avaliações/g) ?? []).length, 1);
});

test('plano: nota 4,9 nunca gera "elevar a nota para acima de 4,7"', async () => {
  const m = await model();
  const text = m.plan.flatMap((w) => [...w.maintain, ...w.actions.flatMap((a) => [a.title, a.objective, a.justification])]).join(' ');
  assert.doesNotMatch(text, /elevar[^.]*4[,.]7/i);
  assert.doesNotMatch(text, /acima de 4[,.]7/i);
});

test('plano: falta de avaliações só é afirmada quando a empresa está atrás do líder coletado', async () => {
  const behind = await model({ lead: { totalReviews: 39 } });
  const a = behind.plan.flatMap((w) => w.actions).find((x) => x.code === 'P2_ACT_01');
  assert.equal(a?.kind, 'ACTION');
  assert.match(a?.justification ?? '', /39 avaliações.*100/);

  const ahead = await model({ lead: { totalReviews: 400 } });
  assert.equal(ahead.plan.flatMap((w) => w.actions).some((x) => x.code === 'P2_ACT_01'), false);
  assert.ok(ahead.plan.flatMap((w) => w.maintain).some((t) => /iguala ou supera/.test(t)));
  assert.doesNotMatch(JSON.stringify(ahead.plan), /faltam\s+avalia/i);
});

test('plano: sem promessas numéricas nem de ranking; aviso de que nada é garantido', async () => {
  const m = await model();
  const all = m.plan.flatMap((w) => w.actions.flatMap((a) => [a.objective, a.justification]));
  assert.ok(all.every((t) => !containsPromise(t)));
  assert.match(m.planDisclaimer, /Nenhuma delas garante melhora de posição/);
  assert.equal(containsPromise('Aumento de 25% a 40% na taxa de cliques'), true);
  assert.equal(containsPromise('Garantimos o primeiro lugar'), true);
});

test('plano: inclui a ação derivada do território quando a empresa não aparece no próprio ponto', async () => {
  const source = await buildReportFixture();
  const absent: BattlefieldMetrics = {
    ...source.battlefield,
    points: source.battlefield.points.map((pt) => (pt.pointIndex === 24 ? { ...pt, targetRank: null } : pt)),
  };
  const m = buildReportModel({ source: { ...source, battlefield: absent }, generatedAt: GENERATED_AT });
  const action = m.plan.flatMap((w) => w.actions).find((a) => a.code === 'TERR_COMPANY_POINT');
  assert.equal(action?.kind, 'HYPOTHESIS');
  assert.match(action?.justification ?? '', /A causa não foi determinada/);
});

/* ------------------------- controles de qualidade ------------------------ */

test('controles de qualidade: todos passam para a fixture', async () => {
  const m = await model();
  assert.ok(m.quality.length >= 8);
  assert.deepEqual(m.quality.filter((c) => !c.passed), []);
});

test('controles de qualidade: detectam termo proibido, promessa e contradição', async () => {
  const m = await model();
  const base = {
    model: m.territory.map,
    score: m.judge.score,
    criteria: m.judge.criteria,
    plan: m.plan,
    rating: 4.9,
    leaderReviews: 100,
    myReviews: 400,
  };
  const bad = runQualityChecks({ ...base, texts: ['Este é o Score Global', 'Garantia de primeiro lugar', 'Elevar a nota para acima de 4,7', 'Faltam avaliações'] });
  const failed = bad.filter((c) => !c.passed).map((c) => c.id);
  assert.ok(failed.includes('no-forbidden-terms'));
  assert.ok(failed.includes('no-contradictions'));
});

test('nome de estabelecimento muito longo é preservado no modelo (o layout o ajusta)', async () => {
  const long = 'Clínica Odontológica Especializada em Implantes, Ortodontia, Estética Dental e Reabilitação Oral Completa da Região Central';
  const m = await model({ lead: { businessName: long } });
  assert.equal(m.company.name, long);
});

/* ------------------- pontuações separadas e simulação (Fase 4, ajustes finais) ------------------- */

import { reevaluateForReport } from '../src/lib/pdf/reevaluate';
import { simulationOriginOf } from '../src/lib/pdf/report-evidence';

test('score histórico gravado é preservado e o recalculado aparece à parte, com metodologia e denominador', async () => {
  const legacy = await buildReportFixture({ dataStyle: 'simulated' });
  const reevaluated = await reevaluateForReport({ source: legacy, lead: legacy.lead });
  assert.equal(reevaluated.storedJudge?.overallScore, legacy.judge.overallScore, 'o valor gravado é preservado');
  assert.equal(reevaluated.judge.scoreMethod, 'PHASE4_SCORED_WEIGHT');
  assert.notEqual(reevaluated.judge.overallScore, legacy.judge.overallScore, 'os dois números são diferentes');

  const m = buildReportModel({ source: reevaluated, generatedAt: GENERATED_AT });
  const [stored, recalculated, verified] = m.judge.scoreLines;
  assert.deepEqual(m.judge.scoreLines.map((l) => l.key), ['STORED_HISTORICAL', 'RECALCULATED', 'VERIFIED_PERFORMANCE']);
  assert.equal(stored?.value, legacy.judge.overallScore);
  assert.equal(stored?.denominatorWeight, 102);
  assert.equal(stored?.denominatorPercent, 100);
  assert.match(stored?.note ?? '', /preservado e não recalculado/);
  assert.equal(recalculated?.value, reevaluated.judge.overallScore);
  assert.ok((recalculated?.denominatorWeight ?? 102) < 102, 'o denominador recalculado é outro');
  assert.match(recalculated?.methodology ?? '', /só sobre os critérios que têm pontuação/);
  assert.match(recalculated?.note ?? '', /Não é comparável ao score histórico|Inclui pontuações apenas indicativas/);
  assert.equal(verified?.value, m.judge.score.verified.performance);
  assert.equal(verified?.denominatorWeight, m.judge.score.verified.weight);
  // "histórico" só no valor armazenado
  assert.ok(m.judge.scoreLines.filter((l) => /histórico/i.test(l.label)).every((l) => l.key === 'STORED_HISTORICAL'));
});

test('auditoria nativa da Fase 4 não tem score histórico: só recalculado e verificado', async () => {
  const native = await buildReportFixture({ dataStyle: 'phase4' });
  const m = buildReportModel({ source: native, generatedAt: GENERATED_AT });
  assert.deepEqual(m.judge.scoreLines.map((l) => l.key), ['RECALCULATED', 'VERIFIED_PERFORMANCE']);
});

test('reavaliar uma ficha que já é da Fase 4 não inventa um score histórico', async () => {
  const native = await buildReportFixture({ dataStyle: 'phase4' });
  const again = await reevaluateForReport({ source: native, lead: native.lead });
  assert.equal(again.storedJudge, undefined);
});

test('origem do dado simulado: legado, demonstração e fixture são distinguidos', async () => {
  const legacy = await buildReportFixture({ dataStyle: 'simulated' });
  const { testFixture: _fixture, ...legacyAudit } = legacy;
  void _fixture;
  assert.equal(simulationOriginOf(legacyAudit), 'LEGACY');
  assert.equal(simulationOriginOf(legacy), 'FIXTURE');

  const native = await buildReportFixture({ dataStyle: 'phase4' });
  const { testFixture: _f2, ...nativeAudit } = native;
  void _f2;
  assert.equal(simulationOriginOf({ ...nativeAudit, battlefield: { ...native.battlefield, dataOrigin: 'SIMULATED' } }), 'DEMO');
  assert.equal(simulationOriginOf({ ...nativeAudit, judge: { ...native.judge, evidenceBundle: { ...(native.judge.evidenceBundle as NonNullable<typeof native.judge.evidenceBundle>), demo: true } } }), 'DEMO');
  // Auditoria nova (coleta da Fase 4) com marcadores de simulação só pode ser demonstração
  assert.equal(simulationOriginOf(nativeAudit), 'DEMO');
});

test('fixtures vindas de reavaliação continuam sintéticas (nunca atribuídas ao Serper)', async () => {
  const legacy = await buildReportFixture({ dataStyle: 'simulated' });
  const reevaluated = await reevaluateForReport({ source: legacy, lead: legacy.lead });
  assert.equal(reevaluated.testFixture, true);
  assert.equal(reevaluated.judge.evidenceBundle?.testFixture, true);
  for (const item of reevaluated.judge.checklist21Items) {
    assert.doesNotMatch(item.evidence?.sourceProvider ?? '', /Serper/);
  }
});
