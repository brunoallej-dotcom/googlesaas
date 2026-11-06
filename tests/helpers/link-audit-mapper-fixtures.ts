import type { OperatorRecord } from '../../src/lib/link-audit/scoring/input';
import type { BasisEvidence, BasisProfile, BasisWebsite, EvidenceFieldStatus, ScoringBasis } from '../../src/lib/link-audit-evidence/scoring-basis';

/* Dados 100% FICTÍCIOS. A base é montada como DADO PURO (sem disco): o mapeador é puro e só depende da forma da base do I1. */
export const NOW = '2026-10-23T10:00:00.000Z';
export const AUDIT = 'auditoria-teste-0001';
export const OBSERVED = '2026-10-22T12:54:48.079Z';
export const OPERATOR_EMAIL = 'ana@empresa.com';
export const hash = (char: string): string => char.repeat(64);

export const CAPTURE_HASH = hash('a');
export const BODY_HASH = hash('b');
export const RAW_WEBSITE_HASH = hash('c');

export function captureEvidence(n = 1, over: Partial<BasisEvidence> = {}): BasisEvidence {
  return {
    ref: `capture:c${String(n).padStart(4, '0')}`,
    kind: 'CAPTURE',
    capture: n,
    revision: null,
    observedAt: OBSERVED,
    generatedAt: null,
    contentSha256: CAPTURE_HASH,
    bodySha256: BODY_HASH,
    superseded: false,
    legacy: false,
    origin: 'GOOGLE_NATIVE',
    provider: 'serper-maps',
    intermediary: true,
    ...over,
  };
}

export function reportEvidence(n = 1, revision = 1, over: Partial<BasisEvidence> = {}): BasisEvidence {
  return {
    ref: `report:c${String(n).padStart(4, '0')}-r${String(revision).padStart(4, '0')}`,
    kind: 'REPORT',
    capture: n,
    revision,
    observedAt: OBSERVED,
    generatedAt: '2026-10-22T13:00:00.000Z',
    contentSha256: hash('d'),
    bodySha256: null,
    superseded: false,
    legacy: false,
    origin: 'GOOGLE_NATIVE',
    provider: 'serper-maps',
    intermediary: true,
    ...over,
  };
}

export const ALL_VERIFIED: Readonly<Record<string, EvidenceFieldStatus>> = {
  'maps-name': 'VERIFIED',
  'maps-address': 'VERIFIED',
  'maps-phone': 'VERIFIED',
  'maps-hours': 'VERIFIED',
  'maps-category': 'VERIFIED',
  'maps-website': 'VERIFIED',
};

export function website(over: Partial<BasisWebsite> = {}): BasisWebsite {
  return {
    state: 'DERIVED',
    derived: 'https://padaria.example/?utm_medium=x&utm_source=x',
    utm: { level: 'COMPLETE', names: ['utm_medium', 'utm_source'] },
    unparsableReason: null,
    derivation: { rule: 'lumos-url-derive-v1', rawSha256: RAW_WEBSITE_HASH, sourceEvidence: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } },
    ...over,
  };
}

export const NO_UTM_WEBSITE = (): BasisWebsite => website({ derived: 'https://padaria.example/', utm: { level: 'NOT_OBSERVED', names: [] } });
export const PARTIAL_UTM_WEBSITE = (): BasisWebsite => website({ derived: 'https://padaria.example/?utm_source=x', utm: { level: 'PARTIAL', names: ['utm_source'] } });
export const UNPARSABLE_WEBSITE = (): BasisWebsite =>
  ({ state: 'UNPARSABLE', derived: null, utm: null, unparsableReason: 'NOT_HTTP', derivation: { rule: 'lumos-url-derive-v1', rawSha256: RAW_WEBSITE_HASH, sourceEvidence: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } } }) as BasisWebsite;

type AvailableProfile = Extract<BasisProfile, { state: 'AVAILABLE' }>;
export function richProfile(over: Partial<AvailableProfile> = {}): AvailableProfile {
  return {
    state: 'AVAILABLE',
    source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH },
    identity: { state: 'PROVEN', matchedBy: { cid: true, placeId: false }, expectedCidOrigin: 'LINK' },
    name: 'Padaria Exemplo',
    phone: '(62) 3000-9999',
    primaryCategory: 'Padaria',
    additionalCategories: ['Confeitaria'],
    address: { raw: 'Rua Fictícia, 100 - Cidade Exemplo - GO' },
    hoursRaw: 'segunda: 08:00–18:00',
    website: website(),
    reportEvidence: { ...ALL_VERIFIED },
    ...over,
  };
}

export interface BasisOverrides {
  readonly auditId?: string;
  readonly layout?: 'VERSIONED' | 'LEGACY';
  readonly evidences?: readonly BasisEvidence[];
  readonly profile?: BasisProfile;
  readonly reviews?: unknown;
}

/** Base com 1 captura, 1 relatório e o perfil rico. A parte informativa (M-4a) vem sempre preenchida, para provar que o mapeador a ignora. */
export function makeBasis(over: BasisOverrides = {}): ScoringBasis {
  const profile = over.profile ?? richProfile();
  return {
    version: 'scoring-basis-v1',
    auditId: over.auditId ?? AUDIT,
    layout: over.layout ?? 'VERSIONED',
    evidences: over.evidences ?? [captureEvidence(1), reportEvidence(1, 1)],
    profile,
    informational: {
      reviews:
        over.reviews !== undefined
          ? (over.reviews as never)
          : { rating: 4.9, ratingCount: 120, scoringUse: 'EXCLUDED_M4A', reason: 'informativo', source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH } },
    },
  };
}

export function unavailable(reason: 'NO_USABLE_CAPTURE' | 'BODY_UNREADABLE' | 'IDENTITY_NOT_CONFIRMED' | 'NOT_LOCATED' | 'AMBIGUOUS_IDENTITY'): BasisProfile {
  return { state: 'UNAVAILABLE', reason } as unknown as BasisProfile;
}

/* ---------------------------------------------------------------- decisões do operador (formato da 6A) */
const base = (id: string, recordedAt: string) => ({ id, operatorEmail: OPERATOR_EMAIL, recordedAt, justification: 'Confirmação feita pelo operador com base no perfil exibido.' });

export const c2Judgement = (id = 'op-0001', value: 'COMPATIBLE' | 'PARTIAL' | 'INCOMPATIBLE' = 'COMPATIBLE', recordedAt = '2026-10-22T13:10:00.000Z'): OperatorRecord => ({ ...base(id, recordedAt), kind: 'JUDGEMENT', subcriterionId: 'C2', value });
export const s4NotApplicable = (id = 'op-0002', recordedAt = '2026-10-22T13:20:00.000Z'): OperatorRecord => ({ ...base(id, recordedAt), kind: 'NOT_APPLICABLE', subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', causeEvidenceIds: [] });

export const COVERAGE_PERCENT = (halfPoints: number): number => halfPoints / 2;
