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

/**
 * Um resultado como as pastas de resultados o mostram (spec §16.17.8, "O que a testemunha entrega"). `originProven` = a etiqueta de origem do resultado é comprovada (`RUN`).
 * `finalizedBy` (e-mail) só circula entre os módulos do servidor: a vista do livro NUNCA o expõe.
 */
export interface RunRef {
  readonly seq: number;
  /** `contentSha256` do resultado (é o que o `RUN_INTENT`/`RUN_CONFIRMED` do livro cita como `runSha256`). */
  readonly sha256: string;
  readonly prevSha256: string | null;
  readonly schemaVersion: 1 | 2;
  readonly ledgerHead: LedgerHead | null;
  readonly finalizedBy: string;
  readonly originProven: boolean;
  /**
   * Id PÚBLICO da chave de ORIGEM que assinou o resultado (`origin.kid` do arquivo; `null` sem etiqueta). Nunca material, nunca prova: só diagnóstico (R1.5; portão do
   * runbook de chaves, §16.17.4/D-R1-6), exposto na vista apenas para o resultado cujo hash é o da operação aberta (`runs.open.originKid`).
   */
  readonly originKid: string | null;
}
/** Resultados ANCORADOS (com recibo), em ordem 1..n, e o pendente (a cauda sem recibo, no máximo 1). */
export interface ResultsRuns {
  readonly anchored: readonly RunRef[];
  readonly pending: RunRef | null;
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
      /** Os resultados em si (R1.2). Ausente = nenhum resultado conhecido (como as listas acima; a testemunha real sempre informa). */
      readonly runs?: ResultsRuns;
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
  | 'GUARD_UNAVAILABLE'
  /** Regra 2 da guarda (G1.b.1): guarda configurada, nenhuma cabeça publicada e o livro com ≥ 2 registros ("esqueceu" ou nunca publicou além da inscrição). */
  | 'GUARD_HEAD_MISSING'
  /** Regra 3 da guarda (G1.b.1): a guarda está atrasada mais que `L_max` registros em relação ao livro. */
  | 'GUARD_LAGGING'
  /*
   * Contradições de RESULTADO julgadas SÓ sobre R1 (spec §16.17.5; D-11, D-21): podem ser o único sinal de livro truncado ou refeito, então CONGELAM também as decisões
   * (`HISTORY_UNRESOLVED`). Não confundir com `PUBLISHED_AFTER_ABORT` (decisões).
   */
  /** `sNNNN` em R1 sem `RUN_INTENT` vivo que o explique (resultado forjado, v1 em auditoria protegida, cauda `RUN_*` removida). */
  | 'UNLEDGERED_RESULT'
  /** `sNNNN` em R1 com hash diferente do `RUN_CONFIRMED(k)` ou do `RUN_INTENT` aberto (arquivo trocado, outro conteúdo no nome). */
  | 'RESULT_DIVERGES'
  /** `sNNNN` com o `runSha256` de um `RUN_ABORTED(k)` e sem `RUN_INTENT` vivo com esse hash (dono lento que publicou depois do aborto). */
  | 'RESULT_PUBLISHED_AFTER_ABORT';

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

/** Razões da família de RESULTADOS que fecham só os resultados (spec §16.17.5, D-21): o livro autêntico continua provando as decisões. */
export type RunsReason = 'RESULT_RECEIPT_REMOVED' | 'RESULT_REGRESSED';
/** Operação de RESULTADO aberta (`RUN_INTENT` sem fecho). A fase vem da leitura de resultados mais recente (R2 se houve, senão R1; §16.17.8). */
export interface OpenRun {
  readonly runOpId: string;
  readonly runSeq: number;
  readonly runSha256: string;
  readonly phase: OperationPhase;
  readonly ageMs: number;
  readonly stale: boolean;
  /** Há receita segura agora: fase A vencida (qualquer operador aborta) ou B/C com origem comprovada (só o autor conclui). Só em `PROTECTED` e com `runs.state = OK`. */
  readonly recoverable: boolean;
  /**
   * R1.5 (pendência da R1.4, D-R1-6): id PÚBLICO da chave de origem do resultado em B/C — o `origin.kid` do `sNNNN` cujo hash é EXATAMENTE o `runSha256` deste `RUN_INTENT`
   * (o livro amarra o hash, logo também a etiqueta). `null` na fase A, sem etiqueta ou quando o que está no nome não é o resultado da operação. Para o portão do runbook
   * ("nenhuma chave de origem aposentada vence com resultado em B/C assinado por ela"); nunca material de chave, nunca identidade de pessoa.
   */
  readonly originKid: string | null;
}
/** Família de resultados no livro (spec §16.17.2): só hashes e posições, nunca identidade. */
export interface LedgerRuns {
  readonly state: 'OK' | 'UNRESOLVED';
  readonly reason: RunsReason | null;
  readonly confirmed: ReadonlyArray<{ readonly runSeq: number; readonly runSha256: string }>;
  readonly open: OpenRun | null;
  /** O recibo de um resultado já confirmado pelo livro foi removido (`RESULT_RECEIPT_REMOVED`): qualquer operador pode reemiti-lo (R1.6). */
  readonly receiptReissuable: boolean;
}

/** Vista pública do livro (sem etiquetas, chaves, caminhos nem identidades de terceiros). */
export interface LedgerView {
  readonly state: LedgerState;
  readonly reason: LedgerReason | null;
  /** Cabeça do LIVRO: o último registro, de qualquer tipo (exibição, guarda, pontos de verificação). */
  readonly head: LedgerHead | null;
  /**
   * Cabeça de DECISÕES do livro (spec §16.17.7, D-6): o último registro que NÃO é `RUN_*` (decisão, GENESIS, ABORTED, RECEIPT_REISSUED, CHECKPOINT). É a que o resultado cita
   * (`ledgerHead`) e a que a barreira compara: uma finalização nunca a move, logo nunca muda a entrada de outra.
   */
  readonly decisionHead: LedgerHead | null;
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
  /**
   * Família de RESULTADOS (spec §16.17.2). Existe sempre que o livro foi lido, autenticado (etiquetas + replay) e passou as TESTEMUNHAS (citações dos resultados e guarda; R6-05):
   * inclusive com `HISTORY_UNRESOLVED` por razão de DECISÃO (16.17.9). `openOperation`, `recoverable` e `receiptReissuable` de topo continuam SÓ de decisão.
   */
  readonly runs?: LedgerRuns;
}

export const NOT_REQUIRED_VIEW: LedgerView = Object.freeze({
  state: 'NOT_REQUIRED',
  reason: null,
  head: null,
  decisionHead: null,
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
  /** R1: a testemunha dos resultados lida ANTES do livro (§16.17.8). */
  readonly results: ResultsEvidence;
  /** A etiqueta de origem da entrada `seq` está comprovada (autor genuíno). */
  readonly entryOriginProven: (seq: number) => boolean;
  readonly nowIso: string;
  /**
   * R2 (§16.17.8, D-13): relê a testemunha dos RESULTADOS agora, DEPOIS do livro e das decisões. Na vista, só é chamada quando o modelo pede (`RUN_CONFIRMED` que R1 não mostra
   * ancorado); na gravação, imediatamente antes de qualquer gravação do livro (R7-06). O que só ela mostra nunca é acusado (pode ter sido gravado depois da leitura do livro).
   */
  readonly freshResults?: () => Promise<ResultsEvidence>;
}
export interface LedgerPrepareInput extends LedgerViewInput {
  readonly actor: string | null;
  /** Quantas vezes esta operação já releu por suspeita de corrida. */
  readonly rechecks: number;
  /** O que o chamador pretende gravar: decide a RESERVA de capacidade (`RECORD` ⇐ reserva de revogação e de manutenção; `REVOKE` ⇐ reserva de manutenção; `NONE` = manutenção, p.ex. `RECOVER`). Ausente = `RECORD`. */
  readonly intended?: 'RECORD' | 'REVOKE' | 'NONE';
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

/* ------------------------------------------------------------------ porta de ESCRITA dos resultados (R1.3, D-R1-3; spec §16.17.3) */

/** Rascunho do `RUN_INTENT`: só o que o resultado JÁ SELADO determina (spec §16.17.2). O livro acrescenta `runOpId`, posição, encadeamento, etiqueta e hash. */
export interface RunDraft {
  readonly runSeq: number;
  /** `contentSha256` do resultado anterior (`null` ⇔ `runSeq` 1). */
  readonly prevRunSha256: string | null;
  /** `contentSha256` do resultado selado que a finalização vai publicar. */
  readonly runSha256: string;
  /** `finalizedBy` (e-mail da sessão, normalizado). */
  readonly author: string;
  /** `ledgerHead` gravado no resultado = cabeça de DECISÕES do livro (§16.17.7). */
  readonly citedLedgerHead: LedgerHead;
  /** `decisions.head` gravado no resultado. */
  readonly decisionsHead: { readonly seq: number; readonly sha256: string } | null;
}

/**
 * Por que um passo da finalização pelo livro não segue. O serviço de RESULTADOS traduz para os códigos públicos dele (nenhum código HTTP novo, D-11):
 *  - `STALE_INPUT` (passo 6 (c)/(d)/I-4): há decisão aberta ou a cabeça de decisões mudou depois da barreira ⇒ `INPUT_CHANGED`;
 *  - `RUNS_UNRESOLVED` (`runs.state = UNRESOLVED`, 16.17.5) ⇒ `RESULT_INTEGRITY`;
 *  - `RUN_DEADLINE` (passo 7: prazo do dono vencido; o próprio `RUN_ABORTED` foi tentado) e `RUN_CLOSED` (a operação do dono foi fechada por outro processo antes de publicar) ⇒
 *    `RESULT_WRITE_CONFLICT`, nada publicado;
 *  - `DURABILITY_UNKNOWN` (fsync do livro) ⇒ `RESULT_DURABILITY_UNKNOWN`;
 *  - os códigos do livro (`LedgerFailureCode`) passam como estão.
 */
export type RunRefusalCode = LedgerFailureCode | 'STALE_INPUT' | 'RUNS_UNRESOLVED' | 'RUN_DEADLINE' | 'RUN_CLOSED' | 'DURABILITY_UNKNOWN';
export interface RunRefusal {
  readonly code: RunRefusalCode;
  readonly reason: LedgerReason | RunsReason | null;
  /** Frases fixas e seguras (nunca caminho, etiqueta nem identidade de terceiros). */
  readonly issues: readonly string[];
}
/** Passo de gravação do livro numa finalização. `RESTART` = o prefixo mudou (outra finalização, R0 atrasado): recomeça do passo 0, consumindo tentativa. */
export type RunStep = { readonly kind: 'OK' } | { readonly kind: 'RESTART' } | { readonly kind: 'REFUSED'; readonly refusal: RunRefusal };
/**
 * Passo 1 dentro do livro (`runPrepare`): `OK` traz a vista (com `runs`) da leitura avaliada e deixa na sessão a autorização de UM `RUN_INTENT` quando não há resultado aberto, ou
 * (R1.4) de UMA conclusão quando o resultado aberto está em B/C com receita (origem comprovada, `PROTECTED`, `runs.state = OK`, testemunha das decisões resolvida) e quem pede é
 * o AUTOR dele. `concludable` diz se esta sessão recebeu a autorização da conclusão (nunca revela a identidade do autor a quem não é ele).
 */
export type LedgerRunPrepareStep =
  | { readonly kind: 'OK'; readonly view: LedgerView; readonly concludable?: boolean }
  | { readonly kind: 'WAIT'; readonly ms: number }
  | { readonly kind: 'RETRY'; readonly ms: number; readonly transient: boolean }
  | { readonly kind: 'REFUSED'; readonly refusal: RunRefusal };
export interface LedgerRunPrepareInput extends LedgerViewInput {
  readonly actor: string;
  /** Quantas vezes esta finalização já releu por suspeita de corrida. */
  readonly rechecks: number;
  /** Se a testemunha das DECISÕES (6B) não está resolvida, o status dela (nenhuma gravação é feita); senão `null`. */
  readonly decisionsWitness?: string | null;
}
/**
 * R1.6 — o que o livro devolve à AÇÃO de reemissão do recibo de resultado (spec §16.17.5, "Reemissão do recibo de resultado confirmado"; MAJOR-3, D-10, D-12). `OK` traz a vista
 * da leitura avaliada (na ordem da §16.17.8, com a releitura R2) e o resultado CONFIRMADO cujo recibo o serviço de resultados grava — `MISSING`: o recibo foi removido (receita
 * `REISSUE_RUN_RECEIPT`); `PRESENT`: o recibo do último confirmado já existe (reenvio da ação depois de uma gravação cuja durabilidade não se comprovou, ou de outro operador): o
 * serviço o ADOTA e só sincroniza (R7-04, espelho do reuso da reemissão de decisão). Nada é gravado no livro em caso algum (D-10). Recusas: `LEDGER_ACTION_INVALID` (sem as condições:
 * nenhum resultado confirmado a reemitir, operação aberta em B/C, `runs` ausente por testemunha ou contradição, `RESULT_REGRESSED`); `DECISIONS_HISTORY_UNRESOLVED` (testemunha das
 * DECISÕES não resolvida, R7-06); `DURABILITY_UNKNOWN`, `LEDGER_NOT_CONFIGURED` e `LEDGER_UNAVAILABLE` (disponibilidade do livro ou da testemunha).
 */
export type LedgerRunReissueStep =
  | { readonly kind: 'OK'; readonly view: LedgerView; readonly run: { readonly runSeq: number; readonly runSha256: string }; readonly receipt: 'MISSING' | 'PRESENT' }
  | { readonly kind: 'REFUSED'; readonly refusal: RunRefusal };
export interface LedgerRunInput {
  /** A sessão do `runPrepare` desta finalização. */
  readonly session: unknown;
  readonly auditId: string;
  /** Quem grava (o e-mail da sessão autenticada, normalizado). */
  readonly actor: string;
  readonly nowIso: string;
}
export interface LedgerRunWriteInput extends LedgerRunInput {
  readonly run: RunDraft;
}

/**
 * O que o serviço de RESULTADOS recebe (`ResultsDeps.ledger`, opcional; D-R1-3). O LIVRO implementa as gravações (`LedgerPort.run*`); quem conhece as decisões (o serviço de
 * decisões) liga o contexto na ordem da §16.17.8 — R1 (testemunha dos resultados) → guarda → livro → decisões → R2 condicional — e a testemunha das decisões, e repassa os passos.
 */
export type ResultsLedgerContext =
  /** `concludable` (R1.4): esta sessão tem a autorização de UMA conclusão B/C (só o autor, com receita). Sem ela, o serviço de resultados recusa ANTES de gravar qualquer coisa. */
  | { readonly kind: 'OK'; readonly session: unknown; readonly view: LedgerView; readonly concludable: boolean }
  | { readonly kind: 'REFUSED'; readonly refusal: RunRefusal };
/**
 * Leitura do livro para as CONSULTAS de resultados (R1.5; spec §16.17.9, D-14): somente leitura, na ordem da §16.17.8 (R1 → guarda → livro → decisões → R2 condicional), com a
 * releitura única das razões transitórias de decisão e SEM depender das evidências (RL-27). `VIEW` traz a vista em qualquer estado (quem consulta decide o que ela permite);
 * as demais dizem que a vista NÃO pôde ser montada — dependência ilegível nunca vira "sem livro" nem `NOT_REQUIRED`: `UNAVAILABLE` (disponibilidade: armazenamento das
 * decisões ou configuração) ⇒ 503; `INTEGRITY` (o histórico de decisões não passa na verificação) ⇒ 409. Frases fixas, sem caminho.
 */
export type ResultsLedgerRead =
  | { readonly kind: 'VIEW'; readonly view: LedgerView }
  | { readonly kind: 'UNAVAILABLE'; readonly issues: readonly string[] }
  | { readonly kind: 'INTEGRITY'; readonly issues: readonly string[] };
export interface ResultsLedgerPort {
  /** Consultas de resultados (R1.5): a vista do livro, somente leitura e independente das evidências. Nunca grava, nunca autoriza gravação. */
  view(input: { readonly auditId: string; readonly nowIso: string }): Promise<ResultsLedgerRead>;
  /** Passo 1: contexto do livro e a receita da fase A (vencida ⇒ `RUN_ABORTED` depois da releitura TOCTOU; recente ⇒ espera limitada e então `LEDGER_OPERATION_IN_PROGRESS`). */
  context(input: { readonly auditId: string; readonly actor: string; readonly nowIso: string }): Promise<ResultsLedgerContext>;
  /** Passo 6: `RUN_INTENT` (ANTES de publicar o resultado). */
  intent(input: LedgerRunWriteInput): Promise<RunStep>;
  /** Passo 7: prazo do dono e releitura — imediatamente ANTES do `link()` do resultado. */
  gate(input: LedgerRunInput): Promise<RunStep>;
  /** Passo 11: `RUN_CONFIRMED` (DEPOIS do recibo durável), gravado pelo autor. */
  confirmed(input: LedgerRunWriteInput): Promise<RunStep>;
  /**
   * Conclusão B/C (R1.4; §16.17.4): `RUN_CONFIRMED` da operação de resultado ABERTA (não desta finalização), pelo AUTOR, depois do recibo (gravado na B, adotado na C) e do sync
   * estrito. Exige (e consome) a autorização do `context` desta sessão.
   */
  conclude(input: LedgerRunWriteInput): Promise<RunStep>;
  /**
   * R1.6: passos 1 e 1b da AÇÃO de reemissão do recibo de resultado (`POST …/results {"action":"REISSUE_RECEIPT"}`): a mesma leitura do `context` (R1 → guarda → livro → decisões →
   * R2) e a testemunha das decisões; de QUALQUER operador; nunca grava nem autoriza gravação no livro.
   */
  reissue(input: { readonly auditId: string; readonly actor: string; readonly nowIso: string }): Promise<LedgerRunReissueStep>;
  /**
   * R1.6: sincroniza o livro desta auditoria (pasta e raiz; `LedgerPort.sync` no modo ESTRITO) e só responde `ok` se ficou comprovadamente durável — antes do 200 do reenvio de
   * resultado já confirmado (passo 11b) e da reemissão do recibo (16.17.5). Falha de fsync ⇒ `DURABILITY_UNKNOWN`; pasta do livro ausente, insegura ou ilegível ⇒ `LEDGER_UNAVAILABLE`
   * com a razão (revisão da R1.6).
   */
  sync(input: { readonly auditId: string }): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: RunRefusal }>;
}

export interface LedgerPort {
  /** Lê o livro (antes das decisões). Devolve uma sessão opaca. */
  begin(auditId: string): Promise<unknown>;
  /** Avaliação SOMENTE LEITURA (nunca grava, nunca recupera, nunca autoriza gravação). */
  view(input: LedgerViewInput): Promise<LedgerView>;
  /** Dentro da coordenação da escrita: confere a proteção e aplica a recuperação verificável. Liberado, autoriza UMA gravação (`intent` ou `reissue`) nesta sessão. */
  prepare(input: LedgerPrepareInput): Promise<LedgerStep>;
  /** `INTENT`: ANTES de publicar a entrada. Exige (e consome) a autorização do `prepare` liberado. */
  intent(input: LedgerEntryInput): Promise<LedgerStep>;
  /** `RECEIPT_REISSUED`: ANTES de reemitir o recibo de entrada já confirmada pelo livro. Exige (e consome) a autorização do `prepare` liberado. */
  reissue(input: LedgerEntryInput): Promise<LedgerStep>;
  /** Finalização, passo 1 (§16.17.3): avalia o contexto e aplica a receita da fase A vencida de resultado. Liberado sem resultado aberto, autoriza UM `RUN_INTENT`. */
  runPrepare(input: LedgerRunPrepareInput): Promise<LedgerRunPrepareStep>;
  /** Finalização, passo 6: `RUN_INTENT` sobre o prefixo relido agora. Exige (e consome) a autorização do `runPrepare`. */
  runIntent(input: LedgerRunWriteInput): Promise<RunStep>;
  /** Finalização, passo 7: a operação do dono continua aberta e o prazo (`staleOperationMs / 2`, monotônico) não venceu; vencido ⇒ grava o próprio `RUN_ABORTED`. */
  runGate(input: LedgerRunInput): Promise<RunStep>;
  /** Finalização, passo 11: `RUN_CONFIRMED` do `RUN_INTENT` desta sessão, pelo autor. */
  runConfirmed(input: LedgerRunWriteInput): Promise<RunStep>;
  /** Conclusão B/C (R1.4): `RUN_CONFIRMED` do `RUN_INTENT` ABERTO que o `runPrepare` desta sessão autorizou concluir (só o autor). Exige (e consome) a autorização. */
  runConclude(input: LedgerRunWriteInput): Promise<RunStep>;
  /** R1.6: a reemissão do recibo de resultado confirmado (16.17.5): avalia o contexto (sanduíche com R2) e diz QUAL resultado tem o recibo a reemitir. Nunca grava (D-10). */
  runReissue(input: LedgerRunPrepareInput): Promise<LedgerRunReissueStep>;
  /** `CONFIRMED`: DEPOIS do recibo. Só então a resposta de sucesso. */
  confirmed(input: LedgerEntryInput): Promise<LedgerStep>;
  /**
   * Sincroniza (fsync) a pasta do livro desta auditoria e SÓ responde `ok` se ficou comprovadamente durável (R7-04). Usada pelo REENVIO de uma entrada que o livro já confirmou: um
   * registro que existe não prova que sobreviveria a uma queda (o fsync dele pode ter falhado antes de um reinício). `requireExisting` (revisão da R1.6): a pasta do livro da
   * auditoria TEM de existir como diretório comum e legível — senão recusa, com a razão (`LEDGER_REMOVED_WITNESSED` ausente, `NOT_CONFIGURED` forma insegura, `UNAVAILABLE` ilegível,
   * `DURABILITY_UNKNOWN` fsync); só para quem confirma o que o livro já registrou (11b e reemissão do recibo de resultado).
   */
  sync(auditId: string, options?: { readonly requireExisting?: boolean }): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
  /** Inscrição explícita de auditoria VAZIA (`GENESIS`). */
  enroll(input: LedgerEnrollInput): Promise<{ readonly ok: true; readonly view: LedgerView } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
}

export type LedgerSource = LedgerPort | typeof LEDGER_NOT_REQUIRED;
