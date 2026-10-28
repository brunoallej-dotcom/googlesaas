import { z } from 'zod';
import { assertSafeUrlShape, UnsafeUrlError } from '../url-safety';
import { isGoogleMapsHost, parseGoogleMapsLink, type MapsIdentifiers } from './maps-link';
import { isSanitizedUrl } from './url-redaction';
import {
  CRITERION_IDS,
  isNativeOnlyAttribute,
  NATIVE_ATTRIBUTE_CRITERION,
  requiresGoogleNativeProof,
} from './methodology';

/**
 * Modelo de evidência da Auditoria por Link (Fase 6, Onda 1).
 *
 * - Cada fato guarda origem, fonte, momento da consulta e status.
 * - Site, redes sociais e terceiros NÃO comprovam atributos nativos do Google (manual §3): para esses
 *   atributos, evidência externa só pode ser "Não verificado".
 * - "Não verificado" não é zero nem ausência. "Não encontrado" é só observação de coleta: exige fonte
 *   adequada, data e o escopo da busca. Nenhum status tem pontuação associada.
 * - Textos coletados são dado: nunca são interpretados como instrução.
 */

export const EVIDENCE_STATUSES = ['VERIFIED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_FOUND'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_STATUS_LABELS_PT: Readonly<Record<EvidenceStatus, string>> = {
  VERIFIED: 'Verificado',
  PARTIAL: 'Parcial',
  NOT_VERIFIED: 'Não verificado',
  NOT_FOUND: 'Não encontrado',
};

export const EVIDENCE_ORIGINS = [
  'GOOGLE_NATIVE',
  'OFFICIAL_SITE',
  'OFFICIAL_SOCIAL',
  'THIRD_PARTY',
  'INSTITUTIONAL',
] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

const MAX_TEXT = 2000;
const text = z.string().trim().min(1).max(MAX_TEXT);

/** Identificadores do perfil contidos em uma fonte do Google Maps; `null` se o link não identifica um perfil. */
export function googleNativeSourceIdentifiers(sourceUrl: string): MapsIdentifiers | null {
  const parsed = parseGoogleMapsLink(sourceUrl);
  return parsed.status === 'IDENTIFIED' ? parsed.identifiers : null;
}

export const evidenceSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'id inválido'),
    attribute: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/, 'attribute inválido (use snake_case minúsculo)'),
    criterionId: z.enum(CRITERION_IDS),
    claim: text,
    status: z.enum(EVIDENCE_STATUSES),
    origin: z.enum(EVIDENCE_ORIGINS),
    sourceUrl: z.string().trim().max(2048).optional(),
    consultedAt: z.string().datetime({ offset: true }),
    limitation: text.optional(),
    searchScope: text.optional(),
    nativeContext: text.optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    let sourceHost: string | null = null;
    if (evidence.sourceUrl !== undefined) {
      try {
        sourceHost = assertSafeUrlShape(evidence.sourceUrl).hostname;
      } catch (error) {
        fail('sourceUrl', error instanceof UnsafeUrlError ? error.message : 'sourceUrl inválida');
      }
      if (!isSanitizedUrl(evidence.sourceUrl)) {
        fail(
          'sourceUrl',
          'a fonte não pode ter credenciais, fragmento nem parâmetros de consulta fora dos identificadores do perfil (tokens e chaves não são guardados).',
        );
      }
    }

    const needsSource = evidence.status !== 'NOT_VERIFIED';
    if (needsSource && evidence.sourceUrl === undefined) {
      fail('sourceUrl', `status ${evidence.status} exige fonte identificável (sourceUrl).`);
    }
    if ((evidence.status === 'PARTIAL' || evidence.status === 'NOT_VERIFIED') && evidence.limitation === undefined) {
      fail('limitation', `status ${evidence.status} exige a limitação que impediu a verificação completa.`);
    }
    if (evidence.status === 'NOT_FOUND' && evidence.searchScope === undefined) {
      fail('searchScope', 'NOT_FOUND exige o escopo da busca (onde e como se procurou).');
    }
    if (evidence.status !== 'NOT_FOUND' && evidence.searchScope !== undefined) {
      fail('searchScope', 'searchScope só é permitido em NOT_FOUND (inacessível não é ausente).');
    }
    if (evidence.status !== 'NOT_VERIFIED' && evidence.nativeContext !== undefined) {
      fail('nativeContext', 'nativeContext (contexto externo) só é permitido em NOT_VERIFIED.');
    }

    if (evidence.origin === 'GOOGLE_NATIVE' && sourceHost !== null) {
      if (!isGoogleMapsHost(sourceHost)) {
        fail('sourceUrl', 'origem GOOGLE_NATIVE exige fonte em host do Google Maps.');
      } else if (googleNativeSourceIdentifiers(evidence.sourceUrl ?? '') === null) {
        fail(
          'sourceUrl',
          'origem GOOGLE_NATIVE exige link do perfil no Google Maps com identificador (cid, placeId ou featureId); busca, link curto e link genérico não servem.',
        );
      }
    }
    const mappedCriterion = isNativeOnlyAttribute(evidence.attribute)
      ? NATIVE_ATTRIBUTE_CRITERION[evidence.attribute]
      : undefined;
    if (mappedCriterion !== undefined && mappedCriterion !== evidence.criterionId) {
      fail('criterionId', `"${evidence.attribute}" pertence ao critério ${mappedCriterion}, não a ${evidence.criterionId}.`);
    }
    if (
      requiresGoogleNativeProof(evidence.attribute, evidence.criterionId) &&
      evidence.origin !== 'GOOGLE_NATIVE' &&
      evidence.status !== 'NOT_VERIFIED'
    ) {
      fail(
        'status',
        `"${evidence.attribute}" (critério ${evidence.criterionId}) só pode ser comprovado pelo próprio perfil do Google; fonte externa permite apenas NOT_VERIFIED.`,
      );
    }
  });

export type Evidence = z.infer<typeof evidenceSchema>;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

export function formatZodIssues(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
}

export function validateEvidence(input: unknown): ValidationResult<Evidence> {
  const parsed = evidenceSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatZodIssues(parsed.error) };
}
