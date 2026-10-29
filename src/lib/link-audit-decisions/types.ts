import { z } from 'zod';
import { operatorRecordSchema, type OperatorRecord } from '../link-audit/scoring/input';

/*
 * Formato dos arquivos de decisão humana (Fase 6, Onda 6B). Cada arquivo `dNNNN.json` é IMUTÁVEL, publicado de uma
 * vez só, e encadeado ao anterior (`prevSha256`). O hash detecta alteração acidental ou inconsistência; NÃO é
 * assinatura criptográfica. A perda do FIM do histórico (que a cadeia sozinha não vê) é detectada pelas ÂNCORAS, recibos
 * `aNNNN.json` em pasta separada, e pelo `expectedHead` exigido nas escritas (ADR `onda6b-adr-ancora-externa.md`).
 *
 * O registro do operador é o contrato da Onda 6A (`operatorRecordSchema`), SEM os campos que só o servidor define
 * (`id`, `operatorEmail`, `recordedAt`). Nenhum valor de pontuação existe aqui: pontos são sempre calculados pelo motor.
 */
export const DECISION_SCHEMA_VERSION = 1 as const;
export const DECISION_FILE_KIND = 'LINK_AUDIT_OPERATOR_DECISION' as const;
/** Igual ao `AUDIT_ID_PATTERN` do serviço de evidências (um teste confere a igualdade). */
export const AUDIT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
export const DECISION_ID_PATTERN = /^op-\d{4}$/;
export const MAX_SEQ = 9999;
/** Igual ao teto de `operatorRecords` da entrada do motor (6A). */
export const MAX_EFFECTIVE_RECORDS = 200;
export const MAX_ENTRY_BYTES = 64 * 1024;
/** As últimas entradas do histórico só aceitam REVOGAÇÕES: uma auditoria nunca fica "congelada" sem poder revogar. */
export const RESERVED_FOR_REVOCATIONS = 100;
export const INTEGRITY_NOTE =
  'O hash SHA-256 detecta alteração acidental ou inconsistência; não é assinatura. A remoção ou o retrocesso do histórico é detectado pelas âncoras (pasta separada) e pelo expectedHead; quem altera as DUAS pastas ao mesmo tempo (ex.: root na VPS) não é detectado.';

export const pad = (n: number): string => String(n).padStart(4, '0');
export const entryFileName = (seq: number): string => `d${pad(seq)}.json`;
export const ENTRY_FILE = /^d(\d{4})\.json$/;
export const anchorFileName = (seq: number): string => `a${pad(seq)}.json`;
export const ANCHOR_FILE = /^a(\d{4})\.json$/;
export const decisionIdFor = (seq: number): string => `op-${pad(seq)}`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
/** Mesma regra de e-mail do contrato da 6A (exige ponto depois do `@`). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z.string().max(254).regex(EMAIL_PATTERN);
const reason = z.string().trim().min(20, 'a justificativa exige pelo menos 20 caracteres').max(2000);
export const decisionIdSchema = z.string().regex(DECISION_ID_PATTERN);
const captureNumber = z.number().int().min(1).max(MAX_SEQ);

/* ------------------------------------------------------------------ registro do operador (contrato da 6A, sem campos do servidor) */

const SERVER_FIELDS = { id: true, operatorEmail: true, recordedAt: true } as const;
export type ClientRecord = DistributiveOmit<OperatorRecord, 'id' | 'operatorEmail' | 'recordedAt'>;

/**
 * Derivado DIRETAMENTE de `operatorRecordSchema` (nenhuma regra copiada): mesmas variantes, mesmos campos, `strict`.
 * Um teste confere que `id`, `operatorEmail` e `recordedAt` enviados pelo cliente são recusados.
 */
export const clientRecordSchema = z.discriminatedUnion(
  'kind',
  (operatorRecordSchema.options as unknown as Array<z.ZodObject>).map((option) => option.omit(SERVER_FIELDS)) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<ClientRecord>;

/* ------------------------------------------------------------------ arquivos de decisão */

const basisSchema = z
  .object({
    /** Número da captura mais recente existente quando a decisão foi tomada (nunca valores de pontuação). */
    capture: captureNumber.nullable(),
    report: z.object({ capture: captureNumber, revision: captureNumber }).strict().nullable(),
    collectedAt: z.string().max(40).nullable(),
  })
  .strict();
export type DecisionBasis = z.infer<typeof basisSchema>;

const common = {
  schemaVersion: z.literal(DECISION_SCHEMA_VERSION),
  kind: z.literal(DECISION_FILE_KIND),
  auditId: z.string().regex(AUDIT_ID_PATTERN),
  seq: z.number().int().min(1).max(MAX_SEQ),
  recordedAt: iso,
  recordedBy: email,
  prevSha256: hex64.nullable(),
  contentSha256: hex64,
};

export const recordEntrySchema = z
  .object({
    ...common,
    action: z.literal('RECORD'),
    decisionId: decisionIdSchema,
    record: clientRecordSchema,
    /** Decisão ativa que esta substitui (continua no histórico, marcada como substituída). */
    supersedes: decisionIdSchema.nullable(),
    basis: basisSchema,
  })
  .strict();

export const revokeEntrySchema = z
  .object({
    ...common,
    action: z.literal('REVOKE'),
    revokes: decisionIdSchema,
    reason,
  })
  .strict();

export const decisionEntrySchema = z.discriminatedUnion('action', [recordEntrySchema, revokeEntrySchema]);
export type RecordEntry = z.infer<typeof recordEntrySchema>;
export type RevokeEntry = z.infer<typeof revokeEntrySchema>;
export type DecisionEntry = RecordEntry | RevokeEntry;
export type DecisionDraft = DistributiveOmit<DecisionEntry, 'seq' | 'prevSha256' | 'contentSha256'>;

/* ------------------------------------------------------------------ corpos aceitos pela API */

/** O head que o operador viu (`null` = histórico vazio). Obrigatório em toda escrita: detecta visão velha e retrocesso. */
export const headSchema = z.object({ seq: captureNumber, sha256: hex64 }).strict();
export type ExpectedHead = z.infer<typeof headSchema>;
export const createBodySchema = z.object({ record: clientRecordSchema, supersedes: decisionIdSchema.optional(), expectedHead: headSchema.nullable() }).strict();
export const revokeBodySchema = z.object({ revokes: decisionIdSchema, reason, expectedHead: headSchema.nullable() }).strict();
export type CreateBody = z.infer<typeof createBodySchema>;
export type RevokeBody = z.infer<typeof revokeBodySchema>;

/* ------------------------------------------------------------------ âncoras (pasta separada; ver o ADR da âncora externa) */

export const ANCHOR_FILE_KIND = 'LINK_AUDIT_DECISION_ANCHOR' as const;
export const anchorSchema = z
  .object({
    schemaVersion: z.literal(DECISION_SCHEMA_VERSION),
    kind: z.literal(ANCHOR_FILE_KIND),
    auditId: z.string().regex(AUDIT_ID_PATTERN),
    /** Âncora do arquivo `dNNNN.json` de mesmo número. */
    seq: z.number().int().min(1).max(MAX_SEQ),
    /** `contentSha256` do arquivo de decisão `seq` no momento em que ele foi gravado. */
    headSha256: hex64,
    anchoredAt: iso,
    prevAnchorSha256: hex64.nullable(),
    contentSha256: hex64,
  })
  .strict();
export type AnchorFile = z.infer<typeof anchorSchema>;
export type AnchorDraft = Omit<AnchorFile, 'contentSha256'>;
