import { z } from 'zod';
import { companyIdentitySchema, criterionAssessmentSchema } from './audit';
import { canonicalJson, CANONICALIZATION_ID, sha256Hex } from './canonical';
import { evidenceSchema, formatZodIssues } from './evidence';
import { parseGoogleMapsLink, type MapsIdentifiers } from './maps-link';
import { CRITERIA, METHODOLOGY_VERSION } from './methodology';
import { validateLinkAudit } from './validate';

/**
 * `DADOS_TRAVADOS`: snapshot de EVIDÊNCIAS da Auditoria por Link (Fase 6, Onda 2).
 *
 * - NÃO é uma auditoria final: não tem pontos, índice, cobertura, classificação nem confiança
 *   (D3 pendente). Os schemas são `.strict()` e rejeitam qualquer campo desse tipo.
 * - Um snapshot fechado nunca é editado: mudar algo é gerar uma nova versão encadeada.
 * - Este módulo é puro (sem arquivo, rede ou relógio); a gravação fica em `snapshot-store.ts`.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_SNAPSHOT_VERSION = 9999;

export const HASH_DISCLAIMER =
  'O hash SHA-256 serve para detectar alteração acidental ou inconsistência do arquivo. Não é assinatura, não é criptografia e não protege contra adulteração deliberada: quem edita o arquivo também pode recalcular o hash.';

const hashHex = z.string().regex(/^[a-f0-9]{64}$/, 'hash deve ter 64 caracteres hexadecimais minúsculos');
const isoDate = z.string().datetime({ offset: true });
const text = z.string().trim().min(1).max(2000);
const versionNumber = z.number().int().min(1).max(MAX_SNAPSHOT_VERSION);

const resolvedLinkSchema = z
  .object({
    url: z.string().min(1).max(2048),
    resolvedAt: isoDate,
    /** Resolução ainda não implementada: o contrato só reserva o vínculo entre link curto e link resolvido. */
    method: z.literal('REDIRECT_CHAIN'),
  })
  .strict();

const linkSchema = z
  .object({
    originalLink: z.string().min(1).max(2048),
    resolved: resolvedLinkSchema.nullable(),
  })
  .strict();

const previousSchema = z.object({ version: versionNumber, hash: hashHex }).strict();

const draftShape = {
  snapshotId: z.string().regex(SNAPSHOT_ID_PATTERN, 'snapshotId inválido (8 a 64 caracteres: letras, números, _ e -)'),
  collectedAt: isoDate,
  frozenAt: isoDate,
  link: linkSchema,
  identity: companyIdentitySchema,
  evidences: z.array(evidenceSchema).max(500),
  criteria: z.array(criterionAssessmentSchema).length(CRITERIA.length),
  limitations: z.array(text).max(100),
};

/** Entrada para congelar: o que o operador/coleta entrega. Versão, cadeia e hash são atribuídos aqui. */
export const snapshotDraftSchema = z.object(draftShape).strict();
export type SnapshotDraft = z.infer<typeof snapshotDraftSchema>;

export const snapshotContentSchema = z
  .object({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    kind: z.literal('EVIDENCE_SNAPSHOT'),
    version: versionNumber,
    previous: previousSchema.nullable(),
    methodologyVersion: z.literal(METHODOLOGY_VERSION),
    indexStatus: z.literal('PENDING_METHODOLOGY'),
    ...draftShape,
  })
  .strict();
export type SnapshotContent = z.infer<typeof snapshotContentSchema>;

export const snapshotEnvelopeSchema = z
  .object({
    canonicalization: z.literal(CANONICALIZATION_ID),
    hash: z.object({ algorithm: z.literal('sha256'), value: hashHex }).strict(),
    content: snapshotContentSchema,
  })
  .strict();
export type LinkAuditSnapshot = z.infer<typeof snapshotEnvelopeSchema>;

export type SnapshotFailureCode = 'SCHEMA' | 'INVALID' | 'HASH_MISMATCH';
export type SnapshotResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SnapshotFailureCode; readonly issues: readonly string[] };

const IDENTIFIER_KEYS = ['cid', 'placeId', 'featureId'] as const;

export function sameProfileIdentifiers(a: MapsIdentifiers, b: MapsIdentifiers): boolean {
  return IDENTIFIER_KEYS.every((key) => a[key] === b[key]);
}

function afterOrEqual(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

/** Regras entre campos. Vazio = coerente. */
function crossCheck(content: SnapshotContent): string[] {
  const issues: string[] = [];
  const { link, identity } = content;

  const original = parseGoogleMapsLink(link.originalLink);
  let effectiveLink = link.originalLink;
  if (original.status === 'IDENTIFIED') {
    if (link.resolved !== null) issues.push('link.resolved: link direto (com identificador) não tem link resolvido.');
  } else if (original.status === 'RESOLUTION_PENDING') {
    if (link.resolved === null) {
      issues.push('link.resolved: link curto só pode ser congelado depois de resolvido e confirmado.');
    } else {
      effectiveLink = link.resolved.url;
    }
  } else {
    issues.push(`link.originalLink: link em "${original.status}" (${original.code}) não pode ser congelado.`);
  }

  const effective = parseGoogleMapsLink(effectiveLink);
  if (effective.status !== 'IDENTIFIED') {
    issues.push(`link efetivo em "${effective.status}" (${effective.code}): não identifica a empresa.`);
  } else if (!sameProfileIdentifiers(effective.identifiers, identity.identifiers)) {
    issues.push('identity.identifiers: não correspondem ao link efetivo (resolvido, se houver; senão o original).');
  }
  if (identity.originalLink !== link.originalLink) {
    issues.push('identity.originalLink: deve ser igual a link.originalLink.');
  }
  if (!identity.confirmation) {
    issues.push('identity.confirmation: o snapshot exige identidade confirmada pelo operador.');
  } else {
    if (link.resolved && !afterOrEqual(identity.confirmation.confirmedAt, link.resolved.resolvedAt)) {
      issues.push('identity.confirmation: a confirmação deve ser posterior à resolução do link.');
    }
    if (!afterOrEqual(content.frozenAt, identity.confirmation.confirmedAt)) {
      issues.push('frozenAt: não pode ser anterior à confirmação da identidade.');
    }
  }

  if (!afterOrEqual(content.frozenAt, content.collectedAt)) issues.push('frozenAt: não pode ser anterior a collectedAt.');
  for (const evidence of content.evidences) {
    if (!afterOrEqual(content.collectedAt, evidence.consultedAt)) {
      issues.push(`evidences.${evidence.id}: consultedAt é posterior a collectedAt.`);
    }
  }

  if (content.version === 1 && content.previous !== null) issues.push('previous: a versão 1 não tem versão anterior.');
  if (content.version > 1) {
    if (content.previous === null) issues.push('previous: versões após a primeira exigem a versão anterior.');
    else if (content.previous.version !== content.version - 1) issues.push('previous.version: deve ser version − 1.');
  }

  // Regras da Onda 1 (nativo × externo, critério × evidência, identidade confirmada), sem duplicá-las.
  const audit = validateLinkAudit({
    schemaVersion: 1,
    methodologyVersion: content.methodologyVersion,
    state: 'IDENTITY_CONFIRMED',
    identity: { ...identity, originalLink: effectiveLink },
    evidences: content.evidences,
    criteria: content.criteria,
    limitations: content.limitations,
    indexStatus: content.indexStatus,
  });
  if (!audit.ok) issues.push(...audit.issues.map((issue) => `auditoria: ${issue}`));
  return issues;
}

/** Hash SHA-256 (hexadecimal) do conteúdo canônico. */
export function snapshotContentHash(content: SnapshotContent): string {
  return sha256Hex(canonicalJson(content));
}

const UNREADABLE: SnapshotResult<never> = {
  ok: false,
  code: 'SCHEMA',
  issues: ['(raiz): estrutura ilegível (propriedade que lança exceção ou valor fora do contrato).'],
};

/** Monta, valida e sela uma versão. A versão e a cadeia vêm do armazenamento (ou do teste). Não lança. */
export function buildSnapshot(
  draft: unknown,
  chain: { readonly version: number; readonly previous: { readonly version: number; readonly hash: string } | null },
): SnapshotResult<LinkAuditSnapshot> {
  try {
    return buildSnapshotUnsafe(draft, chain);
  } catch {
    return UNREADABLE;
  }
}

function buildSnapshotUnsafe(
  draft: unknown,
  chain: { readonly version: number; readonly previous: { readonly version: number; readonly hash: string } | null },
): SnapshotResult<LinkAuditSnapshot> {
  const parsedDraft = snapshotDraftSchema.safeParse(draft);
  if (!parsedDraft.success) return { ok: false, code: 'SCHEMA', issues: formatZodIssues(parsedDraft.error) };

  const parsedContent = snapshotContentSchema.safeParse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: 'EVIDENCE_SNAPSHOT',
    version: chain.version,
    previous: chain.previous,
    methodologyVersion: METHODOLOGY_VERSION,
    indexStatus: 'PENDING_METHODOLOGY',
    ...parsedDraft.data,
  });
  if (!parsedContent.success) return { ok: false, code: 'SCHEMA', issues: formatZodIssues(parsedContent.error) };

  const issues = crossCheck(parsedContent.data);
  if (issues.length > 0) return { ok: false, code: 'INVALID', issues };

  try {
    const canonical = canonicalJson(parsedContent.data);
    const content = JSON.parse(canonical) as SnapshotContent;
    return {
      ok: true,
      value: {
        canonicalization: CANONICALIZATION_ID,
        hash: { algorithm: 'sha256', value: sha256Hex(canonical) },
        content,
      },
    };
  } catch (error) {
    return { ok: false, code: 'SCHEMA', issues: [error instanceof Error ? error.message : 'conteúdo não canonicalizável'] };
  }
}

/**
 * Verifica um snapshot lido de qualquer lugar: formato, hash recalculado e coerência entre campos.
 * Um hash divergente indica alteração ou inconsistência (ver HASH_DISCLAIMER).
 */
export function verifySnapshot(raw: unknown): SnapshotResult<LinkAuditSnapshot> {
  try {
    return verifySnapshotUnsafe(raw);
  } catch {
    return UNREADABLE;
  }
}

function verifySnapshotUnsafe(raw: unknown): SnapshotResult<LinkAuditSnapshot> {
  const parsed = snapshotEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'SCHEMA', issues: formatZodIssues(parsed.error) };

  let canonical: string;
  try {
    canonical = canonicalJson(parsed.data.content);
  } catch (error) {
    return { ok: false, code: 'SCHEMA', issues: [error instanceof Error ? error.message : 'conteúdo não canonicalizável'] };
  }
  const recomputed = sha256Hex(canonical);
  if (recomputed !== parsed.data.hash.value) {
    return {
      ok: false,
      code: 'HASH_MISMATCH',
      issues: [`hash gravado ${parsed.data.hash.value} difere do recalculado ${recomputed}.`],
    };
  }

  const issues = crossCheck(parsed.data.content);
  if (issues.length > 0) return { ok: false, code: 'INVALID', issues };
  return {
    ok: true,
    value: { ...parsed.data, content: JSON.parse(canonical) as SnapshotContent },
  };
}

/** Texto gravado em disco: o próprio envelope em JSON canônico, com quebra de linha final. */
export function serializeSnapshot(snapshot: LinkAuditSnapshot): string {
  return `${canonicalJson(snapshot)}\n`;
}
