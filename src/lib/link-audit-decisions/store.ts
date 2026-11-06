import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../link-audit/canonical';
import { judgeOrigin, type OriginAuthenticator, type OriginVerdict } from '../link-audit-origin';
import { describeError, nodeFsOps, publishExclusive, withLock, type FsOps } from '../link-audit/snapshot-store';
import type { DecisionRef, DecisionsSnapshot, LedgerPort, LedgerRefusal, ResultsEvidence } from './ledger-port';
import { confirmAnchor, prepareAnchorDirectory, readAnchors, verifyAnchors, type AnchorSummary } from './anchor-store';
import {
  assertBase,
  atomicOnly,
  ATOMIC_UNAVAILABLE_ERRNO,
  splitNames,
  dirStatus,
  DURABILITY_UNPROVEN_MESSAGE,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  isBaseTripped,
  locateIn,
  mapOrdered,
  READ_CONCURRENCY,
  readSealedFile,
  seal,
  serialize,
  tripBase,
  watchDurability,
  type Location,
  type StoreFailure,
  type StoreOptions,
  type StoreResult,
} from './files';
import { replay, type LogState } from './project';
import { decisionEntrySchema, ENTRY_FILE, entryFileName, MAX_ENTRY_BYTES, MAX_SEQ, type AnchorFile, type ClientRecord, type DecisionDraft, type DecisionEntry } from './types';

/*
 * Armazenamento das decisões: UM arquivo imutável por entrada (`<base>/<auditId>/dNNNN.json`), no MESMO mecanismo de
 * gravação das evidências e dos snapshots (`publishExclusive`: temporário exclusivo + fsync + link() exclusivo), SOMENTE de
 * forma atômica (sem `link()` não se grava). Nunca sobrescreve, nunca apaga. A base é uma pasta DEDICADA (diferente da de
 * evidências); este módulo não cria a base. Cada entrada tem um recibo na pasta de ÂNCORAS (outro local de gravação), que
 * é o que torna detectável a perda do fim do histórico.
 *
 * PROTOCOLO (Emenda 1 do ADR): uma decisão só é CONFIRMADA quando o arquivo `dNNNN.json` E o recibo `aNNNN.json` estão duráveis.
 * Entre os dois ela é PENDENTE: existe, mas NÃO vale (não entra no estado devolvido, não é sucesso, nada novo é gravado sobre
 * ela). Só o REENVIO do mesmo pedido a conclui, e SOMENTE se o servidor comprovar a ORIGEM do arquivo (etiqueta HMAC com chave fora
 * das pastas; `link-audit-origin`): o "autor", o conteúdo e o selo SHA-256 de um arquivo são afirmações de quem escreve na pasta, e
 * "mesmo autor, mesmo pedido" não prova nada (o pedido é montado a partir do próprio arquivo). A perda de uma confirmada é detectável
 * quando o recibo fica à frente do histórico; a remoção do ÚLTIMO recibo é indistinguível de uma gravação interrompida (limite declarado).
 */
export { clearStorageFatal, hashOk, isStorageFatal, scrubPaths, seal, serialize } from './files';
export type { Location, StoreErrorCode, StoreFailure, StoreOptions, StoreResult } from './files';

export interface ReadOptions extends StoreOptions {
  /** Pasta de âncoras (OBRIGATÓRIA; separada da de decisões). */
  readonly anchorDir: string;
}
export interface WriteOptions extends ReadOptions {
  /** Relógio do servidor (ISO UTC com milissegundos). O módulo nunca consulta o relógio sozinho. */
  readonly now: () => string;
  /**
   * Autenticador de ORIGEM (chave do servidor, fora das pastas). Com ele, toda entrada nova sai assinada e uma PENDENTE só é
   * concluída (recibo) se a etiqueta for válida. SEM ele nada é assinado e NENHUMA pendente é concluída (falha fechada).
   */
  readonly origin?: OriginAuthenticator;
  /**
   * LIVRO DE CABEÇAS (contrato §16): quando presente, a escrita só acontece em auditoria PROTEGIDA e segue `INTENT → entrada → recibo → CONFIRMED`,
   * tudo na MESMA coordenação (trava em processo + `link()` exclusivo entre processos). Sem ele (testes da 6B isolada) nada muda.
   */
  readonly ledger?: {
    readonly port: LedgerPort;
    readonly actor: string;
    /** Classe da operação, para a RESERVA de capacidade (R7-01): `RECORD` (criação/substituição), `REVOKE` ou `NONE` (manutenção, p.ex. `RECOVER`). */
    readonly intended: 'RECORD' | 'REVOKE' | 'NONE';
    /** Lê a testemunha dos RESULTADOS agora (R7-05/R7-06): a cada tentativa, ANTES do livro, e de novo logo antes de uma gravação de recuperação. */
    readonly readResults: () => Promise<ResultsEvidence>;
    /** Status da testemunha das DECISÕES (6B) se NÃO resolvida (nenhuma recuperação do livro é gravada); senão `null`. */
    readonly decisionsWitness: (entries: readonly DecisionEntry[], pending: DecisionEntry | null) => string | null;
  };
}

const WRITE_RETRIES = 5;
/** Esperas por uma operação de OUTRO processo (50 ms cada ⇒ ~2 s) e releituras por suspeita de corrida entre as leituras do livro e das decisões. */
const MAX_LEDGER_WAITS = 40;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Descrição NEUTRA da entrada para o livro (a 6B não entrega a entrada inteira, só o que o livro precisa). */
export function ledgerRefOf(entry: DecisionEntry): DecisionRef {
  const revoke = entry.action === 'REVOKE';
  return {
    seq: entry.seq,
    sha256: entry.contentSha256,
    prevSha256: entry.prevSha256,
    action: entry.action,
    author: entry.recordedBy,
    decisionId: revoke ? null : entry.decisionId,
    revokes: revoke ? entry.revokes : null,
    supersedes: revoke ? null : entry.supersedes,
    affectsPrior: revoke || entry.supersedes !== null,
  };
}
export const ledgerSnapshotOf = (confirmed: readonly DecisionEntry[], pending: DecisionEntry | null): DecisionsSnapshot => ({ confirmed: confirmed.map(ledgerRefOf), pending: pending ? ledgerRefOf(pending) : null });

export const assertDecisionBase = (baseDir: unknown, projectRoot: string): StoreResult<string> => assertBase(baseDir, projectRoot, 'decisões');
export const locateAudit = (baseDir: unknown, auditId: unknown, projectRoot: string): StoreResult<Location> => locateIn(baseDir, auditId, projectRoot, 'decisões');
const locateAnchors = (anchorDir: unknown, auditId: unknown, projectRoot: string): StoreResult<Location> => locateIn(anchorDir, auditId, projectRoot, 'âncoras');

/* ------------------------------------------------------------------ leitura e verificação completa */

export interface LogRead {
  /** Estado CONFIRMADO (decisões com recibo): é o único que vale. A pendente NÃO está aqui. */
  readonly state: LogState;
  /** Cauda publicada e ainda sem recibo (no máximo 1). Existe no disco, mas não vale até ser concluída. */
  readonly pending: DecisionEntry | null;
  /** Arquivos de decisão verificados (inclui a pendente). */
  readonly checkedFiles: number;
  readonly anchors: AnchorSummary;
  /** Nomes fora do padrão que NÃO se parecem com uma entrada (ex.: `desktop.ini`): ignorados, mas informados. */
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

const EMPTY: LogState = Object.freeze({ entries: [], decisions: [], effective: [], head: null });

interface DecisionsRead {
  readonly state: LogState;
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

async function readDecisions(ops: FsOps, located: Location, auditId: string): Promise<StoreResult<DecisionsRead>> {
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento de decisões não existe neste servidor.');
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de decisões não é um diretório comum.');
  const audit = await dirStatus(ops, located.dir);
  if (audit === 'MISSING') return { ok: true, value: { state: EMPTY, unexpectedFiles: [], orphanTempFiles: [] } };
  if (audit !== 'EXISTS') return fail('UNSAFE_PATH', 'A pasta de decisões da auditoria não é um diretório comum.');

  let names: string[];
  try {
    names = await ops.readdir(located.dir);
  } catch (error) {
    return fail('CORRUPT', describeError('listagem', error));
  }
  const { numbers, orphanTempFiles, suspicious, unexpectedFiles } = splitNames(names, ENTRY_FILE, 'd');
  // `d0005.json.bak`, `D0001.JSON`…: parecem uma entrada mas não são; podem ser o rastro de uma remoção/renomeação.
  if (suspicious.length > 0) return fail('CORRUPT', `Arquivo suspeito na pasta de decisões: ${suspicious[0]?.slice(0, 80)}.`);
  for (const [index, n] of numbers.entries()) {
    if (n !== index + 1) return fail('SEQUENCE_GAP', `Lacuna na sequência de decisões (esperado ${entryFileName(index + 1)}, achado ${entryFileName(n)}).`);
  }

  const entries: DecisionEntry[] = [];
  let previous: string | null = null;
  const files = await mapOrdered(numbers, READ_CONCURRENCY, (n) => readSealedFile<DecisionEntry>(ops, path.join(located.dir, entryFileName(n)), MAX_ENTRY_BYTES, decisionEntrySchema));
  for (const [position, n] of numbers.entries()) {
    const name = entryFileName(n);
    const file = files[position] as Awaited<ReturnType<typeof readSealedFile<DecisionEntry>>>;
    if (!file.ok) return file;
    const entry = file.value;
    if (entry.auditId !== auditId) return fail('CHAIN_BROKEN', `${name} pertence a outra auditoria.`);
    if (entry.seq !== n) return fail('CHAIN_BROKEN', `${name}: a sequência interna (${entry.seq}) não corresponde ao nome do arquivo.`);
    if (entry.prevSha256 !== previous) return fail('CHAIN_BROKEN', `${name}: não está encadeado ao arquivo anterior.`);
    previous = entry.contentSha256;
    entries.push(entry);
  }
  const state = replay(entries);
  if (!state.ok) return fail('SEMANTIC', ...state.issues.slice(0, 10));
  return { ok: true, value: { state: state.value, unexpectedFiles, orphanTempFiles } };
}

interface Verified extends LogRead {
  readonly anchorFiles: readonly AnchorFile[];
}

/**
 * Falhas que só aparecem ao CRUZAR as duas pastas. Uma escrita que termina no meio da leitura (as pastas não são lidas no
 * mesmo instante, e a trava é só em memória) pode produzi-las sem nenhuma adulteração: relê-se UMA vez antes de acusar.
 * Uma adulteração real falha igual nas duas leituras.
 */
const CROSS_FOLDER_FAILURES: ReadonlySet<string> = new Set(['TRUNCATED', 'ANCHOR_INTEGRITY', 'ANCHOR_MISMATCH']);

/** Decisões + âncoras, cruzadas. Qualquer falha em qualquer das duas pastas ⇒ nada é devolvido. */
async function readVerified(ops: FsOps, decisions: Location, anchors: Location, auditId: string): Promise<StoreResult<Verified>> {
  const first = await readVerifiedOnce(ops, decisions, anchors, auditId);
  if (first.ok || !CROSS_FOLDER_FAILURES.has(first.code)) return first;
  return readVerifiedOnce(ops, decisions, anchors, auditId);
}

async function readVerifiedOnce(ops: FsOps, decisions: Location, anchors: Location, auditId: string): Promise<StoreResult<Verified>> {
  // As âncoras são lidas ANTES das decisões: como a decisão é publicada antes do recibo, uma escrita concorrente no meio da
  // leitura deixa, no pior caso, uma decisão a mais que recibos (PENDENTE), nunca um recibo à frente (falso TRUNCATED).
  // A precedência dos erros continua sendo a das decisões primeiro.
  const receipts = await readAnchors(ops, anchors, auditId);
  const log = await readDecisions(ops, decisions, auditId);
  if (!log.ok) return log;
  if (!receipts.ok) return receipts;
  const summary = verifyAnchors(log.value.state.entries, receipts.value.anchors);
  if (!summary.ok) return summary;
  // A cauda sem recibo (no máximo 1) é PENDENTE: o estado devolvido é o dos CONFIRMADOS.
  let confirmed = log.value.state;
  let pending: DecisionEntry | null = null;
  if (summary.value.unanchored === 1) {
    pending = log.value.state.entries[log.value.state.entries.length - 1] ?? null;
    const prefix = replay(log.value.state.entries.slice(0, -1));
    if (!prefix.ok) return fail('SEMANTIC', ...prefix.issues.slice(0, 10));
    confirmed = prefix.value;
  }
  return {
    ok: true,
    value: {
      state: confirmed,
      pending,
      checkedFiles: log.value.state.entries.length,
      anchors: summary.value,
      anchorFiles: receipts.value.anchors,
      unexpectedFiles: [...log.value.unexpectedFiles, ...receipts.value.unexpectedFiles],
      orphanTempFiles: [...log.value.orphanTempFiles, ...receipts.value.orphanTempFiles],
    },
  };
}

/** Relê TUDO (decisões e âncoras: bytes, hashes, encadeamento, sequência, semântica, confronto). Nunca escreve. */
export async function readLog(baseDir: unknown, auditId: unknown, options: ReadOptions): Promise<StoreResult<LogRead>> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const located = locateAudit(baseDir, auditId, projectRoot);
  if (!located.ok) return located;
  const anchors = locateAnchors(options.anchorDir, auditId, projectRoot);
  if (!anchors.ok) return anchors;
  const verified = await readVerified(options.fs ?? nodeFsOps, located.value, anchors.value, auditId as string);
  if (!verified.ok) return verified;
  const { anchorFiles, ...rest } = verified.value; // as âncoras em si não saem do módulo
  return { ok: true, value: rest };
}

/* ------------------------------------------------------------------ reenvio idempotente */

/** O que identifica uma operação do operador, SEM hora, número, hash nem base de evidências (o que o servidor acrescenta). */
export type OperationSpec =
  | { readonly action: 'RECORD'; readonly record: ClientRecord; readonly supersedes: string | null }
  | { readonly action: 'REVOKE'; readonly revokes: string; readonly reason: string };

const operationOf = (entry: DecisionEntry): OperationSpec =>
  entry.action === 'RECORD' ? { action: 'RECORD', record: entry.record, supersedes: entry.supersedes } : { action: 'REVOKE', revokes: entry.revokes, reason: entry.reason };

/**
 * Reconhece o REENVIO de um pedido: a entrada logo DEPOIS da visão (`expectedHead`) do operador, encadeada a ela, do mesmo autor
 * e com exatamente a mesma operação. Devolve o `seq` dela (confirmada ou pendente) ou `null`. Outro autor, outro conteúdo ou uma
 * visão que não confere com este histórico nunca são reenvio. Serve para tornar as novas tentativas idempotentes: a mesma
 * decisão não é gravada duas vezes e uma resposta perdida não obriga ninguém a adivinhar se o pedido valeu.
 */
export function findReplay(entries: readonly DecisionEntry[], expected: { readonly seq: number; readonly sha256: string } | null, operator: string, wanted: OperationSpec): number | null {
  if (expected !== null && entries[expected.seq - 1]?.contentSha256 !== expected.sha256) return null;
  const candidate = entries[expected === null ? 0 : expected.seq];
  if (!candidate || candidate.prevSha256 !== (expected?.sha256 ?? null) || candidate.recordedBy !== operator) return null;
  return canonicalJson(operationOf(candidate)) === canonicalJson(wanted) ? candidate.seq : null;
}

/* ------------------------------------------------------------------ gravação */

export interface BuildContext {
  /** Estado CONFIRMADO (decisões com recibo): é o único que vale. */
  readonly state: LogState;
  /** Cauda publicada e ainda SEM recibo (no máximo 1): existe, mas não vale. Nada novo é gravado enquanto houver uma. */
  readonly pending: DecisionEntry | null;
  /** Todas as entradas publicadas (confirmadas + a pendente), em ordem: serve para reconhecer o REENVIO de um pedido. */
  readonly entries: readonly DecisionEntry[];
  /** Número da próxima entrada (depois da pendente, se houver). */
  readonly seq: number;
  /** Hora do servidor, monotônica dentro da trava (nunca anterior à última entrada). */
  readonly recordedAt: string;
}
export type BuildOutcome<F> =
  | { readonly ok: true; readonly draft: DecisionDraft }
  /** O pedido é o reenvio da entrada `replayOf` (confirmada ou pendente): nada novo é gravado; a pendente é concluída. */
  | { readonly ok: true; readonly replayOf: number }
  | { readonly ok: false; readonly failure: F };

/** A entrada foi publicada (ou já existia) mas NÃO está confirmada: o recibo falhou, ou há outra pendente no caminho. */
export interface PendingFailure {
  readonly ok: false;
  /**
   * `ANCHOR_PENDING`: esta chamada publicou a entrada e o recibo falhou. `PENDING_UNCONFIRMED`: já havia uma pendente e o pedido não é
   * o reenvio dela. `ORIGIN_UNPROVEN`: o pedido era o reenvio da pendente, mas a etiqueta de origem falta, não confere ou a chave é
   * outra: NENHUM recibo foi gravado.
   */
  readonly code: 'ANCHOR_PENDING' | 'PENDING_UNCONFIRMED' | 'ORIGIN_UNPROVEN';
  readonly issues: readonly string[];
  readonly pending: DecisionEntry;
  /** Estado CONFIRMADO (sem a pendente): o `head` a usar ao reenviar. */
  readonly state: LogState;
  /** Só em `ORIGIN_UNPROVEN`. */
  readonly verdict?: Exclude<OriginVerdict, 'PROVEN'>;
}

/** `ok: true` SIGNIFICA confirmado: a decisão e o recibo estão duráveis. Não existe mais "gravada, mas sem recibo" como sucesso. */
export type AppendResult<F> =
  | { readonly ok: true; readonly entry: DecisionEntry; readonly state: LogState; readonly anchored: true; readonly replayed: boolean; readonly anchors: AnchorSummary }
  | StoreFailure
  | PendingFailure
  | { readonly ok: false; readonly code: 'LEDGER_REFUSED'; readonly refusal: LedgerRefusal }
  | { readonly ok: false; readonly code: 'REJECTED'; readonly failure: F };

const laterOf = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);
const confirmedSummary = (count: number): AnchorSummary => ({ count, lastSeq: count, unanchored: 0 });

/**
 * Acrescenta UMA entrada ao histórico, sob trava por auditoria, em dois tempos: (1) publica `dNNNN.json`; (2) grava o recibo
 * `aNNNN.json` na pasta separada. SÓ depois do (2) devolve sucesso. Antes de gravar: confere decisões e âncoras e chama o
 * `build` com o estado CONFIRMADO. Se existir uma entrada PENDENTE (publicada sem recibo), nada novo é gravado sobre ela: o
 * `build` pode reconhecer o pedido como o REENVIO dela (`replayOf`), e então o recibo é concluído agora; qualquer outro pedido
 * recebe `PENDING_UNCONFIRMED`; o reenvio da pendente só ganha recibo com a ORIGEM comprovada (`ORIGIN_UNPROVEN` caso contrário: quem escreve na
 * pasta de decisões não consegue "legitimar" uma entrada, nem pelo reenvio do autor nomeado nela). Em
 * corrida com outro processo (o `link()` exclusivo falha com EEXIST), relê e reavalia até `WRITE_RETRIES` vezes: a decisão
 * nunca é gravada sobre um estado desatualizado. Se o recibo falhar, a entrada fica PENDENTE e a resposta é `ANCHOR_PENDING`.
 */
export async function appendEntry<F>(baseDir: unknown, auditId: unknown, build: (context: BuildContext) => BuildOutcome<F>, options: WriteOptions): Promise<AppendResult<F>> {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const located = locateAudit(baseDir, auditId, projectRoot);
  if (!located.ok) return located;
  const anchorLocated = locateAnchors(options.anchorDir, auditId, projectRoot);
  if (!anchorLocated.ok) return anchorLocated;
  const { root, dir } = located.value;
  const ledger = options.ledger;
  // R6-07: com o livro, a ordem de durabilidade entre pastas faz parte do protocolo; a falha do fsync de diretório da entrada ou do recibo NÃO pode virar sucesso.
  const watch = ledger ? watchDurability(ops) : null;
  const atomic = atomicOnly(watch?.ops ?? ops);
  const durabilityUnproven = (): StoreFailure | null => {
    if (!watch || watch.failure() === null) return null;
    tripBase(root);
    tripBase(anchorLocated.value.root);
    return fail('STORAGE_FATAL', DURABILITY_UNPROVEN_MESSAGE);
  };
  /**
   * R7-04: sincroniza (fsync) os diretórios dados e SÓ devolve `null` se todos ficaram comprovadamente duráveis. É o que impede uma RETOMADA (reenvio de pendente, fase C,
   * recibo adotado) de devolver sucesso sem nunca ter sincronizado o diretório cujo fsync falhou antes. Sem o livro (6B isolada) não faz nada.
   */
  const syncStrict = async (dirs: readonly string[]): Promise<StoreFailure | null> => {
    if (!watch) return null;
    for (const target of dirs) {
      try {
        await watch.ops.syncDirectory(target);
      } catch {
        /* registrado por `watchDurability`; a decisão vem logo abaixo */
      }
    }
    return durabilityUnproven();
  };
  /** Diretórios-PAI das pastas da auditoria: numa RETOMADA o fsync deles pode ter falhado numa criação anterior (o fsync da pasta filha não persiste o nome dela). */
  const parentDirs = [path.dirname(dir), path.dirname(anchorLocated.value.dir)];
  /** Pastas da auditoria (decisões e âncoras). Com o livro, só são criadas DEPOIS de o livro autorizar: uma escrita recusada não deixa rastro. */
  const prepareDirectories = async (): Promise<StoreFailure | null> => {
    const hadAnchors = (await dirStatus(ops, anchorLocated.value.dir)) === 'EXISTS';
    const hadDecisions = (await dirStatus(ops, dir)) === 'EXISTS';
    const anchorReady = await prepareAnchorDirectory(ops, anchorLocated.value);
    if (anchorReady) return anchorReady;
    const decisionsReady = await ensureDirectory(ops, dir, 'decisões');
    if (decisionsReady) return decisionsReady;
    // R7-04: o fsync da pasta da auditoria NÃO persiste o nome dela no diretório-PAI
    // R7-04 (revisão 7, M2): SEMPRE sincroniza os pais, não só quando a pasta foi criada agora — uma criação anterior pode ter deixado o fsync do pai falho (e o processo ter reiniciado);
    // depois do reinício a pasta já existe e nada mais diria que o NOME dela nunca foi comprovado em disco. Custo: 2 fsyncs por gravação.
    void hadAnchors;
    void hadDecisions;
    return syncStrict(parentDirs);
  };

  return withLock(`decisions:${dir.toLowerCase()}`, async (): Promise<AppendResult<F>> => {
    let ledgerWaits = 0;
    let rechecks = 0;
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      if (isBaseTripped(root) || isBaseTripped(anchorLocated.value.root)) {
        return fail('STORAGE_FATAL', 'Erro fatal de disco anterior: todas as escritas estão interrompidas até reiniciar o servidor.');
      }
      const base = await dirStatus(ops, root);
      if (base === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento de decisões não existe neste servidor.');
      if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de decisões não é um diretório comum.');
      if (!ledger) {
        const prepared = await prepareDirectories();
        if (prepared) return prepared;
      }

      // ORDEM DE LEITURA CONSISTENTE (R7-05/R7-06): resultados → (guarda →) livro → decisões e recibos. Cada fonte só cresce e cita as anteriores, então ler primeiro a que é
      // citada pela seguinte nunca produz um desacordo falso por corrida; relida A CADA tentativa (nunca fixa durante as esperas e releituras).
      const results = ledger ? await ledger.readResults() : null;
      const session = ledger ? await ledger.port.begin(auditId as string) : null;
      const read = await readVerified(ops, located.value, anchorLocated.value, auditId as string);
      if (!read.ok) return read;
      const { state: confirmed, pending, anchorFiles } = read.value;
      const entries = pending ? [...confirmed.entries, pending] : confirmed.entries;
      const seq = entries.length + 1;
      if (pending === null && seq > MAX_SEQ) return fail('LIMIT_REACHED', `O histórico desta auditoria atingiu o limite de ${MAX_SEQ} entradas.`);
      const recordedAt = laterOf(options.now(), entries[entries.length - 1]?.recordedAt);

      let pendingKind: 'OPEN_INTENT' | 'RECEIPT_REMOVED' | null = null;
      if (ledger) {
        const step = await ledger.port.prepare({
          session,
          auditId: auditId as string,
          snapshot: ledgerSnapshotOf(confirmed.entries, pending),
          results: results as ResultsEvidence,
          intended: ledger.intended,
          freshResults: ledger.readResults,
          decisionsWitness: ledger.decisionsWitness(confirmed.entries, pending),
          ensureDurable: async () => (await syncStrict([dir, anchorLocated.value.dir, ...parentDirs])) === null,
          entryOriginProven: (entrySeq) => {
            const found = entries[entrySeq - 1];
            return found !== undefined && judgeOrigin(options.origin, 'DECISION', found) === 'PROVEN';
          },
          nowIso: options.now(),
          actor: ledger.actor,
          rechecks,
        });
        if (step.kind === 'REFUSED') return durabilityUnproven() ?? { ok: false, code: 'LEDGER_REFUSED', refusal: step.refusal };
        if (step.kind === 'WAIT') {
          if (++ledgerWaits > MAX_LEDGER_WAITS) return { ok: false, code: 'LEDGER_REFUSED', refusal: { code: 'LEDGER_OPERATION_IN_PROGRESS', reason: null, issues: ['Há uma operação de outro processo em andamento nesta auditoria; tente novamente.'], view: null } };
          await sleep(step.ms);
          attempt -= 1; // esperar não consome tentativa
          continue;
        }
        if (step.kind === 'RETRY') {
          if (step.transient) rechecks += 1;
          await sleep(step.ms);
          continue;
        }
        pendingKind = step.pendingKind;
        if (pending && pendingKind === null) return fail('INTERNAL', 'Há decisão pendente que o livro não reconheceu (erro interno): nada foi gravado.');
      }

      const built = build({ state: confirmed, pending, entries, seq, recordedAt });
      if (!built.ok) return { ok: false, code: 'REJECTED', failure: built.failure };

      if ('replayOf' in built) {
        const target = entries[built.replayOf - 1];
        if (!target) return fail('INTERNAL', 'Reenvio aponta para uma entrada que não existe (erro interno).');
        if (target !== pending) {
          if (ledger) {
            // R7-04: reenvio de entrada que o livro JÁ confirmou. "Existe" não prova "sobrevive a uma queda" (o fsync de alguma das três pastas pode ter falhado antes de um
            // reinício): o sucesso exige sincronizar AGORA decisões, recibos e livro. Falha ⇒ durabilidade desconhecida (nunca sucesso).
            const durable = await syncStrict([dir, anchorLocated.value.dir, ...parentDirs]);
            if (durable) return durable;
            const ledgerDurable = await ledger.port.sync(auditId as string);
            if (!ledgerDurable.ok) return { ok: false, code: 'LEDGER_REFUSED', refusal: ledgerDurable.refusal };
          }
          return { ok: true, entry: target, state: confirmed, anchored: true, replayed: true, anchors: confirmedSummary(confirmed.entries.length) };
        }
        // Reenvio da PENDENTE: antes de dar o RECIBO, exige a PROVA DE ORIGEM (o arquivo vive numa pasta que quem escreve nela controla
        // por inteiro: autor, conteúdo e selo são afirmações dele). Sem prova válida o recibo NÃO é dado e nada é gravado.
        const verdict = judgeOrigin(options.origin, 'DECISION', pending);
        if (verdict !== 'PROVEN') return { ok: false, code: 'ORIGIN_UNPROVEN', issues: ['A origem desta pendência não pôde ser comprovada pelo servidor; nenhum recibo foi gravado.'], pending, state: confirmed, verdict };
        if (ledger && pendingKind === 'RECEIPT_REMOVED') {
          // Recibo removido de entrada que o livro JÁ confirmou: a reemissão de MESMO conteúdo fica registrada no livro ANTES do recibo (a evidência não se perde).
          const reissued = await ledger.port.reissue({ session, auditId: auditId as string, actor: ledger.actor, nowIso: options.now(), entry: ledgerRefOf(pending) });
          if (reissued.kind === 'REFUSED') return { ok: false, code: 'LEDGER_REFUSED', refusal: reissued.refusal };
          if (reissued.kind !== 'OK') continue;
        }
        // R7-04: a entrada pendente foi publicada por uma tentativa anterior (talvez com o fsync do diretório falho): ela só é dada como durável depois de sincronizada AGORA.
        const entryDurable = await syncStrict([dir, path.dirname(dir)]);
        if (entryDurable) return entryDurable;
        // Se falhar de novo, continua pendente (e o operador pode reenviar outra vez).
        const concluded = await confirmAnchor(watch?.ops ?? ops, anchorLocated.value, pending, anchorFiles[anchorFiles.length - 1], laterOf(options.now(), pending.recordedAt));
        if (!concluded.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: concluded.issues, pending, state: confirmed };
        // o recibo (gravado agora ou ADOTADO de uma tentativa anterior) também só vale depois de a pasta de recibos ser sincronizada agora
        const receiptDurable = await syncStrict([anchorLocated.value.dir, path.dirname(anchorLocated.value.dir)]);
        if (receiptDurable) return receiptDurable;
        if (ledger && pendingKind === 'OPEN_INTENT') {
          const sealedByLedger = await ledger.port.confirmed({ session, auditId: auditId as string, actor: ledger.actor, nowIso: options.now(), entry: ledgerRefOf(pending) });
          if (sealedByLedger.kind === 'REFUSED') return { ok: false, code: 'LEDGER_REFUSED', refusal: sealedByLedger.refusal };
        }
        const whole = replay(entries);
        if (!whole.ok) return fail('SEMANTIC', ...whole.issues.slice(0, 10));
        return { ok: true, entry: pending, state: whole.value, anchored: true, replayed: true, anchors: confirmedSummary(entries.length) };
      }
      if (pending) {
        return { ok: false, code: 'PENDING_UNCONFIRMED', issues: ['Há uma decisão publicada ainda sem recibo na pasta de âncoras; nada novo é gravado sobre ela.'], pending, state: confirmed };
      }

      // A primitiva NUNCA grava uma entrada sem etiqueta de origem (defesa em profundidade: as rotas e o serviço já recusam sem chave)
      if (!options.origin) return fail('INTERNAL', 'Sem autenticador de origem, nenhuma entrada é gravada.');
      const unsigned = { ...built.draft, seq, prevSha256: confirmed.head?.sha256 ?? null };
      const entry = seal({ ...unsigned, origin: options.origin.sign('DECISION', unsigned) });
      const checked = decisionEntrySchema.safeParse(entry);
      if (!checked.success) return fail('INTERNAL', 'A entrada montada não segue o contrato (erro interno).');
      if (canonicalJson(checked.data) !== canonicalJson(entry)) return fail('INTERNAL', 'O esquema alteraria o conteúdo da entrada (erro interno): nada foi gravado.');
      const next = replay([...confirmed.entries, checked.data]);
      if (!next.ok) return fail('SEMANTIC', ...next.issues.slice(0, 10));
      const data = serialize(entry); // exatamente os bytes que a leitura estrita exige
      if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) return fail('LIMIT_REACHED', 'A entrada ultrapassa o tamanho máximo permitido.');

      if (ledger) {
        const prepared = await prepareDirectories();
        if (prepared) return prepared;
        const intended = await ledger.port.intent({ session, auditId: auditId as string, actor: ledger.actor, nowIso: options.now(), entry: ledgerRefOf(checked.data) });
        if (intended.kind === 'REFUSED') return { ok: false, code: 'LEDGER_REFUSED', refusal: intended.refusal };
        if (intended.kind === 'RETRY' || intended.kind === 'WAIT') {
          await sleep(intended.kind === 'RETRY' ? intended.ms : 10);
          continue; // outro processo ocupou a posição do livro: relê e reavalia (nada foi publicado)
        }
      }

      const finalName = entryFileName(seq);
      const published = await publishExclusive(atomic, {
        dir,
        finalPath: path.join(dir, finalName),
        tempPath: path.join(dir, `.tmp-${finalName}-${randomBytes(8).toString('hex')}`),
        data,
        label: `A decisão ${finalName}`,
      });
      if (!published.ok) {
        if (published.code === 'CONFLICT') continue; // outro processo gravou este número: relê e reavalia
        if (published.errno === ATOMIC_UNAVAILABLE_ERRNO) {
          return fail('ATOMIC_WRITE_UNAVAILABLE', 'O armazenamento não suporta link() atômico; as decisões não são gravadas por caminho não atômico.');
        }
        if (published.errno && FATAL_ERRNO.has(published.errno)) {
          tripBase(root);
          return fail('STORAGE_FATAL', `Erro fatal de disco (${published.errno}): todas as escritas foram interrompidas.`, ...published.issues);
        }
        return fail('WRITE_FAILED', ...published.issues);
      }

      const unprovenEntry = durabilityUnproven();
      if (unprovenEntry) return unprovenEntry; // a entrada existe (fica pendente), mas sem durabilidade comprovada nem o recibo nem o sucesso seguem
      // A entrada já existe, mas SÓ vale depois do recibo. Se ele falhar, a entrada fica PENDENTE e nenhum sucesso é devolvido.
      const receipt = await confirmAnchor(watch?.ops ?? ops, anchorLocated.value, checked.data, anchorFiles[anchorFiles.length - 1], recordedAt);
      if (!receipt.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: receipt.issues, pending: checked.data, state: confirmed };
      const unprovenReceipt = await syncStrict([anchorLocated.value.dir]);
      if (unprovenReceipt) return unprovenReceipt;
      if (ledger) {
        // PONTO DE DURABILIDADE: só depois do CONFIRMED no livro a resposta é de sucesso.
        const sealedByLedger = await ledger.port.confirmed({ session, auditId: auditId as string, actor: ledger.actor, nowIso: options.now(), entry: ledgerRefOf(checked.data) });
        if (sealedByLedger.kind === 'REFUSED') return { ok: false, code: 'LEDGER_REFUSED', refusal: sealedByLedger.refusal };
      }
      return { ok: true, entry: checked.data, state: next.value, anchored: true, replayed: false, anchors: confirmedSummary(seq) };
    }
    return fail('CONFLICT', 'Outro processo gravou continuamente nesta auditoria; nada foi sobrescrito. Tente novamente.');
  });
}

/**
 * BARREIRA de durabilidade das pastas de decisões e de recibos de UMA auditoria (e dos diretórios-pai onde vivem os nomes delas): sincroniza tudo AGORA e só devolve `null` se nenhuma sincronização
 * falhou. Usada antes de selar um resultado que cita o livro. Falha ⇒ as duas bases travam (depois de um erro de fsync não se presume nada).
 */
export async function syncDecisionDirectories(baseDir: unknown, auditId: unknown, options: { readonly fs?: FsOps; readonly projectRoot?: string; readonly anchorDir?: unknown }): Promise<StoreFailure | null> {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const located = locateAudit(baseDir, auditId, projectRoot);
  if (!located.ok) return located;
  const anchorLocated = locateAnchors(options.anchorDir, auditId, projectRoot);
  if (!anchorLocated.ok) return anchorLocated;
  const { root, dir } = located.value;
  if (isBaseTripped(root) || isBaseTripped(anchorLocated.value.root)) return fail('STORAGE_FATAL', DURABILITY_UNPROVEN_MESSAGE);
  const watch = watchDurability(ops);
  let unreadable = false;
  for (const target of [dir, anchorLocated.value.dir, path.dirname(dir), path.dirname(anchorLocated.value.dir)]) {
    // pasta da auditoria que ainda não existe (auditoria sem decisões) não tem o que sincronizar; qualquer outra situação diferente de "existe" é falha
    const status = await dirStatus(ops, target);
    if (status === 'MISSING') continue;
    if (status !== 'EXISTS') {
      unreadable = true;
      continue;
    }
    try {
      await watch.ops.syncDirectory(target);
    } catch {
      /* registrado por `watchDurability` */
    }
  }
  if (watch.failure() === null && !unreadable) return null;
  tripBase(root);
  tripBase(anchorLocated.value.root);
  return fail('STORAGE_FATAL', DURABILITY_UNPROVEN_MESSAGE);
}
