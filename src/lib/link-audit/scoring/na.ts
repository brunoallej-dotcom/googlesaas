import type { ScoringContext } from './context';
import { EMPTY_BASIS, type Basis } from './results';
import { NA_RULES } from './ruler';
import type { NaCode, SubcriterionId } from './types';

export interface NaInfo {
  readonly code: NaCode;
  readonly justification: string;
  readonly causeEvidenceIds: readonly string[];
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly operatorRecordId: string | null;
  readonly basis: Basis;
}

const ANY_ORIGIN = ['GOOGLE_NATIVE', 'OFFICIAL_SITE', 'OFFICIAL_SOCIAL', 'THIRD_PARTY', 'INSTITUTIONAL'] as const;
export const ENGINE_RECORDER = 'DERIVED_BY_ENGINE';

/**
 * Não aplicável. Causas PROVADAS pelos fatos (0 avaliações, website vazio, nenhuma resposta) são derivadas e registradas
 * pelo próprio motor; as demais exigem registro do operador cuja causa NÃO pode ser contrariada pelos fatos. N/A nunca
 * soma à cobertura nem altera o índice em relação a Não verificado.
 */
export function computeNa(ctx: ScoringContext): Map<SubcriterionId, NaInfo> {
  const map = new Map<SubcriterionId, NaInfo>();
  const derive = (code: NaCode, justification: string, basis: Basis): void => {
    for (const sid of NA_RULES[code].subcriteria) {
      if (map.has(sid)) continue;
      map.set(sid, { code, justification, causeEvidenceIds: basis.evidenceIds, recordedBy: ENGINE_RECORDER, recordedAt: ctx.referenceDate, operatorRecordId: null, basis });
    }
  };

  const reviews = ctx.resolve('reviews');
  if (reviews.status === 'OK' && reviews.complete && reviews.value.reviewCount === 0) {
    derive('NO_REVIEWS_PROVEN', 'Perfil com 0 avaliações comprovadas na leitura nativa completa: nota, recência e respostas não existem para medir.', reviews.basis);
  }
  const website = ctx.resolve('website');
  if (website.status === 'OK' && website.complete && (website.value === null || website.value.trim() === '')) {
    derive('NO_WEBSITE_PROVEN', 'Campo "website" do perfil lido por inteiro e vazio: não há site a acessar, percorrer ou analisar.', website.basis);
  }
  const replies = ctx.resolve('replies');
  if (replies.status === 'OK') {
    const value = replies.value;
    const sufficient = value.ownerReplyFieldExposed && value.reviewsRead >= 1 && (value.reviewsRead >= 10 || value.allReviewsRead);
    if (sufficient && value.repliedCount === 0) {
      derive('NO_REPLIES_PROVEN', 'Nenhuma resposta do proprietário existe nas avaliações lidas (campo exposto): não há respostas cuja qualidade avaliar.', replies.basis);
    }
  }

  for (const record of ctx.records('NOT_APPLICABLE')) {
    let causeBasis: Basis = EMPTY_BASIS;
    if (record.causeEvidenceIds.length > 0) {
      const grounded = ctx.ground(record.causeEvidenceIds, ANY_ORIGIN);
      if (!grounded.ok) {
        ctx.reject(`N/A ${record.id}: evidência da causa inválida (${grounded.reason})`);
        continue;
      }
      causeBasis = grounded.basis;
    }
    let contradicted = false;
    for (const sid of record.subcriterionIds) {
      if (record.code === 'FEATURE_UNAVAILABLE' && sid === 'S3') {
        const attributes = ctx.resolve('attributes');
        // uma lista de atributos LIDA (mesmo vazia) mostra que o recurso existe: não é "indisponível"
        if (attributes.status === 'CONFLICT' || attributes.status === 'OK') contradicted = true;
      } else if (record.code === 'FEATURE_UNAVAILABLE') {
        const posts = ctx.resolve('posts');
        // lista de Posts exposta (mesmo vazia) contradiz "recurso inexistente"; só vale se o campo não é exposto
        if (posts.status === 'CONFLICT' || (posts.status === 'OK' && (posts.value.exposed || posts.value.items.length > 0))) contradicted = true;
      } else if (record.code === 'BUSINESS_MODEL') {
        const products = ctx.resolve('products');
        if (products.status === 'CONFLICT' || (products.status === 'OK' && products.value > 0)) contradicted = true;
      } else if (record.code === 'NO_ADDITIONAL_NEEDED') {
        const additional = ctx.resolve('additionalCategories');
        if (!(additional.status === 'OK' && additional.complete && additional.value.length === 0)) contradicted = true;
      }
    }
    if (contradicted) {
      ctx.reject(`N/A ${record.id} (${record.code}): a causa é contrariada ou não é provada pelos fatos informados`);
      continue;
    }
    for (const sid of record.subcriterionIds) {
      map.set(sid, {
        code: record.code,
        justification: record.justification,
        causeEvidenceIds: [...record.causeEvidenceIds].sort(),
        recordedBy: 'OPERATOR_RECORD', // o e-mail fica no registro do operador (operatorRecordId); não é repetido no resultado
        recordedAt: record.recordedAt,
        operatorRecordId: record.id,
        basis: { ...causeBasis, operatorRecordIds: [record.id] },
      });
    }
  }
  return map;
}
