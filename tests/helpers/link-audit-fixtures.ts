import { CRITERIA } from '../../src/lib/link-audit/methodology';

/*
 * Dados 100% FICTÍCIOS para os testes da Fase 6. Nenhuma empresa real é consultada: identificadores,
 * nomes e domínios abaixo foram inventados para teste.
 */
export const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
export const FID_OTHER = '0x935ef1a2b3c4d5e6:0x00000000000000ff';
export const DIRECT_LINK = `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}`;
export const SHORT_LINK = 'https://maps.app.goo.gl/AbCd1234';
export const RESOLVED_LINK = `https://www.google.com/maps/place/Padaria+Exemplo/data=!4m2!3m1!1s${FID}`;
export const SNAPSHOT_ID = 'snap-exemplo-0001';

export const T_CONSULTED = '2026-10-20T11:00:00.000Z';
export const T_COLLECTED = '2026-10-20T12:00:00.000Z';
export const T_RESOLVED = '2026-10-20T12:10:00.000Z';
export const T_CONFIRMED = '2026-10-20T12:30:00.000Z';
export const T_FROZEN = '2026-10-20T13:00:00.000Z';
export const T_FROZEN_LATER = '2026-10-21T09:00:00.000Z';

export type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Rascunho válido de snapshot por link direto, com evidência nativa, externa e uma não verificada. */
export function directDraft(overrides: Mutable = {}): Mutable {
  const criteria = CRITERIA.map((criterion) => ({
    criterionId: criterion.id,
    status: 'NOT_VERIFIED',
    evidenceIds: [] as string[],
  }));
  const byId = (id: string) => criteria.find((c) => c.criterionId === id)!;
  Object.assign(byId('REVIEWS'), { status: 'VERIFIED', evidenceIds: ['ev-rev-1'] });
  Object.assign(byId('NAP'), { status: 'VERIFIED', evidenceIds: ['ev-nap-1'] });
  Object.assign(byId('POSTS_ACTIVITY'), { status: 'NOT_VERIFIED', evidenceIds: ['ev-posts-1'] });

  return {
    snapshotId: SNAPSHOT_ID,
    collectedAt: T_COLLECTED,
    frozenAt: T_FROZEN,
    link: { originalLink: DIRECT_LINK, resolved: null },
    identity: {
      originalLink: DIRECT_LINK,
      identifiers: { featureId: FID },
      name: 'Padaria Exemplo (fictícia)',
      city: 'Cidade Exemplo',
      stateCode: 'GO',
      confirmation: { confirmedBy: 'operador-teste', confirmedAt: T_CONFIRMED },
    },
    evidences: [
      {
        id: 'ev-rev-1',
        attribute: 'google_reviews',
        criterionId: 'REVIEWS',
        claim: 'Nota e quantidade de avaliações exibidas no perfil (fictício).',
        status: 'VERIFIED',
        origin: 'GOOGLE_NATIVE',
        sourceUrl: `https://www.google.com/maps?ftid=${FID}`,
        consultedAt: T_CONSULTED,
      },
      {
        id: 'ev-nap-1',
        attribute: 'official_phone',
        criterionId: 'NAP',
        claim: 'Telefone publicado no site oficial (fictício).',
        status: 'VERIFIED',
        origin: 'OFFICIAL_SITE',
        sourceUrl: 'https://www.padaria-exemplo.example/contato',
        consultedAt: T_CONSULTED,
      },
      {
        id: 'ev-posts-1',
        attribute: 'google_posts',
        criterionId: 'POSTS_ACTIVITY',
        claim: 'Google Posts não puderam ser consultados.',
        status: 'NOT_VERIFIED',
        origin: 'OFFICIAL_SOCIAL',
        sourceUrl: 'https://www.instagram.com/padaria_exemplo',
        consultedAt: T_CONSULTED,
        limitation: 'O perfil do Google não ficou acessível nesta coleta.',
        nativeContext: 'O Instagram oficial publica toda semana (não prova Google Posts).',
      },
    ],
    criteria,
    limitations: ['Google Posts não foram confirmados nesta coleta (fictício).'],
    ...overrides,
  };
}

/** Rascunho por link curto: o link resolvido precisa estar presente e a confirmação vem depois dele. */
export function shortLinkDraft(overrides: Mutable = {}): Mutable {
  const draft = directDraft();
  draft.link = {
    originalLink: SHORT_LINK,
    resolved: { url: RESOLVED_LINK, resolvedAt: T_RESOLVED, method: 'REDIRECT_CHAIN' },
  };
  draft.identity.originalLink = SHORT_LINK;
  return Object.assign(draft, overrides);
}
