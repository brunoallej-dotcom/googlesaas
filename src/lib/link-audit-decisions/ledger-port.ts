/*
 * PORTA do livro de cabeças, do ponto de vista da 6B (decisões). A 6B NÃO importa o módulo do livro (`link-audit-ledger`): ela fala com ele por esta
 * interface estrutural, injetada pelas rotas. Aqui moram os tipos e valores COMPARTILHADOS (o módulo do livro os importa daqui). Sem dependências.
 *
 * OBRIGATÓRIA por construção (como a testemunha): `DecisionServiceOptions.ledger` não é opcional; a dispensa é o símbolo explícito
 * `LEDGER_NOT_REQUIRED`, só para testes da 6B isolada (um teste estático garante que nada em `src/` além do serviço e deste arquivo o referencia).
 */
export const LEDGER_NOT_REQUIRED: unique symbol = Symbol('GMN_LEDGER_NOT_REQUIRED');

export interface LedgerHead {
  readonly ledgerSeq: number;
  readonly sha256: string;
}

export interface DecisionRef {
  readonly seq: number;
  readonly sha256: string;
  readonly prevSha256: string | null;
  readonly action: 'RECORD' | 'REVOKE';
  readonly author: string;
  readonly decisionId: string | null;
  readonly revokes: string | null;
  readonly supersedes: string | null;
  readonly affectsPrior: boolean;
}
export interface DecisionsSnapshot {
  /** Entradas com recibo, em ordem (seq 1..n). */
  readonly confirmed: readonly DecisionRef[];
  /** Entrada publicada e ainda sem recibo (no máximo 1). */
  readonly pending: DecisionRef | null;
}

/** O que as pastas de resultados dizem sobre a auditoria (testemunha independente do livro). */
export type ResultsEvidence =
  | {
      readonly ok: true;
      /** Existe algum resultado (confirmado ou pendente), com ou sem `ledgerHead`. */
      readonly hasResults: boolean;
      /** `ledgerHead` de resultados confirmados e de pendente com origem comprovada: testemunhas. */
      readonly ledgerHeads: readonly LedgerHead[];
      /** `ledgerHead` de pendente SEM origem comprovada: só indício (nunca testemunha). */
      readonly unverifiedLedgerHeads: readonly LedgerHead[];
    }
  | { readonly ok: false };

/* ------------------------------------------------------------------ resultado da avaliação */
export type LedgerState = 'NOT_REQUIRED' | 'LEGACY_READ_ONLY' | 'ENROLLMENT_PENDING' | 'PROTECTED' | 'HISTORY_UNRESOLVED';

export type LedgerReason =
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'UNTRUSTED'
  | 'KEY_REVOKED'
  | 'KEY_EXPIRED'
  | 'KEY_UNKNOWN'
  | 'LIMIT_REACHED'
  /** Falha de fsync (ou erro fatal de disco) neste processo: a durabilidade do que o livro contém NÃO está comprovada; nada é lido como protegido até reiniciar e provar de novo (M2). */
  | 'DURABILITY_UNKNOWN'
  | 'LEDGER_ABSENT_WITH_HISTORY'
  | 'LEDGER_REMOVED_WITNESSED'
  | 'HISTORY_REGRESSED'
  | 'HISTORY_DIVERGES'
  | 'RECEIPT_REMOVED'
  | 'UNLEDGERED_ENTRY'
  | 'UNLEDGERED_PENDING'
  | 'PUBLISHED_AFTER_ABORT'
  | 'LEDGER_BEHIND'
  | 'BEHIND_UNVERIFIABLE'
  | 'RESULT_LEDGER_MISMATCH'
  | 'RESULTS_EVIDENCE_UNAVAILABLE'
  | 'GUARD_MISMATCH'
  | 'GUARD_UNAVAILABLE';

/** `A`: INTENT sem entrada nem recibo. `B`: entrada igual ao INTENT, sem recibo (pendente). `C`: entrada e recibo presentes, sem CONFIRMED. */
export type OperationPhase = 'A' | 'B' | 'C';

export interface OpenOperation {
  readonly opId: string;
  readonly decisionSeq: number;
  readonly phase: OperationPhase;
  readonly ageMs: number;
  /** `true` quando passou do limite de inatividade: pode ser recuperada (fase A ⇒ ABORTED). */
  readonly stale: boolean;
}

export type GuardStatus = 'NOT_CONFIGURED' | 'CONSISTENT' | 'BEHIND' | 'MISMATCH' | 'UNAVAILABLE';

/**
 * CAPACIDADE do livro desta auditoria (R7-01). Todos os números saem da MESMA função que impõe o limite (nunca uma constante anunciada à parte): o que aqui se diz
 * que cabe é exatamente o que o livro consegue executar, uma operação após a outra, respeitando as reservas.
 *  - `OK`: ainda cabem decisões novas;
 *  - `REVOKE_ONLY`: decisões novas encerradas; só cabem revogações (reserva de revogação);
 *  - `EXHAUSTED`: nem revogações cabem — só manutenção (ponto de verificação, abortamento, reemissão de recibo). A auditoria precisa de INTERVENÇÃO.
 */
export type CapacityLevel = 'OK' | 'REVOKE_ONLY' | 'EXHAUSTED';
export interface LedgerCapacity {
  readonly maxRecords: number;
  readonly usedRecords: number;
  readonly remainingRecords: number;
  /** Decisões novas (criação/substituição) que ainda cabem em sequência. */
  readonly decisionsAvailable: number;
  /** Revogações completas que ainda cabem em sequência (nunca anuncia o que o livro não executa). */
  readonly revocationsAvailable: number;
  /**
   * Resultados completos (`RUN_INTENT` + fecho) que ainda cabem na classe RUN (spec §16.17.6): `⌊(RUN − registros − fechos devidos) / 2⌋`. Não entra no nível
   * (`level` é só de decisões e revogações); o teto de 500 resultados é do armazenamento.
   */
  readonly runsAvailable: number;
  readonly level: CapacityLevel;
}
/** Cobertura da rotação de chave (R7-03): `covered` = nenhum registro de OUTRA chave fica sem ponto de verificação da chave ATUAL (id público, nunca material). */
export interface LedgerKeyCoverage {
  readonly keyId: string;
  readonly covered: boolean;
  readonly otherKeyRecords: number;
}

/** Vista pública do livro (sem etiquetas, chaves, caminhos nem identidades de terceiros). */
export interface LedgerView {
  readonly state: LedgerState;
  readonly reason: LedgerReason | null;
  readonly head: LedgerHead | null;
  /** Quantas entradas de decisão o livro confirma. */
  readonly confirmedDecisions: number;
  readonly openOperation: OpenOperation | null;
  /** Há receita segura (idempotente, verificável) que um `RECOVER` ou a próxima escrita aplica (a fase C, só o AUTOR da entrada; §16.16). */
  readonly recoverable: boolean;
  /** Entrada sem recibo, mas já confirmada pelo livro: o recibo de MESMO conteúdo pode ser reemitido pelo autor. */
  readonly receiptReissuable: boolean;
  readonly externalGuard: GuardStatus;
  /** Só o livro real informa (ausente com `NOT_REQUIRED` e quando o livro ainda não tem registros). */
  readonly capacity?: LedgerCapacity;
  readonly keyCoverage?: LedgerKeyCoverage;
}

export const NOT_REQUIRED_VIEW: LedgerView = Object.freeze({
  state: 'NOT_REQUIRED',
  reason: null,
  head: null,
  confirmedDecisions: 0,
  openOperation: null,
  recoverable: false,
  receiptReissuable: false,
  externalGuard: 'NOT_CONFIGURED',
});

/** Estados em que nada é projetado como vigente, nada é finalizável e nenhuma escrita comum é aceita. */
export const isLedgerBlocking = (state: LedgerState): boolean => state !== 'PROTECTED' && state !== 'NOT_REQUIRED';

/* ------------------------------------------------------------------ a porta */
export type LedgerFailureCode =
  | 'LEDGER_ENROLLMENT_REQUIRED'
  | 'LEDGER_LEGACY_READ_ONLY'
  | 'LEDGER_NOT_CONFIGURED'
  | 'DECISIONS_HISTORY_UNRESOLVED'
  /** Fase C (§16.16): quem não é o autor da entrada não conclui o `CONFIRMED`. */
  | 'PENDING_UNCONFIRMED'
  | 'LEDGER_OPERATION_IN_PROGRESS'
  | 'LEDGER_UNAVAILABLE'
  | 'LEDGER_CAPACITY_EXHAUSTED'
  | 'LEDGER_GUARD_UNAVAILABLE'
  | 'ADMIN_APPROVAL_UNAVAILABLE'
  | 'LEDGER_ACTION_INVALID';

export interface LedgerRefusal {
  readonly code: LedgerFailureCode;
  readonly reason: LedgerReason | null;
  readonly issues: readonly string[];
  readonly view: LedgerView | null;
}

/** Resultado de um passo do protocolo. `RETRY`: relê e reavalia (`transient`: pode ser só uma corrida entre leituras). `WAIT`: operação de outro processo em andamento. */
export type LedgerStep =
  | { readonly kind: 'OK'; readonly pendingKind: 'OPEN_INTENT' | 'RECEIPT_REMOVED' | null }
  | { readonly kind: 'WAIT'; readonly ms: number }
  | { readonly kind: 'RETRY'; readonly ms: number; readonly transient: boolean }
  | { readonly kind: 'REFUSED'; readonly refusal: LedgerRefusal };

export interface LedgerViewInput {
  /** Devolvido por `begin` (o livro é lido ANTES das decisões e dos recibos). */
  readonly session: unknown;
  readonly auditId: string;
  readonly snapshot: DecisionsSnapshot;
  readonly results: ResultsEvidence;
  /** A etiqueta de origem da entrada `seq` está comprovada (autor genuíno). */
  readonly entryOriginProven: (seq: number) => boolean;
  readonly nowIso: string;
}
export interface LedgerPrepareInput extends LedgerViewInput {
  readonly actor: string | null;
  /** Quantas vezes esta operação já releu por suspeita de corrida. */
  readonly rechecks: number;
  /** O que o chamador pretende gravar: decide a RESERVA de capacidade (`RECORD` ⇐ reserva de revogação e de manutenção; `REVOKE` ⇐ reserva de manutenção; `NONE` = manutenção, p.ex. `RECOVER`). Ausente = `RECORD`. */
  readonly intended?: 'RECORD' | 'REVOKE' | 'NONE';
  /** Relê a testemunha dos RESULTADOS agora (R7-06): chamada depois da leitura do livro e imediatamente antes de qualquer gravação de recuperação/manutenção. */
  readonly freshResults?: () => Promise<ResultsEvidence>;
  /** Se a testemunha das DECISÕES (6B) não está resolvida, o status dela (nenhuma recuperação é gravada); senão `null`. */
  readonly decisionsWitness?: string | null;
  /** Sincroniza (fsync) as pastas de decisões e de recibos da auditoria; `false` = durabilidade não comprovada (R7-04: antes de completar um `CONFIRMED`). */
  readonly ensureDurable?: () => Promise<boolean>;
}
export interface LedgerEntryInput {
  readonly session: unknown;
  readonly auditId: string;
  readonly actor: string;
  readonly nowIso: string;
  readonly entry: DecisionRef;
}
export interface LedgerEnrollInput {
  readonly auditId: string;
  readonly actor: string;
  readonly snapshot: DecisionsSnapshot;
  readonly results: ResultsEvidence;
  readonly nowIso: string;
}

export interface LedgerPort {
  /** Lê o livro (antes das decisões). Devolve uma sessão opaca. */
  begin(auditId: string): Promise<unknown>;
  /** Avaliação SOMENTE LEITURA (nunca grava, nunca recupera). */
  view(input: LedgerViewInput): Promise<LedgerView>;
  /** Dentro da coordenação da escrita: confere a proteção e aplica a recuperação verificável. */
  prepare(input: LedgerPrepareInput): Promise<LedgerStep>;
  /** `INTENT`: ANTES de publicar a entrada. */
  intent(input: LedgerEntryInput): Promise<LedgerStep>;
  /** `RECEIPT_REISSUED`: ANTES de reemitir o recibo de entrada já confirmada pelo livro. */
  reissue(input: LedgerEntryInput): Promise<LedgerStep>;
  /** `CONFIRMED`: DEPOIS do recibo. Só então a resposta de sucesso. */
  confirmed(input: LedgerEntryInput): Promise<LedgerStep>;
  /**
   * Sincroniza (fsync) a pasta do livro desta auditoria e SÓ responde `ok` se ficou comprovadamente durável (R7-04). Usada pelo REENVIO de uma entrada que o livro já confirmou: um
   * registro que existe não prova que sobreviveria a uma queda (o fsync dele pode ter falhado antes de um reinício).
   */
  sync(auditId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
  /** Inscrição explícita de auditoria VAZIA (`GENESIS`). */
  enroll(input: LedgerEnrollInput): Promise<{ readonly ok: true; readonly view: LedgerView } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
}

export type LedgerSource = LedgerPort | typeof LEDGER_NOT_REQUIRED;
