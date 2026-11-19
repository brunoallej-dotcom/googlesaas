import path from 'node:path';
import type { CapacityLevel, LedgerEnrollInput, LedgerEntryInput, LedgerFailureCode, LedgerPort, LedgerPrepareInput, LedgerRefusal, LedgerStep, LedgerView, LedgerViewInput } from '../link-audit-decisions/ledger-port';
import type { OriginAuthenticator } from '../link-audit-origin';
import { DURABILITY_UNPROVEN_MESSAGE, seal } from '../link-audit-storage';
import { nodeFsOps, type FsOps } from '../link-audit/snapshot-store';
import type { ExternalGuardPort } from './guard';
import { evaluateProtection, ledgerCapacity, operationCost, pendingClosings, replayLedger, resultsGrew, rotationCheckpointDue, verifyTags, type Evaluation, type GuardEvidence, type LedgerReadState, type TagFailure } from './model';
import { PROCESS_OBSERVATIONS, type OpenObservations } from './observed';
import { ensureLedgerProven, ledgerDurabilityTripped, publishLedgerRecord, readLedgerFiles, newOpId, syncLedgerDirectory, type PublishLedgerResult } from './store';
import { CHECKPOINT_EVERY, LEDGER_CAPACITY_POLICY, LEDGER_KIND, LEDGER_SCHEMA_VERSION, ledgerRecordSchema, type DecisionRef, type LedgerCapacityPolicy, type ResultsEvidence, type LedgerDraft, type LedgerHead, type LedgerOp, type LedgerReason, type LedgerRecord } from './types';

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
  readonly guard?: ExternalGuardPort;
  /** Inatividade a partir da qual uma operação aberta pode ser recuperada (padrão 120 s). */
  readonly staleOperationMs?: number;
  /** Intervalo de espera por uma operação de outro processo (padrão 50 ms). */
  readonly pollMs?: number;
  readonly checkpointEvery?: number;
  /** Política de capacidade (padrão = a real de 4000 registros; só testes injetam outra). */
  readonly capacityPolicy?: LedgerCapacityPolicy;
  /** Idade observada das operações abertas com hora gravada no futuro (R7-09). Padrão: o registro do processo (monotônico). Só testes injetam outro. */
  readonly observations?: OpenObservations;
}

const WITNESS_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['RESULT_LEDGER_MISMATCH', 'UNTRUSTED', 'RESULTS_EVIDENCE_UNAVAILABLE', 'GUARD_MISMATCH', 'LEDGER_REMOVED_WITNESSED']);
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
}

const anchorName = (seq: number): string => `a${String(seq).padStart(4, '0')}.json`;
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
};

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
    const session: Session = { auditId, state: 'OK', records: [], tagFailure: null, guard: { status: 'NOT_CONFIGURED' }, intent: null, evaluation: null };
    try {
      if (!path.isAbsolute(options.dir) || (await overlapping())) return { ...session, state: 'NOT_CONFIGURED' };
      // M2: depois de uma falha de fsync (ou erro fatal) neste processo a durabilidade do livro NÃO está comprovada: ele não é lido como protegido (nada vigente, nada finalizável) até reiniciar e provar de novo
      if (ledgerDurabilityTripped(options.dir, storeOptions)) return { ...session, state: 'DURABILITY_UNKNOWN' };
      // ORDEM DE LEITURA (R7-05): guarda → livro. A guarda é publicada DEPOIS de o registro entrar no livro (guarda ≤ livro em todo instante); lida primeiro, ela nunca
      // fica à frente do livro lido e uma corrida legítima não vira `GUARD_MISMATCH`.
      if (options.guard) {
        const latest = await options.guard.latest(auditId);
        session.guard = latest.ok ? { status: 'READ', head: latest.head } : { status: 'UNAVAILABLE' };
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
      return { ...session, state: 'OK', records: [...read.value.records], tagFailure: verifyTags(read.value.records, auth) };
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
    return evaluation;
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
  /** Texto fixo por nível de capacidade (R7-01): nunca "erro interno", nunca caminho, e diz quando a auditoria precisa de intervenção. */
  const capacityMessage = (level: CapacityLevel): string =>
    level === 'OK'
      ? 'A capacidade do livro desta auditoria não comporta esta operação agora. Nada foi gravado.'
      : level === 'REVOKE_ONLY'
        ? 'Capacidade do livro: decisões novas encerradas; só cabem revogações (reserva de revogação). Nada foi gravado.'
        : 'Capacidade do livro ESGOTADA: nem revogações cabem. A auditoria precisa de INTERVENÇÃO (a reabertura administrativa ainda não existe). Nada foi gravado.';
  const capacityLevelOf = (session: Session): CapacityLevel => ledgerCapacity(session.records, auth.keyId, every, policy, pendingClosings(session.records)).level;
  const refused = (code: LedgerFailureCode, view: LedgerView | null, reason?: LedgerReason | null, extra?: string[]): LedgerStep => ({ kind: 'REFUSED', refusal: refusal(code, view, reason, extra) });
  const refusedForState = (view: LedgerView): LedgerStep =>
    view.state === 'ENROLLMENT_PENDING'
      ? refused('LEDGER_ENROLLMENT_REQUIRED', view, null)
      : view.state === 'LEGACY_READ_ONLY'
        ? refused('LEDGER_LEGACY_READ_ONLY', view)
        : refused(view.reason === 'NOT_CONFIGURED' ? 'LEDGER_NOT_CONFIGURED' : 'DECISIONS_HISTORY_UNRESOLVED', view);

  /** Anexa UM registro. `CONFLICT` = outro processo ocupou a posição (relê). Falha de disco ⇒ `LEDGER_UNAVAILABLE`; nada é dado como gravado. */
  async function append(session: Session, draft: LedgerDraft, nowIso: string): Promise<'OK' | 'CONFLICT' | LedgerRefusal> {
    const last = session.records[session.records.length - 1];
    // R7-02: o limite duro vale para QUALQUER registro (inclusive manutenção); o texto nunca diz "erro interno"
    if ((last?.ledgerSeq ?? 0) + 1 > policy.max) return refusal('LEDGER_CAPACITY_EXHAUSTED', null, 'LIMIT_REACHED', [capacityMessage('EXHAUSTED')]);
    const unsigned = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
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
  async function publishGuard(session: Session): Promise<boolean> {
    const tail = head(session);
    if (!options.guard || !tail) return true;
    return (await options.guard.publish({ auditId: session.auditId, ledgerSeq: tail.ledgerSeq, sha256: tail.sha256 })).ok;
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

  /**
   * FECHOS INTERCALADOS (spec §16.17.3, MAJOR-2; D-20), família das DECISÕES. O `link()` do fecho do dono achou a posição ocupada. Relê o livro INTEIRO e exige etiquetas e
   * replay válidos e que a releitura ESTENDA o que esta sessão leu (o livro só cresce; a INTENT da operação é a mesma). Então: (ii) fecho idêntico gravado por outro processo
   * (R6-04) ⇒ `ADOPTED`; (i) a PRÓPRIA operação segue aberta (o intruso só pode ser `CHECKPOINT` ou o fecho de um resultado aberto ANTES da INTENT — `RUN_CONFIRMED`/
   * `RUN_ABORTED`, D-8: são os únicos registros que o replay admite ali) ⇒ `REAPPEND`;
   * (iii) qualquer outra coisa (operação abortada por outro processo, cadeia que não confere) ⇒ recusa. Nunca grava nada.
   */
  async function reconcileClosing(session: Session, intent: LedgerRecord, sameClosing: (record: LedgerRecord) => boolean): Promise<'REAPPEND' | 'ADOPTED' | LedgerRefusal> {
    const reread = await readLedgerFiles(options.dir, session.auditId, storeOptions);
    if (!reread.ok) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_CHANGED_MESSAGE]);
    const records = reread.value.records;
    const replayed = replayLedger(records, session.auditId);
    if (verifyTags(records, auth) !== null || !replayed.ok) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_UNTRUSTED_MESSAGE]);
    const known = session.records[session.records.length - 1];
    const extendsRead = known !== undefined && records.length > session.records.length && records[known.ledgerSeq - 1]?.contentSha256 === known.contentSha256 && records[intent.ledgerSeq - 1]?.contentSha256 === intent.contentSha256;
    if (!extendsRead) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_UNTRUSTED_MESSAGE]);
    const adopted = records.some(sameClosing);
    // a INTENT aberta no replay é a desta operação (mesmo hash ⇒ mesmo opId e mesma cadeia até ela); entre ela e o fecho o replay só admite CHECKPOINT e o fecho de resultado
    const ownOpen = replayed.value.open?.contentSha256 === intent.contentSha256;
    if (!adopted && !ownOpen) return refusal('LEDGER_UNAVAILABLE', null, null, [CLOSING_CLOSED_MESSAGE]);
    session.records = [...records];
    session.state = 'OK';
    session.tagFailure = null;
    return adopted ? 'ADOPTED' : 'REAPPEND';
  }

  return {
    begin,

    async view(input) {
      const session = input.session as Session;
      return (await evaluateSandwich(session, input)).view;
    },

    async prepare(input: LedgerPrepareInput): Promise<LedgerStep> {
      const session = input.session as Session;
      const actor = input.actor ?? 'system';
      const intended = input.intended ?? 'RECORD';
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
        if (plan.kind === 'REISSUE_RECEIPT') return { kind: 'OK', pendingKind: 'RECEIPT_REMOVED' }; // só o reenvio do AUTOR passa pela 6B
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
        await publishGuard(session);
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
          await publishGuard(session);
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
          const tail = head(session) as LedgerHead;
          const written = await append(session, { event: 'CHECKPOINT', recordedAt: input.nowIso, actor, checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.sha256 } }, input.nowIso);
          const stop = stepFromAppend(written);
          if (stop) return stop;
          await publishGuard(session);
          evaluation = evaluate(session, input);
          view = evaluation.view;
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
      // Ponto de verificação (primeira escrita depois de uma rotação de chave e a cada N registros).
      if (cost.checkpoint) {
        const tail = head(session) as LedgerHead;
        const written = await append(session, { event: 'CHECKPOINT', recordedAt: input.nowIso, actor, checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.sha256 } }, input.nowIso);
        const stop = stepFromAppend(written);
        if (stop) return stop;
      }
      // Guarda externa configurada: a cabeça anterior precisa estar publicada antes de uma nova operação.
      if (options.guard && !(await publishGuard(session))) return refused('LEDGER_GUARD_UNAVAILABLE', view, 'GUARD_UNAVAILABLE');
      return { kind: 'OK', pendingKind: null };
    },

    async intent(input: LedgerEntryInput): Promise<LedgerStep> {
      const session = input.session as Session;
      // PONTO AUTORITATIVO da capacidade (R7-01): vale para a posição que esta INTENT vai ocupar. Se outro processo ocupar a posição o `link()` exclusivo falha (CONFLICT) e
      // a reavaliação recomeça com o livro novo — a verificação é coordenada entre processos pelo próprio disco. A INTENT só entra se ela e o registro que a fecha cabem na classe,
      // sem tomar o fecho reservado de um resultado aberto (§16.17.6: `len + 2 + openRun ≤ classe`).
      const cls = input.entry.action === 'REVOKE' ? 'REVOKE' : 'RECORD';
      if (session.records.length + 2 + pendingClosings(session.records) > policy[cls]) return refused('LEDGER_CAPACITY_EXHAUSTED', null, 'LIMIT_REACHED', [capacityMessage(capacityLevelOf(session))]);
      const written = await append(session, { event: 'INTENT', recordedAt: input.nowIso, actor: input.actor, op: opFor(input.entry) }, input.nowIso);
      const stop = stepFromAppend(written);
      if (stop) return stop;
      session.intent = session.records[session.records.length - 1] as LedgerRecord;
      return { kind: 'OK', pendingKind: null };
    },

    async reissue(input: LedgerEntryInput): Promise<LedgerStep> {
      const session = input.session as Session;
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
      await publishGuard(session);
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
      for (let reappends = 0; ; reappends += 1) {
        // CAPACIDADE: cada tentativa passa pelo teto duro de `append` (R7-02: nenhum registro além de `policy.max`; recusa sem gravar). O fecho já estava reservado — a INTENT só
        // entrou com espaço para ela e para o fecho, e o CHECKPOINT do `RECOVER` com operação aberta deixa 1 registro livre — então a regravação cabe enquanto a regra valer.
        const written = await append(session, draft, input.nowIso);
        if (written === 'OK') break;
        if (written !== 'CONFLICT') return { kind: 'REFUSED', refusal: written };
        const next = await reconcileClosing(session, intent, sameClosing);
        if (next === 'ADOPTED') {
          // R7-04: o CONFIRMED adotado foi gravado por OUTRO processo e o fsync dele pode ter falhado/não ter ocorrido: o sucesso do dono exige sincronizar o livro AGORA
          const adopted = await syncLedgerDirectory(options.dir, session.auditId, storeOptions);
          if (!adopted.ok) return refused('LEDGER_UNAVAILABLE', null, null, [...adopted.issues]);
          break;
        }
        if (next !== 'REAPPEND') return { kind: 'REFUSED', refusal: next };
        // (i) a própria operação segue aberta atrás de um CHECKPOINT alheio: regrava o MESMO fecho na nova cauda (publicação estrita, como toda gravação do livro), limitado.
        if (reappends >= WRITE_RETRIES) return refused('LEDGER_UNAVAILABLE', null, null, [CLOSING_RETRIES_MESSAGE]);
      }
      await publishGuard(session);
      return { kind: 'OK', pendingKind: null };
    },

    async sync(auditId: string) {
      const synced = await syncLedgerDirectory(options.dir, auditId, storeOptions);
      return synced.ok ? { ok: true as const } : { ok: false as const, refusal: refusal('LEDGER_UNAVAILABLE', null, null, [...synced.issues]) };
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
      if (!(await publishGuard(session))) return { ok: false as const, refusal: refusal('LEDGER_GUARD_UNAVAILABLE', view, 'GUARD_UNAVAILABLE') };
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
    async sync() {
      return { ok: false as const, refusal };
    },
    async enroll() {
      return { ok: false as const, refusal };
    },
  };
}
