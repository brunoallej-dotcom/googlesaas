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
/** Dígitos demais (com ou sem separadores) parecem telefone; o rótulo curto não pode carregá-los. */
const MIN_PHONE_DIGITS = 8;
const looksLikePhone = (value: string): boolean => value.replace(/\D/g, '').length >= MIN_PHONE_DIGITS;

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

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const isoInstant = z.iso.datetime();
const auditId = z.string().regex(AUDIT_ID_PATTERN);
const entryRef = z.string().regex(/^(?:capture:c\d{4}|report:c\d{4}-r\d{4}|legacy-status:c\d{4})$/);
const shortLabel = z
  .string()
  .min(1)
  .max(MAX_LABEL_LENGTH)
  .refine((value) => !value.includes('@') && !looksLikePhone(value), 'rótulo não pode conter e-mail nem telefone');
const checkId = z.enum(CHECK_IDS);
const nullableName = z.string().min(1).max(MAX_NAME_LENGTH).nullable();

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
  .object({ maxHours: z.number().positive(), observedHours: z.number().nonnegative(), justification: z.string().min(1).max(MAX_NOTE_LENGTH).nullable() })
  .strict();
const deltaSchema = z.object({ added: z.array(entryRef), changed: z.array(entryRef), missing: z.array(entryRef) }).strict();

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

export const candidatePackageSchema = z
  .object({ ...packageBodyShape, delta: deltaSchema.nullable(), packageSha256: hex64, generatedAt: isoInstant })
  .strict()
  .superRefine((pkg, ctx) => {
    const issue = (message: string): void => void ctx.addIssue({ code: 'custom', message });
    const refs = pkg.entries.map((e) => e.ref);
    if (refs.some((ref, i) => i > 0 && (refs[i - 1] ?? '') >= ref)) issue('entries deve estar ordenado por ref e sem repetição');
    const hasLegacy = pkg.entries.some((e) => e.legacy);
    if (pkg.summary.containsLegacy !== hasLegacy) issue('containsLegacy não confere com entries');
    if (pkg.attestable === hasLegacy) issue('attestable deve ser o oposto de containsLegacy');
    if (pkg.summary.captures !== countRefs(pkg.entries, 'capture:')) issue('summary.captures não confere com entries');
    if (pkg.summary.reportRevisions !== countRefs(pkg.entries, 'report:')) issue('summary.reportRevisions não confere com entries');
    if (pkg.summary.artifacts !== countRefs(pkg.entries, 'legacy-status:')) issue('summary.artifacts não confere com entries');
    if (new Set(pkg.checks.map((c) => c.id)).size !== pkg.checks.length) issue('checks com id repetido');
  });
export type CandidatePackage = z.infer<typeof candidatePackageSchema>;

/** Os campos que entram no hash do pacote (§5.3). */
export const packageBodySchema = z.object(packageBodyShape).strict();
export type PackageBody = z.infer<typeof packageBodySchema>;

const evidenceRefSchema = z.object({ id: z.string().min(1).max(MAX_LABEL_LENGTH), sha256: hex64 }).strict();

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
    dossier: evidenceRefSchema,
    humanChecks: z.array(z.object({ id: checkId, result: z.enum(['PASS', 'FAIL']), note: z.string().max(MAX_NOTE_LENGTH) }).strict()),
    riskAcceptance: evidenceRefSchema.nullable(),
  })
  .strict();
export type Approval = z.infer<typeof approvalSchema>;
