import { z } from 'zod';
import { evidenceSchema, EVIDENCE_STATUSES, type ValidationResult, formatZodIssues } from './evidence';
import type { MapsIdentifiers, MapsLinkParseResult } from './maps-link';
import { CRITERIA, CRITERION_IDS, METHODOLOGY_VERSION } from './methodology';

/**
 * Contrato da Auditoria por Link (Fase 6, Onda 1).
 *
 * Nenhum tipo aqui carrega pontos, índice, cobertura ou classificação: a régua de pontuação (D3) ainda
 * não foi aprovada. `indexStatus` fica sempre `PENDING_METHODOLOGY`. Os schemas são `.strict()`, então
 * qualquer campo de pontuação é rejeitado.
 */

export const AUDIT_STATES = [
  'LINK_INVALID',
  'LINK_REJECTED',
  'LINK_UNSUPPORTED',
  'RESOLUTION_PENDING',
  'IDENTITY_AMBIGUOUS',
  'IDENTITY_PENDING_CONFIRMATION',
  'IDENTITY_CONFIRMED',
] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

const identifiersSchema = z
  .object({
    cid: z.string().regex(/^\d{1,20}$/).optional(),
    placeId: z.string().regex(/^[A-Za-z0-9_-]{20,255}$/).optional(),
    featureId: z.string().regex(/^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/).optional(),
  })
  .strict()
  .refine((ids) => ids.cid !== undefined || ids.placeId !== undefined || ids.featureId !== undefined, {
    message: 'A identidade exige ao menos um identificador (cid, placeId ou featureId); nome e coordenadas não identificam.',
  });

export const identityConfirmationSchema = z
  .object({
    confirmedBy: z.string().trim().min(1).max(120),
    confirmedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type IdentityConfirmation = z.infer<typeof identityConfirmationSchema>;

export const companyIdentitySchema = z
  .object({
    originalLink: z.string().min(1).max(2048),
    identifiers: identifiersSchema,
    /** Dados descritivos coletados; nunca são usados para identificar a empresa. */
    name: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    stateCode: z.string().regex(/^[A-Z]{2}$/).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type CompanyIdentity = z.infer<typeof companyIdentitySchema>;

export const criterionAssessmentSchema = z
  .object({
    criterionId: z.enum(CRITERION_IDS),
    status: z.enum(EVIDENCE_STATUSES),
    evidenceIds: z.array(z.string().min(1).max(64)).max(100),
  })
  .strict();
export type CriterionAssessment = z.infer<typeof criterionAssessmentSchema>;

export const linkAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    methodologyVersion: z.literal(METHODOLOGY_VERSION),
    state: z.enum(AUDIT_STATES),
    identity: companyIdentitySchema.nullable(),
    evidences: z.array(evidenceSchema).max(500),
    criteria: z.array(criterionAssessmentSchema).length(CRITERIA.length),
    limitations: z.array(z.string().trim().min(1).max(2000)).max(100),
    indexStatus: z.literal('PENDING_METHODOLOGY'),
  })
  .strict();
export type LinkAudit = z.infer<typeof linkAuditSchema>;

function sameIdentifiers(a: MapsIdentifiers, b: MapsIdentifiers): boolean {
  return a.cid === b.cid && a.placeId === b.placeId && a.featureId === b.featureId;
}

/** Estado da auditoria a partir do resultado do parser e da identidade (pura, sem rede). */
export function deriveAuditState(parse: MapsLinkParseResult, identity: CompanyIdentity | null): AuditState {
  switch (parse?.status) {
    case 'INVALID':
      return 'LINK_INVALID';
    case 'REJECTED':
      return 'LINK_REJECTED';
    case 'UNSUPPORTED':
      return 'LINK_UNSUPPORTED';
    case 'RESOLUTION_PENDING':
      return 'RESOLUTION_PENDING';
    case 'AMBIGUOUS':
      return 'IDENTITY_AMBIGUOUS';
    case 'IDENTIFIED':
      return identity?.confirmation && sameIdentifiers(identity.identifiers, parse.identifiers)
        ? 'IDENTITY_CONFIRMED'
        : 'IDENTITY_PENDING_CONFIRMATION';
    default:
      return 'LINK_INVALID'; // entrada ausente ou fora do contrato
  }
}

/** Identidade ainda sem confirmação, criada somente a partir de um link com identificador. */
export function identityFromParse(parse: MapsLinkParseResult): CompanyIdentity | null {
  if (parse?.status !== 'IDENTIFIED') return null;
  return {
    originalLink: parse.originalInput,
    identifiers: { ...parse.identifiers },
  };
}

/**
 * Confirmação explícita do operador. Só vale para link com identificador; nome parecido nunca confirma.
 */
export function confirmIdentity(
  parse: MapsLinkParseResult,
  confirmation: unknown,
): ValidationResult<CompanyIdentity> {
  if (parse?.status !== 'IDENTIFIED') {
    const found = parse ? `${parse.status} (${parse.code})` : 'ausente';
    return { ok: false, issues: [`Identidade não confirmável: o link está em ${found}.`] };
  }
  const parsedConfirmation = identityConfirmationSchema.safeParse(confirmation);
  if (!parsedConfirmation.success) {
    return { ok: false, issues: formatZodIssues(parsedConfirmation.error, 'confirmation.') };
  }
  const base = identityFromParse(parse);
  if (!base) return { ok: false, issues: ['Identidade ausente.'] };
  return { ok: true, value: { ...base, confirmation: parsedConfirmation.data } };
}

/** Rascunho inicial: todos os critérios "Não verificado" e nenhuma evidência. */
export function createDraftLinkAudit(parse: MapsLinkParseResult): LinkAudit {
  const identity = identityFromParse(parse);
  return {
    schemaVersion: 1,
    methodologyVersion: METHODOLOGY_VERSION,
    state: deriveAuditState(parse, identity),
    identity,
    evidences: [],
    criteria: CRITERIA.map((criterion) => ({
      criterionId: criterion.id,
      status: 'NOT_VERIFIED' as const,
      evidenceIds: [],
    })),
    limitations: [],
    indexStatus: 'PENDING_METHODOLOGY',
  };
}
