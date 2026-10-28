/**
 * Leitor de avaliações do Serper (`POST https://google.serper.dev/reviews`), DESLIGADO por padrão.
 *
 * Estado da verificação (16/10/2026): os PARÂMETROS da requisição (fid obrigatório; cid, placeId,
 * sortBy, nextPageToken, gl, hl opcionais) foram confirmados por um cliente público do endpoint.
 * O FORMATO DA RESPOSTA NÃO foi confirmado em documentação oficial. Por isso o interpretador abaixo
 * é defensivo: só usa campos realmente presentes e com tipo esperado, e qualquer coisa fora do
 * esperado vira "não verificado". As fixtures dos testes são HIPOTÉTICAS (identificadas como tal) e
 * não substituem a confirmação com uma chamada real, que depende de autorização.
 *
 * Nada é consultado sem `GMN_REVIEWS_PROVIDER=serper`. O custo em créditos por chamada também não
 * foi confirmado ("a confirmar"); a coleta fica limitada a `GMN_REVIEWS_MAX_PAGES` páginas (padrão 1).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_WINDOW_DAYS = 30;

export interface ParsedReview {
  readonly rating: number | null;
  readonly text: string | null;
  /** Intervalo, em dias, em que a avaliação foi publicada. Datas ISO têm intervalo de 1 dia. */
  readonly ageDaysMin: number | null;
  readonly ageDaysMax: number | null;
  readonly dateBasis: 'ISO' | 'RELATIVE' | 'NONE';
  readonly hasOwnerReply: boolean;
  /** A resposta do dono é um campo que a API realmente enviou (mesmo vazio) nesta avaliação. */
  readonly ownerReplyFieldPresent: boolean;
}

export interface ParsedReviewsPage {
  readonly reviews: readonly ParsedReview[];
  readonly nextPageToken: string | null;
  /** Total de avaliações do perfil informado pela API, quando existir. */
  readonly totalReported: number | null;
  /** Campos esperados que não vieram: indício de que o formato mudou. */
  readonly warnings: readonly string[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Converte "há 3 dias", "2 weeks ago", "um mês atrás"... em um intervalo de idade em dias.
 * O Google arredonda para baixo: "3 dias" significa de 3 a menos de 4 dias.
 */
export function parseRelativeAge(raw: string): { min: number; max: number } | null {
  const value = raw.toLowerCase().replace(/^editado\s+/, '').replace(/\s+/g, ' ').trim();
  const match = /(?:^|\s)(?:(\d+)|um|uma|a|an)\s+(minutos?|minutes?|horas?|hours?|dias?|days?|semanas?|weeks?|m[eê]s(?:es)?|months?|anos?|years?)(?:\s|$)/.exec(value);
  if (!match) return null;
  const amount = match[1] ? Number(match[1]) : 1;
  const unit = match[2] as string;
  if (!Number.isFinite(amount) || amount < 0) return null;

  if (/^(minut|hora|hour)/.test(unit)) return { min: 0, max: 1 };
  const unitDays = /^(dia|day)/.test(unit) ? 1 : /^(semana|week)/.test(unit) ? 7 : /^(m[eê]s|month)/.test(unit) ? 30 : 365;
  return { min: amount * unitDays, max: (amount + 1) * unitDays - 1 };
}

function parseReview(raw: unknown, nowMs: number): ParsedReview | null {
  const item = record(raw);
  if (!item) return null;

  const rating = typeof item.rating === 'number' && item.rating >= 1 && item.rating <= 5 ? item.rating : null;
  const snippet = text(item.snippet) ?? text(item.text) ?? text(item.description);

  let ageDaysMin: number | null = null;
  let ageDaysMax: number | null = null;
  let dateBasis: ParsedReview['dateBasis'] = 'NONE';

  const iso = text(item.isoDate) ?? text(item.iso_date);
  const isoMs = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(isoMs) && isoMs <= nowMs + DAY_MS) {
    const age = Math.max(0, Math.floor((nowMs - isoMs) / DAY_MS));
    ageDaysMin = age;
    ageDaysMax = age + 1;
    dateBasis = 'ISO';
  } else {
    const relative = text(item.date);
    const parsed = relative ? parseRelativeAge(relative) : null;
    if (parsed) {
      ageDaysMin = parsed.min;
      ageDaysMax = parsed.max;
      dateBasis = 'RELATIVE';
    }
  }

  const response = record(item.response) ?? record(item.ownerResponse) ?? record(item.owner_response);
  const hasOwnerReply = Boolean(response && (text(response.snippet) ?? text(response.text)));
  const ownerReplyFieldPresent = ['response', 'ownerResponse', 'owner_response'].some((key) => key in item);

  return { rating, text: snippet, ageDaysMin, ageDaysMax, dateBasis, hasOwnerReply, ownerReplyFieldPresent };
}

export function parseSerperReviewsResponse(payload: unknown, now: Date = new Date()): ParsedReviewsPage {
  const root = record(payload);
  const warnings: string[] = [];
  const list = root && Array.isArray(root.reviews) ? (root.reviews as unknown[]) : null;
  if (!list) {
    return { reviews: [], nextPageToken: null, totalReported: null, warnings: ['A resposta não contém a lista "reviews" esperada.'] };
  }
  const reviews = list.map((entry) => parseReview(entry, now.getTime())).filter((r): r is ParsedReview => r !== null);
  if (reviews.length < list.length) warnings.push(`${list.length - reviews.length} avaliações em formato inesperado foram ignoradas.`);
  if (reviews.length > 0 && reviews.every((r) => r.dateBasis === 'NONE')) {
    warnings.push('Nenhuma avaliação trouxe data utilizável.');
  }
  const total = root && typeof root.totalReviews === 'number' ? root.totalReviews : null;
  return { reviews, nextPageToken: text(root?.nextPageToken), totalReported: total, warnings };
}

export interface ReviewSampleAnalysis {
  readonly sampleSize: number;
  readonly datedCount: number;
  /** Total de avaliações do perfil (da listagem), usado para saber se a amostra é completa. */
  readonly profileTotalReviews: number | null;
  /** A amostra contém todas as avaliações do perfil. */
  readonly sampleIsComplete: boolean;
  /** O período de 30 dias está inteiramente coberto pela amostra. */
  readonly windowCovered: boolean;
  /** Avaliações dentro de 30 dias: exato só se `windowCovered`; senão, apenas o mínimo comprovado. */
  readonly countLast30Days: number | null;
  readonly countLast30DaysIsLowerBound: boolean;
  readonly ambiguousDates: number;
  readonly ownerReplies: number;
  /**
   * Respostas sobre a amostra (não sobre o perfil, salvo se `sampleIsComplete`). `null` quando a API
   * nunca enviou o campo de resposta: ausência do campo não prova ausência de resposta.
   */
  readonly ownerResponseRatePercent: number | null;
  readonly textsAvailable: number;
  /** Avaliações com texto que citam algum termo de serviço informado; `null` sem termos ou textos. */
  readonly reviewsMentioningTerms: number | null;
  readonly limitations: readonly string[];
}

const stripAccents = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Termos de serviço úteis a partir de categoria e palavra-chave (sem palavras genéricas). */
export function deriveServiceTerms(...sources: readonly string[]): readonly string[] {
  const stop = new Set(['para', 'com', 'sem', 'das', 'dos', 'uma', 'por', 'que', 'em', 'de', 'da', 'do', 'e', 'a', 'o', 'loja', 'servico', 'servicos', 'empresa', 'clinica']);
  const terms = sources
    .flatMap((source) => stripAccents(source).split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 4 && !stop.has(token));
  return [...new Set(terms)].slice(0, 8);
}

/**
 * Calcula recência e taxa de resposta SOMENTE com datas confiáveis e amostra suficiente.
 * Amostra parcial nunca é apresentada como total do perfil.
 */
export function analyzeReviewSample(params: {
  readonly reviews: readonly ParsedReview[];
  readonly profileTotalReviews: number | null;
  /** `true` quando não há mais páginas a buscar. */
  readonly exhausted: boolean;
  readonly serviceTerms?: readonly string[];
}): ReviewSampleAnalysis {
  const { reviews, profileTotalReviews, exhausted, serviceTerms = [] } = params;
  const limitations: string[] = [];
  const dated = reviews.filter((r) => r.ageDaysMin !== null && r.ageDaysMax !== null);

  // Com o total do perfil conhecido, a amostra só é "completa" se cobre quase todas as avaliações
  // (tolerância de 10% para avaliações removidas ou sem texto). "Sem próxima página" não basta:
  // a API pode devolver menos do que o perfil tem.
  const sampleIsComplete =
    reviews.length > 0 &&
    (profileTotalReviews !== null && profileTotalReviews > 0
      ? reviews.length >= Math.floor(profileTotalReviews * 0.9)
      : exhausted);

  const inWindow = dated.filter((r) => (r.ageDaysMax as number) <= REVIEW_WINDOW_DAYS);
  const outOfWindow = dated.filter((r) => (r.ageDaysMin as number) > REVIEW_WINDOW_DAYS);
  const ambiguous = dated.length - inWindow.length - outOfWindow.length;

  // A janela só é "coberta" se TODAS as avaliações têm data e a amostra alcançou datas anteriores à
  // janela (ou esgotou o histórico). Do contrário, só há um mínimo comprovado.
  const allDated = dated.length === reviews.length && reviews.length > 0;
  const reachedBeforeWindow = outOfWindow.length > 0;
  const windowCovered = allDated && ambiguous === 0 && (reachedBeforeWindow || sampleIsComplete);

  if (!allDated && reviews.length > 0) limitations.push('Parte das avaliações veio sem data utilizável.');
  if (ambiguous > 0) limitations.push(`${ambiguous} avaliações têm data imprecisa (limite da janela de 30 dias).`);
  if (!windowCovered && reviews.length > 0) {
    limitations.push('A amostra não alcança datas anteriores aos 30 dias; o número é apenas um mínimo.');
  }
  if (!sampleIsComplete && reviews.length > 0) {
    limitations.push(
      profileTotalReviews !== null
        ? `Amostra de ${reviews.length} de ${profileTotalReviews} avaliações do perfil: indicadores não representam o total.`
        : `Amostra de ${reviews.length} avaliações: indicadores não representam o total do perfil.`
    );
  }

  const ownerReplies = reviews.filter((r) => r.hasOwnerReply).length;
  const replyFieldObserved = reviews.some((r) => r.ownerReplyFieldPresent);
  if (reviews.length > 0 && !replyFieldObserved && ownerReplies === 0) {
    limitations.push('A API não enviou o campo de resposta do proprietário: a taxa de resposta não pode ser calculada.');
  }
  return {
    sampleSize: reviews.length,
    datedCount: dated.length,
    profileTotalReviews,
    sampleIsComplete,
    windowCovered,
    countLast30Days: reviews.length === 0 ? null : inWindow.length,
    countLast30DaysIsLowerBound: reviews.length > 0 && !windowCovered,
    ambiguousDates: ambiguous,
    ownerReplies,
    ownerResponseRatePercent:
      reviews.length > 0 && (replyFieldObserved || ownerReplies > 0)
        ? Number(((ownerReplies / reviews.length) * 100).toFixed(1))
        : null,
    textsAvailable: reviews.filter((r) => r.text).length,
    reviewsMentioningTerms:
      serviceTerms.length > 0 && reviews.some((r) => r.text)
        ? reviews.filter((r) => r.text && serviceTerms.some((term) => stripAccents(r.text as string).includes(term))).length
        : null,
    limitations,
  };
}

export interface SerperReviewsConfig {
  readonly enabled: boolean;
  readonly apiKey: string | null;
  readonly url: string;
  readonly maxPages: number;
}

export function readSerperReviewsConfig(env: Readonly<Record<string, string | undefined>> = process.env): SerperReviewsConfig {
  const key = env.SERPER_API_KEY?.trim() ?? '';
  const usable = key.length > 10 && !key.includes('cole-sua-api-key');
  const pages = Number(env.GMN_REVIEWS_MAX_PAGES ?? '1');
  return {
    enabled: env.GMN_REVIEWS_PROVIDER === 'serper',
    apiKey: usable ? key : null,
    url: env.SERPER_REVIEWS_URL ?? 'https://google.serper.dev/reviews',
    maxPages: Number.isInteger(pages) && pages >= 1 && pages <= 5 ? pages : 1,
  };
}

export type ReviewsFetchOutcome =
  | { readonly state: 'DISABLED'; readonly reason: string }
  | { readonly state: 'MISSING_IDENTIFIER'; readonly reason: string }
  | { readonly state: 'FAILED'; readonly reason: string; readonly httpStatus?: number; readonly pagesFetched: number; readonly reviews: readonly ParsedReview[] }
  | {
      readonly state: 'FETCHED';
      readonly reviews: readonly ParsedReview[];
      readonly pagesFetched: number;
      readonly exhausted: boolean;
      readonly totalReported: number | null;
      readonly warnings: readonly string[];
      readonly fetchedAt: string;
    };

export type ReviewsFetcher = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Busca avaliações (mais novas primeiro). Cada página é uma chamada cobrada: nada roda sem a flag. */
export async function fetchSerperReviews(
  params: { readonly featureId: string | null; readonly placeId: string | null; readonly cid: string | null },
  config: SerperReviewsConfig = readSerperReviewsConfig(),
  fetcher: ReviewsFetcher = (url, init) => fetch(url, init),
  now: () => Date = () => new Date()
): Promise<ReviewsFetchOutcome> {
  if (!config.enabled) return { state: 'DISABLED', reason: 'Coleta de avaliações datadas desligada (GMN_REVIEWS_PROVIDER não é "serper").' };
  if (!config.apiKey) return { state: 'DISABLED', reason: 'Chave do Serper ausente ou inválida.' };
  if (!params.featureId) return { state: 'MISSING_IDENTIFIER', reason: 'O endpoint de avaliações exige o identificador "fid", ausente neste perfil.' };

  const collected: ParsedReview[] = [];
  const warnings: string[] = [];
  let token: string | null = null;
  let totalReported: number | null = null;
  let pages = 0;

  while (pages < config.maxPages) {
    let response;
    try {
      response = await fetcher(config.url, {
        method: 'POST',
        headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fid: params.featureId,
          ...(params.placeId ? { placeId: params.placeId } : {}),
          ...(params.cid ? { cid: params.cid } : {}),
          sortBy: 'newest',
          gl: 'br',
          hl: 'pt-br',
          ...(token ? { nextPageToken: token } : {}),
        }),
      });
    } catch (error: unknown) {
      return { state: 'FAILED', reason: error instanceof Error ? error.message : 'Falha de rede.', pagesFetched: pages, reviews: collected };
    }
    if (!response.ok) {
      return { state: 'FAILED', reason: `Serper Reviews respondeu HTTP ${response.status}.`, httpStatus: response.status, pagesFetched: pages, reviews: collected };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { state: 'FAILED', reason: 'Resposta do Serper Reviews não é JSON.', pagesFetched: pages, reviews: collected };
    }
    pages += 1;
    const page = parseSerperReviewsResponse(payload, now());
    collected.push(...page.reviews);
    warnings.push(...page.warnings);
    totalReported = page.totalReported ?? totalReported;
    token = page.nextPageToken;
    if (!token || page.reviews.length === 0) break;
  }

  return {
    state: 'FETCHED',
    reviews: collected,
    pagesFetched: pages,
    exhausted: token === null,
    totalReported,
    warnings: [...new Set(warnings)],
    fetchedAt: now().toISOString(),
  };
}
