import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../link-audit/canonical';
import { describeError, nodeFsOps, publishExclusive, withLock, type FsOps } from '../link-audit/snapshot-store';
import { confirmAnchor, prepareAnchorDirectory, readAnchors, verifyAnchors, type AnchorSummary } from './anchor-store';
import {
  assertBase,
  atomicOnly,
  ATOMIC_UNAVAILABLE_ERRNO,
  splitNames,
  dirStatus,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  isBaseTripped,
  locateIn,
  readSealedFile,
  seal,
  serialize,
  tripBase,
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
 * ela). Só o REENVIO do mesmo pedido a conclui. Assim a perda de uma pendente não contradiz nenhuma promessa feita, e a perda
 * de uma confirmada é sempre detectável (recibo à frente do histórico).
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
}

const WRITE_RETRIES = 5;

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
  for (const n of numbers) {
    const name = entryFileName(n);
    const file = await readSealedFile<DecisionEntry>(ops, path.join(located.dir, name), MAX_ENTRY_BYTES, decisionEntrySchema);
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
  /** `ANCHOR_PENDING`: esta chamada publicou a entrada e o recibo falhou. `PENDING_UNCONFIRMED`: já havia uma pendente e o pedido não é o reenvio dela. */
  readonly code: 'ANCHOR_PENDING' | 'PENDING_UNCONFIRMED';
  readonly issues: readonly string[];
  readonly pending: DecisionEntry;
  /** Estado CONFIRMADO (sem a pendente): o `head` a usar ao reenviar. */
  readonly state: LogState;
}

/** `ok: true` SIGNIFICA confirmado: a decisão e o recibo estão duráveis. Não existe mais "gravada, mas sem recibo" como sucesso. */
export type AppendResult<F> =
  | { readonly ok: true; readonly entry: DecisionEntry; readonly state: LogState; readonly anchored: true; readonly replayed: boolean; readonly anchors: AnchorSummary }
  | StoreFailure
  | PendingFailure
  | { readonly ok: false; readonly code: 'REJECTED'; readonly failure: F };

const laterOf = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);
const confirmedSummary = (count: number): AnchorSummary => ({ count, lastSeq: count, unanchored: 0 });

/**
 * Acrescenta UMA entrada ao histórico, sob trava por auditoria, em dois tempos: (1) publica `dNNNN.json`; (2) grava o recibo
 * `aNNNN.json` na pasta separada. SÓ depois do (2) devolve sucesso. Antes de gravar: confere decisões e âncoras e chama o
 * `build` com o estado CONFIRMADO. Se existir uma entrada PENDENTE (publicada sem recibo), nada novo é gravado sobre ela: o
 * `build` pode reconhecer o pedido como o REENVIO dela (`replayOf`), e então o recibo é concluído agora; qualquer outro pedido
 * recebe `PENDING_UNCONFIRMED` (quem escreve na pasta de decisões não consegue "legitimar" uma entrada só por existir). Em
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
  const atomic = atomicOnly(ops);

  return withLock(`decisions:${dir.toLowerCase()}`, async (): Promise<AppendResult<F>> => {
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      if (isBaseTripped(root) || isBaseTripped(anchorLocated.value.root)) {
        return fail('STORAGE_FATAL', 'Erro fatal de disco anterior: todas as escritas estão interrompidas até reiniciar o servidor.');
      }
      const base = await dirStatus(ops, root);
      if (base === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento de decisões não existe neste servidor.');
      if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de decisões não é um diretório comum.');
      const anchorReady = await prepareAnchorDirectory(ops, anchorLocated.value);
      if (anchorReady) return anchorReady;
      const ensured = await ensureDirectory(ops, dir, 'decisões');
      if (ensured) return ensured;

      const read = await readVerified(ops, located.value, anchorLocated.value, auditId as string);
      if (!read.ok) return read;
      const { state: confirmed, pending, anchorFiles } = read.value;
      const entries = pending ? [...confirmed.entries, pending] : confirmed.entries;
      const seq = entries.length + 1;
      if (pending === null && seq > MAX_SEQ) return fail('LIMIT_REACHED', `O histórico desta auditoria atingiu o limite de ${MAX_SEQ} entradas.`);
      const recordedAt = laterOf(options.now(), entries[entries.length - 1]?.recordedAt);

      const built = build({ state: confirmed, pending, entries, seq, recordedAt });
      if (!built.ok) return { ok: false, code: 'REJECTED', failure: built.failure };

      if ('replayOf' in built) {
        const target = entries[built.replayOf - 1];
        if (!target) return fail('INTERNAL', 'Reenvio aponta para uma entrada que não existe (erro interno).');
        if (target !== pending) return { ok: true, entry: target, state: confirmed, anchored: true, replayed: true, anchors: confirmedSummary(confirmed.entries.length) };
        // Reenvio da PENDENTE: concluir o recibo agora. Se falhar de novo, continua pendente (e o operador pode reenviar outra vez).
        const concluded = await confirmAnchor(ops, anchorLocated.value, pending, anchorFiles[anchorFiles.length - 1], laterOf(options.now(), pending.recordedAt));
        if (!concluded.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: concluded.issues, pending, state: confirmed };
        const whole = replay(entries);
        if (!whole.ok) return fail('SEMANTIC', ...whole.issues.slice(0, 10));
        return { ok: true, entry: pending, state: whole.value, anchored: true, replayed: true, anchors: confirmedSummary(entries.length) };
      }
      if (pending) {
        return { ok: false, code: 'PENDING_UNCONFIRMED', issues: ['Há uma decisão publicada ainda sem recibo na pasta de âncoras; nada novo é gravado sobre ela.'], pending, state: confirmed };
      }

      const entry = seal({ ...built.draft, seq, prevSha256: confirmed.head?.sha256 ?? null });
      const checked = decisionEntrySchema.safeParse(entry);
      if (!checked.success) return fail('INTERNAL', 'A entrada montada não segue o contrato (erro interno).');
      if (canonicalJson(checked.data) !== canonicalJson(entry)) return fail('INTERNAL', 'O esquema alteraria o conteúdo da entrada (erro interno): nada foi gravado.');
      const next = replay([...confirmed.entries, checked.data]);
      if (!next.ok) return fail('SEMANTIC', ...next.issues.slice(0, 10));
      const data = serialize(entry); // exatamente os bytes que a leitura estrita exige
      if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) return fail('LIMIT_REACHED', 'A entrada ultrapassa o tamanho máximo permitido.');

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

      // A entrada já existe, mas SÓ vale depois do recibo. Se ele falhar, a entrada fica PENDENTE e nenhum sucesso é devolvido.
      const receipt = await confirmAnchor(ops, anchorLocated.value, checked.data, anchorFiles[anchorFiles.length - 1], recordedAt);
      if (!receipt.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: receipt.issues, pending: checked.data, state: confirmed };
      return { ok: true, entry: checked.data, state: next.value, anchored: true, replayed: false, anchors: confirmedSummary(seq) };
    }
    return fail('CONFLICT', 'Outro processo gravou continuamente nesta auditoria; nada foi sobrescrito. Tente novamente.');
  });
}
