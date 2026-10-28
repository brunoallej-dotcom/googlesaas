import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewerAgent } from '../src/agents/reviewer-agent';
import { strategistAgent } from '../src/agents/strategist-agent';
import { buildRecommendations, recommendationContainsPromise } from '../src/lib/recommendations';
import { buildReportFixture, buildReportFixtureLead } from '../src/dev/report-fixture';
import { judgeAgent } from '../src/agents/judge-agent';

async function recs(options: Parameters<typeof buildReportFixture>[0] = { dataStyle: 'phase4' }) {
  const data = await buildReportFixture(options);
  return { data, set: buildRecommendations({ lead: data.lead, judge: data.judge, battlefield: data.battlefield, rivals: data.rivals }) };
}

const byCode = (list: Awaited<ReturnType<typeof recs>>['set']['recommendations'], code: string) => list.find((r) => r.code === code);

test('toda recomendação traz problema, evidência, justificativa, prioridade, prazo, ação, indicador e confiança', async () => {
  const { set } = await recs();
  assert.ok(set.recommendations.length >= 6);
  for (const rec of set.recommendations) {
    for (const field of ['code', 'title', 'problem', 'evidenceSummary', 'justification', 'priority', 'timeframe', 'action', 'indicator', 'objective'] as const) {
      assert.ok(rec[field].trim().length > 3, `${rec.code}.${field}`);
    }
    assert.ok(rec.evidenceCriteria.length > 0, rec.code);
    assert.ok(rec.confidence >= 0 && rec.confidence <= 1, rec.code);
    assert.ok(['PROVEN_ACTION', 'HYPOTHESIS', 'NOT_APPLICABLE'].includes(rec.classification));
  }
});

test('sem evidência: a recomendação é HIPÓTESE a validar, com baixa confiança, nunca ação comprovada', async () => {
  const { set } = await recs();
  for (const code of ['P0_ACT_01', 'P0_ACT_02', 'P0_ACT_03', 'P1_ACT_01', 'P1_ACT_02']) {
    const rec = byCode(set.recommendations, code);
    assert.equal(rec?.classification, 'HYPOTHESIS', code);
    assert.ok((rec?.confidence ?? 1) <= 0.3, code);
    if (code !== 'P0_ACT_02') assert.match(rec?.evidenceSummary ?? '', /Não foi possível comprovar/, code);
  }
  // WhatsApp: o número em formato de celular é só um indício; a recomendação é confirmar o canal.
  assert.match(byCode(set.recommendations, 'P0_ACT_02')?.justification ?? '', /não comprova uma conta ativa/);
});

test('ação comprovada só nasce de evidência VERIFICADA', async () => {
  const { data, set } = await recs({ dataStyle: 'phase4-live' });
  const proven = set.recommendations.filter((r) => r.classification === 'PROVEN_ACTION');
  assert.ok(proven.length > 0);
  for (const rec of proven) {
    for (const n of rec.evidenceCriteria.slice(0, 1)) {
      const item = data.judge.checklist21Items.find((i) => i.itemNumber === n);
      const ok = item?.evidence?.status === 'VERIFIED' || rec.code === 'P3_ACT_02';
      assert.ok(ok, `${rec.code} apoiada no critério ${n} (${item?.evidence?.status})`);
    }
  }
});

test('amostra parcial de avaliações gera hipótese (nunca ação comprovada) para a taxa de resposta', async () => {
  const { set } = await recs({ dataStyle: 'phase4-live' });
  const reply = byCode(set.recommendations, 'P0_ACT_01');
  assert.equal(reply?.classification, 'HYPOTHESIS');
  assert.match(reply?.evidenceSummary ?? '', /25% das 24 avaliações da amostra/);
});

test('nota 4,9 não gera "elevar a nota"; critério atendido vira nota de manutenção', async () => {
  const { set } = await recs({ dataStyle: 'phase4-live' });
  assert.equal(byCode(set.recommendations, 'P2_ACT_03'), undefined);
  const text = JSON.stringify(set);
  assert.doesNotMatch(text, /elevar[^"]*4[,.]7/i);
  assert.ok(set.maintain.some((note) => /Nota Média de Estrelas/.test(note)));
});

test('volume de avaliações: só afirma que falta quando a comparação com o líder é verificada e a empresa está atrás', async () => {
  const live = await recs({ dataStyle: 'phase4-live' });
  const volume = byCode(live.set.recommendations, 'P2_ACT_01');
  assert.equal(volume?.classification, 'PROVEN_ACTION');
  assert.match(volume?.evidenceSummary ?? '', /39 avaliações contra 100/);

  // Empresa à frente do líder: sem recomendação de "pedir mais avaliações para alcançar o líder"
  const ahead = buildReportFixtureLead({ totalReviews: 400 });
  const data = await buildReportFixture({ dataStyle: 'phase4-live', lead: { totalReviews: 400 } });
  const set = buildRecommendations({ lead: ahead, judge: data.judge, battlefield: data.battlefield, rivals: data.rivals });
  assert.equal(byCode(set.recommendations, 'P2_ACT_01'), undefined);
  assert.ok(set.maintain.some((note) => /Volume Total de Avaliações/.test(note)));

  // Sem comparação possível (nota e total ausentes ou padrão): hipótese de comparar antes de definir meta
  const noComparison = await buildReportFixture({ dataStyle: 'phase4', lead: { rating: 4.5, totalReviews: 15 } });
  const hypothesis = buildRecommendations({ lead: noComparison.lead, judge: noComparison.judge, battlefield: noComparison.battlefield, rivals: noComparison.rivals });
  assert.equal(byCode(hypothesis.recommendations, 'P2_ACT_01')?.classification, 'HYPOTHESIS');
});

test('site: bloqueio de indexação é ação comprovada; sem verificação é hipótese; rede social pede domínio próprio', async () => {
  const live = await buildReportFixture({ dataStyle: 'phase4-live' });
  assert.equal(byCode(buildRecommendations({ lead: live.lead, judge: live.judge, battlefield: live.battlefield, rivals: live.rivals }).recommendations, 'P2_ACT_02'), undefined, 'site bom: só manter');

  const offline = await recs();
  assert.equal(byCode(offline.set.recommendations, 'P2_ACT_02')?.classification, 'HYPOTHESIS');

  const social = await buildReportFixture({ dataStyle: 'phase4', lead: { websiteStatus: 'SOCIAL_LINK_ONLY', websiteUrl: 'https://instagram.com/x' } });
  const socialRec = byCode(buildRecommendations({ lead: social.lead, judge: social.judge, battlefield: social.battlefield, rivals: social.rivals }).recommendations, 'P2_ACT_02');
  assert.equal(socialRec?.classification, 'PROVEN_ACTION');
  assert.match(socialRec?.title ?? '', /domínio próprio/);
});

test('modelo de atendimento inferido (endereço oculto): ação sobre endereço é NÃO APLICÁVEL, com a ressalva da inferência', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4', lead: { businessName: 'Chaveiro 24h Móvel', isAddressHidden: true, addressRaw: null } });
  const set = buildRecommendations({ lead: data.lead, judge: data.judge, battlefield: data.battlefield, rivals: data.rivals });
  const address = byCode(set.recommendations, 'P1_ACT_04');
  assert.equal(address?.classification, 'NOT_APPLICABLE');
  assert.match(address?.justification ?? '', /inferida, não confirmada/);
});

test('o território gera prioridade só quando a evidência territorial é verificada e há pontos entre 4 e 20', async () => {
  const { set } = await recs();
  assert.equal(byCode(set.recommendations, 'TERR_FOCUS_PRESENCE')?.classification, 'PROVEN_ACTION');
  const noReading = await buildReportFixture({ dataStyle: 'phase4', territory: 'unreadable' });
  const blank = { ...noReading.battlefield, points: noReading.battlefield.points.map((p) => ({ ...p, readStatus: 'UNREADABLE' as const, targetRank: null })) };
  const judge = judgeAgent.evaluate({ auditId: 'x', lead: noReading.lead, reputation: noReading.reputation, vitrine: noReading.vitrine, battlefield: blank, rivals: noReading.rivals });
  const none = buildRecommendations({ lead: noReading.lead, judge, battlefield: blank, rivals: noReading.rivals });
  assert.equal(byCode(none.recommendations, 'TERR_FOCUS_PRESENCE'), undefined);
});

test('nenhuma promessa de resultado, de posição ou de ganho percentual em nenhum texto', async () => {
  for (const options of [{ dataStyle: 'phase4' as const }, { dataStyle: 'phase4-live' as const }]) {
    const { set, data } = await recs(options);
    const texts = set.recommendations.flatMap((r) => [r.title, r.problem, r.justification, r.action, r.objective, r.evidenceSummary]);
    for (const text of texts) assert.equal(recommendationContainsPromise(text), false, text);
    const strategist = await strategistAgent.synthesizeStrategy({ auditId: 'p', lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, judge: data.judge, revisionAttempt: 1 });
    const all = [strategist.executiveSummary, strategist.diagnosticNarrative, strategist.territoryOpportunityNarrative].join(' ');
    assert.doesNotMatch(all, /score global/i);
    assert.equal(recommendationContainsPromise(all), false);
  }
  assert.equal(recommendationContainsPromise('Aumento de 25% a 40% garantido'), true);
  assert.equal(recommendationContainsPromise('Triplicar o ritmo de avaliações'), true);
  assert.equal(recommendationContainsPromise('Responder as avaliações pendentes'), false);
});

test('texto estratégico distingue índice de posição e posição conhecida, e cita cobertura de evidências', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  const strategist = await strategistAgent.synthesizeStrategy({ auditId: 'p', lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, judge: data.judge, revisionAttempt: 1 });
  assert.match(strategist.diagnosticNarrative, /índice de posição/i);
  assert.match(strategist.diagnosticNarrative, /não é a posição real/);
  assert.match(strategist.executiveSummary, /Score Juiz histórico/);
  assert.match(strategist.executiveSummary, /cobertura de evidências/);
  assert.doesNotMatch(strategist.diagnosticNarrative, /posição média real/i);
});

test('Revisor: aprova o texto do Estrategista (inclusive com métricas indisponíveis) e reprova números divergentes ou proibidos', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  const strategist = await strategistAgent.synthesizeStrategy({ auditId: 'p', lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, judge: data.judge, revisionAttempt: 1 });
  const ok = reviewerAgent.auditMathematically({ auditId: 'p', judgeSheet: data.judge, strategistOutput: strategist, iterationNumber: 1 });
  assert.equal(ok.approved, true, JSON.stringify(ok.discrepancies));
  assert.equal(strategist.citedMetricsSnapshot.interactionsLast30Days, null);

  const forgedNumber = { ...strategist, citedMetricsSnapshot: { ...strategist.citedMetricsSnapshot, interactionsLast30Days: 12 } };
  const bad = reviewerAgent.auditMathematically({ auditId: 'p', judgeSheet: data.judge, strategistOutput: forgedNumber, iterationNumber: 1 });
  assert.equal(bad.approved, false);
  assert.ok(bad.discrepancies.some((d) => d.metricField === 'interactionsLast30Days'));

  const promising = { ...strategist, executiveSummary: `${strategist.executiveSummary} Score Global de 90 com ganho de +25% garantido.` };
  const forbidden = reviewerAgent.auditMathematically({ auditId: 'p', judgeSheet: data.judge, strategistOutput: promising, iterationNumber: 1 });
  assert.ok(forbidden.discrepancies.some((d) => d.metricField === 'forbidden_global_score_label'));
  assert.ok(forbidden.discrepancies.some((d) => d.metricField === 'forbidden_result_promise'));
});

test('as quatro ondas P0–P3 são sempre entregues, com o contrato do Estrategista preservado', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  assert.equal(data.strategist.tacticalWaves.length, 4);
  assert.deepEqual(data.strategist.tacticalWaves.map((w) => w.wave), ['P0', 'P1', 'P2', 'P3']);
  for (const wave of data.strategist.tacticalWaves) {
    for (const action of wave.actions) {
      assert.ok(action.actionCode && action.title && action.technicalInstruction && action.expectedImpact && action.effortLevel);
    }
  }
});
