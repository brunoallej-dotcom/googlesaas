import { CRITERIA, type CriterionId } from '../methodology';
import { frac, type Frac } from './math';
import type { NaCode, SubcriterionId } from './types';
import { METHODOLOGY_VERSION, SCORE_MODEL_VERSION } from './versions';

/**
 * Régua `regua-d3b-r2` (D3B homologada em 22/10/2026) como DADOS. Metodologia RECONSTRUÍDA: nenhuma faixa aqui
 * pertence ao agente original. Os pesos dos nove critérios vêm de `methodology.ts` (soma 100) e a soma dos
 * subcritérios de cada critério precisa ser exatamente o peso (testado).
 *
 * Pontos em MEIOS-PONTOS (inteiros): 1,5 ponto = 3. As faixas são listas ordenadas; vale a PRIMEIRA que casa.
 */

export type SourceClass = 'NATIVE' | 'SITE' | 'EXTERNAL' | 'COMPETITORS' | 'CROSS' | 'NATIVE_AND_OPERATOR';

export interface SubcriterionDef {
  readonly id: SubcriterionId;
  readonly criterionId: CriterionId;
  readonly label: string;
  readonly maxHalfPoints: number;
  readonly source: SourceClass;
}

export const SUBCRITERIA: readonly SubcriterionDef[] = [
  { id: 'N1', criterionId: 'NAP', label: 'Nome do perfil presente', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'N2', criterionId: 'NAP', label: 'Endereço ou área de atendimento', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'N3', criterionId: 'NAP', label: 'Telefone', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'N4', criterionId: 'NAP', label: 'Horários', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'N5', criterionId: 'NAP', label: 'Consistência entre fontes (nome, endereço, telefone, horário)', maxHalfPoints: 8, source: 'CROSS' },
  { id: 'C1', criterionId: 'CATEGORIES', label: 'Categoria principal definida', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'C2', criterionId: 'CATEGORIES', label: 'Compatibilidade da principal com a atividade real', maxHalfPoints: 8, source: 'NATIVE_AND_OPERATOR' },
  { id: 'C3', criterionId: 'CATEGORIES', label: 'Categorias adicionais: relevância e coerência', maxHalfPoints: 6, source: 'NATIVE_AND_OPERATOR' },
  { id: 'S1', criterionId: 'SERVICES', label: 'Descrição nativa', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'S2', criterionId: 'SERVICES', label: 'Serviços/itens cadastrados no Google', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'S3', criterionId: 'SERVICES', label: 'Atributos do perfil', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'S4', criterionId: 'SERVICES', label: 'Produtos cadastrados no Google', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'S5', criterionId: 'SERVICES', label: 'Oferta pública em fonte própria', maxHalfPoints: 6, source: 'SITE' },
  { id: 'R1', criterionId: 'REVIEWS', label: 'Nota média', maxHalfPoints: 12, source: 'NATIVE' },
  { id: 'R2', criterionId: 'REVIEWS', label: 'Volume de avaliações', maxHalfPoints: 12, source: 'NATIVE' },
  { id: 'R3', criterionId: 'REVIEWS', label: 'Recência da avaliação mais recente', maxHalfPoints: 12, source: 'NATIVE' },
  { id: 'P1', criterionId: 'REVIEW_REPLIES', label: 'Taxa de resposta', maxHalfPoints: 8, source: 'NATIVE' },
  { id: 'P2', criterionId: 'REVIEW_REPLIES', label: 'Tempo de resposta (mediana)', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'P3', criterionId: 'REVIEW_REPLIES', label: 'Qualidade das respostas (revisão humana)', maxHalfPoints: 4, source: 'NATIVE_AND_OPERATOR' },
  { id: 'V1', criterionId: 'VISUALS', label: 'Logo e capa no perfil', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'V2', criterionId: 'VISUALS', label: 'Fotos no perfil', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'V3', criterionId: 'VISUALS', label: 'Vídeos no perfil', maxHalfPoints: 2, source: 'NATIVE' },
  { id: 'V4', criterionId: 'VISUALS', label: 'Recência da mídia nativa', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'V5', criterionId: 'VISUALS', label: 'Presença visual em fonte própria', maxHalfPoints: 4, source: 'EXTERNAL' },
  { id: 'A1', criterionId: 'POSTS_ACTIVITY', label: 'Publicação vigente', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'A2', criterionId: 'POSTS_ACTIVITY', label: 'Recência da última publicação', maxHalfPoints: 6, source: 'NATIVE' },
  { id: 'A3', criterionId: 'POSTS_ACTIVITY', label: 'Frequência nos últimos 90 dias', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'X1', criterionId: 'CONVERSION', label: 'Website configurado no perfil', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'X2', criterionId: 'CONVERSION', label: 'Site acessível (URL configurada)', maxHalfPoints: 2, source: 'SITE' },
  { id: 'X3', criterionId: 'CONVERSION', label: 'Canais de contato/ação no perfil', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'X4', criterionId: 'CONVERSION', label: 'Jornada no site', maxHalfPoints: 6, source: 'SITE' },
  { id: 'X5', criterionId: 'CONVERSION', label: 'Marcação UTM na URL de destino do website do perfil', maxHalfPoints: 4, source: 'NATIVE' },
  { id: 'L1', criterionId: 'LOCAL_AUTHORITY', label: 'Nota frente aos concorrentes', maxHalfPoints: 6, source: 'COMPETITORS' },
  { id: 'L2', criterionId: 'LOCAL_AUTHORITY', label: 'Volume de avaliações frente aos concorrentes', maxHalfPoints: 6, source: 'COMPETITORS' },
  { id: 'L3', criterionId: 'LOCAL_AUTHORITY', label: 'Prova externa de autoridade', maxHalfPoints: 6, source: 'EXTERNAL' },
];

export const SUBCRITERION_DEFS: ReadonlyMap<SubcriterionId, SubcriterionDef> = new Map(SUBCRITERIA.map((def) => [def.id, def]));

export function subcriterionDef(id: SubcriterionId): SubcriterionDef {
  const def = SUBCRITERION_DEFS.get(id);
  if (!def) throw new Error(`subcritério desconhecido: ${id}`);
  return def;
}

/* ---------------------------------------------------------------- faixas */

/** Faixa "quanto maior, melhor": vale a primeira com valor >= min (ou > min se `exclusive`). */
export interface AscTier {
  readonly label: string;
  readonly halfPoints: number;
  readonly min: Frac;
  readonly exclusive?: boolean;
}
/** Faixa "quanto menor, melhor" (idade em dias, nº de divergências): vale a primeira com valor <= maxAge; a última não tem teto. */
export interface AgeTier {
  readonly label: string;
  readonly halfPoints: number;
  readonly maxAge: Frac | null;
}

const asc = (rows: ReadonlyArray<readonly [string, number, number | Frac]>): readonly AscTier[] =>
  rows.map(([label, halfPoints, min]) => ({ label, halfPoints, min: typeof min === 'number' ? frac(min) : min }));
const age = (rows: ReadonlyArray<readonly [string, number, number | null]>): readonly AgeTier[] =>
  rows.map(([label, halfPoints, maxAge]) => ({ label, halfPoints, maxAge: maxAge === null ? null : frac(maxAge) }));

export const TIERS = {
  /** x = nota × 100 (inteiro). */
  R1: asc([['4,8–5,0', 12, 480], ['4,5–4,79', 10, 450], ['4,2–4,49', 8, 420], ['4,0–4,19', 6, 400], ['3,5–3,99', 4, 350], ['3,0–3,49', 2, 300], ['abaixo de 3,0', 0, 0]]),
  R2: asc([['≥ 100', 12, 100], ['50–99', 10, 50], ['25–49', 8, 25], ['10–24', 6, 10], ['5–9', 4, 5], ['1–4', 2, 1], ['0', 0, 0]]),
  R3: age([['até 30 dias', 12, 30], ['31–90 dias', 8, 90], ['91–180 dias', 4, 180], ['181–365 dias', 2, 365], ['mais de 365 dias', 0, null]]),
  P1: [
    { label: '≥ 90 %', halfPoints: 8, min: frac(9, 10) },
    { label: '70–89 %', halfPoints: 6, min: frac(7, 10) },
    { label: '50–69 %', halfPoints: 4, min: frac(1, 2) },
    { label: 'acima de 0 % e abaixo de 50 %', halfPoints: 2, min: frac(0), exclusive: true },
    { label: '0 %', halfPoints: 0, min: frac(0) },
  ] as readonly AscTier[],
  P2: age([['mediana até 7 dias', 4, 7], ['mediana de 7 a 30 dias', 2, 30], ['mediana acima de 30 dias', 0, null]]),
  S1: asc([['≥ 250 caracteres', 4, 250], ['1–249 caracteres', 2, 1], ['sem descrição', 0, 0]]),
  S2: asc([['≥ 5 itens', 6, 5], ['3–4 itens', 4, 3], ['1–2 itens', 2, 1], ['nenhum', 0, 0]]),
  S3: asc([['≥ 3 atributos', 4, 3], ['1–2 atributos', 2, 1], ['nenhum', 0, 0]]),
  S4: asc([['≥ 3 produtos', 4, 3], ['1–2 produtos', 2, 1], ['nenhum', 0, 0]]),
  S5: asc([['≥ 5 ofertas nomeadas', 6, 5], ['1–4 ofertas nomeadas', 3, 1], ['nenhuma', 0, 0]]),
  V1: asc([['logo e capa', 4, 2], ['um dos dois', 2, 1], ['nenhum', 0, 0]]),
  V2: asc([['≥ 20 fotos', 6, 20], ['10–19 fotos', 4, 10], ['5–9 fotos', 2, 5], ['1–4 fotos', 1, 1], ['nenhuma', 0, 0]]),
  V3: asc([['≥ 1 vídeo', 2, 1], ['nenhum', 0, 0]]),
  V4: age([['mídia até 90 dias', 4, 90], ['mídia de 91 a 365 dias', 2, 365], ['mídia com mais de 365 dias', 0, null]]),
  V5: asc([['≥ 2 tipos de imagem real', 4, 2], ['1 tipo', 2, 1], ['nenhum', 0, 0]]),
  A2: age([['até 30 dias', 6, 30], ['31–60 dias', 4, 60], ['61–90 dias', 2, 90], ['mais de 90 dias', 0, null]]),
  A3: asc([['≥ 4 publicações em 90 dias', 4, 4], ['2–3 publicações', 2, 2], ['0–1 publicação', 0, 0]]),
  X3: asc([['≥ 3 canais', 4, 3], ['2 canais', 3, 2], ['1 canal', 2, 1], ['nenhum', 0, 0]]),
  X4: asc([['3 elementos da jornada', 6, 3], ['2 elementos', 4, 2], ['1 elemento', 2, 1], ['nenhum', 0, 0]]),
  N4: asc([['7 dias definidos', 4, 7], ['1 a 6 dias definidos', 2, 1], ['nenhum dia', 0, 0]]),
  /** Nº de campos divergentes (nome, endereço, telefone, horário): menos é melhor. */
  N5: age([['nenhuma divergência', 8, 0], ['1 campo divergente', 5, 1], ['2 campos divergentes', 2, 2], ['3 ou mais campos divergentes', 0, null]]),
  L3: asc([['≥ 2 tipos corroborados', 6, 2], ['1 tipo', 3, 1], ['nenhum', 0, 0]]),
} as const;

/** Pontos de subcritérios categóricos (meios-pontos). */
export const CATEGORICAL = {
  PRESENT: 6, // N1, N3, C1
  N2_FULL: 6,
  N2_PARTIAL: 3,
  C2: { COMPATIBLE: 8, PARTIAL: 4, INCOMPATIBLE: 0 },
  C3: { ALL_RELEVANT: 6, MOSTLY_RELEVANT: 3, MOSTLY_IRRELEVANT: 0, MISSING_NEEDED: 0 },
  P3: { SPECIFIC: 4, GENERIC_OR_MIXED: 2, INAPPROPRIATE: 0 },
  A1: { VIGENT: 6, EXISTING_NONE_VIGENT: 2, EMPTY: 0 },
  X1_PRESENT: 4,
  X2_OK: 2,
  X5: { BOTH: 4, SOME: 2, NONE: 0 },
} as const;

/* ---------------------------------------------------------------- regras numéricas */

export const RULES = {
  /** Publicação (decisão final do usuário). */
  minCoveragePercent: 40,
  publishedFromCoveragePercent: 65,
  minCriteria: 3,
  /** D3B-15 (final): só conta o critério com pelo menos 3 pontos possíveis efetivamente avaliados. */
  minCriterionEvaluatedPoints: 3,
  /** R1 e L1 só pontuam com pelo menos 5 avaliações. */
  minReviewsForRating: 5,
  competitorMinReviews: 5,
  minEligibleCompetitors: 3,
  competitorMinVerifiableElements: 2,
  repliesMinSample: 10,
  repliesMinPairs: 3,
  p3MinReviewed: 5,
  postVigentMaxDays: 180,
  postsWindowDays: 90,
  evidenceAgedAfterDays: 90,
  evidenceCannotGroundAfterDays: 180,
  minJustificationChars: 20,
  maxSiteChannelKinds: 4,
  maxJourneyElements: 3,
  maxImageTypes: 3,
  authorityClasses: 4,
  confidence: {
    coverageHighFrom: 90,
    coverageMediumFrom: 65,
    breadthHighFrom: 7,
    breadthMediumFrom: 5,
    reliabilityHighFromPercent: 90,
    reliabilityMediumFromPercent: 60,
    freshnessHighUpToPercent: 10,
    freshnessMediumUpToPercent: 40,
    conflictsMediumUpTo: 2,
    naWeightHighUpTo: 15,
    naWeightMediumUpTo: 30,
  },
  classification: { criticalUpTo: 39, weakUpTo: 59, developingUpTo: 74, strongUpTo: 89 },
} as const;

/* ---------------------------------------------------------------- Não aplicável */

export interface NaRule {
  readonly subcriteria: readonly SubcriterionId[];
  /** `true`: a causa é PROVADA pelos fatos (o motor deriva e registra); `false`: exige registro do operador. */
  readonly derived: boolean;
}
export const NA_RULES: Readonly<Record<NaCode, NaRule>> = {
  NO_REVIEWS_PROVEN: { subcriteria: ['R1', 'R3', 'L1', 'P1', 'P2', 'P3'], derived: true },
  NO_REPLIES_PROVEN: { subcriteria: ['P3'], derived: true },
  NO_WEBSITE_PROVEN: { subcriteria: ['X2', 'X4', 'X5'], derived: true },
  FEATURE_UNAVAILABLE: { subcriteria: ['S3', 'A1', 'A2', 'A3'], derived: false },
  BUSINESS_MODEL: { subcriteria: ['S4'], derived: false },
  NO_ADDITIONAL_NEEDED: { subcriteria: ['C3'], derived: false },
};

/** Detectores determinísticos validados para S5/X4. Na Onda 6A não há nenhum: só confirmação do operador. */
export const VALIDATED_DETECTORS: readonly string[] = [];

/* ---------------------------------------------------------------- impressão digital */

/** Congela em profundidade: a régua não pode ser alterada em tempo de execução (nem `push`, nem troca de número). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Tudo o que define os pontos, em forma canônica: se qualquer número mudar, a impressão digital muda. */
export const RULER_DATA = {
  methodologyVersion: METHODOLOGY_VERSION,
  scoreModelVersion: SCORE_MODEL_VERSION,
  criteria: CRITERIA.map((criterion) => ({ id: criterion.id, weight: criterion.maxWeight })),
  subcriteria: SUBCRITERIA.map((def) => ({ id: def.id, criterionId: def.criterionId, maxHalfPoints: def.maxHalfPoints, source: def.source })),
  tiers: TIERS,
  categorical: CATEGORICAL,
  rules: RULES,
  naRules: NA_RULES,
  validatedDetectors: VALIDATED_DETECTORS,
} as const;

// Congelamento no carregamento do módulo (as estruturas acima são as mesmas referenciadas por RULER_DATA).
deepFreeze(SUBCRITERIA);
deepFreeze(TIERS);
deepFreeze(CATEGORICAL);
deepFreeze(RULES);
deepFreeze(NA_RULES);
deepFreeze(VALIDATED_DETECTORS);
deepFreeze(RULER_DATA);
