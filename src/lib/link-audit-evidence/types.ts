import { z } from 'zod';

/*
 * Formato dos arquivos de evidência (Onda 5A). Cada arquivo é IMUTÁVEL, publicado de uma vez só e traz
 * `contentSha256` (SHA-256 do JSON canônico sem o próprio campo). O hash detecta alteração acidental ou
 * inconsistência; NÃO é assinatura criptográfica de autenticidade.
 */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;
/** Minúsculas (sistemas de arquivos do Windows ignoram caixa), 8 a 64 caracteres. */
export const AUDIT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
export const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;
export const MAX_AUX_BYTES = 2 * 1024 * 1024;

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const captureSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    kind: z.literal('LINK_AUDIT_CAPTURE'),
    auditId: z.string().regex(AUDIT_ID_PATTERN),
    captureNumber: z.number().int().positive().max(9999),
    methodologyVersion: z.string().min(1).max(60),
    collectedAt: iso,
    provider: z.literal('serper-maps'),
    request: z.object({ method: z.literal('POST'), url: z.string().max(300), body: z.record(z.string(), z.unknown()) }).strict(),
    response: z
      .object({
        httpStatus: z.number().int().min(100).max(599).nullable(),
        attempts: z.number().int().min(0).max(10),
        /** Texto UTF-8 decodificado da resposta, exatamente como recebido (nunca cabeçalhos). */
        bodyText: z.string().nullable(),
        bodySha256: hex64.nullable(),
        bytes: z.number().int().nonnegative(),
        creditsReportedByApi: z.number().nullable(),
        failure: z.string().max(400).nullable(),
        /** Avisos sobre o corpo guardado: a resposta paga NUNCA é descartada por suspeita de segredo. */
        flags: z.array(z.enum(['KEY_REDACTED', 'AUTH_PATTERN_IN_BODY'])).max(2).optional(),
      })
      .strict(),
    input: z.object({ snapshotId: z.string().min(1).max(100), originalLink: z.string().max(2048), identity: z.record(z.string(), z.unknown()) }).strict(),
    contentSha256: hex64,
  })
  .strict();
export type CaptureFile = z.infer<typeof captureSchema>;

export const siteSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    kind: z.literal('LINK_AUDIT_SITE_OBSERVATION'),
    auditId: z.string().regex(AUDIT_ID_PATTERN),
    captureNumber: z.number().int().positive().max(9999),
    captureSha256: hex64,
    observedAt: iso,
    outcome: z.record(z.string(), z.unknown()),
    contentSha256: hex64,
  })
  .strict();
export type SiteFile = z.infer<typeof siteSchema>;

export const reportSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    kind: z.literal('LINK_AUDIT_REPORT'),
    auditId: z.string().regex(AUDIT_ID_PATTERN),
    captureNumber: z.number().int().positive().max(9999),
    revision: z.number().int().positive().max(9999),
    methodologyVersion: z.string().min(1).max(60),
    generatedAt: iso,
    captureSha256: hex64,
    siteSha256: hex64.nullable(),
    report: z.record(z.string(), z.unknown()),
    contentSha256: hex64,
  })
  .strict();
export type ReportFile = z.infer<typeof reportSchema>;

export const pad = (n: number): string => String(n).padStart(4, '0');
export const captureName = (n: number): string => `c${pad(n)}.capture.json`;
export const siteName = (n: number): string => `c${pad(n)}.site.json`;
export const reportName = (n: number, r: number): string => `c${pad(n)}.report-r${pad(r)}.json`;
export const CAPTURE_FILE = /^c(\d{4})\.capture\.json$/;
export const SITE_FILE = /^c(\d{4})\.site\.json$/;
export const REPORT_FILE = /^c(\d{4})\.report-r(\d{4})\.json$/;
export const TEMP_FILE = /^\.tmp-[a-z0-9.-]+-[a-f0-9]{16}\.json$/;
