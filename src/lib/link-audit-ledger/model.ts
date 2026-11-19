import type { OriginAuthenticator } from '../link-audit-origin';
import {
  CHECKPOINT_EVERY,
  isRunEvent,
  LEDGER_CAPACITY_POLICY,
  MAX_LEDGER_RECORDS,
  RECORDS_PER_OPERATION,
  REISSUE_ALLOWANCE,
  type CapacityLevel,
  type LedgerCapacityPolicy,
  type DecisionRef,
  type DecisionsSnapshot,
  type GuardStatus,
  type LedgerCapacity,
  type LedgerHead,
  type LedgerKeyCoverage,
  type LedgerOp,
  type LedgerReason,
  type LedgerRecord,
  type LedgerRun,
  type LedgerView,
  type OpenOperation,
  type ResultsEvidence,
} from './types';

/*
 * MODELO PURO do livro de cabeças: reprodução da cadeia, conferência de etiquetas e AVALIAÇÃO da proteção da auditoria frente ao que as outras
 * pastas dizem. Sem disco, relógio, ambiente nem aleatoriedade (o tempo entra por `ageMsOf`; a chave por `OriginAuthenticator`).
 *
 * REGRA DE OURO (Q1): a ausência do livro NUNCA vira "cabeça vazia". Livro ausente com histórico ⇒ LEGACY_READ_ONLY; ausente com testemunha de
 * que já existiu ⇒ HISTORY_UNRESOLVED. Qualquer falha, ausência de dependência ou dúvida ⇒ HISTORY_UNRESOLVED (falha fechada).
 */

export interface ConfirmedOp {
  readonly decisionSeq: number;
  readonly sha256: string;
  readonly intentSeq: number;
  readonly confirmedSeq: number;
  readonly op: LedgerOp;
}
export interface AbortedOp {
  readonly op: LedgerOp;
  readonly intentSeq: number;
  readonly abortedSeq: number;
}
/** Resultado confirmado pelo livro (`RUN_CONFIRMED`, spec §16.17.2). */
export interface ConfirmedRun {
  readonly runSeq: number;
  readonly runSha256: string;
  readonly intentSeq: number;
  readonly confirmedSeq: number;
  readonly run: LedgerRun;
}
export interface AbortedRun {
  readonly run: LedgerRun;
  readonly intentSeq: number;
  readonly abortedSeq: number;
}
export interface LedgerReplay {
  readonly records: readonly LedgerRecord[];
  readonly head: LedgerHead;
  /** Operações confirmadas, em ordem de `decisionSeq` (1..n). */
  readonly confirmed: readonly ConfirmedOp[];
  /** O `INTENT` ainda sem `CONFIRMED`/`ABORTED` (no máximo um). */
  readonly open: LedgerRecord | null;
  readonly aborted: readonly AbortedOp[];
  /** Resultados confirmados pelo livro, em ordem de `runSeq` (1..n). */
  readonly confirmedRuns: readonly ConfirmedRun[];
  /** O `RUN_INTENT` ainda sem `RUN_CONFIRMED`/`RUN_ABORTED` (no máximo um). Slot INDEPENDENTE de `open` (D-8). */
  readonly openRun: LedgerRecord | null;
  readonly abortedRuns: readonly AbortedRun[];
}
export type ReplayResult = { readonly ok: true; readonly value: LedgerReplay } | { readonly ok: false; readonly issues: readonly string[] };

const SAME_FIELDS = ['opId', 'decisionSeq', 'action', 'author', 'decisionId', 'revokes', 'supersedes', 'affectsPrior'] as const;
const sameOp = (a: LedgerOp, b: LedgerOp): boolean =>
  SAME_FIELDS.every((field) => a[field] === b[field]) &&
  a.newDecisionsHead.seq === b.newDecisionsHead.seq &&
  a.newDecisionsHead.sha256 === b.newDecisionsHead.sha256 &&
  (a.prevDecisionsHead?.seq ?? null) === (b.prevDecisionsHead?.seq ?? null) &&
  (a.prevDecisionsHead?.sha256 ?? null) === (b.prevDecisionsHead?.sha256 ?? null);

/** I-5: o fecho de resultado repete os campos do `RUN_INTENT` (espelho de `sameOp`). */
const SAME_RUN_FIELDS = ['runOpId', 'runSeq', 'prevRunSha256', 'runSha256', 'author'] as const;
const sameRun = (a: LedgerRun, b: LedgerRun): boolean =>
  SAME_RUN_FIELDS.every((field) => a[field] === b[field]) &&
  a.citedLedgerHead.ledgerSeq === b.citedLedgerHead.ledgerSeq &&
  a.citedLedgerHead.sha256 === b.citedLedgerHead.sha256 &&
  (a.decisionsHead?.seq ?? null) === (b.decisionsHead?.seq ?? null) &&
  (a.decisionsHead?.sha256 ?? null) === (b.decisionsHead?.sha256 ?? null);

/**
 * D-R1-1 (§16.17.13): quem grava o fecho que CONFIRMA (`CONFIRMED`, `RUN_CONFIRMED`) é o AUTOR da operação. Identidades normalizadas como na fronteira (`operatorOf`:
 * sem espaços nas pontas, minúsculas). Livro autêntico com fecho de não autor é código com a chave fazendo o que a regra proíbe ⇒ replay inválido (`UNTRUSTED`).
 */
const sameIdentity = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Estrutura da cadeia: contígua, encadeada, no máximo UMA operação de decisão aberta e UMA de resultado aberta (slots independentes, D-8), fechos casando com a
 * abertura (I-5, `sameOp`) e gravados pelo autor quando confirmam (D-R1-1), e os `RUN_INTENT` amarrados ao prefixo (I-1…I-4). NÃO confere etiquetas.
 */
export function replayLedger(records: readonly LedgerRecord[], auditId: string): ReplayResult {
  const issues: string[] = [];
  const fail = (message: string): ReplayResult => ({ ok: false, issues: [...issues, message] });
  if (records.length === 0) return fail('livro vazio');
  const confirmed: ConfirmedOp[] = [];
  const aborted: AbortedOp[] = [];
  let open: LedgerRecord | null = null;
  const confirmedRuns: ConfirmedRun[] = [];
  const abortedRuns: AbortedRun[] = [];
  let openRun: LedgerRecord | null = null;
  /** Cabeça de decisões do PREFIXO: último registro que NÃO é `RUN_*` (decisão, GENESIS, ABORTED, RECEIPT_REISSUED, CHECKPOINT; D-6). */
  let decisionHead: LedgerHead | null = null;
  let previous: LedgerRecord | null = null;
  for (const [index, record] of records.entries()) {
    const where = `registro ${record.ledgerSeq}`;
    if (record.auditId !== auditId) return fail(`${where}: pertence a outra auditoria`);
    if (record.ledgerSeq !== index + 1) return fail(`${where}: sequência interna difere da posição ${index + 1}`);
    if (record.prevSha256 !== (previous?.contentSha256 ?? null)) return fail(`${where}: não está encadeado ao anterior`);
    if (previous && record.recordedAt < previous.recordedAt) return fail(`${where}: hora anterior à do registro anterior`);
    if (index === 0 && record.event !== 'GENESIS') return fail('o primeiro registro não é o GENESIS');
    if (index > 0 && record.event === 'GENESIS') return fail(`${where}: GENESIS repetido`);
    const op = record.op;
    switch (record.event) {
      case 'GENESIS':
        break;
      case 'CHECKPOINT': {
        const through = records[(record.checkpoint?.throughSeq ?? 0) - 1];
        if (!through || through.contentSha256 !== record.checkpoint?.throughSha256) return fail(`${where}: o ponto de verificação não confere com o registro que declara`);
        break;
      }
      case 'INTENT': {
        if (open) return fail(`${where}: INTENT com outra operação aberta`);
        if (!op) return fail(`${where}: sem operação`);
        const last = confirmed[confirmed.length - 1];
        if (op.decisionSeq !== confirmed.length + 1) return fail(`${where}: decisionSeq ${op.decisionSeq} difere do esperado ${confirmed.length + 1}`);
        if ((op.prevDecisionsHead?.seq ?? null) !== (last?.decisionSeq ?? null) || (op.prevDecisionsHead?.sha256 ?? null) !== (last?.sha256 ?? null)) {
          return fail(`${where}: a cabeça anterior não é a do último CONFIRMED`);
        }
        open = record;
        break;
      }
      case 'CONFIRMED':
      case 'ABORTED': {
        if (!open || !op || !open.op) return fail(`${where}: ${record.event} sem INTENT aberto`);
        if (op.intentSeq !== open.ledgerSeq || !sameOp(op, open.op)) return fail(`${where}: ${record.event} não casa com o INTENT ${open.ledgerSeq}`);
        if (record.event === 'CONFIRMED' && !sameIdentity(record.actor, open.op.author)) return fail(`${where}: CONFIRMED gravado por quem não é o autor da INTENT ${open.ledgerSeq}`);
        if (record.event === 'CONFIRMED') confirmed.push({ decisionSeq: op.decisionSeq, sha256: op.newDecisionsHead.sha256, intentSeq: open.ledgerSeq, confirmedSeq: record.ledgerSeq, op });
        else aborted.push({ op, intentSeq: open.ledgerSeq, abortedSeq: record.ledgerSeq });
        open = null;
        break;
      }
      case 'RECEIPT_REISSUED': {
        if (open || !op) return fail(`${where}: reemissão de recibo com operação aberta ou sem operação`);
        const target = confirmed[confirmed.length - 1];
        if (!target || op.decisionSeq !== target.decisionSeq || op.intentSeq !== target.intentSeq || !sameOp(op, target.op)) return fail(`${where}: reemissão não casa com a última operação confirmada`);
        break;
      }
      case 'RUN_INTENT': {
        const run = record.run;
        if (!run) return fail(`${where}: sem operação de resultado`);
        // I-1: nenhuma operação aberta, de NENHUMA família (o contrário não vale: um INTENT de decisão entra com resultado aberto, D-8)
        if (openRun || open) return fail(`${where}: RUN_INTENT com outra operação aberta`);
        // I-2: próximo resultado da cadeia confirmada pelo livro
        const lastRun = confirmedRuns[confirmedRuns.length - 1];
        if (run.runSeq !== confirmedRuns.length + 1) return fail(`${where}: runSeq ${run.runSeq} difere do esperado ${confirmedRuns.length + 1}`);
        if (run.prevRunSha256 !== (lastRun?.runSha256 ?? null)) return fail(`${where}: o resultado anterior não é o do último RUN_CONFIRMED`);
        // I-3: o resultado cita a cabeça de DECISÕES do prefixo, nunca uma posição RUN_*
        if (!decisionHead || run.citedLedgerHead.ledgerSeq !== decisionHead.ledgerSeq || run.citedLedgerHead.sha256 !== decisionHead.sha256) return fail(`${where}: a cabeça citada não é a cabeça de decisões do prefixo`);
        // I-4: a cabeça das decisões gravada no resultado é a do último CONFIRMED
        const lastDecision = confirmed[confirmed.length - 1];
        if ((run.decisionsHead?.seq ?? null) !== (lastDecision?.decisionSeq ?? null) || (run.decisionsHead?.sha256 ?? null) !== (lastDecision?.sha256 ?? null)) return fail(`${where}: a cabeça das decisões não é a do último CONFIRMED`);
        openRun = record;
        break;
      }
      case 'RUN_CONFIRMED':
      case 'RUN_ABORTED': {
        const run = record.run;
        const intent = openRun?.run;
        if (!openRun || !run || !intent) return fail(`${where}: ${record.event} sem RUN_INTENT aberto`);
        // I-5: fecha o RUN_INTENT aberto e repete os campos dele
        if (run.intentSeq !== openRun.ledgerSeq || !sameRun(run, intent)) return fail(`${where}: ${record.event} não casa com o RUN_INTENT ${openRun.ledgerSeq}`);
        // D-R1-1: só o AUTOR confirma; o RUN_ABORTED (fase A vencida) continua de qualquer operador
        if (record.event === 'RUN_CONFIRMED' && !sameIdentity(record.actor, intent.author)) return fail(`${where}: RUN_CONFIRMED gravado por quem não é o autor do RUN_INTENT ${openRun.ledgerSeq}`);
        if (record.event === 'RUN_CONFIRMED') confirmedRuns.push({ runSeq: run.runSeq, runSha256: run.runSha256, intentSeq: openRun.ledgerSeq, confirmedSeq: record.ledgerSeq, run });
        else abortedRuns.push({ run, intentSeq: openRun.ledgerSeq, abortedSeq: record.ledgerSeq });
        openRun = null;
        break;
      }
      default:
        return fail(`${where}: evento desconhecido`);
    }
    // I-6: CHECKPOINT e RECEIPT_REISSUED não olham `openRun` (a capacidade deles é regra do escritor, 16.17.6)
    if (!isRunEvent(record.event)) decisionHead = { ledgerSeq: record.ledgerSeq, sha256: record.contentSha256 };
    previous = record;
  }
  const last = records[records.length - 1] as LedgerRecord;
  return { ok: true, value: { records, head: { ledgerSeq: last.ledgerSeq, sha256: last.contentSha256 }, confirmed, open, aborted, confirmedRuns, openRun, abortedRuns } };
}

export type TagFailure = { readonly reason: Extract<LedgerReason, 'UNTRUSTED' | 'KEY_REVOKED' | 'KEY_EXPIRED' | 'KEY_UNKNOWN'>; readonly seq: number };

/**
 * Etiquetas (HMAC, domínio LEDGER, chave EXCLUSIVA do livro). Chave atual ou aposentada VÁLIDA ⇒ verifica. Chave REVOGADA ⇒ `KEY_REVOKED`, SEMPRE
 * (comprometimento: nenhuma etiqueta dela autentica, nem a de pontos de verificação posteriores a cobrem). Chave aposentada VENCIDA ou desconhecida ⇒ só
 * é aceita se um `CHECKPOINT` válido (etiqueta PROVEN, chave atual/aposentada válida) cobre aquela posição por encadeamento.
 */
export function verifyTags(records: readonly LedgerRecord[], authenticator: OriginAuthenticator): TagFailure | null {
  const verdicts = records.map((record) => authenticator.verify('LEDGER', record));
  let covered = 0;
  for (const [index, record] of records.entries()) {
    if (record.event === 'CHECKPOINT' && verdicts[index] === 'PROVEN') covered = Math.max(covered, record.checkpoint?.throughSeq ?? 0);
  }
  for (const [index, verdict] of verdicts.entries()) {
    const seq = index + 1;
    if (verdict === 'PROVEN') continue;
    if (verdict === 'KEY_REVOKED') return { reason: 'KEY_REVOKED', seq };
    if (verdict === 'KEY_EXPIRED' && seq <= covered) continue;
    if (verdict === 'KEY_EXPIRED') return { reason: 'KEY_EXPIRED', seq };
    if (verdict === 'KEY_MISMATCH' && seq <= covered) continue;
    if (verdict === 'KEY_MISMATCH') return { reason: 'KEY_UNKNOWN', seq };
    return { reason: 'UNTRUSTED', seq }; // MISSING / INVALID: adulterado ou forjado
  }
  return keyEpochViolation(records, authenticator.keyId);
}

/**
 * ÉPOCA DE CHAVE (R6-06). A referência é a ORDEM da cadeia (encadeada por hash; ninguém a muda sem refazer tudo), NUNCA `recordedAt` (que quem forja escolhe)
 * nem a validade da chave aposentada (que só diz até quando ela ainda VERIFICA). Regra: a partir do momento em que um registro é assinado por OUTRA chave, a
 * anterior não pode reaparecer — uma chave aposentada verifica o passado, não autoriza registros novos. Vale também para a chave ATUAL: se ela já foi substituída
 * neste livro, usá-la de novo (reversão de configuração, chave antiga reposta) deixa a auditoria não resolvida em vez de abrir uma segunda linha de assinatura.
 * LIMITE: antes do primeiro registro da chave nova (entre a rotação e a primeira operação), quem tem a chave antiga ainda anexa registros que o sistema não
 * distingue dos legítimos; só a revogação do id (ou a guarda externa) fecha essa janela. O runbook manda gravar o ponto de verificação logo após a rotação.
 */
export function keyEpochViolation(records: readonly LedgerRecord[], currentKeyId: string): TagFailure | null {
  const finished = new Set<string>();
  for (let index = 1; index < records.length; index += 1) {
    const previous = (records[index - 1] as LedgerRecord).origin.kid;
    const kid = (records[index] as LedgerRecord).origin.kid;
    if (kid === previous) continue;
    finished.add(previous);
    if (finished.has(kid)) return { reason: 'UNTRUSTED', seq: index + 1 };
  }
  const last = records[records.length - 1];
  if (last && last.origin.kid !== currentKeyId && finished.has(currentKeyId)) return { reason: 'UNTRUSTED', seq: records.length };
  return null;
}

/**
 * ROTAÇÃO (R6-02): existe registro de OUTRA chave que nenhum ponto de verificação da chave ATUAL cobre (inclusive o último ponto de verificação antigo). Enquanto isto for
 * verdade, a chave antiga não pode vencer sem matar a auditoria (`KEY_EXPIRED`).
 */
export function rotationCheckpointDue(records: readonly LedgerRecord[], currentKeyId: string): boolean {
  let lastCurrentCheckpoint = 0;
  for (const record of records) if (record.event === 'CHECKPOINT' && record.origin.kid === currentKeyId) lastCurrentCheckpoint = record.ledgerSeq;
  return records.slice(lastCurrentCheckpoint).some((record) => record.origin.kid !== currentKeyId);
}

/** Registros depois do último ponto de verificação (de qualquer chave): a cada `every` um novo é devido. */
const recordsSinceCheckpoint = (records: readonly LedgerRecord[]): number => {
  let last = 0;
  for (const record of records) if (record.event === 'CHECKPOINT') last = record.ledgerSeq;
  return records.length - last;
};

/** Ponto de verificação devido: rotação não coberta ou `every` registros desde o último. */
export function needsCheckpoint(records: readonly LedgerRecord[], currentKeyId: string, every: number): boolean {
  return recordsSinceCheckpoint(records) >= every || rotationCheckpointDue(records, currentKeyId);
}

/* ------------------------------------------------------------------ capacidade (R7-01) */

export type CapacityClassName = 'RECORD' | 'REVOKE';

/**
 * Quantas operações COMPLETAS da classe ainda cabem em sequência, no PIOR CASO (D3): cada operação é admitida como o escritor a admite (ponto de verificação devido antes da INTENT, depois INTENT +
 * fecho) e depois consome também 1 registro de reemissão de recibo (`REISSUE_ALLOWANCE`) — o máximo que uma entrada confirmada pode ganhar. `limit` = total de registros permitido DEPOIS de concluída cada
 * operação. É a ÚNICA fonte da verdade: o escritor impõe o limite com `operationCost` e a vista anuncia o resultado desta função — um piso que continua valendo mesmo sob remoção de recibos.
 */
export function simulateOperations(used: number, since: number, rotationDue: boolean, every: number, limit: number): number {
  let count = 0;
  let u = used;
  let s = since;
  let rotation = rotationDue;
  while (count < MAX_LEDGER_RECORDS) {
    const due = rotation || s >= every;
    const need = (due ? 1 : 0) + RECORDS_PER_OPERATION;
    if (u + need > limit) break;
    u += need + REISSUE_ALLOWANCE;
    s = (due ? 0 : s) + RECORDS_PER_OPERATION + REISSUE_ALLOWANCE;
    rotation = false;
    count += 1;
  }
  return count;
}

/**
 * Fechos ainda devidos pelas operações ABERTAS das duas famílias (spec §16.17.6): `(open ? 1 : 0) + (openRun ? 1 : 0)`. Todo registro que não fecha operação só
 * entra se deixar esse espaço (`len + 1 + closing ≤ MAX`); as admissões de `INTENT` e `RUN_INTENT` também o descontam. Os registros já passaram pelo replay.
 */
export function pendingClosings(records: readonly LedgerRecord[]): number {
  let open = false;
  let openRun = false;
  for (const record of records) {
    if (record.event === 'INTENT') open = true;
    else if (record.event === 'CONFIRMED' || record.event === 'ABORTED') open = false;
    else if (record.event === 'RUN_INTENT') openRun = true;
    else if (record.event === 'RUN_CONFIRMED' || record.event === 'RUN_ABORTED') openRun = false;
  }
  return (open ? 1 : 0) + (openRun ? 1 : 0);
}

/** Registros que UMA operação da classe ainda consumirá agora (ponto de verificação devido + INTENT + fecho); `null` quando não cabe no limite da classe — que também guarda o fecho de um resultado aberto (§16.17.6). */
export function operationCost(records: readonly LedgerRecord[], currentKeyId: string, every: number, cls: CapacityClassName, policy: LedgerCapacityPolicy = LEDGER_CAPACITY_POLICY): { readonly checkpoint: boolean; readonly records: number } | null {
  const checkpoint = needsCheckpoint(records, currentKeyId, every);
  const cost = (checkpoint ? 1 : 0) + RECORDS_PER_OPERATION;
  return records.length + cost + pendingClosings(records) <= policy[cls] ? { checkpoint, records: cost } : null;
}

/** Classe RUN = limite `RECORD` (D-9): uma única fonte; nenhum valor da política permite a resultados entrar na região das revogações. */
const runLimit = (policy: LedgerCapacityPolicy): number => policy.RECORD;

/**
 * Resultados COMPLETOS (`RUN_INTENT` + fecho = 2 registros) que ainda cabem na classe RUN, descontando os fechos devidos. Um resultado nunca grava nem reserva
 * `CHECKPOINT` (D-7). É a MESMA conta que a vista anuncia (`capacity.runsAvailable`) e que a admissão impõe (`runIntentFits`).
 */
export function runsAvailableOf(used: number, closing: number, policy: LedgerCapacityPolicy = LEDGER_CAPACITY_POLICY): number {
  return Math.max(0, Math.floor((runLimit(policy) - used - closing) / RECORDS_PER_OPERATION));
}

/** Admissão do `RUN_INTENT` (16.17.6): ele e o fecho cabem na classe RUN sobre os registros lidos (o escritor confere na posição que o registro vai ocupar). */
export function runIntentFits(records: readonly LedgerRecord[], policy: LedgerCapacityPolicy = LEDGER_CAPACITY_POLICY): boolean {
  return runsAvailableOf(records.length, pendingClosings(records), policy) >= 1;
}

export function ledgerCapacity(records: readonly LedgerRecord[], currentKeyId: string, every: number = CHECKPOINT_EVERY, policy: LedgerCapacityPolicy = LEDGER_CAPACITY_POLICY, closing = 0): LedgerCapacity {
  // `closing`: cada operação ABERTA (decisão e/ou resultado) ainda vai consumir 1 registro (o fecho) — a vista não anuncia espaço que elas vão ocupar
  // `usedRecords`/`remainingRecords` descrevem o que EXISTE (a tela confere que fecham em `maxRecords`); só as contagens de operações descontam o fecho
  const used = records.length + closing;
  const since = recordsSinceCheckpoint(records);
  const rotation = rotationCheckpointDue(records, currentKeyId);
  const decisionsAvailable = simulateOperations(used, since, rotation, every, policy.RECORD);
  const revocationsAvailable = simulateOperations(used, since, rotation, every, policy.REVOKE);
  const runsAvailable = runsAvailableOf(records.length, closing, policy);
  // o nível continua definido só por decisões e revogações (16.17.6); em REVOKE_ONLY ainda podem caber resultados, sem tocar a reserva
  const level: CapacityLevel = decisionsAvailable > 0 ? 'OK' : revocationsAvailable > 0 ? 'REVOKE_ONLY' : 'EXHAUSTED';
  return { maxRecords: policy.max, usedRecords: records.length, remainingRecords: Math.max(0, policy.max - records.length), decisionsAvailable, revocationsAvailable, runsAvailable, level };
}

export function keyCoverageOf(records: readonly LedgerRecord[], currentKeyId: string): LedgerKeyCoverage {
  return { keyId: currentKeyId, covered: !rotationCheckpointDue(records, currentKeyId), otherKeyRecords: records.filter((record) => record.origin.kid !== currentKeyId).length };
}

/* ------------------------------------------------------------------ avaliação da proteção */

export type LedgerReadState =
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'PRESENT'; readonly records: readonly LedgerRecord[]; readonly tagFailure: TagFailure | null }
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'UNTRUSTED' }
  /** A base do livro travou depois de uma falha de fsync/erro fatal neste processo (M2). */
  | { readonly kind: 'DURABILITY_UNKNOWN' };

/** O que a guarda externa (se houver) informa. */
export type GuardEvidence =
  | { readonly status: 'NOT_CONFIGURED' }
  | { readonly status: 'UNAVAILABLE' }
  | { readonly status: 'READ'; readonly head: LedgerHead | null };

export interface ProtectionInput {
  readonly configured: boolean;
  readonly read: LedgerReadState;
  readonly auditId: string;
  readonly decisions: DecisionsSnapshot;
  /** A etiqueta de ORIGEM da entrada `seq` é comprovada (autor genuíno): condição para o servidor concluir o `CONFIRMED` em nome do autor. */
  readonly entryOriginProven: (seq: number) => boolean;
  readonly results: ResultsEvidence;
  readonly guard: GuardEvidence;
  /** Idade da operação aberta. `openKey` identifica a operação (opId) para a referência de tempo independente do relógio gravado (R7-09; ver `observed.ts`). */
  readonly ageMsOf: (recordedAt: string, openKey?: string) => number;
  readonly staleMs: number;
  /** Id PÚBLICO da chave atual do livro e o intervalo dos pontos de verificação: com eles a vista informa capacidade e cobertura da rotação. */
  readonly currentKeyId?: string;
  readonly checkpointEvery?: number;
  readonly capacityPolicy?: LedgerCapacityPolicy;
}

/** Receita de recuperação VERIFICÁVEL que o escritor aplica sob a coordenação da escrita (nunca na leitura). */
export type RecoveryPlan =
  | { readonly kind: 'NONE' }
  /** Fase A vencida: abortar o INTENT (entrada e recibo ausentes). */
  | { readonly kind: 'ABORT'; readonly intent: LedgerRecord }
  /** Fase A não vencida: aguardar o dono. */
  | { readonly kind: 'WAIT'; readonly intent: LedgerRecord }
  /** Fase C: acrescentar o CONFIRMED que faltou. */
  | { readonly kind: 'COMPLETE_CONFIRMED'; readonly intent: LedgerRecord; readonly entry: DecisionRef }
  /** Recibo removido de entrada já confirmada: o autor pode reemitir o recibo de MESMO conteúdo (registrando `RECEIPT_REISSUED`). */
  | { readonly kind: 'REISSUE_RECEIPT'; readonly confirmed: ConfirmedOp; readonly entry: DecisionRef };

export interface Evaluation {
  readonly view: LedgerView;
  readonly replay: LedgerReplay | null;
  readonly plan: RecoveryPlan;
}

const matchesOp = (entry: DecisionRef, op: LedgerOp): boolean =>
  entry.seq === op.decisionSeq &&
  entry.sha256 === op.newDecisionsHead.sha256 &&
  entry.prevSha256 === (op.prevDecisionsHead?.sha256 ?? null) &&
  entry.author === op.author &&
  entry.action === op.action &&
  entry.decisionId === op.decisionId &&
  entry.revokes === op.revokes &&
  entry.supersedes === op.supersedes &&
  entry.affectsPrior === op.affectsPrior;

export function evaluateProtection(input: ProtectionInput): Evaluation {
  const none: RecoveryPlan = { kind: 'NONE' };
  const guardStatus: GuardStatus = input.guard.status === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : input.guard.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'CONSISTENT';
  const make = (state: LedgerView['state'], reason: LedgerReason | null, replay: LedgerReplay | null, extra: Partial<LedgerView> = {}, plan: RecoveryPlan = none): Evaluation => ({
    view: {
      state,
      reason,
      head: replay?.head ?? null,
      confirmedDecisions: replay?.confirmed.length ?? 0,
      openOperation: null,
      recoverable: false,
      receiptReissuable: false,
      externalGuard: guardStatus,
      // `closing` dos DOIS slots (16.17.6): o fecho da operação de decisão aberta e o do resultado aberto
      ...(replay && input.currentKeyId ? { capacity: ledgerCapacity(replay.records, input.currentKeyId, input.checkpointEvery ?? CHECKPOINT_EVERY, input.capacityPolicy ?? LEDGER_CAPACITY_POLICY, (replay.open ? 1 : 0) + (replay.openRun ? 1 : 0)), keyCoverage: keyCoverageOf(replay.records, input.currentKeyId) } : {}),
      ...extra,
    },
    replay,
    plan,
  });
  const unresolved = (reason: LedgerReason, replay: LedgerReplay | null = null, extra: Partial<LedgerView> = {}, plan: RecoveryPlan = none): Evaluation => make('HISTORY_UNRESOLVED', reason, replay, extra, plan);

  if (!input.configured) return unresolved('NOT_CONFIGURED');
  const { read, decisions, results } = input;
  if (read.kind === 'DURABILITY_UNKNOWN') return unresolved('DURABILITY_UNKNOWN');
  if (read.kind === 'UNAVAILABLE') return unresolved('UNAVAILABLE');
  if (read.kind === 'UNTRUSTED') return unresolved('UNTRUSTED');
  if (!results.ok) return unresolved('RESULTS_EVIDENCE_UNAVAILABLE');
  if (input.guard.status === 'UNAVAILABLE') return unresolved('GUARD_UNAVAILABLE');

  const hasHistory = decisions.confirmed.length > 0 || decisions.pending !== null || results.hasResults;
  if (read.kind === 'ABSENT') {
    const guardHasRecord = input.guard.status === 'READ' && input.guard.head !== null;
    if (results.ledgerHeads.length > 0 || results.unverifiedLedgerHeads.length > 0 || guardHasRecord) return unresolved('LEDGER_REMOVED_WITNESSED', null, guardHasRecord ? { externalGuard: 'MISMATCH' } : {});
    return hasHistory ? make('LEGACY_READ_ONLY', 'LEDGER_ABSENT_WITH_HISTORY', null) : make('ENROLLMENT_PENDING', null, null);
  }

  const replayed = replayLedger(read.records, input.auditId);
  if (!replayed.ok) return unresolved('UNTRUSTED');
  const replay = replayed.value;
  if (read.tagFailure) return unresolved(read.tagFailure.reason, replay);

  const L = replay.confirmed;
  const D = decisions.confirmed;
  const P = decisions.pending;
  const entryAt = (seq: number): DecisionRef | undefined => (seq <= D.length ? D[seq - 1] : P && P.seq === seq ? P : undefined);

  // TESTEMUNHAS ANTES DE QUALQUER RECEITA (R6-05): resultado que cita o livro (`ledgerHead`) e guarda externa. Uma recuperação grava um registro NOVO (outra hora, outro
  // hash); se uma testemunha cita uma posição que o livro perdeu, recuperar tornaria a citação irrecuperável e esconderia o retrocesso. Desacordo ⇒ nada é recuperado.
  const at = (seq: number): LedgerRecord | undefined => replay.records[seq - 1];
  for (const cited of results.ledgerHeads) {
    if (at(cited.ledgerSeq)?.contentSha256 !== cited.sha256) return unresolved('RESULT_LEDGER_MISMATCH', replay);
  }
  for (const cited of results.unverifiedLedgerHeads) {
    if (at(cited.ledgerSeq)?.contentSha256 !== cited.sha256) return unresolved('UNTRUSTED', replay); // indício que contradiz o livro: não confiável
  }
  if (input.guard.status === 'READ' && input.guard.head) {
    if (at(input.guard.head.ledgerSeq)?.contentSha256 !== input.guard.head.sha256) return unresolved('GUARD_MISMATCH', replay, { externalGuard: 'MISMATCH' });
  }

  // Uma entrada publicada DEPOIS do ABORTED da sua posição: dono lento que perdeu a corrida (falha fechada, declarada).
  for (const abort of replay.aborted) {
    const found = entryAt(abort.op.decisionSeq);
    if (found && found.sha256 === abort.op.newDecisionsHead.sha256) return unresolved('PUBLISHED_AFTER_ABORT', replay);
  }
  // Cruzamento livro × decisões: prefixo comum igual.
  for (let index = 0; index < Math.min(L.length, D.length); index += 1) {
    if ((L[index] as ConfirmedOp).sha256 !== (D[index] as DecisionRef).sha256) return unresolved('HISTORY_DIVERGES', replay);
  }
  const open = replay.open;
  const openOp = open?.op;

  let phase: OpenOperation['phase'] | null = null;
  let plan: RecoveryPlan = none;
  let recoverable = false;
  let receiptReissuable = false;

  if (D.length < L.length) {
    // O livro confirma mais do que as decisões têm. Único caso explicável e recuperável: o recibo da ÚLTIMA entrada foi removido (a entrada segue lá, pendente).
    const lastConfirmed = L[L.length - 1] as ConfirmedOp;
    if (D.length === L.length - 1 && P && P.seq === lastConfirmed.decisionSeq && matchesOp(P, lastConfirmed.op) && open === null) {
      receiptReissuable = true;
      return unresolved('RECEIPT_REMOVED', replay, { receiptReissuable }, { kind: 'REISSUE_RECEIPT', confirmed: lastConfirmed, entry: P });
    }
    return unresolved('HISTORY_REGRESSED', replay);
  }
  if (D.length > L.length) {
    const extra = D[L.length] as DecisionRef;
    const explained = D.length === L.length + 1 && P === null && open !== null && openOp !== undefined && matchesOp(extra, openOp);
    if (!explained) return unresolved('UNLEDGERED_ENTRY', replay);
    if (!input.entryOriginProven(extra.seq)) return unresolved('BEHIND_UNVERIFIABLE', replay);
    phase = 'C';
    recoverable = true;
    plan = { kind: 'COMPLETE_CONFIRMED', intent: open as LedgerRecord, entry: extra };
    return unresolved('LEDGER_BEHIND', replay, { recoverable, openOperation: describeOpen(open as LedgerRecord, phase, input) }, plan);
  }
  // D.length === L.length
  if (P) {
    if (!open || !openOp || !matchesOp(P, openOp)) return unresolved('UNLEDGERED_PENDING', replay);
    phase = 'B';
  } else if (open && openOp) {
    phase = 'A';
    const age = input.ageMsOf(open.recordedAt, openOp.opId);
    plan = age >= input.staleMs ? { kind: 'ABORT', intent: open } : { kind: 'WAIT', intent: open };
    recoverable = age >= input.staleMs;
  }

  const guardBehind = input.guard.status === 'READ' && (input.guard.head === null ? replay.head.ledgerSeq > 0 : input.guard.head.ledgerSeq < replay.head.ledgerSeq);
  return make(
    'PROTECTED',
    null,
    replay,
    { openOperation: open && phase ? describeOpen(open, phase, input) : null, recoverable, externalGuard: guardBehind ? 'BEHIND' : guardStatus },
    plan,
  );
}

function describeOpen(intent: LedgerRecord, phase: OpenOperation['phase'], input: ProtectionInput): OpenOperation {
  const opId = (intent.op as LedgerOp).opId;
  const ageMs = input.ageMsOf(intent.recordedAt, opId);
  return { opId, decisionSeq: (intent.op as LedgerOp).decisionSeq, phase, ageMs, stale: ageMs >= input.staleMs };
}
