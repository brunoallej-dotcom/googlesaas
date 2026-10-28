import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCost, formatCostEstimate, SECONDARY_SOURCE_ASSUMPTIONS } from '../src/lib/link-audit/collector/cost';

test('uma auditoria (1 /maps + site): 1 chamada paga, créditos e dólares só como faixa não confirmada', () => {
  const estimate = estimateCost({ maps: 1, reviews: 0, site: 1 });
  assert.deepEqual(estimate.paidCalls, { maps: 1, reviews: 0, total: 1 });
  assert.equal(estimate.siteHttpRequestsMax, 8);
  assert.deepEqual(estimate.credits, { min: 3, max: 3 }, '3 créditos por /maps: custo observado por fonte independente (não oficial)');
  assert.ok(estimate.usd && Math.abs(estimate.usd.min - 0.0009) < 1e-12 && Math.abs(estimate.usd.max - 0.003) < 1e-12);
  assert.ok(estimate.basis.some((text) => /3 créditos por chamada do \/maps/.test(text)));
  assert.equal(estimate.confirmed, false);
  assert.ok(estimate.caveats.some((text) => /ESTIMATIVA NÃO CONFIRMADA/.test(text)));
  assert.ok(estimate.caveats.some((text) => /painel do Serper/.test(text)));
  assert.ok(estimate.basis.some((text) => /fontes secundárias/.test(text)));
});

test('sem chamadas pagas o custo é zero; o site nunca soma créditos', () => {
  const none = estimateCost({ maps: 0, reviews: 0, site: 1 });
  assert.deepEqual(none.credits, { min: 0, max: 0 });
  assert.deepEqual(none.usd, { min: 0, max: 0 });
  assert.equal(estimateCost({ maps: 1, reviews: 0, site: 0 }).siteHttpRequestsMax, 0);
});

test('parâmetros desconhecidos viram "desconhecido", nunca um número inventado', () => {
  const unknown = estimateCost({ maps: 1, reviews: 0, site: 1 }, { creditsPerPaidCall: null, usdPerCredit: null, freeCreditsRemaining: null });
  assert.equal(unknown.credits, null);
  assert.equal(unknown.usd, null);
  assert.equal(unknown.coveredByFreeCredits, null);
  const lines = formatCostEstimate(unknown).join('\n');
  assert.match(lines, /Créditos estimados: desconhecido/);
  assert.match(lines, /Custo estimado: desconhecido/);
  assert.match(lines, /Créditos por chamada: desconhecido/);

  const noPrice = estimateCost({ maps: 1, reviews: 0, site: 1 }, { ...SECONDARY_SOURCE_ASSUMPTIONS, usdPerCredit: null });
  assert.deepEqual(noPrice.credits, { min: 3, max: 3 });
  assert.equal(noPrice.usd, null);
});

test('créditos gratuitos: só afirma cobertura se o saldo informado cobre o pior caso', () => {
  assert.equal(estimateCost({ maps: 1, reviews: 0, site: 1 }, { ...SECONDARY_SOURCE_ASSUMPTIONS, freeCreditsRemaining: 2500 }).coveredByFreeCredits, true);
  assert.equal(estimateCost({ maps: 1, reviews: 0, site: 1 }, { ...SECONDARY_SOURCE_ASSUMPTIONS, freeCreditsRemaining: 1 }).coveredByFreeCredits, false);
  assert.equal(estimateCost({ maps: 1, reviews: 0, site: 1 }).coveredByFreeCredits, null, 'saldo desconhecido');
});

test('o /reviews, se pedido, vem com a ressalva de custo desconhecido', () => {
  const estimate = estimateCost({ maps: 1, reviews: 2, site: 0 });
  assert.equal(estimate.paidCalls.total, 3);
  assert.ok(estimate.caveats.some((text) => /\/reviews é desconhecido/.test(text)));
});

test('texto para o operador está em português e mostra faixa e ressalvas', () => {
  const lines = formatCostEstimate(estimateCost({ maps: 1, reviews: 0, site: 1 })).join('\n');
  assert.match(lines, /Chamadas pagas: 1 ao Serper \/maps e 0 ao \/reviews\./);
  assert.match(lines, /Site próprio: até 8 requisições HTTP, sem custo de API\./);
  assert.match(lines, /Créditos estimados: 3 crédito\(s\)\./);
  assert.match(lines, /Custo estimado: US\$ 0,0009 a 0,003\./);
  assert.match(lines, /ESTIMATIVA NÃO CONFIRMADA/);
});
