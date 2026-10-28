import type { AuditDetailDto, AuditListItemDto, EvidenceDto } from '../../src/lib/link-audit-evidence';

/* Dados 100% FICTÍCIOS no formato que o servidor entrega à interface. */
export const LIMIT = 'Obtido via Serper /maps, intermediário de coleta da listagem pública do Google Maps; não é a API oficial do Google Business Profile e o perfil não foi aberto diretamente no Google.';

export const listItem = (over: Partial<AuditListItemDto> = {}): AuditListItemDto => ({
  auditId: 'auditoria-teste-0001',
  companyName: 'Padaria Exemplo',
  city: 'Cidade Exemplo',
  stateCode: 'GO',
  confirmedCid: '1311768467294899695',
  collectedAt: '2026-10-22T12:54:48.079Z',
  sourceLabel: 'Serper /maps (intermediário; não é a API oficial do Google)',
  state: 'COMPLETE',
  layout: 'VERSIONED',
  captureCount: 1,
  reportRevisions: 2,
  integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 4, issues: [], note: 'O hash detecta alteração acidental; não é assinatura.' },
  ...over,
});

const verified = (id: string, claim: string, criterionId = 'NAP'): EvidenceDto => ({ id, criterionId, attribute: id, claim, status: 'VERIFIED', origin: 'GOOGLE_NATIVE', consultedAt: '2026-10-22T12:54:48.079Z', limitation: LIMIT });
const unverified = (id: string, reason: string, criterionId = 'VISUALS', origin = 'GOOGLE_NATIVE'): EvidenceDto => ({ id, criterionId, attribute: id, claim: `${id}: não verificado.`, status: 'NOT_VERIFIED', origin, consultedAt: '2026-10-22T12:54:48.079Z', limitation: reason });

export const detailDto = (over: Partial<AuditDetailDto> = {}): AuditDetailDto => ({
  kind: 'EVIDENCE_COLLECTION',
  auditId: 'auditoria-teste-0001',
  layout: 'VERSIONED',
  state: 'COMPLETE',
  selected: { capture: 1, revision: 2 },
  company: { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' },
  collectedAt: '2026-10-22T12:54:48.079Z',
  methodologyVersion: 'lumos-reconstruida-v1',
  source: { label: 'Serper /maps (intermediário; não é a API oficial do Google)', officialGoogleApi: false, description: null, httpStatus: 200, httpAttempts: 1, creditsReportedByApi: 3, resultCount: 1 },
  located: 'MATCHED',
  establishment: {
    name: 'Padaria Exemplo (fictícia)',
    address: 'Rua Fictícia, 100 - Cidade Exemplo - GO',
    phone: '(62) 99999-0000',
    website: 'https://www.padaria-exemplo.example/',
    category: 'Padaria',
    secondaryCategories: ['Confeitaria'],
    rating: 4.8,
    ratingCount: 86,
    openingHours: [
      { day: 'sábado', hours: 'Fechado' },
      { day: 'segunda-feira', hours: '08:00–18:00' },
      { day: 'domingo', hours: 'Fechado' },
    ],
    queriedAt: '2026-10-22T12:54:48.079Z',
  },
  location: { latitude: -16.1, longitude: -49.2 },
  site: { requestedUrl: 'https://www.padaria-exemplo.example/', accessClass: 'HTTP_403', accessNote: 'O site respondeu HTTP 403 à verificação automatizada. Isso não prova que o site exija login.', httpRequests: 1, checkedAt: '2026-10-22T12:54:48.084Z' },
  identifiers: {
    fromLink: { cid: null, featureId: '0x0:0x1234567890abcdef', placeId: null },
    derivedCid: { value: '1311768467294899695', method: 'hex-suffix-to-decimal-bigint' },
    returnedByProvider: { cid: '1311768467294899695', featureId: '0x94aa11bb22cc33dd:0x1234567890abcdef', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' },
    confirmed: [{ type: 'cid', value: '1311768467294899695', expectedOrigin: 'DERIVED_FROM_FID', providerFields: ['cid', 'fid (2ª metade)'] }],
  },
  evidences: {
    verified: [verified('maps-name', 'Nome exibido no perfil: Padaria Exemplo (fictícia)'), verified('maps-address', 'Endereço exibido no perfil: Rua Fictícia, 100'), verified('maps-phone', 'Telefone exibido no perfil: (62) 99999-0000')],
    unverified: [unverified('unavailable-photos', 'A fonte consultada (Serper /maps) não disponibiliza este dado.'), unverified('site-reachable', 'Verificação técnica do site não concluída (HTTP_403).', 'CONVERSION', 'OFFICIAL_SITE')],
    other: [],
  },
  limitations: ['O CID esperado (1311768467294899695) foi derivado do FID do link por conversão offline; não foi retornado por nenhuma API.', 'Dados do perfil obtidos via Serper /maps (intermediário); o perfil não foi aberto diretamente no Google.'],
  divergences: [],
  versions: [{ capture: 1, collectedAt: '2026-10-22T12:54:48.079Z', httpStatus: 200, reportRevisions: [{ revision: 1, generatedAt: '2026-10-22T13:00:00.000Z', superseded: true }, { revision: 2, generatedAt: '2026-10-22T14:00:00.000Z', superseded: false }] }],
  integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 4, issues: [], note: 'O hash detecta alteração acidental; não é assinatura.' },
  scoring: 'NOT_AVAILABLE_PENDING_D3',
  ...over,
});
