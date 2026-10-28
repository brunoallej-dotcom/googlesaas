import { scoreAudit, type ScoreResult, type SubcriterionId, type SubcriterionResult } from '../../src/lib/link-audit/scoring';
import type { Mutable } from './link-audit-fixtures';

/** Fixtures FICTÍCIAS do motor de pontuação (nenhum dado real; nenhuma rede). */
export const REF = '2026-10-22';
export const SHA = 'a'.repeat(64);

export function evidence(id: string, over: Mutable = {}): Mutable {
  return { id, origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-20T10:00:00-03:00', contentSha256: SHA, ...over };
}

export const obs = (value: unknown, over: { ids?: string[]; complete?: boolean } = {}): Mutable => ({
  evidenceIds: over.ids ?? ['n1'],
  complete: over.complete ?? true,
  value,
});

const SITE_PAGE = { url: 'https://exemplo.com.br/', status: 200, sha256: SHA, fetchedAt: '2026-10-21T10:00:00-03:00' };
export const record = (kind: string, id: string, over: Mutable = {}): Mutable => ({
  kind,
  id,
  operatorEmail: 'ana@empresa.com',
  recordedAt: '2026-10-21T12:00:00-03:00',
  justification: 'Conferido no painel e no site oficial pelo operador responsável.',
  ...over,
});

function weekdays(): Mutable {
  return { kind: 'STRUCTURED', days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: false, intervals: [['08:00', '18:00']] })) };
}

/** Perfil fictício com TODOS os subcritérios no nível máximo: 100 pontos avaliados, índice 100. */
export function richInput(): Mutable {
  return {
    schemaVersion: 1,
    auditId: 'audit-fixture-01',
    referenceDate: REF,
    evidences: [
      evidence('n1'),
      evidence('site1', { origin: 'OFFICIAL_SITE' }),
      evidence('soc1', { origin: 'OFFICIAL_SOCIAL' }),
      evidence('c1'),
      evidence('c2'),
      evidence('c3'),
    ],
    profile: {
      name: [obs('Padaria Exemplo')],
      address: [obs({ raw: 'Rua das Flores, 100, Centro, Cidade Exemplo - GO, 75000-000', parsed: { street: 'Rua das Flores', number: '100', city: 'Cidade Exemplo', state: 'GO' } })],
      phone: [obs('(62) 3233-7847')],
      hours: [obs(weekdays())],
      website: [obs('https://exemplo.com.br/?utm_source=google&utm_medium=gbp')],
      primaryCategory: [obs('Padaria')],
      additionalCategories: [obs(['Confeitaria', 'Cafeteria'])],
      description: [obs({ lengthChars: 400 })],
      services: [obs(8)],
      attributes: [obs(4)],
      products: [obs(5)],
      logoCover: [obs({ logo: true, cover: true })],
      photos: [obs(25)],
      videos: [obs(2)],
      latestMedia: [obs({ kind: 'EXACT', date: '2026-09-22' })],
      reviews: [obs({ ratingShown: '4.9', reviewCount: 130 })],
      latestReviewDate: [obs({ kind: 'EXACT', date: '2026-10-02' })],
      replies: [
        obs({
          ownerReplyFieldExposed: true,
          reviewsRead: 10,
          allReviewsRead: false,
          repliedCount: 9,
          pairs: [
            { reviewDate: '2026-09-01', replyDate: '2026-09-02' },
            { reviewDate: '2026-09-05', replyDate: '2026-09-06' },
            { reviewDate: '2026-09-10', replyDate: '2026-09-12' },
          ],
        }),
      ],
      posts: [
        obs({
          exposed: true,
          items: ['2026-10-15', '2026-10-10', '2026-09-25', '2026-09-10', '2026-08-30'].map((date) => ({ date: { kind: 'EXACT', date } })),
        }),
      ],
      actions: [obs({ kinds: ['PHONE', 'WHATSAPP', 'MESSAGES'] })],
    },
    site: {
      scope: { kind: 'SITEMAP_COMPLETE', pagesRead: [SITE_PAGE], requestCap: 8, capReached: false, blockers: [], sitemap: { urlsListed: 1, urlsRead: 1 }, limitations: [] },
      accessibility: { evidenceIds: ['site1'], outcome: 'OK', status: 200 },
      offers: { evidenceIds: ['site1'], distinctNamedOffers: 6, determination: { method: 'OPERATOR_CONFIRMED', operatorRecordId: 'op-obs' } },
      journey: { evidenceIds: ['site1'], elements: ['CTA', 'CATALOG_OR_SERVICE', 'CONTACT_OR_PURCHASE'], determination: { method: 'OPERATOR_CONFIRMED', operatorRecordId: 'op-obs' } },
    },
    nap: { sources: [{ sourceId: 'site-nap', kind: 'SITE', evidenceIds: ['site1'], name: 'Padaria Exemplo', phone: '62 3233-7847', address: 'Rua das Flores, 100 - Centro - Cidade Exemplo GO 75000-000' }] },
    competitors: [
      { id: 'comp-a', name: 'Concorrente A', region: 'Cidade Exemplo', equivalenceCriterion: 'mesma cidade e categoria', verifiableElements: 2, evidenceIds: ['c1'], rating: '4.8', reviewCount: 120 },
      { id: 'comp-b', name: 'Concorrente B', region: 'Cidade Exemplo', equivalenceCriterion: 'mesma cidade e categoria', verifiableElements: 2, evidenceIds: ['c2'], rating: '4.5', reviewCount: 80 },
      { id: 'comp-c', name: 'Concorrente C', region: 'Cidade Exemplo', equivalenceCriterion: 'mesma cidade e categoria', verifiableElements: 3, evidenceIds: ['c3'], rating: '4.3', reviewCount: 40 },
    ],
    authority: {
      findings: [
        { class: 'OFFICIAL_SITE', corroborated: true, evidenceIds: ['site1'] },
        { class: 'SOCIAL', corroborated: true, evidenceIds: ['soc1'] },
      ],
    },
    operatorRecords: [
      record('JUDGEMENT', 'op-c2', { subcriterionId: 'C2', value: 'COMPATIBLE' }),
      record('JUDGEMENT', 'op-c3', { subcriterionId: 'C3', value: 'ALL_RELEVANT' }),
      record('JUDGEMENT', 'op-p3', { subcriterionId: 'P3', value: 'SPECIFIC', sampleSize: 5 }),
      record('OBSERVATION_CONFIRMATION', 'op-obs', { subcriterionIds: ['S5', 'X4'] }),
      record('IMAGES_CONFIRMATION', 'op-img', { imageTypes: ['PLACE', 'PRODUCT_OR_SERVICE'], evidenceIds: ['site1'] }),
      record('SITE_SCOPE_ATTESTATION', 'op-scope', { subcriterionIds: ['S5', 'V5', 'X4'], scopeDescription: 'Sitemap integralmente percorrido e páginas de oferta conferidas manualmente.' }),
    ],
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Pontua uma cópia de `richInput()` depois de `mutate`; falha o teste se a entrada for recusada. */
export function run(mutate: (draft: Mutable) => void = () => undefined): ScoreResult {
  const draft = clone(richInput());
  mutate(draft);
  const outcome = scoreAudit(draft);
  if (!outcome.ok) throw new Error(`entrada recusada: ${outcome.issues.join(' | ')}`);
  return outcome.result;
}

export function sub(result: ScoreResult, id: SubcriterionId): SubcriterionResult {
  const found = result.subcriteria.find((item) => item.id === id);
  if (!found) throw new Error(`subcritério ${id} ausente`);
  return found;
}

/** Remove fatos do perfil (vira Não verificado: sem observação). */
export function without(...keys: string[]): (draft: Mutable) => void {
  return (draft) => {
    for (const key of keys) delete draft.profile[key];
  };
}

export { scoreAudit };
