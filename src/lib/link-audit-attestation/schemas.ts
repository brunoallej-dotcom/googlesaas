import { z } from 'zod';
import { AUDIT_ID_PATTERN } from '../link-audit-evidence/types';

/** Formatos do P1 (spec §5.3 e §5.4). Todos estritos: campo desconhecido é recusa, nunca ignorado. */
export const PACKAGE_KIND = 'LINK_AUDIT_P1_CANDIDATE' as const;
export const APPROVAL_KIND = 'LINK_AUDIT_P1_APPROVAL' as const;
export const ATTESTATION_SCHEMA_VERSION = 1 as const;
export const MAX_PACKAGE_ENTRIES = 2000;

const MAX_LABEL_LENGTH = 64;
const MAX_NOTE_LENGTH = 280;
const MAX_NAME_LENGTH = 200;
/** Dígitos demais seguidos (ignorando separadores) parecem telefone. Oito dígitos (ex.: `OP-20261023`) ainda é identificador. */
const PHONE_DIGIT_RUN = 9;
/**
 * O que separa grupos de dígitos de um telefone. Inclui todo separador que os próprios rótulos e o `dossier.id` aceitam (`_`, `-`, `.`, espaço:
 * `119_1234_5678` é telefone) e, nas notas de texto livre, `/` (`119/1234/5678`). Revisão da W4.1, notas no §5.5.1 da spec.
 */
const PHONE_SEPARATORS = /[ \-.()_\/]/gu;
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SHORT_ID_ALLOWLIST = /^[\p{L}\p{N} ._-]+$/u;

/** Verdadeiro se, depois de NFKC, o texto não carrega e-mail (inclusive `＠` de largura total), telefone, controle nem bidi. */
export function isSafeText(value: string): boolean {
  const text = value.normalize('NFKC');
  if (CONTROL_OR_BIDI.test(text) || text.includes('@')) return false;
  return !new RegExp(`\\p{Nd}{${PHONE_DIGIT_RUN},}`, 'u').test(text.replace(PHONE_SEPARATORS, ''));
}
export const hasNoControlChars = (value: string): boolean => !CONTROL_OR_BIDI.test(value.normalize('NFKC'));

export const CHECK_IDS = [
  'INTEGRITY_LOCAL',
  'COLLECTOR_HASH_MATCHES',
  'COLLECTION_GAP_WITHIN_LIMIT',
  'HTTP_2XX_AND_COLLECTED_AT',
  'REPORT_REPRODUCES',
  'AUTHORIZATION_CONSUMED',
  'PROVIDER_PANEL_CREDITS',
  'URL_QUERY_COHERENCE',
] as const;
/** Spec §5.3.1: não mecanizáveis offline, sempre `NOT_EXECUTED` no pacote; o resultado humano vai em `approval.json`. */
const NON_MECHANICAL_CHECK_IDS = ['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE'] as const;
/** O que `approval.json` pode atestar: os não mecanizáveis e `REPORT_REPRODUCES` (enquanto a viabilidade não for confirmada, §5.3.1). */
export const HUMAN_CHECK_IDS = [...NON_MECHANICAL_CHECK_IDS, 'REPORT_REPRODUCES'] as const;

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** Precisão fixa de milissegundos em UTC: assim a ordem lexicográfica é a ordem cronológica (sem `Date` neste módulo puro). */
export const isoInstant = z.iso.datetime({ precision: 3 });
export const auditId = z.string().regex(AUDIT_ID_PATTERN);
export const entryRef = z.string().regex(/^(?:capture:c\d{4}|report:c\d{4}-r\d{4}|legacy-status:c\d{4})$/);
/** Rótulo/identificador curto: lista de permissão E texto seguro (NFKC). */
export const shortLabel = z.string().min(1).max(MAX_LABEL_LENGTH).regex(SHORT_ID_ALLOWLIST).refine(isSafeText, 'não pode conter e-mail, telefone nem caracteres de controle');
const safeNote = z.string().max(MAX_NOTE_LENGTH).refine(isSafeText, 'não pode conter e-mail, telefone nem caracteres de controle');
const checkId = z.enum(CHECK_IDS);
const humanCheckId = z.enum(HUMAN_CHECK_IDS);
const nullableName = z.string().min(1).max(MAX_NAME_LENGTH).refine(hasNoControlChars, 'caractere de controle').nullable();

const entrySchema = z.object({ ref: entryRef, contentSha256: hex64, legacy: z.boolean() }).strict();

const summarySchema = z
  .object({
    company: z.object({ name: nullableName, city: nullableName, stateCode: z.string().regex(/^[A-Z]{2}$/).nullable() }).strict(),
    firstCollectedAt: isoInstant,
    lastCollectedAt: isoInstant,
    captures: z.number().int().nonnegative(),
    reportRevisions: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    containsLegacy: z.boolean(),
  })
  .strict();

const checkSchema = z.object({ id: checkId, status: z.enum(['PASS', 'FAIL', 'NOT_EXECUTED']) }).strict();
const gapSchema = z
  .object({ maxHours: z.number().positive(), observedHours: z.number().int().nonnegative(), justification: safeNote.min(1).nullable() })
  .strict();
const refList = z.array(entryRef).max(MAX_PACKAGE_ENTRIES);
const deltaSchema = z.object({ added: refList, changed: refList, missing: refList }).strict();

/** O corpo coberto por `packageSha256` (tudo menos `delta`, `packageSha256` e `generatedAt`). */
const packageBodyShape = {
  schemaVersion: z.literal(ATTESTATION_SCHEMA_VERSION),
  kind: z.literal(PACKAGE_KIND),
  auditId,
  layout: z.enum(['VERSIONED', 'LEGACY']),
  attestable: z.boolean(),
  summary: summarySchema,
  integrity: z.object({ status: z.literal('OK'), algorithm: z.literal('SHA-256'), checkedFiles: z.number().int().nonnegative() }).strict(),
  checks: z.array(checkSchema),
  /** `null` quando não há captura nova a medir (pacote legado, não atestável). Ambiguidade da spec resolvida de forma conservadora. */
  gap: gapSchema.nullable(),
  entries: z.array(entrySchema).min(1).max(MAX_PACKAGE_ENTRIES),
};

const countRefs = (entries: ReadonlyArray<{ ref: string }>, prefix: string): number => entries.filter((e) => e.ref.startsWith(prefix)).length;

/** Coerência do CORPO (a mesma para o esquema do pacote e para o hash: "hash consistente" implica "corpo válido"). */
function checkBodyCoherence(pkg: z.infer<typeof packageBodySchemaBase>, ctx: z.RefinementCtx): void {
  const issue = (message: string): void => void ctx.addIssue({ code: 'custom', message });
  const refs = pkg.entries.map((e) => e.ref);
  if (refs.some((ref, i) => i > 0 && (refs[i - 1] ?? '') >= ref)) issue('entries deve estar ordenado por ref e sem repetição');
  const hasLegacy = pkg.entries.some((e) => e.legacy);
  if (pkg.summary.containsLegacy !== hasLegacy) issue('containsLegacy não confere com entries');
  if (pkg.attestable === hasLegacy) issue('attestable deve ser o oposto de containsLegacy');
  if ((pkg.layout === 'LEGACY') !== pkg.summary.containsLegacy) issue('layout LEGACY deve coincidir com containsLegacy');
  if (pkg.attestable && pkg.gap === null) issue('pacote atestável exige gap');
  if (pkg.summary.firstCollectedAt > pkg.summary.lastCollectedAt) issue('firstCollectedAt depois de lastCollectedAt');
  if (pkg.summary.captures !== countRefs(pkg.entries, 'capture:')) issue('summary.captures não confere com entries');
  if (pkg.summary.reportRevisions !== countRefs(pkg.entries, 'report:')) issue('summary.reportRevisions não confere com entries');
  if (pkg.summary.artifacts !== countRefs(pkg.entries, 'legacy-status:')) issue('summary.artifacts não confere com entries');
  checkMechanicalChecks(pkg.checks, issue);
}

/** Spec §5.3.1: o `export` grava TODAS as verificações da tabela, cada uma uma vez; as três não mecanizáveis ficam sempre `NOT_EXECUTED`. */
function checkMechanicalChecks(checks: ReadonlyArray<{ id: string; status: string }>, issue: (message: string) => void): void {
  for (const id of CHECK_IDS) if (checks.filter((c) => c.id === id).length !== 1) issue(`verificação ${id} deve aparecer exatamente uma vez`);
  for (const id of NON_MECHANICAL_CHECK_IDS) if (checks.some((c) => c.id === id && c.status !== 'NOT_EXECUTED')) issue(`verificação ${id} não é mecanizável: sempre NOT_EXECUTED`);
}

const packageBodySchemaBase = z.object(packageBodyShape).strict();
/** Os campos que entram no hash do pacote (§5.3), já com a coerência. */
export const packageBodySchema = packageBodySchemaBase.superRefine(checkBodyCoherence);
export type PackageBody = z.infer<typeof packageBodySchema>;

export const candidatePackageSchema = z
  .object({ ...packageBodyShape, delta: deltaSchema.nullable(), packageSha256: hex64, generatedAt: isoInstant })
  .strict()
  .superRefine(checkBodyCoherence);
export type CandidatePackage = z.infer<typeof candidatePackageSchema>;

const evidenceRefSchema = z.object({ id: shortLabel, sha256: hex64 }).strict();
/**
 * `dossier.id` no padrão do contrato do verificador `v2` (§2 e O7; spec §5.5.1 item 3) E texto seguro (sem sequência de telefone): tudo o que a
 * aprovação aceita o manifesto `v2` também aceita. Cópia deliberada do padrão (o verificador não o exporta e este esquema não importa o
 * verificador); a paridade é travada por teste contra `buildEvidenceSealBodyV2`.
 */
export const DOSSIER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const dossierRefSchema = z
  .object({ id: z.string().regex(DOSSIER_ID_PATTERN).refine(isSafeText, 'não pode parecer telefone'), sha256: hex64 })
  .strict();

export const approvalSchema = z
  .object({
    schemaVersion: z.literal(ATTESTATION_SCHEMA_VERSION),
    kind: z.literal(APPROVAL_KIND),
    auditId,
    packageSha256: hex64,
    /** Qualquer outro valor é recusa: o literal impede que um `REJECTED` passe como aprovação. */
    decision: z.literal('APPROVED'),
    approvedBy: shortLabel,
    operator: shortLabel,
    approvedAt: isoInstant,
    dossier: dossierRefSchema,
    /** Cruzar com o pacote ("resultado humano só para verificação NOT_EXECUTED") é do `sign` (`sign-core.ts`, W4.1), não deste esquema. */
    humanChecks: z.array(z.object({ id: humanCheckId, result: z.enum(['PASS', 'FAIL']), note: safeNote }).strict()).max(HUMAN_CHECK_IDS.length),
    riskAcceptance: evidenceRefSchema.nullable(),
  })
  .strict()
  .refine((approval) => new Set(approval.humanChecks.map((c) => c.id)).size === approval.humanChecks.length, { message: 'humanChecks com id repetido', path: ['humanChecks'] });
export type Approval = z.infer<typeof approvalSchema>;
