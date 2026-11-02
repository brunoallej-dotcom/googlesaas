import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../link-audit/canonical';
import { judgeOrigin, type OriginAuthenticator, type OriginVerdict } from '../link-audit-origin';
import { describeError, nodeFsOps, publishExclusive, withLock, type FsOps } from '../link-audit/snapshot-store';
import {
  assertBase,
  atomicOnly,
  ATOMIC_UNAVAILABLE_ERRNO,
  confirmReceipt,
  dirStatus,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  isBaseTripped,
  locateIn,
  prepareReceiptDirectory,
  readReceipts,
  readSealedFile,
  seal,
  serialize,
  splitNames,
  tripBase,
  verifyReceipts,
  type Location,
  type ReceiptProfile,
  type ReceiptSummary,
  type StoreFailure,
  type StoreOptions,
  type StoreResult,
} from '../link-audit-storage';
import { STORE_AUDIT_ID } from './audit-id-alias';
import { MAX_RUN_ANCHOR_BYTES, MAX_RUN_BYTES, MAX_RUNS, RUN_ANCHOR_FILE, RUN_ANCHOR_KIND, RUN_FILE, RUN_SCHEMA_VERSION, runAnchorFileName, runAnchorSchema, runFileName, scoreRunSchema, type RunAnchor, type ScoreRun, type ScoreRunDraft } from './results-types';

/*
 * Armazenamento dos RESULTADOS FINALIZADOS (Onda 6C, I4): UM arquivo imutável por resultado (`<base>/<auditId>/sNNNN.json`), no MESMO
 * mecanismo de gravação das evidências, dos snapshots e das decisões (`publishExclusive`: temporário exclusivo + fsync + `link()`
 * exclusivo), SOMENTE de forma atômica; nunca sobrescreve, nunca apaga. A base é uma pasta DEDICADA (GMN_LINK_AUDIT_RESULTS_DIR) e o
 * recibo de cada resultado vai para outra (GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR), pelo protocolo de recibos do I0 (`link-audit-storage`).
 *
 * PROTOCOLO (idêntico ao da 6B, Emenda 1): um resultado só é CONFIRMADO quando o arquivo `sNNNN.json` E o recibo `aNNNN.json` estão
 * duráveis. Entre os dois ele é PENDENTE: existe, mas NÃO vale (não é devolvido como resultado, não é sucesso, nada novo é gravado
 * sobre ele). Só o REENVIO do mesmo pedido pelo mesmo autor o conclui, e SOMENTE se o servidor comprovar a ORIGEM do arquivo (etiqueta HMAC
 * com chave fora das pastas; `link-audit-origin`): o "autor", o conteúdo e o selo SHA-256 são afirmações de quem escreve na pasta, e "mesmo
 * autor, mesmo pedido" não prova nada (o pedido é montado a partir do próprio arquivo). A perda de um resultado confirmado é detectável
 * quando o recibo fica à frente do histórico; a remoção do ÚLTIMO recibo é indistinguível de uma gravação interrompida (limite declarado).
 *
 * Por que `appendRun` não reutiliza o `appendEntry` da 6B: aquele é amarrado ao tipo de entrada, ao esquema e à projeção de decisões
 * e a 6B está CONGELADA (I0 provou a refatoração byte a byte); generalizá-lo exigiria mexer no protocolo da 6B. Aqui a mecânica
 * (trava, releitura, corrida por `link()`, recibo, pendente) é a mesma, com um `build` ASSÍNCRONO (a finalização relê evidências e
 * decisões DENTRO da trava) e sem projeção semântica (a verificação semântica é do serviço).
 */
export type { Location, StoreErrorCode, StoreFailure, StoreOptions, StoreResult } from '../link-audit-storage';
/** O serviço usa o MESMO sistema de arquivos injetável do armazenamento (testes injetam falhas de disco); só este arquivo toca o mecanismo de gravação. */
export { nodeFsOps, type FsOps };
export type RunAnchorSummary = ReceiptSummary;

export interface ReadOptions extends StoreOptions {
  /** Pasta de recibos (OBRIGATÓRIA; separada da de resultados). */
  readonly anchorDir: string;
}
export interface WriteOptions extends ReadOptions {
  /** Relógio do servidor (ISO UTC com milissegundos). O módulo nunca consulta o relógio sozinho. */
  readonly now: () => string;
  /** Verificação semântica do registro JÁ SELADO, antes de publicar (devolve problemas; vazio = ok). */
  readonly validate?: (sealed: ScoreRun) => readonly string[];
  /**
   * Autenticador de ORIGEM (chave do servidor, fora das pastas). Com ele, todo resultado novo sai assinado e uma PENDENTE só é
   * concluída (recibo) se a etiqueta for válida. SEM ele nada é assinado e NENHUMA pendente é concluída (falha fechada).
   */
  readonly origin?: OriginAuthenticator;
}

const WRITE_RETRIES = 5;
const ID_RULE = { pattern: STORE_AUDIT_ID, message: 'auditId inválido (8 a 64 caracteres: letras minúsculas, números, _ e -).' };

export const assertResultsBase = (baseDir: unknown, projectRoot: string): StoreResult<string> => assertBase(baseDir, projectRoot, 'resultados');
export const locateRuns = (baseDir: unknown, auditId: unknown, projectRoot: string): StoreResult<Location> => locateIn(baseDir, auditId, projectRoot, 'resultados', ID_RULE);
const locateRunAnchors = (anchorDir: unknown, auditId: unknown, projectRoot: string): StoreResult<Location> => locateIn(anchorDir, auditId, projectRoot, 'recibos de resultados', ID_RULE);

/* ------------------------------------------------------------------ recibos (perfil do protocolo genérico do I0) */
const RUN_ANCHORS: ReceiptProfile<RunAnchor> = {
  schemaVersion: RUN_SCHEMA_VERSION,
  kind: RUN_ANCHOR_KIND,
  prefix: 'a',
  filePattern: RUN_ANCHOR_FILE,
  fileName: runAnchorFileName,
  maxBytes: MAX_RUN_ANCHOR_BYTES,
  schema: runAnchorSchema,
  attempts: 3,
  messages: {
    storeMissing: 'O armazenamento de recibos de resultados não existe neste servidor.',
    storeNotDirectory: 'O armazenamento de recibos de resultados não é um diretório comum.',
    auditNotDirectory: 'A pasta de recibos de resultados da auditoria não é um diretório comum.',
    listingLabel: 'listagem dos recibos de resultados',
    directoryLabel: 'recibos de resultados',
    suspicious: (name) => `Arquivo suspeito na pasta de recibos de resultados: ${name}.`,
    gap: (expected, found) => `Lacuna na sequência de recibos de resultados (esperado ${expected}, achado ${found}).`,
    otherAudit: (name) => `${name} pertence a outra auditoria.`,
    sequenceMismatch: (name, n) => `${name}: a sequência interna (${n}) não corresponde ao nome do arquivo.`,
    notChained: (name) => `${name}: não está encadeado ao recibo anterior.`,
    truncated: (entries, receipts) => `O histórico de resultados tem ${entries} arquivo(s), mas há recibo(s) até a posição ${receipts}: resultados foram removidos ou o histórico foi restaurado de uma cópia antiga.`,
    mismatch: (n) => `O resultado ${n} não confere com o recibo gravado na pasta separada (arquivo reescrito ou substituído).`,
    tooManyUnanchored: (count) => `${count} resultados estão sem recibo (o máximo tolerado é 1): recibos removidos ou pasta de recibos trocada.`,
    fatalBefore: 'Erro fatal de disco anterior na pasta de recibos de resultados: escritas interrompidas até reiniciar o servidor.',
    invalidContract: 'O recibo montado não segue o contrato (erro interno).',
    label: (name) => `O recibo ${name}`,
    exists: (name) => `O recibo ${name} já existe; nada foi sobrescrito.`,
    noAtomicLink: 'O armazenamento de recibos de resultados não suporta link() atômico.',
    fatalNow: (errno) => `Erro fatal de disco (${errno}) na pasta de recibos de resultados: escritas interrompidas.`,
    noAttempt: 'Nenhuma tentativa de gravar o recibo foi feita.',
    notLast: (name) => `O recibo ${name} existe, mas a pasta de recibos não termina nele.`,
    notMatching: (name, n) => `O recibo ${name} já existe e NÃO corresponde ao resultado ${n}.`,
  },
};

/* ------------------------------------------------------------------ leitura e verificação completa */
export interface RunLog {
  /** Resultados CONFIRMADOS (com recibo): são os únicos que valem. */
  readonly runs: readonly ScoreRun[];
  /** Cauda publicada e ainda sem recibo (no máximo 1). Existe no disco, mas não vale até ser concluída. */
  readonly pending: ScoreRun | null;
  readonly checkedFiles: number;
  readonly anchors: RunAnchorSummary;
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

interface RunsRead {
  readonly runs: readonly ScoreRun[];
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

async function readRunFiles(ops: FsOps, located: Location, auditId: string): Promise<StoreResult<RunsRead>> {
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento de resultados não existe neste servidor.');
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de resultados não é um diretório comum.');
  const audit = await dirStatus(ops, located.dir);
  if (audit === 'MISSING') return { ok: true, value: { runs: [], unexpectedFiles: [], orphanTempFiles: [] } };
  if (audit !== 'EXISTS') return fail('UNSAFE_PATH', 'A pasta de resultados da auditoria não é um diretório comum.');

  let names: string[];
  try {
    names = await ops.readdir(located.dir);
  } catch (error) {
    return fail('CORRUPT', describeError('listagem', error));
  }
  const { numbers, orphanTempFiles, suspicious, unexpectedFiles } = splitNames(names, RUN_FILE, 's');
  if (suspicious.length > 0) return fail('CORRUPT', `Arquivo suspeito na pasta de resultados: ${suspicious[0]?.slice(0, 80)}.`);
  for (const [index, n] of numbers.entries()) {
    if (n !== index + 1) return fail('SEQUENCE_GAP', `Lacuna na sequência de resultados (esperado ${runFileName(index + 1)}, achado ${runFileName(n)}).`);
  }
  const runs: ScoreRun[] = [];
  let previous: string | null = null;
  for (const n of numbers) {
    const name = runFileName(n);
    const file = await readSealedFile<ScoreRun>(ops, path.join(located.dir, name), MAX_RUN_BYTES, scoreRunSchema);
    if (!file.ok) return file;
    const run = file.value;
    if (run.auditId !== auditId) return fail('CHAIN_BROKEN', `${name} pertence a outra auditoria.`);
    if (run.seq !== n) return fail('CHAIN_BROKEN', `${name}: a sequência interna (${run.seq}) não corresponde ao nome do arquivo.`);
    if (run.prevSha256 !== previous) return fail('CHAIN_BROKEN', `${name}: não está encadeado ao arquivo anterior.`);
    if (run.finalizedAt < (runs[runs.length - 1]?.finalizedAt ?? '')) return fail('SEMANTIC', `${name}: a hora do resultado é anterior à do resultado anterior.`);
    previous = run.contentSha256;
    runs.push(run);
  }
  return { ok: true, value: { runs, unexpectedFiles, orphanTempFiles } };
}

interface Verified extends RunLog {
  readonly anchorFiles: readonly RunAnchor[];
  /** Todos os arquivos publicados (confirmados + a pendente), em ordem. */
  readonly all: readonly ScoreRun[];
}

/** Falhas que só aparecem ao CRUZAR as duas pastas: relê-se UMA vez antes de acusar (uma escrita concorrente pode produzi-las sem adulteração). */
const CROSS_FOLDER_FAILURES: ReadonlySet<string> = new Set(['TRUNCATED', 'ANCHOR_INTEGRITY', 'ANCHOR_MISMATCH']);

async function readVerified(ops: FsOps, runs: Location, anchors: Location, auditId: string): Promise<StoreResult<Verified>> {
  const first = await readVerifiedOnce(ops, runs, anchors, auditId);
  if (first.ok || !CROSS_FOLDER_FAILURES.has(first.code)) return first;
  return readVerifiedOnce(ops, runs, anchors, auditId);
}

async function readVerifiedOnce(ops: FsOps, runs: Location, anchors: Location, auditId: string): Promise<StoreResult<Verified>> {
  // Os recibos são lidos ANTES: como o resultado é publicado antes do recibo, uma escrita concorrente no meio da leitura deixa, no
  // pior caso, um resultado a mais que recibos (PENDENTE), nunca um recibo à frente (falso TRUNCATED).
  const receipts = await readReceipts(RUN_ANCHORS, ops, anchors, auditId);
  const log = await readRunFiles(ops, runs, auditId);
  if (!log.ok) return log;
  if (!receipts.ok) return receipts;
  const summary = verifyReceipts(RUN_ANCHORS, log.value.runs, receipts.value.anchors);
  if (!summary.ok) return summary;
  const all = log.value.runs;
  const pending = summary.value.unanchored === 1 ? (all[all.length - 1] ?? null) : null;
  return {
    ok: true,
    value: {
      runs: pending ? all.slice(0, -1) : all,
      all,
      pending,
      checkedFiles: all.length,
      anchors: summary.value,
      anchorFiles: receipts.value.anchors,
      unexpectedFiles: [...log.value.unexpectedFiles, ...receipts.value.unexpectedFiles],
      orphanTempFiles: [...log.value.orphanTempFiles, ...receipts.value.orphanTempFiles],
    },
  };
}

/** `null` = pode ler. Raiz ausente (`mustExist`) ou qualquer erro de E/S ⇒ `STORAGE_UNAVAILABLE`; existe e não é um diretório comum (arquivo, link) ⇒ `NOT_CONFIGURED`. */
export async function probeDirectory(ops: FsOps, dir: string, mustExist: boolean): Promise<'NOT_CONFIGURED' | 'STORAGE_UNAVAILABLE' | null> {
  try {
    const info = await ops.lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? null : 'NOT_CONFIGURED';
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !mustExist ? null : 'STORAGE_UNAVAILABLE';
  }
}

/** Relê TUDO (resultados e recibos: bytes, hashes, encadeamento, sequência, confronto). Nunca escreve. */
export async function readRunLog(baseDir: unknown, auditId: unknown, options: ReadOptions): Promise<StoreResult<RunLog & { readonly all: readonly ScoreRun[] }>> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const located = locateRuns(baseDir, auditId, projectRoot);
  if (!located.ok) return located;
  const anchors = locateRunAnchors(options.anchorDir, auditId, projectRoot);
  if (!anchors.ok) return anchors;
  const verified = await readVerified(options.fs ?? nodeFsOps, located.value, anchors.value, auditId as string);
  if (!verified.ok) return verified;
  const { anchorFiles, ...rest } = verified.value; // os recibos em si não saem do módulo
  void anchorFiles;
  return { ok: true, value: rest };
}

/* ------------------------------------------------------------------ gravação */
export interface BuildContext {
  /** Resultados CONFIRMADOS. */
  readonly runs: readonly ScoreRun[];
  /** Cauda publicada e ainda SEM recibo (no máximo 1): existe, mas não vale. Nada novo é gravado enquanto houver uma. */
  readonly pending: ScoreRun | null;
  /** Todos os arquivos publicados (confirmados + a pendente), em ordem. */
  readonly all: readonly ScoreRun[];
  /** Número do próximo resultado. */
  readonly seq: number;
  /** Hora do servidor, monotônica dentro da trava (nunca anterior ao último resultado). */
  readonly finalizedAt: string;
}
export type BuildOutcome<F> =
  | { readonly ok: true; readonly draft: ScoreRunDraft }
  /** O pedido é o reenvio do resultado `replayOf` (confirmado ou pendente): nada novo é gravado; a pendente é concluída. */
  | { readonly ok: true; readonly replayOf: number }
  | { readonly ok: false; readonly failure: F };

/** O resultado foi publicado (ou já existia) mas NÃO está confirmado: o recibo falhou, há outra pendente no caminho ou a ORIGEM dela não é comprovada. */
export interface PendingFailure {
  readonly ok: false;
  /** `ORIGIN_UNPROVEN`: o pedido era o reenvio da pendente, mas a etiqueta de origem falta, não confere ou a chave é outra: NENHUM recibo foi gravado. */
  readonly code: 'ANCHOR_PENDING' | 'PENDING_UNCONFIRMED' | 'ORIGIN_UNPROVEN';
  readonly issues: readonly string[];
  readonly pending: ScoreRun;
  readonly runs: readonly ScoreRun[];
  /** Só em `ORIGIN_UNPROVEN`. */
  readonly verdict?: Exclude<OriginVerdict, 'PROVEN'>;
}

/** `ok: true` SIGNIFICA confirmado: o resultado e o recibo estão duráveis. */
export type AppendResult<F> =
  | { readonly ok: true; readonly run: ScoreRun; readonly runs: readonly ScoreRun[]; readonly anchored: true; readonly replayed: boolean; readonly anchors: RunAnchorSummary }
  | StoreFailure
  | PendingFailure
  | { readonly ok: false; readonly code: 'REJECTED'; readonly failure: F };

const laterOf = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);
const confirmedSummary = (count: number): RunAnchorSummary => ({ count, lastSeq: count, unanchored: 0 });

/**
 * Acrescenta UM resultado, sob trava por auditoria, em dois tempos: (1) publica `sNNNN.json`; (2) grava o recibo `aNNNN.json` na pasta
 * separada. SÓ depois do (2) devolve sucesso. Antes de gravar: confere resultados e recibos e chama o `build` (assíncrono) com o
 * estado CONFIRMADO. Existindo uma PENDENTE, nada novo é gravado sobre ela: o `build` pode reconhecer o pedido como o REENVIO dela
 * (`replayOf`) e então o recibo é concluído agora; qualquer outro pedido recebe `PENDING_UNCONFIRMED`. Em corrida com outro processo
 * (o `link()` exclusivo falha com EEXIST), relê e reavalia até `WRITE_RETRIES` vezes: nunca grava sobre estado desatualizado. Se o
 * recibo falhar, o resultado fica PENDENTE e a resposta é `ANCHOR_PENDING`.
 */
export async function appendRun<F>(baseDir: unknown, auditId: unknown, build: (context: BuildContext) => Promise<BuildOutcome<F>>, options: WriteOptions): Promise<AppendResult<F>> {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const located = locateRuns(baseDir, auditId, projectRoot);
  if (!located.ok) return located;
  const anchorLocated = locateRunAnchors(options.anchorDir, auditId, projectRoot);
  if (!anchorLocated.ok) return anchorLocated;
  const { root, dir } = located.value;
  const atomic = atomicOnly(ops);

  return withLock(`results:${dir.toLowerCase()}`, async (): Promise<AppendResult<F>> => {
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      if (isBaseTripped(root) || isBaseTripped(anchorLocated.value.root)) {
        return fail('STORAGE_FATAL', 'Erro fatal de disco anterior: todas as escritas estão interrompidas até reiniciar o servidor.');
      }
      const base = await dirStatus(ops, root);
      if (base === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento de resultados não existe neste servidor.');
      if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de resultados não é um diretório comum.');
      const anchorReady = await prepareReceiptDirectory(RUN_ANCHORS, ops, anchorLocated.value);
      if (anchorReady) return anchorReady;
      const ensured = await ensureDirectory(ops, dir, 'resultados');
      if (ensured) return ensured;

      const read = await readVerified(ops, located.value, anchorLocated.value, auditId as string);
      if (!read.ok) return read;
      const { runs: confirmed, pending, anchorFiles, all } = read.value;
      const seq = all.length + 1;
      const atLimit = pending === null && seq > MAX_RUNS; // só impede GRAVAÇÃO nova: o reenvio idempotente do último continua 200
      const finalizedAt = laterOf(options.now(), all[all.length - 1]?.finalizedAt);

      const built = await build({ runs: confirmed, pending, all, seq, finalizedAt });
      if (!built.ok) return { ok: false, code: 'REJECTED', failure: built.failure };

      if ('replayOf' in built) {
        const target = all[built.replayOf - 1];
        if (!target) return fail('INTERNAL', 'Reenvio aponta para um resultado que não existe (erro interno).');
        if (target !== pending) return { ok: true, run: target, runs: confirmed, anchored: true, replayed: true, anchors: confirmedSummary(confirmed.length) };
        // Reenvio da PENDENTE: antes de dar o RECIBO, exige a PROVA DE ORIGEM (o arquivo vive numa pasta que quem escreve nela controla
        // por inteiro: autor, conteúdo e selo são afirmações dele). Sem prova válida o recibo NÃO é dado e nada é gravado.
        const verdict = judgeOrigin(options.origin, 'RUN', pending);
        if (verdict !== 'PROVEN') return { ok: false, code: 'ORIGIN_UNPROVEN', issues: ['A origem desta pendência não pôde ser comprovada pelo servidor; nenhum recibo foi gravado.'], pending, runs: confirmed, verdict };
        // Se o recibo falhar de novo, continua pendente (e o operador pode reenviar outra vez).
        const concluded = await confirmReceipt(RUN_ANCHORS, ops, anchorLocated.value, pending, anchorFiles[anchorFiles.length - 1], laterOf(options.now(), pending.finalizedAt));
        if (!concluded.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: concluded.issues, pending, runs: confirmed };
        return { ok: true, run: pending, runs: all, anchored: true, replayed: true, anchors: confirmedSummary(all.length) };
      }
      if (atLimit) return fail('LIMIT_REACHED', `A auditoria atingiu o limite de ${MAX_RUNS} resultados.`);
      if (pending) {
        return { ok: false, code: 'PENDING_UNCONFIRMED', issues: ['Há um resultado publicado ainda sem recibo na pasta de recibos; nada novo é gravado sobre ele.'], pending, runs: confirmed };
      }

      // A primitiva NUNCA grava um resultado sem etiqueta de origem (defesa em profundidade: as rotas e o serviço já recusam sem chave)
      if (!options.origin) return fail('INTERNAL', 'Sem autenticador de origem, nenhum resultado é gravado.');
      const unsigned = { ...built.draft, seq, prevSha256: confirmed[confirmed.length - 1]?.contentSha256 ?? null };
      const run = seal({ ...unsigned, origin: options.origin.sign('RUN', unsigned) });
      const checked = scoreRunSchema.safeParse(run);
      if (!checked.success) return fail('INTERNAL', 'O resultado montado não segue o contrato (erro interno).');
      if (canonicalJson(checked.data) !== canonicalJson(run)) return fail('INTERNAL', 'O esquema alteraria o conteúdo do resultado (erro interno): nada foi gravado.');
      const problems = options.validate?.(checked.data) ?? [];
      if (problems.length > 0) return fail('SEMANTIC', ...problems.slice(0, 10));
      const data = serialize(run); // exatamente os bytes que a leitura estrita exige
      if (Buffer.byteLength(data) > MAX_RUN_BYTES) return fail('LIMIT_REACHED', 'O resultado ultrapassa o tamanho máximo permitido.');

      const finalName = runFileName(seq);
      const published = await publishExclusive(atomic, {
        dir,
        finalPath: path.join(dir, finalName),
        tempPath: path.join(dir, `.tmp-${finalName}-${randomBytes(8).toString('hex')}`),
        data,
        label: `O resultado ${finalName}`,
      });
      if (!published.ok) {
        if (published.code === 'CONFLICT') continue; // outro processo gravou este número: relê e reavalia
        if (published.errno === ATOMIC_UNAVAILABLE_ERRNO) return fail('ATOMIC_WRITE_UNAVAILABLE', 'O armazenamento não suporta link() atômico; os resultados não são gravados por caminho não atômico.');
        if (published.errno && FATAL_ERRNO.has(published.errno)) {
          tripBase(root);
          return fail('STORAGE_FATAL', `Erro fatal de disco (${published.errno}): todas as escritas foram interrompidas.`, ...published.issues);
        }
        return fail('WRITE_FAILED', ...published.issues);
      }

      // O resultado já existe, mas SÓ vale depois do recibo. Se ele falhar, fica PENDENTE e nenhum sucesso é devolvido.
      const receipt = await confirmReceipt(RUN_ANCHORS, ops, anchorLocated.value, checked.data, anchorFiles[anchorFiles.length - 1], finalizedAt);
      if (!receipt.ok) return { ok: false, code: 'ANCHOR_PENDING', issues: receipt.issues, pending: checked.data, runs: confirmed };
      return { ok: true, run: checked.data, runs: [...confirmed, checked.data], anchored: true, replayed: false, anchors: confirmedSummary(seq) };
    }
    return fail('CONFLICT', 'Outro processo gravou continuamente nesta auditoria; nada foi sobrescrito. Tente novamente.');
  });
}

export type { StoreFailure as RunStoreFailure };
