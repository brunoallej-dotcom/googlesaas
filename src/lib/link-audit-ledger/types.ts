import { z } from 'zod';
import { originProofSchema } from '../link-audit-origin';

/*
 * LIVRO DE CABEÇAS das decisões (Onda 6B/6C; contrato normativo em `docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md` §16).
 *
 * Um registro por evento, imutável, encadeado e autenticado por HMAC com a chave EXCLUSIVA do livro (domínio LEDGER), em pasta própria
 * `<LEDGER_DIR>/<auditId>/lNNNNNN.json`. Este módulo NÃO conhece o armazenamento de decisões: recebe a descrição do que lá existe
 * (`DecisionsSnapshot`) e decide. A 6B também não importa este módulo: fala com ele por uma porta estrutural (`ledger-port.ts`).
 */
export const LEDGER_SCHEMA_VERSION = 1 as const;
/**
 * Versão dos registros de RESULTADO (`RUN_*`, spec §16.17.2, D-3). Regra versão ⇔ família: `1` nos seis eventos de decisão (bytes, hashes e etiquetas de todo
 * registro anterior à R1 ficam idênticos) e `2` nos três `RUN_*`. Uma imagem anterior à R1 recusa `RUN_*` (literal e enum estritos) ⇒ `UNTRUSTED` (falha fechada).
 */
export const LEDGER_RUN_SCHEMA_VERSION = 2 as const;
export const LEDGER_KIND = 'link-audit-decisions-ledger' as const;
export const MAX_LEDGER_RECORD_BYTES = 4096;
/** CAPACIDADE TOTAL por auditoria (falha fechada ao atingir): inclui os registros que concluem operações já iniciadas. Política de reserva: ver `LEDGER_CAPACITY_POLICY` e §16.12. */
export const MAX_LEDGER_RECORDS = 4000;
export const LEDGER_FILE = /^l(\d{6})\.json$/;
export const ledgerFileName = (seq: number): string => `l${String(seq).padStart(6, '0')}.json`;
/** Igual ao `AUDIT_ID_PATTERN` das decisões (um teste confere a igualdade). */
export const LEDGER_AUDIT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
/** Pontos de verificação automáticos: a cada N registros e na primeira escrita depois de uma rotação de chave. */
export const CHECKPOINT_EVERY = 64;
/**
 * Teto de resultados por auditoria e nome do recibo de resultado (`aNNNN.json`): DUPLICADOS de `MAX_RUNS` e `runAnchorFileName` dos resultados
 * (`link-audit-scoring-runs/results-types.ts`), porque o livro não importa os resultados (lista fechada de imports). Um teste confere a igualdade.
 */
export const MAX_RUNS = 500;
export const runAnchorName = (seq: number): string => `a${String(seq).padStart(4, '0')}.json`;

/*
 * POLÍTICA DE CAPACIDADE (R7-01 e D3; especificação §16.12). Registros DURÁVEIS por operação, no pior caso:
 *   criação ou revogação .......... INTENT + CONFIRMED = 2 (+1 CHECKPOINT antes, quando devido: a cada 64 registros ou na rotação de chave) ⇒ 3
 *   + REEMISSÃO DE RECIBO ......... até 1 RECEIPT_REISSUED por entrada confirmada (recibo removido depois do CONFIRMED; quem tem escrita na pasta de recibos provoca, o autor reenvia) ⇒ +1
 *   operação que falha ............ INTENT + ABORTED = 2 (e a nova tentativa paga de novo)
 *   recuperação de fase C ......... só o CONFIRMED que faltou = 1 (a INTENT já estava paga)
 *   rotação de chave .............. CHECKPOINT = 1 por auditoria
 * Três CLASSES, com limites sobre o total de registros DEPOIS de concluída a operação:
 *   RECORD (decisão nova) ≤ MAX − MANUTENÇÃO − RESERVA DE REVOGAÇÃO;   REVOKE ≤ MAX − MANUTENÇÃO;   MANUTENÇÃO (CHECKPOINT, ABORTED, REEMISSÃO, CONFIRMED que
 *   conclui o que já começou) ≤ MAX. Uma INTENT só é aceita se ela e o registro que a fecha cabem no limite da CLASSE ⇒ toda operação iniciada consegue terminar.
 * A reserva de revogação garante 100 REVOGAÇÕES COMPLETAS (a mesma contagem da 6B, `RESERVED_FOR_REVOCATIONS`) — 100 operações, não 100 registros — MESMO que cada uma seja seguida de uma reemissão de
 * recibo (D3): por isso a reserva conta 3 registros por revogação e a simulação do que "cabe" (anunciado na vista) assume 1 reemissão após cada operação. Reproduzido antes da correção: com 1 reemissão
 * por revogação só 4 de 5 revogações reservadas cabiam.
 */
export const REVOCATIONS_RESERVED = 100;
export const RECORDS_PER_OPERATION = 2;
/** Registro EXTRA que uma operação confirmada pode ganhar: a reemissão do recibo removido (no máximo 1 por entrada confirmada — ver `reissue()`). */
export const REISSUE_ALLOWANCE = 1;
/** Registros que nenhuma INTENT usa: pontos de verificação (rotação e automático), abortamentos e reemissões de recibo da ÚLTIMA operação. */
export const MAINTENANCE_RESERVE = 8;
/**
 * Folga do fecho de RESULTADO (spec §16.17.6, D-9/D-24): no máximo UM fecho de resultado (`RUN_CONFIRMED`/`RUN_ABORTED`) pode cair na região de revogação (resultado
 * aberto abaixo do limite e fechado depois de revogações). Termo PRÓPRIO de `deriveCapacityPolicy`, fora de `revocationReserveRecords` (que continua sendo só a
 * aritmética das 100 revogações: `REVOCATION_RESERVE_RECORDS` = 307).
 */
export const RUN_CLOSING_ALLOWANCE = 1;
/** Limites (total de registros depois de concluída a operação), por classe. `max` é a capacidade total. */
export interface LedgerCapacityPolicy {
  readonly max: number;
  /** Decisões novas E resultados (`RUN_INTENT` + fecho): D-9 fixa o MESMO limite, então não existe um segundo campo que possa divergir (revisão da R1.1). */
  readonly RECORD: number;
  readonly REVOKE: number;
  readonly MAINTENANCE: number;
}
/** Registros da reserva de revogação: N revogações × (2 + 1 reemissão) + pontos de verificação automáticos no pior alinhamento + 2 de folga. */
export const revocationReserveRecords = (revocations: number, every: number): number => {
  const worst = revocations * (RECORDS_PER_OPERATION + REISSUE_ALLOWANCE);
  return worst + Math.ceil(worst / every) + 2;
};
/** `RECORD` (limite de decisões novas e de resultados, D-9) `= max − manutenção − reserva de revogação − RUN_CLOSING_ALLOWANCE`; `REVOKE = max − manutenção`; `MAINTENANCE = max` (§16.12, §16.17.6). */
export function deriveCapacityPolicy(max: number, revocations: number, every: number, maintenance: number = MAINTENANCE_RESERVE): LedgerCapacityPolicy {
  const decisionsAndRuns = max - maintenance - revocationReserveRecords(revocations, every) - RUN_CLOSING_ALLOWANCE;
  return Object.freeze({ max, RECORD: decisionsAndRuns, REVOKE: max - maintenance, MAINTENANCE: max });
}
export const REVOCATION_RESERVE_RECORDS = revocationReserveRecords(REVOCATIONS_RESERVED, CHECKPOINT_EVERY);
export const LEDGER_CAPACITY_POLICY: LedgerCapacityPolicy = deriveCapacityPolicy(MAX_LEDGER_RECORDS, REVOCATIONS_RESERVED, CHECKPOINT_EVERY);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const seqNumber = z.number().int().min(1).max(9999);
/** Identidade autenticada do operador (e-mail da sessão) ou `system`. Sem espaço nem caractere de controle. */
const actorSchema = z.string().regex(/^[^\s\u0000-\u001f\u007f-\u009f]{1,254}$/);
const decisionIdSchema = z.string().regex(/^op-\d{4}$/);
const headSchema = z.object({ seq: seqNumber, sha256: hex64 }).strict();
const ledgerPosition = z.number().int().min(1).max(MAX_LEDGER_RECORDS);

/** Eventos da família das DECISÕES (`schemaVersion` 1) e dos RESULTADOS (`RUN_*`, `schemaVersion` 2; spec §16.17.2, D-1). */
export const LEDGER_DECISION_EVENTS = ['GENESIS', 'INTENT', 'CONFIRMED', 'ABORTED', 'RECEIPT_REISSUED', 'CHECKPOINT'] as const;
export const LEDGER_RUN_EVENTS = ['RUN_INTENT', 'RUN_CONFIRMED', 'RUN_ABORTED'] as const;
export const LEDGER_EVENTS = [...LEDGER_DECISION_EVENTS, ...LEDGER_RUN_EVENTS] as const;
export type LedgerEvent = (typeof LEDGER_EVENTS)[number];
export type LedgerRunEvent = (typeof LEDGER_RUN_EVENTS)[number];
export const isRunEvent = (event: LedgerEvent): event is LedgerRunEvent => (LEDGER_RUN_EVENTS as readonly string[]).includes(event);

const opSchema = z
  .object({
    /** Identificador da operação (128 bits, gerado pelo servidor no `INTENT`). */
    opId: hex32,
    /** Posição da entrada de decisão que esta operação publica. */
    decisionSeq: seqNumber,
    prevDecisionsHead: headSchema.nullable(),
    newDecisionsHead: headSchema,
    action: z.enum(['RECORD', 'REVOKE']),
    /** Autor da entrada de decisão (`recordedBy`). */
    author: actorSchema,
    decisionId: decisionIdSchema.nullable(),
    revokes: decisionIdSchema.nullable(),
    supersedes: decisionIdSchema.nullable(),
    /** A entrada revoga ou substitui outra: a sua perda reativaria uma decisão. */
    affectsPrior: z.boolean(),
    /** Posição do `INTENT` que este registro fecha/refere. */
    intentSeq: z.number().int().min(1).max(MAX_LEDGER_RECORDS).optional(),
    /** Recibo da 6B que ancora a entrada (nome e hash da entrada ancorada). */
    anchorRef: z.object({ name: z.string().regex(/^a\d{4}\.json$/), headSha256: hex64 }).strict().optional(),
    /** O que a recuperação observou ao abortar. */
    observed: z.object({ entryPresent: z.literal(false), receiptPresent: z.literal(false), ageMs: z.number().int().min(0) }).strict().optional(),
  })
  .strict();
export type LedgerOp = z.infer<typeof opSchema>;

/** Operação de RESULTADO (spec §16.17.2). Só hashes, posições e o autor; a etiqueta do registro cobre todo o objeto. */
const runSchema = z
  .object({
    /** Identificador da operação de resultado (128 bits, gerado no `RUN_INTENT`). */
    runOpId: hex32,
    /** Número do resultado (`sNNNN`); teto = `MAX_RUNS`. */
    runSeq: z.number().int().min(1).max(MAX_RUNS),
    /** `contentSha256` do resultado anterior; `null` ⇔ `runSeq = 1` (S-7). */
    prevRunSha256: hex64.nullable(),
    /** `contentSha256` do resultado JÁ SELADO que a operação publica. */
    runSha256: hex64,
    /** `finalizedBy` (e-mail da sessão, normalizado). */
    author: actorSchema,
    /** `ledgerHead` gravado no resultado = cabeça de decisões do livro no prefixo (I-3). */
    citedLedgerHead: z.object({ ledgerSeq: ledgerPosition, sha256: hex64 }).strict(),
    /** `decisions.head` gravado no resultado (I-4). */
    decisionsHead: headSchema.nullable(),
    /** `RUN_CONFIRMED`/`RUN_ABORTED`: posição do `RUN_INTENT` que fecham. */
    intentSeq: ledgerPosition.optional(),
    /** `RUN_CONFIRMED`: o recibo que ancora o resultado. */
    anchorRef: z.object({ name: z.string().regex(/^a\d{4}\.json$/), headSha256: hex64 }).strict().optional(),
    /** `RUN_ABORTED`: o que a recuperação observou (resultado e recibo ausentes). */
    observed: z.object({ resultPresent: z.literal(false), receiptPresent: z.literal(false), ageMs: z.number().int().min(0) }).strict().optional(),
  })
  .strict();
export type LedgerRun = z.infer<typeof runSchema>;

/** Regras S-3…S-7 de um `RUN_*` (spec §16.17.2; cada uma é ponto de mutação). */
function refineRun(event: LedgerRunEvent, run: LedgerRun, ledgerSeq: number, bad: (message: string) => void): void {
  if (event === 'RUN_INTENT' && (run.intentSeq !== undefined || run.anchorRef || run.observed)) bad('S-3: RUN_INTENT não fecha nada');
  if (event === 'RUN_CONFIRMED') {
    if (run.intentSeq === undefined || !run.anchorRef || run.observed) bad('S-4: RUN_CONFIRMED exige intentSeq e anchorRef, sem observed');
    if (run.anchorRef && (run.anchorRef.headSha256 !== run.runSha256 || run.anchorRef.name !== runAnchorName(run.runSeq))) bad('S-4: anchorRef não ancora o resultado da operação');
  }
  if (event === 'RUN_ABORTED' && (run.intentSeq === undefined || !run.observed || run.anchorRef)) bad('S-5: RUN_ABORTED exige intentSeq e observed, sem anchorRef');
  if (run.intentSeq !== undefined && run.intentSeq >= ledgerSeq) bad('S-6: intentSeq deve ser anterior');
  if (run.citedLedgerHead.ledgerSeq >= ledgerSeq) bad('S-6: a cabeça citada deve ser anterior');
  if ((run.runSeq === 1) !== (run.prevRunSha256 === null)) bad('S-7: runSeq 1 ⇔ sem resultado anterior');
}

export const ledgerRecordSchema = z
  .object({
    schemaVersion: z.union([z.literal(LEDGER_SCHEMA_VERSION), z.literal(LEDGER_RUN_SCHEMA_VERSION)]),
    kind: z.literal(LEDGER_KIND),
    auditId: z.string().regex(LEDGER_AUDIT_ID_PATTERN),
    ledgerSeq: z.number().int().min(1).max(MAX_LEDGER_RECORDS),
    prevSha256: hex64.nullable(),
    event: z.enum(LEDGER_EVENTS),
    recordedAt: iso,
    actor: actorSchema,
    op: opSchema.optional(),
    genesis: z.object({ mode: z.literal('EMPTY') }).strict().optional(),
    checkpoint: z.object({ throughSeq: z.number().int().min(1).max(MAX_LEDGER_RECORDS), throughSha256: hex64 }).strict().optional(),
    run: runSchema.optional(),
    origin: originProofSchema,
    contentSha256: hex64,
  })
  .strict()
  .superRefine((record, ctx) => {
    const bad = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const { event, op, genesis, checkpoint, run } = record;
    // S-1: `run` presente ⇔ evento RUN_*; RUN_* não carrega op, genesis nem checkpoint (e evento de decisão não carrega run)
    const runFamily = isRunEvent(event);
    if (runFamily !== (run !== undefined)) bad('S-1: run presente ⇔ evento RUN_*');
    if (runFamily && (op || genesis || checkpoint)) bad('S-1: RUN_* não carrega op, genesis nem checkpoint');
    // S-2: versão ⇔ família (decisão = 1, resultado = 2)
    if ((record.schemaVersion === LEDGER_RUN_SCHEMA_VERSION) !== runFamily) bad('S-2: versão do esquema incoerente com a família do evento');
    if (runFamily) {
      if (run) refineRun(event, run, record.ledgerSeq, bad);
      return;
    }
    if (event === 'GENESIS') {
      if (!genesis || op || checkpoint || record.ledgerSeq !== 1 || record.prevSha256 !== null) bad('GENESIS inválido');
      return;
    }
    if (genesis) bad('só o GENESIS carrega genesis');
    if (event === 'CHECKPOINT') {
      if (!checkpoint || op || checkpoint.throughSeq >= record.ledgerSeq) bad('CHECKPOINT inválido');
      return;
    }
    if (checkpoint) bad('só o CHECKPOINT carrega checkpoint');
    if (!op) {
      bad(`${event} exige op`);
      return;
    }
    if (op.newDecisionsHead.seq !== op.decisionSeq) bad('newDecisionsHead.seq difere de decisionSeq');
    if ((op.prevDecisionsHead?.seq ?? 0) + 1 !== op.decisionSeq) bad('prevDecisionsHead não é o anterior de decisionSeq');
    if (op.action === 'REVOKE' ? op.revokes === null || op.decisionId !== null : op.revokes !== null || op.decisionId === null) bad('campos de ação incoerentes');
    if (op.affectsPrior !== (op.action === 'REVOKE' || op.supersedes !== null)) bad('affectsPrior incoerente');
    if (event === 'INTENT' && (op.intentSeq !== undefined || op.anchorRef || op.observed)) bad('INTENT não fecha nada');
    if ((event === 'CONFIRMED' || event === 'RECEIPT_REISSUED') && (op.intentSeq === undefined || !op.anchorRef || op.observed)) bad(`${event} exige intentSeq e anchorRef`);
    if (event === 'ABORTED' && (op.intentSeq === undefined || op.anchorRef || !op.observed)) bad('ABORTED exige intentSeq e observed');
    if (op.intentSeq !== undefined && op.intentSeq >= record.ledgerSeq) bad('intentSeq deve ser anterior');
    if (op.anchorRef && op.anchorRef.headSha256 !== op.newDecisionsHead.sha256) bad('anchorRef não ancora a entrada da operação');
  });
export type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
/** O que o chamador informa; o serviço acrescenta posição, encadeamento, etiqueta e hash. */
export type LedgerDraft = Omit<LedgerRecord, 'schemaVersion' | 'kind' | 'auditId' | 'ledgerSeq' | 'prevSha256' | 'origin' | 'contentSha256'>;

/* Tipos e valores COMPARTILHADOS com a 6B (dono: a porta `link-audit-decisions/ledger-port.ts`, sem dependências). */
export { isLedgerBlocking, NOT_REQUIRED_VIEW } from '../link-audit-decisions/ledger-port';
export type {
  CapacityLevel,
  DecisionRef,
  DecisionsSnapshot,
  GuardStatus,
  LedgerCapacity,
  LedgerHead,
  LedgerKeyCoverage,
  LedgerReason,
  LedgerState,
  LedgerView,
  OpenOperation,
  OperationPhase,
  ResultsEvidence,
} from '../link-audit-decisions/ledger-port';

