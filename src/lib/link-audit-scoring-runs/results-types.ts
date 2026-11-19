import { z } from 'zod';
import { originProofSchema } from '../link-audit-origin';
import type { ReceiptShape } from '../link-audit-storage';
import { ENGINE_AUDIT_ID, STORE_AUDIT_ID } from './audit-id-alias';

/*
 * Formato dos RESULTADOS FINALIZADOS (Onda 6C, I4). Cada arquivo `sNNNN.json` é IMUTÁVEL, publicado de uma vez só, selado
 * (`contentSha256` = SHA-256 do JSON canônico sem o próprio campo) e ENCADEADO ao anterior (`prevSha256`). Cada resultado tem um
 * recibo `aNNNN.json` em pasta SEPARADA (mesmo protocolo das decisões da 6B, reutilizando as primitivas do I0). O selo detecta
 * alteração e inconsistência; NÃO é assinatura de autenticidade. A remoção do FIM do histórico é detectada pelos recibos; quem altera
 * as DUAS pastas ao mesmo tempo (ex.: root na VPS) não é detectado.
 *
 * O registro guarda a ENTRADA EXATA do motor e o RESULTADO COMPLETO (necessários para `verifyScoreResult`). Por isso ele contém dados
 * internos (e-mail do operador, justificativas das decisões): NUNCA é devolvido por uma rota; as rotas devolvem a projeção pública.
 * Nenhum valor de pontuação é fornecido pelo cliente: tudo vem do motor.
 */
export const RUN_SCHEMA_VERSION = 1 as const;
/** Formato com `ledgerHead` (livro de cabeças, Q4): só resultados NOVOS gravados em auditoria PROTEGIDA. O v1 continua legível e inalterado. */
export const RUN_SCHEMA_VERSION_LEDGER = 2 as const;
export const RUN_FILE_KIND = 'LINK_AUDIT_SCORE_RUN' as const;
export const RUN_ANCHOR_KIND = 'LINK_AUDIT_SCORE_RUN_ANCHOR' as const;
/** Até 500 versões por auditoria (spec §15). */
export const MAX_RUNS = 500;
/** Teto de um registro (entrada + resultado). Medido no I4; ver `tests/link-audit-scoring-results-store.test.ts`. */
export const MAX_RUN_BYTES = 1024 * 1024;
export const MAX_RUN_ANCHOR_BYTES = 16 * 1024;
export const INTEGRITY_NOTE =
  'O hash SHA-256 detecta alteração acidental ou inconsistência; não é assinatura. A remoção ou o retrocesso do histórico de resultados é detectado pelos recibos (pasta separada); quem altera as DUAS pastas ao mesmo tempo (ex.: root na VPS) não é detectado.';

export const pad = (n: number): string => String(n).padStart(4, '0');
export const runFileName = (seq: number): string => `s${pad(seq)}.json`;
export const RUN_FILE = /^s(\d{4})\.json$/;
export const runAnchorFileName = (seq: number): string => `a${pad(seq)}.json`;
export const RUN_ANCHOR_FILE = /^a(\d{4})\.json$/;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const isoAny = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const auditId = z.string().regex(STORE_AUDIT_ID);
const email = z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const ref = z.string().regex(/^(?:capture:c\d{4}|report:c\d{4}-r\d{4})$/);
const seq = z.number().int().min(1).max(MAX_RUNS);

export const headSchema = z.object({ seq: z.number().int().min(1).max(9999), sha256: hex64 }).strict();
export type RunHead = z.infer<typeof headSchema>;

const evidenceItem = z
  .object({ ref, kind: z.enum(['CAPTURE', 'REPORT']), observedAt: isoAny, contentSha256: hex64, bodySha256: hex64.nullable(), legacy: z.boolean(), superseded: z.boolean() })
  .strict();
const source = z.object({ ref, observedAt: isoAny, contentSha256: hex64, bodySha256: hex64 }).strict();

export const scoreRunSchema = z
  .object({
    schemaVersion: z.union([z.literal(RUN_SCHEMA_VERSION), z.literal(RUN_SCHEMA_VERSION_LEDGER)]),
    kind: z.literal(RUN_FILE_KIND),
    auditId,
    seq,
    /** Hora do SERVIDOR, monotônica dentro da auditoria; nunca vem do cliente. */
    finalizedAt: iso,
    finalizedBy: email,
    outcome: z.enum(['PONTUADO', 'INCONCLUSIVO']),
    scored: z.object({ level: z.enum(['PROVISORIO', 'PUBLICAVEL']) }).strict().nullable(),
    inconclusive: z
      .object({
        reasonCode: z.enum(['COBERTURA_INSUFICIENTE', 'CRITERIOS_INSUFICIENTES', 'SEM_NAP_OU_AVALIACOES', 'SEM_DADOS_AVALIADOS']),
        failedGates: z.array(z.string().max(40)).max(10),
        coveragePercent: z.number().min(0).max(100),
        minimumCoveragePercent: z.literal(40),
      })
      .strict()
      .nullable(),
    scoringAuditId: z.string().regex(ENGINE_AUDIT_ID),
    auditIdAlias: z.object({ applied: z.boolean(), rule: z.string().max(60), reason: z.string().max(40).nullable(), sourceAuditId: auditId }).strict(),
    decisions: z
      .object({
        /** Head das decisões CONFIRMADAS consultado (o mesmo nas leituras que concordaram). */
        head: headSchema.nullable(),
        count: z.number().int().min(0).max(200),
        appliedIds: z.array(z.string().max(64)).max(200),
        /** Carimbo de captura que a 6B gravou em cada decisão aplicada: rastreia o vínculo do juízo C2 (limite documentado). */
        applied: z
          .array(z.object({ decisionId: z.string().max(64), kind: z.string().max(40), seq: z.number().int().min(1).max(9999), stampCapture: z.number().int().min(0).max(9999).nullable(), stampCollectedAt: z.string().max(40).nullable() }).strict())
          .max(200),
      })
      .strict(),
    layout: z.enum(['VERSIONED', 'LEGACY']),
    evidenceBasis: z.array(evidenceItem).min(1).max(500),
    profileSource: source.nullable(),
    referenceDate: day,
    referenceDateSource: z.object({ ref, observedAt: isoAny, rule: z.string().max(60) }).strict(),
    websiteDerivation: z
      .object({
        rule: z.string().max(60),
        rawSha256: hex64,
        sourceEvidence: z.object({ ref, contentSha256: hex64, bodySha256: hex64 }).strict(),
        utmLevel: z.enum(['COMPLETE', 'PARTIAL', 'NOT_OBSERVED']).nullable(),
        x5Proof: z.string().max(40),
      })
      .strict()
      .nullable(),
    mapperVersion: z.string().max(40),
    methodologyVersion: z.string().max(60),
    scoreModelVersion: z.string().max(60),
    rulerFingerprint: hex64,
    input: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
    inputSha256: hex64,
    resultSha256: hex64,
    /** PROVA DE ORIGEM (HMAC do servidor, chave fora das pastas): presente nos resultados gravados depois da remediação do MAJOR-1; ausente nos anteriores (não podem ser concluídos se ficarem pendentes). */
    origin: originProofSchema.optional(),
    /** Cabeça de DECISÕES do livro no instante da finalização (v2; §16.17.7: nunca uma posição RUN_*): a leitura confere que a posição citada existe no livro com o mesmo hash. */
    ledgerHead: z.object({ ledgerSeq: z.number().int().min(1).max(4000), sha256: hex64 }).strict().optional(),
    prevSha256: hex64.nullable(),
    contentSha256: hex64,
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.schemaVersion === RUN_SCHEMA_VERSION && run.ledgerHead !== undefined) ctx.addIssue({ code: 'custom', message: 'o formato v1 não carrega ledgerHead' });
    if (run.schemaVersion === RUN_SCHEMA_VERSION_LEDGER && run.ledgerHead === undefined) ctx.addIssue({ code: 'custom', message: 'o formato v2 exige ledgerHead' });
  });
export type ScoreRun = z.infer<typeof scoreRunSchema>;
export type ScoreRunDraft = Omit<ScoreRun, 'seq' | 'prevSha256' | 'contentSha256'>;

/** Recibo do resultado (protocolo genérico do I0). */
export const runAnchorSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    kind: z.literal(RUN_ANCHOR_KIND),
    auditId,
    /** Recibo do arquivo `sNNNN.json` de mesmo número. */
    seq,
    /** `contentSha256` do resultado no momento em que foi gravado. */
    headSha256: hex64,
    anchoredAt: iso,
    prevAnchorSha256: hex64.nullable(),
    contentSha256: hex64,
  })
  .strict();
export type RunAnchor = z.infer<typeof runAnchorSchema>;

/*
 * Guarda de TIPO (como na 6B): o protocolo genérico monta o recibo com as chaves de `ReceiptShape`; o esquema precisa ter EXATAMENTE
 * as mesmas. Se alguém acrescentar ou tirar um campo, a compilação quebra aqui.
 */
type BodyKeys = keyof Omit<ReceiptShape, 'contentSha256'>;
type RunAnchorBodyKeys = keyof Omit<RunAnchor, 'contentSha256'>;
const sameBodyKeys: [BodyKeys] extends [RunAnchorBodyKeys] ? ([RunAnchorBodyKeys] extends [BodyKeys] ? true : never) : never = true;
void sameBodyKeys;

/** Corpo estrito da finalização: SÓ a visão que o operador viu. Autor e hora vêm da sessão e do servidor. */
export const finalizeBodySchema = z.object({ expectedHead: headSchema.nullable(), expectedInputSha256: hex64 }).strict();
export type FinalizeBody = z.infer<typeof finalizeBodySchema>;
