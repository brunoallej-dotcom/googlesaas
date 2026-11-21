import path from 'node:path';
import type {
  CapacityLevel,
  LedgerEnrollInput,
  LedgerEntryInput,
  LedgerFailureCode,
  LedgerPort,
  LedgerPrepareInput,
  LedgerRefusal,
  LedgerRunInput,
  LedgerRunPrepareInput,
  LedgerRunPrepareStep,
  LedgerRunReissueStep,
  LedgerRunWriteInput,
  LedgerStep,
  LedgerView,
  LedgerViewInput,
  RunDraft,
  RunRefusal,
  RunRefusalCode,
  RunStep,
} from '../link-audit-decisions/ledger-port';
import type { OriginAuthenticator } from '../link-audit-origin';
import { DURABILITY_UNPROVEN_MESSAGE, seal } from '../link-audit-storage';
import { nodeFsOps, type FsOps } from '../link-audit/snapshot-store';
import { boundGuard, PROCESS_GUARD_TIMER, type ExternalGuardPort, type GuardTimer } from './guard';
import { NO_GUARD_ALARMS, type GuardAlarm, type GuardAlarmSink, type GuardPublishCause, type GuardPublishPoint } from './guard-alarm';
import { evaluateProtection, guardVerdictNeedsReread, ledgerCapacity, operationCost, pendingClosings, replayLedger, resultsGrew, rotationCheckpointDue, runIntentFits, verifyTags, type Evaluation, type GuardEvidence, type LedgerReadState, type LedgerReplay, type TagFailure } from './model';
import { monotonicNow, PROCESS_OBSERVATIONS, type OpenObservations } from './observed';
import { ensureLedgerProven, ledgerDurabilityTripped, publishLedgerRecord, readLedgerFiles, newOpId, syncLedgerDirectory, type PublishLedgerResult } from './store';
import {
  CHECKPOINT_EVERY,
  GUARD_BEHIND_ALARM_MS,
  GUARD_MAX_LAG,
  isRunEvent,
  LEDGER_CAPACITY_POLICY,
  LEDGER_KIND,
  LEDGER_RUN_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  ledgerRecordSchema,
  runAnchorName,
  type DecisionRef,
  type LedgerCapacityPolicy,
  type ResultsEvidence,
  type LedgerDraft,
  type LedgerHead,
  type LedgerOp,
  type LedgerReason,
  type LedgerRecord,
  type LedgerRun,
  type RunsReason,
} from './types';

/*
 * SERVIÇO do livro de cabeças (contrato: `onda6c-especificacao-livro-de-cabecas.md` §16). Implementa a porta que a 6B consome (`LedgerPort`).
 *
 * A exclusão mútua entre PROCESSOS não vem de memória compartilhada: duas escritas só conseguem anexar a mesma posição do livro por `link()`
 * exclusivo (o perdedor relê). O mutex em processo da 6B é só otimização. O livro é lido ANTES das decisões e dos recibos: uma escrita concorrente
 * só pode deixar as decisões à FRENTE do livro, nunca atrás de um `CONFIRMED` já lido.
 *
 * A indisponibilidade do livro NUNCA é lida como histórico vazio: leitura que falha ⇒ `HISTORY_UNRESOLVED`; pasta da auditoria ausente ⇒ o MODELO decide
 * (inscrição, modo legado ou livro removido), nunca uma cabeça vazia implícita.
 */
export interface LedgerServiceOptions {
  /** Pasta do livro (absoluta). */
  readonly dir: string;
  /** Autenticador da chave EXCLUSIVA do livro (domínio LEDGER). Nunca o de origem. */
  readonly authenticator: OriginAuthenticator;
  /** Outras pastas (decisões, recibos, resultados, recibos de resultados, evidências, manifestos): o livro não pode coincidir nem se aninhar com elas. */
  readonly otherDirs: ReadonlyArray<string | null | undefined>;
  readonly fs?: FsOps;
  readonly projectRoot?: string;
  /** Guarda externa (G1.b.1: o serviço sempre fala com ela pelo prazo de resposta e pela validação de `boundGuard`). */
  readonly guard?: ExternalGuardPort;
  /** Relógio do prazo de resposta da guarda (padrão: o do processo, 3 s por chamada). Só testes injetam outro. */
  readonly guardTimer?: GuardTimer;
  /** Porta dos alarmes da guarda (GE-E6; padrão: nenhum destino — a ligação ao logger é da G1.b.2). */
  readonly guardAlarms?: GuardAlarmSink;
  /** Inatividade a partir da qual uma operação aberta pode ser recuperada (padrão 120 s). */
  readonly staleOperationMs?: number;
  /** Intervalo de espera por uma operação de outro processo (padrão 50 ms). */
  readonly pollMs?: number;
  readonly checkpointEvery?: number;
  /** Política de capacidade (padrão = a real de 4000 registros; só testes injetam outra). */
  readonly capacityPolicy?: LedgerCapacityPolicy;
  /** Idade observada das operações abertas com hora gravada no futuro (R7-09). Padrão: o registro do processo (monotônico). Só testes injetam outro. */
  readonly observations?: OpenObservations;
  /** Relógio MONOTÔNICO do prazo do dono de uma finalização (§16.17.3, passo 7; D-22). Padrão: o do processo (`observed.ts`). Só testes injetam outro. */
  readonly monotonicMs?: () => number;
}

const WITNESS_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['RESULT_LEDGER_MISMATCH', 'UNTRUSTED', 'RESULTS_EVIDENCE_UNAVAILABLE', 'GUARD_MISMATCH', 'GUARD_HEAD_MISSING', 'GUARD_LAGGING', 'LEDGER_REMOVED_WITNESSED']);
/** Arquivo de FORMATO hostil no lugar de um registro (FIFO, soquete, diretório, link, grande demais, mudou durante a leitura): integridade, nunca "indisponível" (R7-07). */
const HOSTILE_SHAPE = /\b(?:leitura|listagem)[^:]*: (?:ENOTFILE|ETOOBIG|ECHANGED|ELOOP|EISDIR|ENOTDIR)\b/;
const READ_ERRNO = /\b(?:leitura|listagem)[^:]*: (?:E[A-Z0-9]+|DESCONHECIDO)\b/;

interface Session {
  readonly auditId: string;
  state: 'OK' | 'ABSENT' | 'UNAVAILABLE' | 'UNTRUSTED' | 'NOT_CONFIGURED' | 'DURABILITY_UNKNOWN';
  records: LedgerRecord[];
  tagFailure: TagFailure | null;
  guard: GuardEvidence;
  /** `INTENT` gravado por esta operação. */
  intent: LedgerRecord | null;
  evaluation: Evaluation | null;
  /**
   * AUTORIZAÇÃO DE USO ÚNICO (revisão da R1.2, `junin-02`): só um `prepare`/`runPrepare` LIBERADO a emite, para a gravação que ele liberou; `intent`, `reissue` e `runIntent` a
   * exigem e a consomem já na primeira chamada. `view()` (somente leitura) a revoga: uma avaliação de vista nunca vale como preparação.
   */
  grant: 'INTENT' | 'REISSUE' | 'RUN_INTENT' | 'RUN_CONCLUDE' | null;
  /** `RUN_INTENT` gravado por esta finalização (passos 7 e 11) e o instante monotônico anotado ANTES de publicá-lo (prazo do dono). */
  runIntent: LedgerRecord | null;
  runMark: number | null;
  /** R1.4: o `RUN_INTENT` ABERTO (fase B/C) cuja conclusão o `runPrepare` desta sessão autorizou ao autor (`grant = 'RUN_CONCLUDE'`). */
  concludeIntent: LedgerRecord | null;
  /** G1.b.1: alarmes da guarda já emitidos nesta sessão (um por tipo e ponto; a avaliação roda várias vezes por pedido). */
  readonly alarmed: Set<string>;
}

const anchorName = (seq: number): string => `a${String(seq).padStart(4, '0')}.json`;
/** Consome a autorização de uso único: devolve se ela era a esperada e a apaga em qualquer caso (falha fechada). */
const takeGrant = (session: Session, kind: NonNullable<Session['grant']>): boolean => {
  const granted = session.grant === kind;
  session.grant = null;
  return granted;
};
const laterOf = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);

const MESSAGES: Partial<Record<LedgerReason, string>> = {
  NOT_CONFIGURED: 'O livro de cabeças não está configurado neste servidor (pasta e chave exclusivas).',
  UNAVAILABLE: 'O armazenamento do livro de cabeças não pôde ser lido.',
  UNTRUSTED: 'O livro de cabeças não é confiável (cadeia, etiqueta ou formato não conferem).',
  KEY_REVOKED: 'Há registros do livro assinados por chave revogada por comprometimento.',
  KEY_EXPIRED: 'Há registros do livro assinados por chave aposentada vencida e sem ponto de verificação que os cubra.',
  KEY_UNKNOWN: 'Há registros do livro assinados por chave desconhecida deste servidor.',
  LIMIT_REACHED: 'O livro desta auditoria atingiu o limite de registros.',
  DURABILITY_UNKNOWN: DURABILITY_UNPROVEN_MESSAGE,
  LEDGER_REMOVED_WITNESSED: 'O livro desta auditoria sumiu, mas resultados ou a guarda externa provam que ele existiu.',
  HISTORY_REGRESSED: 'O livro confirma decisões que não existem mais nas pastas de decisões.',
  HISTORY_DIVERGES: 'Uma decisão difere da que o livro confirmou naquela posição.',
  RECEIPT_REMOVED: 'O recibo de uma decisão já confirmada pelo livro foi removido.',
  UNLEDGERED_ENTRY: 'Há decisão confirmada que o livro nunca registrou.',
  UNLEDGERED_PENDING: 'Há decisão pendente que o livro nunca registrou.',
  PUBLISHED_AFTER_ABORT: 'Uma decisão foi publicada depois de a operação ter sido abortada no livro.',
  LEDGER_BEHIND: 'O livro está atrasado em relação a uma decisão confirmada.',
  BEHIND_UNVERIFIABLE: 'O livro está atrasado e a origem da decisão não pode ser comprovada.',
  RESULT_LEDGER_MISMATCH: 'Um resultado selado cita uma posição do livro que não confere.',
  RESULTS_EVIDENCE_UNAVAILABLE: 'Os resultados (testemunha independente) não puderam ser lidos.',
  GUARD_MISMATCH: 'A guarda externa guarda uma cabeça que o livro não contém.',
  GUARD_UNAVAILABLE: 'A guarda externa não pôde ser consultada.',
  GUARD_HEAD_MISSING: 'A guarda externa não tem nenhuma cabeça publicada desta auditoria, mas o livro já tem registros além da inscrição.',
  GUARD_LAGGING: 'A guarda externa está atrasada além do limite aceito em relação ao livro.',
  // R1.5 (§16.17.5, D-11): contradições de RESULTADO que congelam também as decisões — texto próprio (o das decisões diria "decisão" e mentiria ao operador)
  UNLEDGERED_RESULT: 'Há resultado na pasta de resultados que o livro nunca registrou (sem a operação de resultado correspondente).',
  RESULT_DIVERGES: 'Um resultado difere do que o livro registrou naquela posição (arquivo trocado ou outro conteúdo no nome).',
  RESULT_PUBLISHED_AFTER_ABORT: 'Um resultado foi publicado depois de a operação de resultado ter sido abortada no livro.',
};
/** Razões da família de RESULTADOS que fecham só os resultados (§16.17.5); texto fixo, nunca eco de dado. */
const RUNS_MESSAGES: Readonly<Record<RunsReason, string>> = {
  RESULT_RECEIPT_REMOVED: 'O recibo de um resultado já confirmado pelo livro foi removido; nada foi gravado.',
  RESULT_REGRESSED: 'Um resultado confirmado pelo livro não está mais na pasta de resultados (volume restaurado sozinho ou arquivo removido); nada foi gravado.',
};
const messageOf = (reason: LedgerReason | RunsReason): string | undefined => (MESSAGES as Partial<Record<string, string>>)[reason] ?? (RUNS_MESSAGES as Partial<Record<string, string>>)[reason];
/** Gravação sem a autorização do `prepare`/`runPrepare` liberado nesta mesma sessão (p.ex. depois de só uma `view()`). */
const NOT_PREPARED_MESSAGE = 'Gravação no livro sem a preparação liberada desta mesma operação; nada foi gravado.';
/* Textos fixos da finalização pelo livro (R1.3; nunca caminho nem identidade). */
const RUN_AUTHOR_MESSAGE = 'Só o autor do resultado grava a operação de resultado no livro; nada foi gravado.';
const RUN_STALE_MESSAGE = 'O livro mudou depois da conferência da finalização (decisão aberta ou cabeça de decisões diferente); nenhum resultado foi publicado.';
const RUN_REREAD_MESSAGE = 'O livro de cabeças não pôde ser relido antes da gravação; nenhum resultado foi publicado.';
const RUN_NO_INTENT_MESSAGE = 'Não há operação de resultado aberta por esta finalização para este resultado; nada foi gravado.';
const RUN_CLOSED_MESSAGE = 'A operação desta finalização foi encerrada por outro processo antes da publicação; nenhum resultado foi publicado.';
const RUN_DEADLINE_MESSAGE = 'A finalização passou do prazo seguro entre o registro no livro e a publicação; nenhum resultado foi publicado.';
const RUN_CLOSED_BEFORE_CONFIRM_MESSAGE = 'A operação deste resultado foi encerrada por outro processo antes da confirmação; a confirmação não foi gravada e o resultado gravado NÃO vale: ele NÃO pode ser concluído por reenvio (resultado publicado depois do encerramento da operação). Trate como incidente (runbook).';
const RUN_OPEN_NO_RECIPE_MESSAGE = 'Há uma operação de resultado aberta sem receita segura nesta auditoria; nada foi gravado.';
const RUN_TOCTOU_UNAVAILABLE_MESSAGE = 'Sem como reler os resultados antes de abortar a operação de resultado; nada foi gravado.';
const RUN_REPLAY_MESSAGE = 'O registro de resultado montado violaria as invariantes do livro (erro interno); nada foi gravado.';
/* Textos fixos da conclusão B/C e dos fechos intercalados da família de resultados (R1.4; nunca caminho nem identidade). */
const RUN_CONCLUDE_NOT_AUTHOR_MESSAGE = 'Há um resultado gravado e ainda não confirmado nesta auditoria; somente o autor dele o conclui, reenviando o mesmo pedido. Nada foi gravado.';
const RUN_CLOSING_CHANGED_MESSAGE = 'Outro processo alterou o livro durante a confirmação do resultado; a confirmação não foi gravada (o resultado e o recibo existem; o autor conclui reenviando o mesmo pedido).';
const RUN_CLOSING_RETRIES_MESSAGE = 'O livro mudou a cada tentativa de gravar a confirmação do resultado; ela não foi gravada (o resultado e o recibo existem; o autor conclui reenviando o mesmo pedido).';
/* Textos fixos da reemissão do recibo de resultado (R1.6; nunca caminho nem identidade). */
const REISSUE_NOTHING_MESSAGE = 'Não há recibo de resultado a reemitir: o livro não aponta resultado confirmado com o recibo removido; nada foi gravado.';
/** Razões de DISPONIBILIDADE com que a reemissão não é avaliada (16.17.9, MINOR-3): o operador tenta de novo depois, nunca "ação inválida". */
const REISSUE_AVAILABILITY: Readonly<Partial<Record<LedgerReason, RunRefusalCode>>> = {
  DURABILITY_UNKNOWN: 'DURABILITY_UNKNOWN',
  NOT_CONFIGURED: 'LEDGER_NOT_CONFIGURED',
  UNAVAILABLE: 'LEDGER_UNAVAILABLE',
  GUARD_UNAVAILABLE: 'LEDGER_UNAVAILABLE',
  RESULTS_EVIDENCE_UNAVAILABLE: 'LEDGER_UNAVAILABLE',
};
/** O rascunho do `RUN_INTENT` com EXATAMENTE os campos do contrato (o esquema é estrito; nada do chamador passa além deles). */
const runFieldsOf = (run: RunDraft) => ({
  runSeq: run.runSeq,
  prevRunSha256: run.prevRunSha256,
  runSha256: run.runSha256,
  author: run.author,
  citedLedgerHead: { ledgerSeq: run.citedLedgerHead.ledgerSeq, sha256: run.citedLedgerHead.sha256 },
  decisionsHead: run.decisionsHead === null ? null : { seq: run.decisionsHead.seq, sha256: run.decisionsHead.sha256 },
});
/** O `RUN_INTENT` desta sessão é o deste resultado (mesmo número, encadeamento, hash, autor e citações). */
const sameDraft = (run: LedgerRun, draft: RunDraft): boolean =>
  run.runSeq === draft.runSeq &&
  run.prevRunSha256 === draft.prevRunSha256 &&
  run.runSha256 === draft.runSha256 &&
  run.author === draft.author &&
  run.citedLedgerHead.ledgerSeq === draft.citedLedgerHead.ledgerSeq &&
  run.citedLedgerHead.sha256 === draft.citedLedgerHead.sha256 &&
  (run.decisionsHead?.seq ?? null) === (draft.decisionsHead?.seq ?? null) &&
  (run.decisionsHead?.sha256 ?? null) === (draft.decisionsHead?.sha256 ?? null);

/**
 * §16.16: quem grava é o AUTOR da entrada? As duas identidades chegam já normalizadas na fronteira (`operatorOf` do serviço de decisões: sem espaços nas pontas, minúsculas;
 * `op.author` é o `recordedBy` da entrada, gravado do mesmo jeito; o `actor` do livro não admite espaço). Comparação ÚNICA, usada na fase C e na adoção do fecho (R6-04).
 */
const isEntryAuthor = (actor: string, author: string): boolean => actor === author;
/** Texto fixo da recusa da fase C a quem não é o autor (sem identidade de terceiros; §16.16). */
const PHASE_C_NOT_AUTHOR_MESSAGE = 'A decisão já tem entrada e recibo, mas o livro ainda não a confirmou; somente o autor dela a conclui, reenviando o mesmo pedido ou pela recuperação verificável do livro. Nada foi gravado.';

/**
 * FECHOS INTERCALADOS (spec §16.17.3; D-20): quantas vezes o dono regrava o MESMO fecho na nova cauda depois de um EEXIST. Mesmo limite das escritas das decisões e dos
 * resultados (`WRITE_RETRIES` dos stores). Esgotado ⇒ recusa; a decisão fica em fase C e o autor a conclui (reenvio ou `RECOVER` dele).
 */
const WRITE_RETRIES = 5;
/** Textos fixos das recusas do fecho (nunca caminho do disco). */
const CLOSING_CHANGED_MESSAGE = 'Outro processo alterou o livro durante a operação; a confirmação não foi gravada (a decisão e o recibo existem; reenvie para concluir).';
const CLOSING_UNTRUSTED_MESSAGE = 'O livro relido depois de uma gravação concorrente não confere (cadeia, etiqueta ou histórico lido); a confirmação não foi gravada.';
const CLOSING_CLOSED_MESSAGE = 'A operação desta decisão foi encerrada por outro processo antes da confirmação; a confirmação não foi gravada.';
const CLOSING_RETRIES_MESSAGE = 'O livro mudou a cada tentativa de gravar a confirmação; ela não foi gravada (a decisão e o recibo existem; reenvie para concluir).';
/**
 * G1.b.1 (spec `link-audit-production-gates.md` §5.1.7, revisão do PR #53): o CHECKPOINT da ROTAÇÃO só entra com a guarda em dia; sem conseguir publicar a cabeça atual, a
 * manutenção recusa. Texto fixo, só quando esta manutenção não gravou nada (senão a resposta é de sucesso, regra 4).
 */
const ROTATION_GUARD_MESSAGE = 'A rotação da chave do livro só grava o ponto de verificação com a guarda externa em dia nesta auditoria, e a cabeça atual não pôde ser publicada agora. Nada foi gravado. Siga o runbook da guarda: com a guarda de volta, repita a manutenção (RECOVER).';
/** Recusa transitória da releitura R2 (§16.17.8): os resultados continuaram mudando a cada releitura antes de gravar (finalizações concorrentes). Nada foi gravado. */
const RESULTS_MOVING_MESSAGE = 'Os resultados desta auditoria mudaram durante a operação (outra finalização em andamento); nada foi gravado. Tente novamente em instantes.';

export function createLedgerService(options: LedgerServiceOptions): LedgerPort {
  // Q3: o livro só aceita a chave EXCLUSIVA dele; uma chave de origem (decisões/resultados) nunca autentica o livro.
  if (options.authenticator.purpose !== 'ledger') throw new Error('o livro exige a chave exclusiva do livro (finalidade ledger)');
  const ops = options.fs ?? nodeFsOps;
  const storeOptions = { ...(options.fs ? { fs: options.fs } : {}), ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) };
  const staleMs = options.staleOperationMs ?? 120_000;
  const pollMs = options.pollMs ?? 50;
  const every = options.checkpointEvery ?? CHECKPOINT_EVERY;
  /** Política de capacidade (padrão = a real; só testes injetam uma pequena para provar o fluxo completo sem 4000 registros). */
  const policy = options.capacityPolicy ?? LEDGER_CAPACITY_POLICY;
  const auth = options.authenticator;
  const observations = options.observations ?? PROCESS_OBSERVATIONS;
  const monotonic = options.monotonicMs ?? monotonicNow;
  /** A guarda com o prazo de resposta (3 s por chamada, D-G0-3) e a validação de cada resposta: erro, prazo esgotado ou resposta fora do esquema ⇒ indisponível (regra 5). */
  const guard = options.guard ? boundGuard(options.guard, options.guardTimer ?? PROCESS_GUARD_TIMER) : undefined;
  const alarms = options.guardAlarms ?? NO_GUARD_ALARMS;

  /**
   * Alarme da guarda (GE-E6): um por tipo e ponto em cada sessão. A porta não deve lançar; se lançar, o protocolo segue igual — o alarme nunca muda o desfecho (regra de ouro
   * da spec de observabilidade, §11.1), e este módulo não tem outro canal onde registrar a falha do próprio canal de alarme.
   */
  function alarm(session: Session, event: GuardAlarm): void {
    const key = `${event.kind}:${'point' in event ? event.point : 'call' in event ? event.call : ''}`;
    if (session.alarmed.has(key)) return;
    session.alarmed.add(key);
    try {
      alarms.emit(event);
    } catch {
      // ver o comentário da função: a falha do destino do alarme não altera a resposta do livro
    }
  }

  async function overlapping(): Promise<boolean> {
    const real = async (target: string): Promise<string> => {
      try {
        return (await ops.realpath(target)).toLowerCase();
      } catch {
        return path.resolve(target).toLowerCase();
      }
    };
    const dirs = [options.dir, ...options.otherDirs.filter((dir): dir is string => typeof dir === 'string' && dir !== '')];
    const resolved = await Promise.all(dirs.map(real));
    // O livro não pode coincidir nem se aninhar com NENHUMA outra pasta (as outras entre si são problema de quem as configura, não do livro).
    const [mine, ...others] = resolved as [string, ...string[]];
    return others.some((other) => mine === other || mine.startsWith(other + path.sep) || other.startsWith(mine + path.sep));
  }

  async function begin(auditId: string): Promise<Session> {
    const session: Session = { auditId, state: 'OK', records: [], tagFailure: null, guard: { status: 'NOT_CONFIGURED' }, intent: null, evaluation: null, grant: null, runIntent: null, runMark: null, concludeIntent: null, alarmed: new Set<string>() };
    try {
      if (!path.isAbsolute(options.dir) || (await overlapping())) return { ...session, state: 'NOT_CONFIGURED' };
      // M2: depois de uma falha de fsync (ou erro fatal) neste processo a durabilidade do livro NÃO está comprovada: ele não é lido como protegido (nada vigente, nada finalizável) até reiniciar e provar de novo
      if (ledgerDurabilityTripped(options.dir, storeOptions)) return { ...session, state: 'DURABILITY_UNKNOWN' };
      // ORDEM DE LEITURA (R7-05): guarda → livro. A guarda é publicada DEPOIS de o registro entrar no livro (guarda ≤ livro em todo instante); lida primeiro, ela nunca
      // fica à frente do livro lido e uma corrida legítima não vira `GUARD_MISMATCH`.
      if (guard) {
        const latest = await guard.latest(auditId);
        session.guard = latest.ok ? { status: 'READ', head: latest.head } : { status: 'UNAVAILABLE' };
        if (!latest.ok) alarm(session, { kind: 'GUARD_UNAVAILABLE', call: 'LATEST' });
      }
      const read = await readLedgerFiles(options.dir, auditId, storeOptions);
      if (!read.ok) {
        const state = read.code === 'UNSAFE_PATH' || read.code === 'INVALID_ID' ? 'NOT_CONFIGURED' : read.code === 'STORAGE_MISSING' || (read.issues.some((issue) => READ_ERRNO.test(issue)) && !read.issues.some((issue) => HOSTILE_SHAPE.test(issue))) ? 'UNAVAILABLE' : 'UNTRUSTED';
        return { ...session, state };
      }
      if (read.value.records.length === 0) return { ...session, state: 'ABSENT' };
      // REINÍCIO NÃO É COMPROVAÇÃO: com registros no disco, a durabilidade precisa estar PROVADA neste processo (uma vez por auditoria) antes de o livro ser lido como protegido
      const proof = await ensureLedgerProven(options.dir, auditId, storeOptions);
      if (!proof.ok) return { ...session, state: 'DURABILITY_UNKNOWN' };
      const records = [...read.value.records];
      // REGRAS 2 E 3 numa corrida legítima (G1.b.1): o livro pode ter crescido entre a leitura da guarda e a dele. Só quando o veredito seria GUARD_HEAD_MISSING ou
      // GUARD_LAGGING, relê a guarda DEPOIS do livro; a leitura anterior continua sendo a única que decide o GUARD_MISMATCH (R7-05).
      if (guard && session.guard.status === 'READ' && guardVerdictNeedsReread(session.guard.head, records.length)) {
        const again = await guard.latest(auditId);
        session.guard = again.ok ? { status: 'READ', head: session.guard.head, afterLedger: again.head } : { status: 'UNAVAILABLE' };
        if (!again.ok) alarm(session, { kind: 'GUARD_UNAVAILABLE', call: 'LATEST' });
      }
      return { ...session, state: 'OK', records, tagFailure: verifyTags(records, auth) };
    } catch {
      return { ...session, state: 'UNAVAILABLE' };
    }
  }

  function readState(session: Session): LedgerReadState {
    if (session.state === 'OK') return { kind: 'PRESENT', records: session.records, tagFailure: session.tagFailure };
    if (session.state === 'ABSENT') return { kind: 'ABSENT' };
    if (session.state === 'DURABILITY_UNKNOWN') return { kind: 'DURABILITY_UNKNOWN' };
    return { kind: session.state === 'UNTRUSTED' ? 'UNTRUSTED' : 'UNAVAILABLE' };
  }

  /** Avalia sobre a leitura do livro desta sessão. `afterLedger` = R2 (releitura dos resultados POSTERIOR ao livro; §16.17.8), quando já foi feita. */
  function evaluate(session: Session, input: LedgerViewInput, afterLedger?: ResultsEvidence): Evaluation {
    const now = Date.parse(input.nowIso);
    const evaluation = evaluateProtection({
      configured: session.state !== 'NOT_CONFIGURED',
      read: readState(session),
      auditId: input.auditId,
      decisions: input.snapshot,
      entryOriginProven: input.entryOriginProven,
      results: input.results,
      ...(afterLedger ? { resultsAfterLedger: afterLedger } : {}),
      guard: session.guard,
      // R7-09: hora gravada NO FUTURO (idade de parede negativa) ⇒ a idade vem do tempo monotônico observado por este processo; senão, a de parede
      ageMsOf: (recordedAt, openKey) => {
        const wall = now - Date.parse(recordedAt);
        return wall >= 0 || openKey === undefined ? wall : observations.ageOf(`${input.auditId}:${openKey}`);
      },
      staleMs,
      currentKeyId: auth.keyId,
      checkpointEvery: every,
      capacityPolicy: policy,
    });
    session.evaluation = evaluation;
    viewAlarms(session, evaluation, now);
    return evaluation;
  }

  /** Alarmes que a VISTA mostra (GE-E6): MISMATCH, cabeça ausente (regra 2), atraso acima de `L_max` (regra 3) e `BEHIND` há mais de `T` (§5.1.7). */
  function viewAlarms(session: Session, evaluation: Evaluation, now: number): void {
    const view = evaluation.view;
    const lag = evaluation.guardLag;
    if (view.externalGuard === 'MISMATCH') alarm(session, { kind: 'GUARD_MISMATCH' });
    if (view.reason === 'GUARD_HEAD_MISSING') alarm(session, { kind: 'GUARD_HEAD_MISSING', ledgerSeq: view.head?.ledgerSeq ?? 0 });
    if (view.reason === 'GUARD_LAGGING' && lag) alarm(session, { kind: 'GUARD_LAGGING', lag: lag.lag, maxLag: GUARD_MAX_LAG });
    if (!lag || lag.lag === 0 || lag.lag > GUARD_MAX_LAG || view.reason === 'GUARD_HEAD_MISSING') return;
    // idade do atraso: relógio do servidor (a hora recebida) menos a hora gravada do PRIMEIRO registro ainda não publicado
    const firstUnpublished = session.records[lag.head?.ledgerSeq ?? 0];
    const ageMs = firstUnpublished ? now - Date.parse(firstUnpublished.recordedAt) : Number.NaN;
    if (ageMs > GUARD_BEHIND_ALARM_MS) alarm(session, { kind: 'GUARD_BEHIND_PROLONGED', lag: lag.lag, ageMs: Math.floor(ageMs) });
  }

  /** Relê os resultados agora (R2). Exceção NUNCA vira "sem resultados": vira testemunha indisponível. */
  async function reread(freshResults: () => Promise<ResultsEvidence>): Promise<ResultsEvidence> {
    try {
      return await freshResults();
    } catch {
      return { ok: false };
    }
  }

  /**
   * LEITURA "SANDUÍCHE" (§16.17.8, D-13): R1 (antes do livro) → guarda → livro → decisões → R2 SÓ quando a avaliação pede (um `RUN_CONFIRMED` que R1 não mostra ancorado). A
   * ordem é fixa e cada fonte só cresce, então a corrida legítima se resolve de forma determinística, sem releituras probabilísticas. Sem quem releia, fica a avaliação sobre R1.
   */
  async function evaluateSandwich(session: Session, input: LedgerViewInput): Promise<Evaluation> {
    const first = evaluate(session, input);
    if (!first.needsFreshResults || !input.freshResults) return first;
    return evaluate(session, input, await reread(input.freshResults));
  }

  const refusal = (code: LedgerFailureCode, view: LedgerView | null, reason: LedgerReason | null = view?.reason ?? null, extra: string[] = []): LedgerRefusal => ({
    code,
    reason,
    issues: [...(reason ? [`livro: ${reason}`, ...(MESSAGES[reason] ? [MESSAGES[reason] as string] : [])] : []), ...extra],
    view,
  });
  /** Recusa de um passo da finalização pelo livro (texto fixo; nada gravado salvo quando o texto diz o contrário). */
  const runRefused = (code: RunRefusalCode, reason: LedgerReason | RunsReason | null = null, extra: string[] = []): { readonly kind: 'REFUSED'; readonly refusal: RunRefusal } => {
    const message = reason ? messageOf(reason) : undefined;
    return { kind: 'REFUSED', refusal: { code, reason, issues: [...(reason ? [`livro: ${reason}`, ...(message ? [message] : [])] : []), ...extra] } };
  };
  /** Recusa do livro (estado ou gravação) como recusa de um passo da finalização: durabilidade não comprovada vira `DURABILITY_UNKNOWN` (R6-07: nunca sucesso). */
  const asRun = (from: LedgerRefusal): { readonly kind: 'REFUSED'; readonly refusal: RunRefusal } => ({
    kind: 'REFUSED',
    refusal: { code: from.reason === 'DURABILITY_UNKNOWN' || from.issues.includes(DURABILITY_UNPROVEN_MESSAGE) ? 'DURABILITY_UNKNOWN' : from.code, reason: from.reason, issues: from.issues },
  });
  /** Texto fixo por nível de capacidade (R7-01): nunca "erro interno", nunca caminho, e diz quando a auditoria precisa de intervenção. */
  const capacityMessage = (level: CapacityLevel): string =>
    level === 'OK'
      ? 'A capacidade do livro desta auditoria não comporta esta operação agora. Nada foi gravado.'
      : level === 'REVOKE_ONLY'
        ? 'Capacidade do livro: decisões novas encerradas; só cabem revogações (reserva de revogação). Nada foi gravado.'
        : 'Capacidade do livro ESGOTADA: nem revogações cabem. A auditoria precisa de INTERVENÇÃO (a reabertura administrativa ainda não existe). Nada foi gravado.';
  const capacityLevelOf = (session: Session): CapacityLevel => ledgerCapacity(session.records, auth.keyId, every, policy, pendingClosings(session.records)).level;
  const refused = (code: LedgerFailureCode, view: LedgerView | null, reason?: LedgerReason | null, extra?: string[]): LedgerStep => ({ kind: 'REFUSED', refusal: refusal(code, view, reason, extra) });
  const stateRefusal = (view: LedgerView): LedgerRefusal =>
    view.state === 'ENROLLMENT_PENDING'
      ? refusal('LEDGER_ENROLLMENT_REQUIRED', view, null)
      : view.state === 'LEGACY_READ_ONLY'
        ? refusal('LEDGER_LEGACY_READ_ONLY', view)
        : refusal(view.reason === 'NOT_CONFIGURED' ? 'LEDGER_NOT_CONFIGURED' : 'DECISIONS_HISTORY_UNRESOLVED', view);
  const refusedForState = (view: LedgerView): LedgerStep => ({ kind: 'REFUSED', refusal: stateRefusal(view) });
  /**
   * Passo 1 da finalização (§16.17.3) e passo 6 (a): só em `PROTECTED` e com a família de resultados resolvida. Estado ⇒ o código do estado (`refusedForState`); `runs` não resolvido
   * ⇒ `RUNS_UNRESOLVED` (o serviço de resultados responde `RESULT_INTEGRITY`). `null` = segue.
   */
  const runBlocked = (evaluation: Evaluation): { readonly kind: 'REFUSED'; readonly refusal: RunRefusal } | null => {
    const view = evaluation.view;
    if (view.state !== 'PROTECTED') return asRun(stateRefusal(view));
    if (!view.runs || view.runs.state !== 'OK') return runRefused('RUNS_UNRESOLVED', view.runs?.reason ?? null);
    return null;
  };

  /**
   * Anexa UM registro. `CONFLICT` = outro processo ocupou a posição (relê). Falha de disco ⇒ `LEDGER_UNAVAILABLE`; nada é dado como gravado. A versão do esquema segue a FAMÍLIA
   * do evento (D-3: 1 nas decisões, bytes de sempre; 2 nos `RUN_*`). `verifyReplay`: antes de publicar, o replay da cadeia COM o registro novo tem de ser válido (os `RUN_*` nunca
   * são publicados se deixariam o livro não confiável — defesa contra erro de montagem).
   */
  async function append(session: Session, draft: LedgerDraft, nowIso: string, verifyReplay = false): Promise<'OK' | 'CONFLICT' | LedgerRefusal> {
    const last = session.records[session.records.length - 1];
    // R7-02: o limite duro vale para QUALQUER registro (inclusive manutenção); o texto nunca diz "erro interno"
    if ((last?.ledgerSeq ?? 0) + 1 > policy.max) return refusal('LEDGER_CAPACITY_EXHAUSTED', null, 'LIMIT_REACHED', [capacityMessage('EXHAUSTED')]);
    const unsigned = {
      schemaVersion: isRunEvent(draft.event) ? LEDGER_RUN_SCHEMA_VERSION : LEDGER_SCHEMA_VERSION,
      kind: LEDGER_KIND,
      auditId: session.auditId,
      ledgerSeq: (last?.ledgerSeq ?? 0) + 1,
      prevSha256: last?.contentSha256 ?? null,
      ...draft,
      recordedAt: laterOf(nowIso, last?.recordedAt),
    };
    let record: LedgerRecord;
    try {
      record = seal({ ...unsigned, origin: auth.sign('LEDGER', unsigned) }) as LedgerRecord;
    } catch {
      return refusal('LEDGER_UNAVAILABLE', null, null, ['O registro do livro não pôde ser assinado; nada foi gravado.']);
    }
    const checked = ledgerRecordSchema.safeParse(record);
    if (!checked.success) return refusal('LEDGER_UNAVAILABLE', null, null, ['O registro do livro não segue o contrato (erro interno); nada foi gravado.']);
    if (verifyReplay && !replayLedger([...session.records, checked.data], session.auditId).ok) return refusal('LEDGER_UNAVAILABLE', null, null, [RUN_REPLAY_MESSAGE]);
    const published: PublishLedgerResult = await publishLedgerRecord(options.dir, checked.data, storeOptions);
    if (published.ok) {
      session.records.push(checked.data);
      session.state = 'OK'; // o livro passou a ter registros (a sessão acompanha o que gravou)
      session.tagFailure = null;
      return 'OK';
    }
    if (published.code === 'CONFLICT') return 'CONFLICT';
    // R6-03: mensagem FIXA (as do armazenamento podem citar caminhos do disco). R6-07: falha fatal/de durabilidade tem texto próprio, sem caminho (só o código do erro).
    if (published.code === 'STORAGE_FATAL') return refusal('LEDGER_UNAVAILABLE', null, null, [...published.issues]);
    return refusal('LEDGER_UNAVAILABLE', null, null, ['O livro de cabeças não pôde ser gravado; verifique o armazenamento do livro.']);
  }

  const head = (session: Session): LedgerHead | null => {
    const last = session.records[session.records.length - 1];
    return last ? { ledgerSeq: last.ledgerSeq, sha256: last.contentSha256 } : null;
  };
  /**
   * Publica a cabeça ATUAL na guarda (regra 7). `STALE` (outro processo já publicou uma cabeça maior) relê o `latest`: se a cabeça maior da guarda está no livro relido (etiquetas
   * e replay válidos, e a nossa cauda no mesmo lugar), a publicação está COBERTA — sucesso, sem alarme. Aceita ⇒ a sessão passa a saber que a guarda tem ao menos esta cabeça.
   */
  async function publishGuard(session: Session): Promise<'OK' | GuardPublishCause> {
    const tail = head(session);
    if (!guard || !tail) return 'OK';
    const published = await guard.publish({ auditId: session.auditId, ledgerSeq: tail.ledgerSeq, sha256: tail.sha256 });
    if (published.ok || (published.reason === 'STALE' && (await staleCovered(session.auditId, tail)))) {
      session.guard = { status: 'READ', head: tail };
      return 'OK';
    }
    return published.reason === 'STALE' ? 'STALE_UNCOVERED' : published.reason;
  }
  async function staleCovered(auditId: string, tail: LedgerHead): Promise<boolean> {
    if (!guard) return false;
    const latest = await guard.latest(auditId);
    if (!latest.ok || latest.head === null || latest.head.ledgerSeq <= tail.ledgerSeq) return false;
    const read = await readLedgerFiles(options.dir, auditId, storeOptions);
    if (!read.ok) return false;
    const records = read.value.records;
    if (verifyTags(records, auth) !== null || !replayLedger(records, auditId).ok) return false;
    return records[tail.ledgerSeq - 1]?.contentSha256 === tail.sha256 && records[latest.head.ledgerSeq - 1]?.contentSha256 === latest.head.sha256;
  }
  /**
   * REGRA 4 (G1.b.1, PG-G03): publicação de MELHOR ESFORÇO depois de um registro já durável no livro (pontos S1–S9 da §5.1.2). A falha nunca vira "nada foi gravado": o
   * chamador responde como antes (sucesso, ou `RUN_DEADLINE` no S9), a vista mostra `BEHIND` e o alarme sai AQUI, no ponto; a próxima publicação obrigatória recusa.
   */
  async function publishAfterRecord(session: Session, point: GuardPublishPoint): Promise<void> {
    const outcome = await publishGuard(session);
    if (outcome === 'OK') return;
    const ledgerSeq = head(session)?.ledgerSeq ?? 0;
    alarm(session, { kind: 'GUARD_PUBLISH_FAILED_AFTER_RECORD', point, cause: outcome, ledgerSeq });
    if (outcome === 'CONFLICT') alarm(session, { kind: 'GUARD_CONFLICT', ledgerSeq });
  }
  /**
   * Publicação OBRIGATÓRIA (antes de uma operação nova, do CHECKPOINT da rotação e depois do GENESIS): `null` = publicada (ou sem guarda); senão a razão da recusa
   * `LEDGER_GUARD_UNAVAILABLE` — `GUARD_UNAVAILABLE`, ou `GUARD_MISMATCH` quando a guarda tem outra cabeça na posição (`CONFLICT`) ou uma maior que o livro não contém.
   */
  async function publishRequired(session: Session): Promise<LedgerReason | null> {
    const outcome = await publishGuard(session);
    if (outcome === 'OK') return null;
    if (outcome === 'UNAVAILABLE') {
      alarm(session, { kind: 'GUARD_UNAVAILABLE', call: 'PUBLISH' });
      return 'GUARD_UNAVAILABLE';
    }
    alarm(session, outcome === 'CONFLICT' ? { kind: 'GUARD_CONFLICT', ledgerSeq: head(session)?.ledgerSeq ?? 0 } : { kind: 'GUARD_MISMATCH' });
    return 'GUARD_MISMATCH';
  }

  const opFor = (entry: DecisionRef): LedgerOp => ({
    opId: newOpId(),
    decisionSeq: entry.seq,
    prevDecisionsHead: entry.prevSha256 === null ? null : { seq: entry.seq - 1, sha256: entry.prevSha256 },
    newDecisionsHead: { seq: entry.seq, sha256: entry.sha256 },
    action: entry.action,
    author: entry.author,
    decisionId: entry.decisionId,
    revokes: entry.revokes,
    supersedes: entry.supersedes,
    affectsPrior: entry.affectsPrior,
  });

  /*
   * EEXIST nas gravações do `prepare` (CHECKPOINT, `ABORTED` da fase A vencida, `CONFIRMED` da fase C): vira `RETRY` e o laço das decisões RELÊ tudo e REAVALIA (limitado
   * pelo `WRITE_RETRIES` do store). Por isso a regra dos fechos intercalados (`reconcileClosing`) NÃO é aplicada a esses fechos, embora eles também possam colidir com o
   * CHECKPOINT de outro `RECOVER` (ex.: um que viu a fase A ainda recente — outro relógio ou idade observada, R7-09 — grava o CHECKPOINT com a operação aberta, R7-03): são
   * RECEITAS de recuperação, não o passo do dono, e precisam ser rederivadas de uma leitura nova — o `ABORTED` grava o que foi observado (entrada e recibo ausentes, idade),
   * e as conferências de R7-06 (testemunhas, `revalidate`) e a origem/durabilidade da fase C valem para CADA gravação. Regravar o mesmo registro às cegas afirmaria uma
   * observação velha. A nova tentativa já leva o fecho à nova cauda quando a receita continua valendo e não grava nada quando a operação foi fechada por outro processo.
   */
  const stepFromAppend = (result: 'OK' | 'CONFLICT' | LedgerRefusal): LedgerStep | null =>
    result === 'OK' ? null : result === 'CONFLICT' ? { kind: 'RETRY', ms: 10, transient: false } : { kind: 'REFUSED', refusal: result };

  /** Textos fixos das recusas de um fecho intercalado, por família (o das decisões fala de decisão; o dos resultados, de resultado). */
  interface ClosingTexts {
    readonly changed: string;
    readonly retries: string;
  }
  const DECISION_CLOSING: ClosingTexts = { changed: CLOSING_CHANGED_MESSAGE, retries: CLOSING_RETRIES_MESSAGE };
  const RUN_CLOSING: ClosingTexts = { changed: RUN_CLOSING_CHANGED_MESSAGE, retries: RUN_CLOSING_RETRIES_MESSAGE };

  /**
   * FECHOS INTERCALADOS (spec §16.17.3, MAJOR-2; D-20), as DUAS famílias (o `slot` diz qual: `open` = decisão, `openRun` = resultado). O `link()` do fecho do dono achou a posição
   * ocupada. Relê o livro INTEIRO e exige etiquetas e replay válidos e que a releitura ESTENDA o que esta sessão leu (o livro só cresce; o registro que abriu a operação é o mesmo).
   * Então: (ii) fecho idêntico gravado por outro processo (R6-04; `sameClosing` exige também que ele tenha sido gravado pelo AUTOR quando confirma) ⇒ `ADOPTED`; (i) a PRÓPRIA
   * operação segue aberta no slot dela ⇒ `REAPPEND`. O intruso só pode ser `CHECKPOINT`, registro da OUTRA família (D-8: um `INTENT`/`CONFIRMED`/`ABORTED` de decisão com
   * resultado aberto; o `RUN_CONFIRMED`/`RUN_ABORTED` de um resultado aberto ANTES da INTENT de decisão) ou `RECEIPT_REISSUED` (só sem decisão aberta): são os únicos que o
   * replay admite ali (I-1 recusa `RUN_INTENT` com qualquer operação aberta). (iii) Operação fechada de outro modo ⇒ `CLOSED` (o chamador diz o que isso significa na família
   * dele: na de resultados é o `RUN_CLOSED`, sem promessa de conclusão por reenvio — revisão da R1.4); cadeia que não confere ⇒ recusa. Nunca grava nada.
   */
  async function reconcileClosing(session: Session, intent: LedgerRecord, sameClosing: (record: LedgerRecord) => boolean, slot: 'open' | 'openRun', texts: ClosingTexts): Promise<'REAPPEND' | 'ADOPTED' | 'CLOSED' | LedgerRefusal> {
    const reread = await readLedgerFiles(options.dir, session.auditId, storeOptions);
    if (!reread.ok) return refusal('LEDGER_UNAVAILABLE', null, null, [texts.changed]);
    const records = reread.value.records;
    const replayed = replayLedger(records, session.auditId);
    if (verifyTags(records, auth) !== null || !replayed.ok) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_UNTRUSTED_MESSAGE]);
    const known = session.records[session.records.length - 1];
    const extendsRead = known !== undefined && records.length > session.records.length && records[known.ledgerSeq - 1]?.contentSha256 === known.contentSha256 && records[intent.ledgerSeq - 1]?.contentSha256 === intent.contentSha256;
    if (!extendsRead) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_UNTRUSTED_MESSAGE]);
    const adopted = records.some(sameClosing);
    // o registro aberto no slot desta família é o desta operação (mesmo hash ⇒ mesmo opId/runOpId e mesma cadeia até ele)
    const ownOpen = replayed.value[slot]?.contentSha256 === intent.contentSha256;
    if (!adopted && !ownOpen) return 'CLOSED';
    session.records = [...records];
    session.state = 'OK';
    session.tagFailure = null;
    return adopted ? 'ADOPTED' : 'REAPPEND';
  }

  /**
   * Grava o FECHO de uma operação aplicando a regra dos fechos intercalados (spec §16.17.3; D-20): `CONFLICT` ⇒ `reconcileClosing`; (i) regrava o MESMO fecho na nova cauda (só
   * `ledgerSeq`, `prevSha256`, `recordedAt`, etiqueta e hash mudam, calculados por `append`), até `WRITE_RETRIES` vezes, cada gravação estrita e dentro do teto duro de capacidade
   * de `append` (R7-02: o fecho já estava reservado — a abertura só entrou com espaço para ele, e o CHECKPOINT/RECEIPT_REISSUED só entram deixando o fecho de toda operação
   * aberta, 16.17.6); (ii) `ADOPTED` (o chamador sincroniza o livro antes de responder); (iii) recusa.
   */
  async function appendClosing(session: Session, intent: LedgerRecord, draft: LedgerDraft, nowIso: string, family: { readonly slot: 'open' | 'openRun'; readonly sameClosing: (record: LedgerRecord) => boolean; readonly texts: ClosingTexts; readonly verifyReplay: boolean }): Promise<'OK' | 'ADOPTED' | 'CLOSED' | LedgerRefusal> {
    for (let reappends = 0; ; reappends += 1) {
      const written = await append(session, draft, nowIso, family.verifyReplay);
      if (written === 'OK') return 'OK';
      if (written !== 'CONFLICT') return written;
      const next = await reconcileClosing(session, intent, family.sameClosing, family.slot, family.texts);
      if (next !== 'REAPPEND') return next;
      if (reappends >= WRITE_RETRIES) return refusal('LEDGER_UNAVAILABLE', null, null, [family.texts.retries]);
    }
  }

  /**
   * R6-04 na família de resultados: `record` é o `RUN_CONFIRMED` IDÊNTICO desta operação — mesmo `runOpId`, a posição do `RUN_INTENT` (`intentSeq`), o mesmo resultado (`runSha256`)
   * e a âncora dele — GRAVADO PELO AUTOR (espelho do `isEntryAuthor` da família das decisões; D-R1-1). Um fecho autêntico de outro operador nunca vale como o do autor.
   */
  const sameRunClosing = (intent: LedgerRecord) => (record: LedgerRecord): boolean => {
    const run = intent.run;
    const closing = record.run;
    return (
      record.event === 'RUN_CONFIRMED' &&
      run !== undefined &&
      closing !== undefined &&
      isEntryAuthor(record.actor, run.author) &&
      closing.runOpId === run.runOpId &&
      closing.intentSeq === intent.ledgerSeq &&
      closing.runSha256 === run.runSha256 &&
      closing.anchorRef?.headSha256 === run.runSha256
    );
  };

  /* ------------------------------------------------------------------ finalização pelo livro (R1.3; spec §16.17.3 e 16.17.4) */

  /**
   * RELEITURA do livro desta auditoria AGORA (passos 6, 7 e 11 da finalização): o prefixo sobre o qual o próximo registro vai entrar. Exige etiquetas e replay válidos e que a
   * releitura ESTENDA o que esta sessão já leu (o livro só cresce; conferir o último registro conhecido fixa o resto, pelo encadeamento). Atualiza a sessão; nunca grava.
   */
  async function rereadPrefix(session: Session): Promise<{ readonly ok: true; readonly replay: LedgerReplay } | { readonly ok: false; readonly step: { readonly kind: 'REFUSED'; readonly refusal: RunRefusal } }> {
    if (ledgerDurabilityTripped(options.dir, storeOptions)) return { ok: false, step: runRefused('DURABILITY_UNKNOWN', 'DURABILITY_UNKNOWN') };
    const read = await readLedgerFiles(options.dir, session.auditId, storeOptions);
    if (!read.ok) return { ok: false, step: runRefused('LEDGER_UNAVAILABLE', 'UNAVAILABLE', [RUN_REREAD_MESSAGE]) };
    const records = read.value.records;
    const tagFailure = verifyTags(records, auth);
    const replayed = replayLedger(records, session.auditId);
    if (tagFailure !== null || !replayed.ok) return { ok: false, step: runRefused('DECISIONS_HISTORY_UNRESOLVED', tagFailure?.reason ?? 'UNTRUSTED') };
    const known = session.records[session.records.length - 1];
    const extendsRead = known !== undefined && records.length >= session.records.length && records[known.ledgerSeq - 1]?.contentSha256 === known.contentSha256;
    if (!extendsRead) return { ok: false, step: runRefused('DECISIONS_HISTORY_UNRESOLVED', 'UNTRUSTED') };
    session.records = [...records];
    session.state = 'OK';
    session.tagFailure = null;
    return { ok: true, replay: replayed.value };
  }

  /**
   * FECHO QUE CONFIRMA um resultado (passo 11 da finalização e a conclusão B/C; R1.4). Só o AUTOR chega aqui (o chamador conferiu). Relê o prefixo (etiquetas, replay, estende o
   * lido) e: (a) a operação já foi fechada antes da releitura ⇒ só vale o `RUN_CONFIRMED` idêntico do AUTOR (R6-04: outro processo do mesmo autor concluiu antes do dono), e o
   * sucesso exige sincronizar o livro AGORA (R7-04); qualquer outro fecho (p.ex. `RUN_ABORTED` alheio) ⇒ recusa, nunca um `RUN_CONFIRMED` depois de um `RUN_ABORTED`; (b) a
   * operação segue aberta ⇒ grava o `RUN_CONFIRMED` na cauda atual com a regra dos fechos intercalados (`appendClosing`). Nunca grava fora disso.
   */
  async function closeRun(session: Session, intent: LedgerRecord, actor: string, nowIso: string): Promise<RunStep> {
    const run = intent.run as LedgerRun;
    const prefix = await rereadPrefix(session);
    if (!prefix.ok) return prefix.step;
    const matches = sameRunClosing(intent);
    let outcome: 'OK' | 'ADOPTED' | 'CLOSED' | LedgerRefusal;
    if (prefix.replay.openRun?.contentSha256 !== intent.contentSha256) {
      if (!session.records.some(matches)) return runRefused('RUN_CLOSED', null, [RUN_CLOSED_BEFORE_CONFIRM_MESSAGE]);
      outcome = 'ADOPTED';
    } else {
      const draft: LedgerDraft = { event: 'RUN_CONFIRMED', recordedAt: nowIso, actor, run: { ...run, intentSeq: intent.ledgerSeq, anchorRef: { name: runAnchorName(run.runSeq), headSha256: run.runSha256 } } };
      outcome = await appendClosing(session, intent, draft, nowIso, { slot: 'openRun', sameClosing: matches, texts: RUN_CLOSING, verifyReplay: true });
    }
    // fechada por outro processo entre a releitura e o link() (p.ex. RUN_ABORTED alheio): o resultado já publicado nunca será confirmado — RUN_CLOSED, não "reenvie"
    if (outcome === 'CLOSED') return runRefused('RUN_CLOSED', null, [RUN_CLOSED_BEFORE_CONFIRM_MESSAGE]);
    if (outcome === 'ADOPTED') {
      // o RUN_CONFIRMED adotado foi gravado por OUTRO processo e o fsync dele pode ter falhado/não ter ocorrido: o sucesso exige sincronizar o livro AGORA (R7-04)
      const synced = await syncLedgerDirectory(options.dir, session.auditId, storeOptions);
      if (!synced.ok) return asRun(refusal('LEDGER_UNAVAILABLE', null, null, [...synced.issues]));
    } else if (outcome !== 'OK') return asRun(outcome);
    await publishAfterRecord(session, 'S1');
    return { kind: 'OK' };
  }

  /** `RUN_ABORTED` de uma operação de resultado aberta em fase A: repete o `RUN_INTENT` e grava o observado (resultado e recibo ausentes, idade). */
  const runAbortDraft = (intent: LedgerRecord, ageMs: number, actor: string, nowIso: string): LedgerDraft => ({
    event: 'RUN_ABORTED',
    recordedAt: nowIso,
    actor,
    run: { ...(intent.run as LedgerRun), intentSeq: intent.ledgerSeq, observed: { resultPresent: false, receiptPresent: false, ageMs: Math.max(0, Math.floor(ageMs)) } },
  });

  /**
   * RECEITA DA FASE A VENCIDA de resultado pela FINALIZAÇÃO (§16.17.4; RL-18): qualquer operador grava `RUN_ABORTED`, e só depois de (1) a testemunha das DECISÕES resolvida
   * (R7-06 (2)); (2) RELER os resultados AGORA (R2) e conferir, sobre a MESMA leitura do livro, que `sk` e `ak` continuam ausentes (TOCTOU, espelho da §16.14): resultado novo
   * na releitura ⇒ nova tentativa limitada (a leitura seguinte vê a fase B), nunca aborto às cegas; releitura que falha ⇒ recusa. As testemunhas (citações e guarda, R6-05) já
   * decidiram na avaliação: o plano só existe em `PROTECTED`.
   */
  async function abortStaleRun(session: Session, input: LedgerRunPrepareInput, evaluation: Evaluation): Promise<{ readonly kind: 'DONE'; readonly evaluation: Evaluation } | { readonly kind: 'STOP'; readonly step: LedgerRunPrepareStep }> {
    const stop = (step: LedgerRunPrepareStep) => ({ kind: 'STOP' as const, step });
    const busy = (): LedgerRunPrepareStep => (input.rechecks < 3 ? { kind: 'RETRY', ms: 25, transient: true } : runRefused('LEDGER_OPERATION_IN_PROGRESS', null, [RESULTS_MOVING_MESSAGE]));
    if (input.decisionsWitness) return stop(runRefused('DECISIONS_HISTORY_UNRESOLVED', null, [`testemunha: ${input.decisionsWitness}`]));
    if (!input.freshResults) return stop(runRefused('LEDGER_UNAVAILABLE', null, [RUN_TOCTOU_UNAVAILABLE_MESSAGE]));
    const fresh = await reread(input.freshResults);
    if (!fresh.ok) return stop(asRun(stateRefusal(evaluate(session, input, fresh).view)));
    if (resultsGrew(input.results, fresh)) return stop(busy());
    const again = evaluate(session, input, fresh);
    const blocked = runBlocked(again);
    if (blocked) return stop(blocked);
    // a MESMA operação continua vencida e com o lugar vazio sobre R1 + R2; qualquer mudança ⇒ nova tentativa, nunca aborto às cegas
    const target = evaluation.runPlan.kind === 'ABORT_RUN' ? evaluation.runPlan.intent.contentSha256 : null;
    if (again.runPlan.kind !== 'ABORT_RUN' || again.runPlan.intent.contentSha256 !== target) return stop(busy());
    const written = await append(session, runAbortDraft(again.runPlan.intent, again.runPlan.ageMs, input.actor, input.nowIso), input.nowIso, true);
    if (written === 'CONFLICT') return stop({ kind: 'RETRY', ms: 10, transient: false });
    if (written !== 'OK') return stop(asRun(written));
    await publishAfterRecord(session, 'S2');
    const after = evaluate(session, input, fresh);
    const afterBlocked = runBlocked(after);
    return afterBlocked ? stop(afterBlocked) : { kind: 'DONE', evaluation: after };
  }

  return {
    begin,

    async view(input) {
      const session = input.session as Session;
      session.grant = null; // somente leitura: nunca vale como preparação (`junin-02`)
      session.concludeIntent = null;
      return (await evaluateSandwich(session, input)).view;
    },

    async prepare(input: LedgerPrepareInput): Promise<LedgerStep> {
      const session = input.session as Session;
      session.grant = null;
      const actor = input.actor ?? 'system';
      const intended = input.intended ?? 'RECORD';
      /** Registros antes desta preparação: a manutenção sabe se já gravou uma receita (regra 4) antes de recusar a rotação. */
      const startLength = session.records.length;
      let evaluation = evaluate(session, input);
      let view = evaluation.view;
      if (view.state === 'ENROLLMENT_PENDING' || view.state === 'LEGACY_READ_ONLY') return refusedForState(view);

      /** R7-06 (2): a testemunha das DECISÕES (6B) não resolvida impede QUALQUER gravação de recuperação/manutenção do livro. */
      const witnessBlock = (): LedgerStep | null => (input.decisionsWitness ? refused('DECISIONS_HISTORY_UNRESOLVED', view, null, [`testemunha: ${input.decisionsWitness}`]) : null);
      /**
       * R7-06 (1): ANTES de cada gravação relê a testemunha dos RESULTADOS agora e reavalia sobre a MESMA leitura do livro. Essa releitura é POSTERIOR ao livro, logo é R2 (§16.17.8,
       * MINOR-1), nunca a testemunha anterior ao livro: (a) releitura que falha ⇒ recusa; (b) resultado, recibo ou citação que R1 não mostrava pode ter sido gravado DEPOIS da leitura
       * do livro (uma finalização concorrente) ⇒ relê TUDO, limitado (`rechecks`), para que ele seja julgado como R1 contra o livro relido — nunca acusação; esgotado ⇒ recusa
       * transitória, sem gravar; (c) nada novo ⇒ avalia com R1 + R2 (R2 só decide o que o livro cita e a fase do resultado aberto). As razões de resultado nunca entram em
       * `WITNESS_REASONS`. Uma contradição real (resultado selado entre a leitura e a gravação que contradiz o livro) é recusada na releitura, antes de qualquer gravação.
       */
      const revalidate = async (): Promise<LedgerStep | null> => {
        if (!input.freshResults) return null;
        const fresh = await reread(input.freshResults);
        if (!fresh.ok) return refusedForState(evaluate(session, { ...input, results: fresh }).view);
        if (resultsGrew(input.results, fresh)) return input.rechecks < 3 ? { kind: 'RETRY', ms: 25, transient: true } : refused('LEDGER_OPERATION_IN_PROGRESS', view, null, [RESULTS_MOVING_MESSAGE]);
        const again = evaluate(session, input, fresh);
        const same = again.view.state === evaluation.view.state && again.view.reason === evaluation.view.reason && again.plan.kind === evaluation.plan.kind;
        if (same) {
          evaluation = again;
          view = again.view;
          return null;
        }
        if (again.view.state === 'HISTORY_UNRESOLVED' && again.view.reason !== null && WITNESS_REASONS.has(again.view.reason)) return refusedForState(again.view);
        return input.rechecks < 3 ? { kind: 'RETRY', ms: 25, transient: true } : refusedForState(again.view);
      };

      if (view.state === 'HISTORY_UNRESOLVED') {
        // Pode ser só uma corrida entre as leituras (livro lido antes; decisões já à frente): relê algumas vezes antes de acusar.
        if ((view.reason === 'UNLEDGERED_ENTRY' || view.reason === 'UNLEDGERED_PENDING') && input.rechecks < 3) return { kind: 'RETRY', ms: 25, transient: true };
        const plan = evaluation.plan;
        if (plan.kind === 'REISSUE_RECEIPT') {
          // A reemissão GRAVA (`RECEIPT_REISSUED`, que pela D-6 move a cabeça de decisões): as mesmas conferências de R7-06, na mesma ordem dos outros ramos, antes de liberar —
          // testemunha das decisões e releitura R2 dos resultados (§16.17.8). Revisão independente da R1.2 (`junin-02`): antes liberava sem nenhuma (desvio desde a 6C).
          // Só o reenvio do AUTOR passa pela 6B.
          const blocked = witnessBlock();
          if (blocked) return blocked;
          const stale = await revalidate();
          if (stale) return stale;
          // autoriza UMA reemissão nesta sessão — salvo para a manutenção (`RECOVER`), que nunca reemite
          session.grant = intended === 'NONE' ? null : 'REISSUE';
          return { kind: 'OK', pendingKind: 'RECEIPT_REMOVED' };
        }
        if (plan.kind !== 'COMPLETE_CONFIRMED') return refusedForState(view);
        // Spec §16.16 (16/11/2026): a fase C só é concluída pelo AUTOR da entrada (os recibos não são autenticados: recibo forjado por quem escreve só na pasta de recibos
        // não pode promover a pendente de outro operador). Escrita ou RECOVER de quem não é o autor: recusa, nada gravado; a pendente segue bloqueando (como na fase B).
        if (!isEntryAuthor(actor, plan.entry.author)) return refused('PENDING_UNCONFIRMED', view, null, [PHASE_C_NOT_AUTHOR_MESSAGE]);
        // Fase C: o livro ficou um registro atrás (queda entre o recibo e o CONFIRMED). Conclui-se SOMENTE o verificável: origem comprovada (no modelo), testemunhas
        // frescas (resultados e decisões) e entrada + recibo comprovadamente DURÁVEIS (R7-04) antes de o CONFIRMED existir.
        const blocked = witnessBlock();
        if (blocked) return blocked;
        const stale = await revalidate();
        if (stale) return stale;
        if (input.ensureDurable && !(await input.ensureDurable())) return refused('LEDGER_UNAVAILABLE', view, null, [DURABILITY_UNPROVEN_MESSAGE]);
        const intentOp = plan.intent.op as LedgerOp;
        const written = await append(session, { event: 'CONFIRMED', recordedAt: input.nowIso, actor, op: { ...intentOp, intentSeq: plan.intent.ledgerSeq, anchorRef: { name: anchorName(plan.entry.seq), headSha256: plan.entry.sha256 } } }, input.nowIso);
        const stop = stepFromAppend(written);
        if (stop) return stop;
        await publishAfterRecord(session, 'S3');
        evaluation = evaluate(session, input);
        view = evaluation.view;
        if (view.state !== 'PROTECTED') return refusedForState(view);
      }

      // PROTECTED
      if (evaluation.plan.kind === 'ABORT') {
        const blocked = witnessBlock();
        if (blocked) return blocked;
        const stale = await revalidate();
        if (stale) return stale;
        if (evaluation.plan.kind === 'ABORT') {
          const intent = evaluation.plan.intent;
          const intentOp = intent.op as LedgerOp;
          // EEXIST (p.ex. o CHECKPOINT de outro RECOVER) ⇒ RETRY com releitura e reavaliação, nunca regravação cega (ver o comentário de `stepFromAppend`)
          const written = await append(session, { event: 'ABORTED', recordedAt: input.nowIso, actor, op: { ...intentOp, intentSeq: intent.ledgerSeq, observed: { entryPresent: false, receiptPresent: false, ageMs: Math.max(0, view.openOperation?.ageMs ?? 0) } } }, input.nowIso);
          const stop = stepFromAppend(written);
          if (stop) return stop;
          await publishAfterRecord(session, 'S4');
          evaluation = evaluate(session, input);
          view = evaluation.view;
          if (view.state !== 'PROTECTED') return refusedForState(view);
        }
      }

      // RECOVER (só a manutenção; escritas de decisão nunca aplicam receita de resultado, §16.17.4): aborta a fase A VENCIDA de resultado (`RUN_ABORTED`, qualquer operador) com as
      // mesmas conferências das outras receitas — testemunha das decisões e releitura R2 dos resultados (TOCTOU: `sk` e `ak` ainda ausentes) — e nunca conclui B/C (D-12).
      if (intended === 'NONE' && evaluation.runPlan.kind === 'ABORT_RUN') {
        const blocked = witnessBlock();
        if (blocked) return blocked;
        if (!input.freshResults) return refused('LEDGER_UNAVAILABLE', view, null, [RUN_TOCTOU_UNAVAILABLE_MESSAGE]);
        const before = evaluation.runPlan.intent.contentSha256;
        const stale = await revalidate();
        if (stale) return stale;
        if (evaluation.runPlan.kind === 'ABORT_RUN' && evaluation.runPlan.intent.contentSha256 === before) {
          const written = await append(session, runAbortDraft(evaluation.runPlan.intent, evaluation.runPlan.ageMs, actor, input.nowIso), input.nowIso, true);
          const stop = stepFromAppend(written);
          if (stop) return stop;
          await publishAfterRecord(session, 'S5');
          evaluation = evaluate(session, input);
          view = evaluation.view;
          if (view.state !== 'PROTECTED') return refusedForState(view);
        }
      }

      // MANUTENÇÃO pedida (`RECOVER`): grava o ponto de verificação da chave ATUAL quando a rotação ainda não está coberta — também COM operação aberta (R7-03: o replay aceita o
      // CHECKPOINT entre a INTENT e o fecho). Deixa sempre 1 registro livre para fechar CADA operação aberta, de decisão e de resultado (§16.17.6, MINOR-2: `len + 1 + closing ≤ MAX`;
      // uma operação iniciada nunca fica sem como terminar).
      if (intended === 'NONE') {
        if (rotationCheckpointDue(session.records, auth.keyId)) {
          const closing = pendingClosings(session.records);
          if (session.records.length + 1 + closing > policy.max) return refused('LEDGER_CAPACITY_EXHAUSTED', view, 'LIMIT_REACHED', [capacityMessage('EXHAUSTED')]);
          const blocked = witnessBlock();
          if (blocked) return blocked;
          const stale = await revalidate();
          if (stale) return stale;
          // G1.b.1 (§5.1.7, revisão do PR #53): com a guarda configurada, o CHECKPOINT da rotação só entra com `externalGuard` = CONSISTENT — publicação OBRIGATÓRIA da
          // cabeça atual antes dele, como numa operação nova. Sem isso, cada rotação dentro da mesma janela somaria 1 ao atraso e passaria de `L_max` (GUARD_LAGGING, sem
          // reabertura). Não publicou: recusa se esta manutenção ainda não gravou nada; se já gravou uma receita (S3–S5), a resposta é de sucesso (regra 4) e a rotação
          // continua descoberta na vista até a próxima manutenção.
          let guardReady = !guard || view.externalGuard === 'CONSISTENT';
          if (!guardReady && (await publishRequired(session)) === null) {
            evaluation = evaluate(session, input);
            view = evaluation.view;
            guardReady = view.state === 'PROTECTED' && view.externalGuard === 'CONSISTENT';
          }
          if (!guardReady && session.records.length === startLength) return refused('LEDGER_GUARD_UNAVAILABLE', view, null, [ROTATION_GUARD_MESSAGE]);
          if (guardReady) {
            const tail = head(session) as LedgerHead;
            const written = await append(session, { event: 'CHECKPOINT', recordedAt: input.nowIso, actor, checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.sha256 } }, input.nowIso);
            const stop = stepFromAppend(written);
            if (stop) return stop;
            await publishAfterRecord(session, 'S6');
            evaluation = evaluate(session, input);
            view = evaluation.view;
          }
        }
        // R7-04: o sucesso da manutenção diz que o livro desta auditoria está DURÁVEL — também quando o registro já existia e nada foi gravado agora
        if (session.records.length > 0) {
          const synced = await syncLedgerDirectory(options.dir, session.auditId, storeOptions);
          if (!synced.ok) return refused('LEDGER_UNAVAILABLE', view, null, [...synced.issues]);
        }
        return { kind: 'OK', pendingKind: view.openOperation?.phase === 'B' ? 'OPEN_INTENT' : null };
      }

      if (evaluation.plan.kind === 'WAIT') return { kind: 'WAIT', ms: pollMs };
      if (view.openOperation?.phase === 'B') return { kind: 'OK', pendingKind: 'OPEN_INTENT' };
      if (view.openOperation) return { kind: 'WAIT', ms: pollMs };

      // CAPACIDADE (R7-01): a classe da operação decide o limite; sem espaço para o ponto de verificação (se devido) + INTENT + fecho, recusa ANTES de gravar qualquer coisa.
      const cost = operationCost(session.records, auth.keyId, every, intended, policy);
      if (cost === null) return refused('LEDGER_CAPACITY_EXHAUSTED', view, 'LIMIT_REACHED', [capacityMessage(capacityLevelOf(session))]);
      const blocked = witnessBlock();
      if (blocked) return blocked;
      const stale = await revalidate();
      if (stale) return stale;
      // Guarda externa configurada: a cabeça atual publicada ANTES de qualquer gravação da operação nova — inclusive o ponto de verificação automático (G1.b.1). Publicação
      // recusada ⇒ nada novo entra no livro: o CHECKPOINT nunca fica sem publicação depois de uma recusa (com a ordem antiga, cada rotação somava 1 ao atraso e a inscrição
      // com a publicação falha chegava a 2 registros sem cabeça, GUARD_HEAD_MISSING).
      if (guard) {
        const failed = await publishRequired(session);
        if (failed) return refused('LEDGER_GUARD_UNAVAILABLE', view, failed);
      }
      // Ponto de verificação (primeira escrita depois de uma rotação de chave e a cada N registros).
      if (cost.checkpoint) {
        const tail = head(session) as LedgerHead;
        const written = await append(session, { event: 'CHECKPOINT', recordedAt: input.nowIso, actor, checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.sha256 } }, input.nowIso);
        const stop = stepFromAppend(written);
        if (stop) return stop;
      }
      session.grant = 'INTENT'; // autoriza UMA INTENT nesta sessão (consumida pelo `intent`)
      return { kind: 'OK', pendingKind: null };
    },

    async intent(input: LedgerEntryInput): Promise<LedgerStep> {
      const session = input.session as Session;
      // PONTO AUTORITATIVO da capacidade (R7-01): vale para a posição que esta INTENT vai ocupar. Se outro processo ocupar a posição o `link()` exclusivo falha (CONFLICT) e
      // a reavaliação recomeça com o livro novo — a verificação é coordenada entre processos pelo próprio disco. A INTENT só entra se ela e o registro que a fecha cabem na classe,
      // sem tomar o fecho reservado de um resultado aberto (§16.17.6: `len + 2 + openRun ≤ classe`).
      // A autorização do `prepare` liberado é consumida já aqui (uso único, `junin-02`); a capacidade continua conferida antes, sozinha (a porta se defende mesmo sem preparação).
      const granted = takeGrant(session, 'INTENT');
      const cls = input.entry.action === 'REVOKE' ? 'REVOKE' : 'RECORD';
      if (session.records.length + 2 + pendingClosings(session.records) > policy[cls]) return refused('LEDGER_CAPACITY_EXHAUSTED', null, 'LIMIT_REACHED', [capacityMessage(capacityLevelOf(session))]);
      if (!granted) return refused('LEDGER_UNAVAILABLE', null, null, [NOT_PREPARED_MESSAGE]);
      const written = await append(session, { event: 'INTENT', recordedAt: input.nowIso, actor: input.actor, op: opFor(input.entry) }, input.nowIso);
      const stop = stepFromAppend(written);
      if (stop) return stop;
      session.intent = session.records[session.records.length - 1] as LedgerRecord;
      return { kind: 'OK', pendingKind: null };
    },

    async reissue(input: LedgerEntryInput): Promise<LedgerStep> {
      const session = input.session as Session;
      // só depois de um `prepare` LIBERADO para esta reemissão (uso único): uma `view()` deixa o plano na sessão, mas não autoriza gravar (`junin-02`)
      if (!takeGrant(session, 'REISSUE')) return refused('LEDGER_UNAVAILABLE', null, null, [NOT_PREPARED_MESSAGE]);
      const plan = session.evaluation?.plan;
      if (!plan || plan.kind !== 'REISSUE_RECEIPT' || plan.entry.sha256 !== input.entry.sha256) return refused('LEDGER_UNAVAILABLE', null, null, ['Reemissão de recibo sem a confirmação correspondente no livro; nada foi gravado.']);
      const confirmed = plan.confirmed;
      // Reemissão JÁ registrada para este recibo (tentativa anterior cujo recibo falhou, p.ex. ENOSPC): a evidência existe — não grava OUTRO registro por tentativa. Sem isto, reenvios repetidos com o
      // recibo falhando consomem a reserva de revogação e de manutenção e travam a auditoria para sempre (reproduzido). Custo declarado: remoções repetidas do MESMO recibo ficam registradas uma vez só.
      const alreadyRecorded = session.records.some((record) => record.event === 'RECEIPT_REISSUED' && record.ledgerSeq > confirmed.confirmedSeq && record.op?.opId === confirmed.op.opId && record.op.anchorRef?.headSha256 === input.entry.sha256);
      if (alreadyRecorded) {
        // D1: "já registrada" NÃO prova "durável" — o registro pode ter sido publicado por outra tentativa/processo cujo fsync falhou. O reuso só vale depois de sincronizar o livro AGORA (pasta + raiz).
        const synced = await syncLedgerDirectory(options.dir, session.auditId, storeOptions);
        if (!synced.ok) return refused('LEDGER_UNAVAILABLE', null, null, [...synced.issues]);
        return { kind: 'OK', pendingKind: null };
      }
      // §16.17.6 (MINOR-2): a reemissão não fecha operação — só entra deixando o fecho de toda operação aberta (o RUN_CONFIRMED/RUN_ABORTED de um resultado aberto).
      if (session.records.length + 1 + pendingClosings(session.records) > policy.max) return refused('LEDGER_CAPACITY_EXHAUSTED', null, 'LIMIT_REACHED', [capacityMessage('EXHAUSTED')]);
      const written = await append(session, { event: 'RECEIPT_REISSUED', recordedAt: input.nowIso, actor: input.actor, op: { ...confirmed.op, intentSeq: confirmed.intentSeq, anchorRef: { name: anchorName(input.entry.seq), headSha256: input.entry.sha256 } } }, input.nowIso);
      const stop = stepFromAppend(written);
      if (stop) return stop;
      await publishAfterRecord(session, 'S7');
      return { kind: 'OK', pendingKind: null };
    },

    async confirmed(input: LedgerEntryInput): Promise<LedgerStep> {
      const session = input.session as Session;
      const intent = session.intent ?? session.evaluation?.replay?.open ?? null;
      const intentOp = intent?.op;
      if (!intent || !intentOp || intentOp.newDecisionsHead.sha256 !== input.entry.sha256) return refused('LEDGER_UNAVAILABLE', null, null, ['Não há INTENT do livro para esta entrada; a confirmação não foi gravada.']);
      // O conteúdo do fecho não depende da posição: numa regravação só `ledgerSeq`, `prevSha256`, `recordedAt`, etiqueta e hash mudam (calculados por `append`).
      const draft: LedgerDraft = { event: 'CONFIRMED', recordedAt: input.nowIso, actor: input.actor, op: { ...intentOp, intentSeq: intent.ledgerSeq, anchorRef: { name: anchorName(input.entry.seq), headSha256: input.entry.sha256 } } };
      // R6-04: o MESMO `CONFIRMED` desta operação gravado por outro processo (opId, posição da INTENT e entrada ancorada) — e, pela §16.16, gravado pelo AUTOR: um CONFIRMED
      // autêntico de outro operador (código que deixasse um não autor concluir a fase C) não é adotado; cai no caso (iii) e o dono recusa sem gravar.
      const sameClosing = (record: LedgerRecord): boolean =>
        record.event === 'CONFIRMED' && isEntryAuthor(record.actor, intentOp.author) && record.op?.opId === intentOp.opId && record.op.intentSeq === intent.ledgerSeq && record.op.anchorRef?.headSha256 === input.entry.sha256;
      // (i) a própria operação segue aberta atrás de um registro alheio (CHECKPOINT ou o fecho de um resultado aberto): regrava o MESMO fecho na nova cauda, limitado; (ii) adota
      const written = await appendClosing(session, intent, draft, input.nowIso, { slot: 'open', sameClosing, texts: DECISION_CLOSING, verifyReplay: false });
      if (written === 'CLOSED') return refused('LEDGER_UNAVAILABLE', null, null, [CLOSING_CLOSED_MESSAGE]);
      if (written === 'ADOPTED') {
        // R7-04: o CONFIRMED adotado foi gravado por OUTRO processo e o fsync dele pode ter falhado/não ter ocorrido: o sucesso do dono exige sincronizar o livro AGORA
        const adopted = await syncLedgerDirectory(options.dir, session.auditId, storeOptions);
        if (!adopted.ok) return refused('LEDGER_UNAVAILABLE', null, null, [...adopted.issues]);
      } else if (written !== 'OK') return { kind: 'REFUSED', refusal: written };
      await publishAfterRecord(session, 'S8');
      return { kind: 'OK', pendingKind: null };
    },

    async runPrepare(input: LedgerRunPrepareInput): Promise<LedgerRunPrepareStep> {
      const session = input.session as Session;
      session.grant = null;
      session.runIntent = null;
      session.runMark = null;
      session.concludeIntent = null;
      // leitura "sanduíche" (§16.17.8): R1 → guarda → livro → decisões → R2 só se a avaliação pedir
      let evaluation = await evaluateSandwich(session, input);
      // passo 1: `runs` não resolvido ⇒ RESULT_INTEGRITY. Estado que não é `PROTECTED`: nenhuma receita e NENHUMA autorização de RUN_INTENT — a avaliação da própria finalização o
      // recusa adiante (`NOT_FINALIZABLE`, com os bloqueios, como antes da R1.3), e o passo 6 (a) recusaria pelo código do estado se ela chegasse lá (falha fechada nos dois).
      const runs = evaluation.view.runs;
      if (runs && runs.state !== 'OK') return runRefused('RUNS_UNRESOLVED', runs.reason);
      if (evaluation.view.state !== 'PROTECTED') return { kind: 'OK', view: evaluation.view };
      const blocked = runBlocked(evaluation);
      if (blocked) return blocked;
      if (evaluation.runPlan.kind === 'WAIT_RUN') return { kind: 'WAIT', ms: pollMs };
      if (evaluation.runPlan.kind === 'ABORT_RUN') {
        const aborted = await abortStaleRun(session, input, evaluation);
        if (aborted.kind === 'STOP') return aborted.step;
        evaluation = aborted.evaluation;
      }
      const open = evaluation.view.runs?.open ?? null;
      // fase A sem receita (vencida com o lugar ocupado, ou ainda dentro do prazo depois de uma releitura): nada a fazer com segurança agora
      if (open !== null && open.phase === 'A') return runRefused('LEDGER_OPERATION_IN_PROGRESS', null, [RUN_OPEN_NO_RECIPE_MESSAGE]);
      // sem resultado aberto: autoriza UM RUN_INTENT nesta sessão (a testemunha das decisões resolvida também é condição; a finalização a confere de novo na barreira)
      if (open === null && !input.decisionsWitness) session.grant = 'RUN_INTENT';
      // R1.4 (§16.17.4): fase B/C COM RECEITA (`CONCLUDE_RUN`: origem comprovada pela testemunha, PROTECTED, runs OK) e quem pede é o AUTOR do resultado aberto (e-mail da sessão
      // normalizado na fronteira === `run.author`), com a testemunha das decisões resolvida ⇒ autoriza UMA conclusão nesta sessão. Os demais recebem a vista, sem autorização: o
      // serviço de resultados recusa ANTES de gravar (RESULT_PENDING_UNCONFIRMED / RESULT_PENDING_ORIGIN_UNPROVEN). O `RECOVER` nunca passa por aqui (D-12).
      const plan = evaluation.runPlan;
      if (open !== null && plan.kind === 'CONCLUDE_RUN' && plan.intent.run && !input.decisionsWitness && isEntryAuthor(input.actor, plan.intent.run.author)) {
        session.grant = 'RUN_CONCLUDE';
        session.concludeIntent = plan.intent;
      }
      return { kind: 'OK', view: evaluation.view, concludable: session.grant === 'RUN_CONCLUDE' };
    },

    async runIntent(input: LedgerRunWriteInput): Promise<RunStep> {
      const session = input.session as Session;
      // autorização de uso ÚNICO do `runPrepare` liberado nesta sessão (sem resultado aberto), consumida já na primeira chamada
      if (!takeGrant(session, 'RUN_INTENT')) return runRefused('LEDGER_UNAVAILABLE', null, [NOT_PREPARED_MESSAGE]);
      const run = input.run;
      if (!isEntryAuthor(input.actor, run.author)) return runRefused('LEDGER_UNAVAILABLE', null, [RUN_AUTHOR_MESSAGE]);
      // o prefixo AGORA: é sobre ele que o `link()` exclusivo da posição torna a admissão autoritativa (quem chegar antes ocupa a posição e este recomeça)
      const prefix = await rereadPrefix(session);
      if (!prefix.ok) return prefix.step;
      const replay = prefix.replay;
      // (c)/(d): decisão aberta, ou cabeça de decisões que não é a citada pelo resultado selado ⇒ a entrada mudou depois da barreira (INPUT_CHANGED), nada publicado
      if (replay.open !== null || replay.decisionHead.ledgerSeq !== run.citedLedgerHead.ledgerSeq || replay.decisionHead.sha256 !== run.citedLedgerHead.sha256) return runRefused('STALE_INPUT', null, [RUN_STALE_MESSAGE]);
      // (b): outra finalização abriu uma operação de resultado ⇒ recomeça do passo 0
      if (replay.openRun !== null) return { kind: 'RESTART' };
      // (e) I-2: o resultado encadeia no último RUN_CONFIRMED (senão a leitura R0 ficou atrás do livro) ⇒ recomeça
      const lastRun = replay.confirmedRuns[replay.confirmedRuns.length - 1];
      if (run.runSeq !== replay.confirmedRuns.length + 1 || run.prevRunSha256 !== (lastRun?.runSha256 ?? null)) return { kind: 'RESTART' };
      // (e) I-4: as decisões citadas são as do último CONFIRMED ⇒ senão a entrada mudou
      const lastDecision = replay.confirmed[replay.confirmed.length - 1];
      if ((run.decisionsHead?.seq ?? null) !== (lastDecision?.decisionSeq ?? null) || (run.decisionsHead?.sha256 ?? null) !== (lastDecision?.sha256 ?? null)) return runRefused('STALE_INPUT', null, [RUN_STALE_MESSAGE]);
      // (f): o RUN_INTENT e o fecho cabem na classe RUN (a MESMA conta que a vista anuncia em `runsAvailable`)
      if (!runIntentFits(session.records, policy)) return runRefused('LEDGER_CAPACITY_EXHAUSTED', 'LIMIT_REACHED', [capacityMessage(capacityLevelOf(session))]);
      // (g): com guarda configurada, a cabeça atual publicada antes
      if (guard) {
        const failed = await publishRequired(session);
        if (failed) return runRefused('LEDGER_GUARD_UNAVAILABLE', failed);
      }
      // prazo do dono (passo 7): o instante monotônico é anotado ANTES de publicar o RUN_INTENT
      session.runMark = monotonic();
      const written = await append(session, { event: 'RUN_INTENT', recordedAt: input.nowIso, actor: input.actor, run: { runOpId: newOpId(), ...runFieldsOf(run) } }, input.nowIso, true);
      if (written === 'CONFLICT') return { kind: 'RESTART' }; // EEXIST na posição: relê e recomeça do passo 0
      if (written !== 'OK') return asRun(written);
      session.runIntent = session.records[session.records.length - 1] as LedgerRecord;
      return { kind: 'OK' };
    },

    async runGate(input: LedgerRunInput): Promise<RunStep> {
      const session = input.session as Session;
      const intent = session.runIntent;
      const mark = session.runMark;
      if (!intent?.run || mark === null) return runRefused('LEDGER_UNAVAILABLE', null, [RUN_NO_INTENT_MESSAGE]);
      // a operação do dono foi fechada por OUTRO processo (fase A vencida abortada): publicar agora seria resultado depois do aborto (RL-11) ⇒ não publica
      const prefix = await rereadPrefix(session);
      if (!prefix.ok) return prefix.step;
      if (prefix.replay.openRun?.contentSha256 !== intent.contentSha256) {
        session.runIntent = null;
        return runRefused('RUN_CLOSED', null, [RUN_CLOSED_MESSAGE]);
      }
      // PRAZO DO DONO (D-22): passados MAIS de staleOperationMs / 2 monotônicos desde o RUN_INTENT, não publica — grava o próprio RUN_ABORTED (uma tentativa; sem ela a fase A segue
      // aberta até vencer e qualquer operador a aborta). A margem até o aborto alheio (≥ staleOperationMs) fica de pelo menos staleOperationMs / 2.
      const elapsed = monotonic() - mark;
      if (!(elapsed <= staleMs / 2)) {
        session.runIntent = null;
        // o próprio RUN_ABORTED é fecho: num EEXIST segue a regra dos fechos intercalados (R1.4; a operação é dele e nada foi publicado — o dono não chega ao link() do resultado).
        // Fechada de outro modo, ou regravações esgotadas, a fase A fica aberta até vencer (qualquer operador a aborta). A resposta é sempre RUN_DEADLINE, salvo durabilidade.
        const written = await appendClosing(session, intent, runAbortDraft(intent, Number.isFinite(elapsed) ? elapsed : 0, input.actor, input.nowIso), input.nowIso, { slot: 'openRun', sameClosing: () => false, texts: RUN_CLOSING, verifyReplay: true });
        if (written === 'OK') await publishAfterRecord(session, 'S9');
        else if (written !== 'ADOPTED' && written !== 'CLOSED' && asRun(written).refusal.code === 'DURABILITY_UNKNOWN') return asRun(written);
        return runRefused('RUN_DEADLINE', null, [RUN_DEADLINE_MESSAGE]);
      }
      return { kind: 'OK' };
    },

    async runConfirmed(input: LedgerRunWriteInput): Promise<RunStep> {
      const session = input.session as Session;
      const intent = session.runIntent;
      const run = intent?.run;
      if (!intent || !run || !sameDraft(run, input.run)) return runRefused('LEDGER_UNAVAILABLE', null, [RUN_NO_INTENT_MESSAGE]);
      // D-R1-1: só o AUTOR confirma (o replay também recusa o fecho de quem não é o autor)
      if (!isEntryAuthor(input.actor, run.author)) return runRefused('LEDGER_UNAVAILABLE', null, [RUN_AUTHOR_MESSAGE]);
      // o fecho entra na cauda ATUAL, só se a própria operação continua aberta, com a regra dos fechos intercalados; fechada antes pelo RUN_CONFIRMED idêntico do autor ⇒ sucesso (R6-04)
      const closed = await closeRun(session, intent, input.actor, input.nowIso);
      if (closed.kind === 'OK') session.runIntent = null;
      return closed;
    },

    async runConclude(input: LedgerRunWriteInput): Promise<RunStep> {
      const session = input.session as Session;
      // autorização de uso ÚNICO do `runPrepare` desta sessão (B/C com receita, pedida pelo autor), consumida já na primeira chamada, qualquer que seja o desfecho
      const granted = takeGrant(session, 'RUN_CONCLUDE');
      const intent = session.concludeIntent;
      session.concludeIntent = null;
      if (!granted || !intent?.run) return runRefused('LEDGER_UNAVAILABLE', null, [NOT_PREPARED_MESSAGE]);
      // §16.17.4: SÓ O AUTOR conclui (e-mail da sessão normalizado === run.author); quem não é recebe PENDING_UNCONFIRMED e nada é gravado
      if (!isEntryAuthor(input.actor, intent.run.author)) return runRefused('PENDING_UNCONFIRMED', null, [RUN_CONCLUDE_NOT_AUTHOR_MESSAGE]);
      // o resultado a confirmar é EXATAMENTE o que o RUN_INTENT aberto amarra (número, encadeamento, hash, autor e citações)
      if (!sameDraft(intent.run, input.run)) return runRefused('LEDGER_UNAVAILABLE', null, [RUN_NO_INTENT_MESSAGE]);
      return closeRun(session, intent, input.actor, input.nowIso);
    },

    /**
     * R1.6 — REEMISSÃO DO RECIBO DE RESULTADO CONFIRMADO (§16.17.5, MAJOR-3; D-10, D-12): só os passos 1 e 1b; QUALQUER operador; nunca grava nem autoriza gravação no livro. A leitura
     * é o "sanduíche" (§16.17.8): o recibo removido só é julgado sobre a releitura R2, POSTERIOR ao livro (a receita exige R2; M-R15), e `runs` só existe depois das testemunhas
     * (R6-05, RL-24) e sem contradição de resultado. Espelho da reemissão do recibo de DECISÃO depois da revisão da R1.2 (R7-06): com a testemunha das DECISÕES não resolvida, nada
     * é gravado por este caminho. Autoria e origem não entram (o conteúdo do recibo é o `anchorRef` do `RUN_CONFIRMED`, autenticado pela chave do livro).
     */
    async runReissue(input: LedgerRunPrepareInput): Promise<LedgerRunReissueStep> {
      const session = input.session as Session;
      session.grant = null;
      session.runIntent = null;
      session.runMark = null;
      session.concludeIntent = null;
      const evaluation = await evaluateSandwich(session, input);
      const view = evaluation.view;
      const runs = view.runs;
      if (!runs) {
        const availability = view.reason !== null ? REISSUE_AVAILABILITY[view.reason] : undefined;
        if (availability) return runRefused(availability, view.reason);
        return runRefused('LEDGER_ACTION_INVALID', view.reason, [...(view.reason === null ? [`livro: ${view.state}`] : []), REISSUE_NOTHING_MESSAGE]);
      }
      const plan = evaluation.runPlan;
      const last = runs.confirmed[runs.confirmed.length - 1];
      // MISSING: a receita (recibo do último confirmado removido, julgado sobre R2). PRESENT: o recibo do último confirmado já existe e nada está pendente depois dele — o reenvio da
      // ação (p.ex. depois de um fsync falho e do reinício) só ADOTA e sincroniza (R7-04, espelho do reuso da reemissão de decisão); B/C aberta é do autor (R1.4), nunca daqui
      const target: { readonly run: { readonly runSeq: number; readonly runSha256: string }; readonly receipt: 'MISSING' | 'PRESENT' } | null =
        plan.kind === 'REISSUE_RUN_RECEIPT'
          ? { run: { runSeq: plan.confirmed.runSeq, runSha256: plan.confirmed.runSha256 }, receipt: 'MISSING' }
          : runs.state === 'OK' && last !== undefined && (runs.open === null || runs.open.phase === 'A')
            ? { run: { runSeq: last.runSeq, runSha256: last.runSha256 }, receipt: 'PRESENT' }
            : null;
      if (!target) return runRefused('LEDGER_ACTION_INVALID', runs.reason, [REISSUE_NOTHING_MESSAGE]);
      // R7-06 (1): a testemunha das DECISÕES não resolvida impede qualquer gravação deste caminho (o recibo tornaria testemunha a cabeça de decisões do resultado)
      if (input.decisionsWitness) return runRefused('DECISIONS_HISTORY_UNRESOLVED', null, [`testemunha: ${input.decisionsWitness}`]);
      return { kind: 'OK', view, run: target.run, receipt: target.receipt };
    },

    async sync(auditId: string, syncOptions: { readonly requireExisting?: boolean } = {}) {
      const synced = await syncLedgerDirectory(options.dir, auditId, { ...storeOptions, ...(syncOptions.requireExisting ? { requireExisting: true } : {}) });
      if (synced.ok) return { ok: true as const };
      // a razão só é dita no modo estrito (revisão da R1.6): o livro ausente com resultado confirmado foi removido depois de testemunhado; os demais chamadores recebem o de sempre
      const reason: LedgerReason | null = !syncOptions.requireExisting ? null : synced.code === 'ABSENT' ? 'LEDGER_REMOVED_WITNESSED' : synced.code === 'UNSAFE_PATH' ? 'NOT_CONFIGURED' : synced.code === 'UNREADABLE' ? 'UNAVAILABLE' : 'DURABILITY_UNKNOWN';
      return { ok: false as const, refusal: { code: 'LEDGER_UNAVAILABLE' as const, reason, issues: [...synced.issues], view: null } };
    },

    async enroll(input: LedgerEnrollInput) {
      const session = await begin(input.auditId);
      const evaluation = evaluate(session, { session, auditId: input.auditId, snapshot: input.snapshot, results: input.results, entryOriginProven: () => false, nowIso: input.nowIso });
      const view = evaluation.view;
      if (view.state === 'LEGACY_READ_ONLY') return { ok: false as const, refusal: refusal('ADMIN_APPROVAL_UNAVAILABLE', view, view.reason, ['A adoção de histórico existente exige aprovação administrativa, que ainda não existe neste sistema.']) };
      if (view.state === 'PROTECTED') return { ok: false as const, refusal: refusal('LEDGER_ACTION_INVALID', view, null, ['Esta auditoria já está inscrita no livro.']) };
      if (view.state !== 'ENROLLMENT_PENDING') return { ok: false as const, refusal: refusal(view.reason === 'NOT_CONFIGURED' ? 'LEDGER_NOT_CONFIGURED' : 'DECISIONS_HISTORY_UNRESOLVED', view) };
      const written = await append(session, { event: 'GENESIS', recordedAt: input.nowIso, actor: input.actor, genesis: { mode: 'EMPTY' } }, input.nowIso);
      if (written === 'CONFLICT') return { ok: false as const, refusal: refusal('LEDGER_UNAVAILABLE', view, null, ['Outro processo inscreveu a auditoria ao mesmo tempo; releia.']) };
      if (written !== 'OK') return { ok: false as const, refusal: written };
      const failed = await publishRequired(session);
      if (failed) return { ok: false as const, refusal: refusal('LEDGER_GUARD_UNAVAILABLE', view, failed) };
      const after = evaluate(session, { session, auditId: input.auditId, snapshot: input.snapshot, results: input.results, entryOriginProven: () => false, nowIso: input.nowIso });
      return { ok: true as const, view: after.view };
    },
  };
}

/** Porta do livro NÃO CONFIGURADO (pasta ou chave ausente/insegura/sobreposta): tudo responde `NOT_CONFIGURED` (falha fechada), nada é gravado. */
export function createUnconfiguredLedger(): LedgerPort {
  const notConfigured: LedgerView = {
    state: 'HISTORY_UNRESOLVED',
    reason: 'NOT_CONFIGURED',
    head: null,
    decisionHead: null,
    confirmedDecisions: 0,
    openOperation: null,
    recoverable: false,
    receiptReissuable: false,
    externalGuard: 'NOT_CONFIGURED',
  };
  const refusal: LedgerRefusal = { code: 'LEDGER_NOT_CONFIGURED', reason: 'NOT_CONFIGURED', issues: ['livro: NOT_CONFIGURED', MESSAGES.NOT_CONFIGURED as string], view: notConfigured };
  const step: LedgerStep = { kind: 'REFUSED', refusal };
  const runStep = { kind: 'REFUSED' as const, refusal: { code: refusal.code, reason: refusal.reason, issues: refusal.issues } };
  return {
    async begin() {
      return null;
    },
    async view() {
      return notConfigured;
    },
    async prepare() {
      return step;
    },
    async intent() {
      return step;
    },
    async reissue() {
      return step;
    },
    async confirmed() {
      return step;
    },
    async runPrepare() {
      // como no livro configurado com estado não PROTECTED: nenhuma autorização de RUN_INTENT; a avaliação da finalização recusa (`NOT_FINALIZABLE`) e os passos seguintes também
      return { kind: 'OK' as const, view: notConfigured };
    },
    async runIntent() {
      return runStep;
    },
    async runGate() {
      return runStep;
    },
    async runConfirmed() {
      return runStep;
    },
    async runConclude() {
      return runStep;
    },
    async runReissue() {
      return runStep;
    },
    async sync() {
      return { ok: false as const, refusal };
    },
    async enroll() {
      return { ok: false as const, refusal };
    },
  };
}
