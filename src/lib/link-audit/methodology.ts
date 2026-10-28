/**
 * Metodologia da Auditoria por Link (Fase 6), reconstrução v1.
 *
 * ATENÇÃO: é uma reconstrução baseada nos materiais fornecidos (documento mestre, manual, guia,
 * JSON e PDFs de referência). NÃO é o prompt original do agente antigo, que não foi recuperado, e
 * não reproduz integralmente o comportamento dele.
 *
 * Este módulo é independente do Juiz da GMN (21 critérios, peso 102) e da grade de 49 pontos.
 * A régua de pontos por critério (D3) ainda não foi aprovada: aqui só existem os pesos máximos.
 */

export const METHODOLOGY_VERSION = 'lumos-reconstruida-v1' as const;

export const METHODOLOGY_STATUS =
  'Reconstrução baseada nos materiais fornecidos; não é o prompt original do agente e não garante comportamento idêntico.' as const;

export const CRITERION_IDS = [
  'NAP',
  'CATEGORIES',
  'SERVICES',
  'REVIEWS',
  'REVIEW_REPLIES',
  'VISUALS',
  'POSTS_ACTIVITY',
  'CONVERSION',
  'LOCAL_AUTHORITY',
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

export interface CriterionDefinition {
  readonly id: CriterionId;
  readonly label: string;
  /** Peso máximo (teto do critério). Não é regra de atribuição de pontos. */
  readonly maxWeight: number;
}

/** Nove critérios e pesos máximos (JSON de exemplo, Lumos p4, Rio p4 e mestre §5). Soma = 100. */
export const CRITERIA: readonly CriterionDefinition[] = [
  { id: 'NAP', label: 'Dados essenciais e consistência NAP', maxWeight: 15 },
  { id: 'CATEGORIES', label: 'Categorias e relevância comercial', maxWeight: 10 },
  { id: 'SERVICES', label: 'Serviços, produtos, descrição e atributos', maxWeight: 12 },
  { id: 'REVIEWS', label: 'Avaliações e reputação', maxWeight: 18 },
  { id: 'REVIEW_REPLIES', label: 'Respostas às avaliações', maxWeight: 8 },
  { id: 'VISUALS', label: 'Fotos, vídeos e identidade visual', maxWeight: 10 },
  { id: 'POSTS_ACTIVITY', label: 'Publicações e atividade', maxWeight: 8 },
  { id: 'CONVERSION', label: 'Conversão e jornada', maxWeight: 10 },
  { id: 'LOCAL_AUTHORITY', label: 'Autoridade local e competitividade', maxWeight: 9 },
];

export const TOTAL_MAX_WEIGHT = CRITERIA.reduce((sum, criterion) => sum + criterion.maxWeight, 0);

if (TOTAL_MAX_WEIGHT !== 100) {
  throw new Error(`Pesos da metodologia devem somar 100 (soma atual: ${TOTAL_MAX_WEIGHT}).`);
}

export function isCriterionId(value: unknown): value is CriterionId {
  return typeof value === 'string' && (CRITERION_IDS as readonly string[]).includes(value);
}

/**
 * Atributos que só o próprio perfil do Google pode comprovar (manual §3): site e redes sociais NÃO
 * comprovam. Evidência externa sobre eles só pode ser registrada como "Não verificado".
 */
export const NATIVE_ONLY_ATTRIBUTES = [
  'google_categories',
  'google_services',
  'google_reviews',
  'google_review_replies',
  'google_profile_photos',
  'google_profile_videos',
  'google_posts',
  'google_products',
  'google_attributes',
] as const;

export type NativeOnlyAttribute = (typeof NATIVE_ONLY_ATTRIBUTES)[number];

export function isNativeOnlyAttribute(value: string): value is NativeOnlyAttribute {
  return (NATIVE_ONLY_ATTRIBUTES as readonly string[]).includes(value);
}

/** Critério da metodologia ao qual cada atributo nativo pertence. */
export const NATIVE_ATTRIBUTE_CRITERION: Readonly<Record<NativeOnlyAttribute, CriterionId>> = {
  google_categories: 'CATEGORIES',
  google_services: 'SERVICES',
  google_reviews: 'REVIEWS',
  google_review_replies: 'REVIEW_REPLIES',
  google_profile_photos: 'VISUALS',
  google_profile_videos: 'VISUALS',
  google_posts: 'POSTS_ACTIVITY',
  google_products: 'SERVICES',
  google_attributes: 'SERVICES',
};

/**
 * Critérios definidos como recursos do próprio Google (manual §3 e mestre §5: categorias, avaliações e
 * respostas "do Google", Google Posts). Neles, só o perfil do Google comprova; site e redes entram como
 * contexto em "Não verificado". SERVICES e VISUALS são mistos: lá só os atributos `google_*` são nativos.
 */
export const NATIVE_ONLY_CRITERIA: readonly CriterionId[] = ['CATEGORIES', 'REVIEWS', 'REVIEW_REPLIES', 'POSTS_ACTIVITY'];

/** `true` quando a evidência só pode ser comprovada pelo perfil do Google (pelo atributo ou pelo critério). */
export function requiresGoogleNativeProof(attribute: string, criterionId: CriterionId): boolean {
  return isNativeOnlyAttribute(attribute) || attribute.startsWith('google_') || NATIVE_ONLY_CRITERIA.includes(criterionId);
}
