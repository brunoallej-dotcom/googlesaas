/*
 * Estimativa de custo por auditoria (Onda 4B). Módulo puro. NÃO inventa preço: os parâmetros entram por
 * argumento e o resultado é sempre marcado como "não confirmado". Se um parâmetro for desconhecido, o valor
 * correspondente fica `null` ("desconhecido").
 */

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface CostAssumptions {
  /** Créditos que UMA chamada paga consome. `null` = desconhecido. */
  readonly creditsPerPaidCall: Range | null;
  /** Dólares por crédito. `null` = desconhecido. */
  readonly usdPerCredit: Range | null;
  /** Créditos gratuitos ainda disponíveis (contas novas ganham 2 500, segundo a página oficial). `null` = desconhecido. */
  readonly freeCreditsRemaining: number | null;
}

/**
 * Premissas com base em FONTES SECUNDÁRIAS (pesquisa na web em 21/10/2026; a página oficial `serper.dev/pricing`
 * devolve 404): pacotes pré-pagos de US$ 50 (50 mil créditos) a US$ 3 750 (12,5 milhões) ≈ US$ 1,00 a 0,30 por mil
 * consultas; "um crédito cobre até 10 resultados e 11–100 resultados custam 2". Créditos por chamada do `/maps`: 3, valor OBSERVADO
 * por fonte independente informada pelo usuário em 21/10/2026 (Onda 4C). NÃO é preço oficial nem está confirmado.
 */
export const SECONDARY_SOURCE_ASSUMPTIONS: CostAssumptions = {
  creditsPerPaidCall: { min: 3, max: 3 },
  usdPerCredit: { min: 0.0003, max: 0.001 },
  freeCreditsRemaining: null,
};

export interface CostBudget {
  readonly maps: number;
  readonly reviews: number;
  readonly site: number;
}

export interface CostEstimate {
  readonly paidCalls: { readonly maps: number; readonly reviews: number; readonly total: number };
  /** Requisições HTTP ao site (sem custo de API). 8 é o teto por verificação. */
  readonly siteHttpRequestsMax: number;
  readonly credits: Range | null;
  readonly usd: Range | null;
  /** Há créditos gratuitos suficientes para cobrir o pior caso? `null` = não se sabe. */
  readonly coveredByFreeCredits: boolean | null;
  readonly confirmed: false;
  readonly basis: readonly string[];
  readonly caveats: readonly string[];
}

const SITE_HTTP_REQUESTS_PER_CHECK = 8;

function times(range: Range | null, factor: number): Range | null {
  return range ? { min: range.min * factor, max: range.max * factor } : null;
}

export function estimateCost(budget: CostBudget, assumptions: CostAssumptions = SECONDARY_SOURCE_ASSUMPTIONS): CostEstimate {
  const total = budget.maps + budget.reviews;
  const credits = total === 0 ? { min: 0, max: 0 } : times(assumptions.creditsPerPaidCall, total);
  const usd = credits && (credits.max === 0 ? { min: 0, max: 0 } : assumptions.usdPerCredit ? { min: credits.min * assumptions.usdPerCredit.min, max: credits.max * assumptions.usdPerCredit.max } : null);
  const covered = credits && assumptions.freeCreditsRemaining !== null ? assumptions.freeCreditsRemaining >= credits.max : null;

  const caveats = [
    'ESTIMATIVA NÃO CONFIRMADA: a página oficial de preços do Serper não está acessível (serper.dev/pricing devolve 404) e o custo do endpoint /maps não consta em fonte oficial.',
    'Antes do LIVE, confirme no painel do Serper o saldo e os créditos realmente cobrados por chamada do /maps (fonte independente: 3 créditos).',
    ...(budget.reviews > 0 ? ['O custo do endpoint /reviews é desconhecido.'] : []),
    ...(assumptions.creditsPerPaidCall === null ? ['Créditos por chamada: desconhecido.'] : []),
    ...(assumptions.usdPerCredit === null ? ['Preço por crédito: desconhecido.'] : []),
  ];
  return {
    paidCalls: { maps: budget.maps, reviews: budget.reviews, total },
    siteHttpRequestsMax: budget.site * SITE_HTTP_REQUESTS_PER_CHECK,
    credits,
    usd,
    coveredByFreeCredits: covered,
    confirmed: false,
    basis: [
      'Chamadas pagas: somente Serper /maps e /reviews; o site próprio não consome créditos de API.',
      'Premissas de preço de fontes secundárias (não oficiais): US$ 1,00 a 0,30 por mil consultas; 3 créditos por chamada do /maps (custo observado por fonte independente, informado pelo usuário; não é preço oficial).',
    ],
    caveats,
  };
}

const fmt = (value: number): string => String(Number(value.toPrecision(3))).replace('.', ',');
const range = (r: Range | null, unit: string): string => (r ? (r.min === r.max ? `${fmt(r.min)} ${unit}` : `${fmt(r.min)} a ${fmt(r.max)} ${unit}`) : 'desconhecido');

/** Linhas em português para mostrar ao operador antes de qualquer execução real. */
export function formatCostEstimate(estimate: CostEstimate): string[] {
  return [
    `Chamadas pagas: ${estimate.paidCalls.maps} ao Serper /maps e ${estimate.paidCalls.reviews} ao /reviews.`,
    `Site próprio: até ${estimate.siteHttpRequestsMax} requisições HTTP, sem custo de API.`,
    `Créditos estimados: ${range(estimate.credits, 'crédito(s)')}.`,
    `Custo estimado: ${estimate.usd ? `US$ ${range(estimate.usd, '').trim()}` : 'desconhecido'}${estimate.coveredByFreeCredits ? ' (coberto pelos créditos gratuitos informados)' : ''}.`,
    ...estimate.caveats,
  ];
}
