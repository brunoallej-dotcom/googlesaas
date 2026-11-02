import { randomBytes } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { formatZodIssues } from './evidence';
import {
  buildSnapshot,
  MAX_SNAPSHOT_VERSION,
  serializeSnapshot,
  SNAPSHOT_ID_PATTERN,
  sameProfileIdentifiers,
  snapshotDraftSchema,
  verifySnapshot,
  type LinkAuditSnapshot,
} from './snapshot';

/**
 * Armazenamento LOCAL dos snapshots (Fase 6, Onda 2). É o único arquivo do módulo com acesso a disco.
 *
 * - Pasta privada `.data/link-audits/<snapshotId>/vNNNN.json`, fora de `public/` e ignorada pelo git.
 * - Cada arquivo `vNNNN.json` é um snapshot FECHADO: não existe API para editá-lo. Mudar algo = nova
 *   versão, encadeada pelo hash da anterior. Nada é apagado, movido ou corrigido automaticamente.
 * - Gravação: temporário exclusivo + fsync + `link()` (criação exclusiva e atômica). Se o sistema de
 *   arquivos não suportar `link`, o arquivo final é criado com `wx` (exclusivo, nunca substitui), o que
 *   não é atômico: uma queda no meio pode deixar um `vNNNN.json` parcial, que a leitura reporta como
 *   CORRUPT e que bloqueia novas versões. Nunca se usa `rename` (ele substituiria uma versão existente).
 *   Uma queda antes da publicação deixa no máximo um `.tmp-*`, que nenhum leitor trata como snapshot.
 * - Os bytes do arquivo precisam ser exatamente a serialização canônica (uma versão = uma sequência de bytes).
 * - O hash detecta alteração acidental ou inconsistência; não é assinatura (ver HASH_DISCLAIMER).
 * - Nenhuma leitura de ambiente, rede ou relógio: datas e `now` vêm de quem chama.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const VERSION_FILE = /^v(\d{4})\.json$/;
const TEMP_FILE = /^\.tmp-v\d{4}-[a-f0-9]{16}\.json$/;
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

export type StoreErrorCode =
  | 'INVALID'
  | 'INVALID_ID'
  | 'UNSAFE_PATH'
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'HASH_MISMATCH'
  | 'SCHEMA'
  | 'CONFLICT'
  | 'CHAIN_BROKEN'
  | 'IDENTITY_CHANGED'
  | 'WRITE_FAILED';

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly issues: readonly string[] };

export interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Operações de disco usadas pelo armazenamento. Injetável para simular quedas nos testes. */
export interface FsOps {
  mkdir(dir: string): Promise<void>;
  lstat(target: string): Promise<FileInfo>;
  readdir(dir: string): Promise<string[]>;
  realpath(target: string): Promise<string>;
  /** Lê sem seguir symlink, confere que é arquivo comum e recusa mais de `maxBytes`. */
  readFile(target: string, maxBytes: number): Promise<string>;
  /** Cria o arquivo de forma exclusiva (flag `wx`; modo padrão 0o600), grava, faz fsync e fecha. */
  writeExclusive(target: string, data: string, mode?: number): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  syncDirectory(dir: string): Promise<void>;
}

export const nodeFsOps: FsOps = {
  async mkdir(dir) {
    await fsPromises.mkdir(dir, { recursive: true });
  },
  lstat: (target) => fsPromises.lstat(target),
  readdir: (dir) => fsPromises.readdir(dir),
  realpath: (target) => fsPromises.realpath(target),
  /**
   * Leitura de um arquivo de DADOS (evidências, decisões, resultados, recibos). Quem escreve numa pasta de dados pode deixar ali um arquivo
   * ESPECIAL com nome válido (FIFO, dispositivo, soquete): `open()` bloqueante de um FIFO nunca retorna, prende uma thread do pool de I/O do
   * libuv (4 por padrão) e, com poucos deles, TODO o I/O de arquivo do processo web para (e o processo nem encerra). Por isso:
   *  - `O_NONBLOCK`: o `open()` de um FIFO retorna na hora (em arquivo comum não tem efeito) e o tipo é conferido a seguir;
   *  - `O_NOFOLLOW`: sem seguir link simbólico;
   *  - o tipo e o tamanho são conferidos no DESCRITOR já aberto (`fstat`), nunca por um `lstat` anterior (que seria uma corrida);
   *  - a leitura é LIMITADA ao tamanho declarado + 1 byte (um arquivo que cresce depois do `fstat` também é recusado);
   *  - qualquer tipo inesperado falha FECHADO (ENOTFILE/ETOOBIG), sem ler nada.
   */
  async readFile(target, maxBytes) {
    const { constants } = fsPromises;
    const handle = await fsPromises.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw Object.assign(new Error('não é um arquivo comum'), { code: 'ENOTFILE' });
      if (info.size > maxBytes) throw Object.assign(new Error(`excede ${maxBytes} bytes`), { code: 'ETOOBIG' });
      // `size + 1`: um byte a mais que o declarado denuncia um arquivo que CRESCEU depois do fstat (adulteração ou corrida): falha fechada
      const buffer = Buffer.allocUnsafe(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > info.size) throw Object.assign(new Error('o arquivo mudou durante a leitura'), { code: 'ECHANGED' });
      return buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  },
  async writeExclusive(target, data, mode = 0o600) {
    const handle = await fsPromises.open(target, 'wx', mode);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  link: (from, to) => fsPromises.link(from, to),
  unlink: (target) => fsPromises.unlink(target),
  chmod: (target, mode) => fsPromises.chmod(target, mode),
  async syncDirectory(dir) {
    const handle = await fsPromises.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** Pasta privada padrão (fora de `public/`). */
export function defaultLinkAuditDirectory(cwd: string = process.cwd()): string {
  return path.join(cwd, '.data', 'link-audits');
}

function fail(code: StoreErrorCode, ...issues: string[]): { readonly ok: false; readonly code: StoreErrorCode; readonly issues: readonly string[] } {
  return { ok: false, code, issues };
}

export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'DESCONHECIDO';
}

export function describeError(operation: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${operation}: ${errorCode(error)} ${message}`;
}

function versionFileName(version: number): string {
  return `v${String(version).padStart(4, '0')}.json`;
}

interface Location {
  readonly root: string;
  readonly dir: string;
}

function locate(baseDir: string, snapshotId: unknown): { ok: true; value: Location } | { ok: false; code: StoreErrorCode; issues: readonly string[] } {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    return fail('INVALID_ID', 'snapshotId inválido (8 a 64 caracteres: letras, números, _ e -).');
  }
  if (typeof baseDir !== 'string' || baseDir.length === 0 || baseDir.includes('\0')) {
    return fail('UNSAFE_PATH', 'Diretório base inválido.');
  }
  const root = path.resolve(baseDir);
  const dir = path.join(root, snapshotId);
  if (!dir.startsWith(root + path.sep)) return fail('UNSAFE_PATH', 'O caminho do snapshot sai do diretório base.');
  return { ok: true, value: { root, dir } };
}

/** Exclusão mútua em memória por diretório (a criação exclusiva do arquivo cobre o resto). */
const locks = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  locks.set(key, chained);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function ensureSafeDirectory(ops: FsOps, dir: string, create: boolean): Promise<StoreResult<'EXISTS' | 'MISSING'>> {
  try {
    const info = await ops.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return fail('UNSAFE_PATH', 'O diretório do snapshot não é um diretório comum.');
    return { ok: true, value: 'EXISTS' };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return fail('WRITE_FAILED', describeError('lstat', error));
  }
  if (!create) return { ok: true, value: 'MISSING' };
  try {
    await ops.mkdir(dir);
    return { ok: true, value: 'EXISTS' };
  } catch (error) {
    return fail('WRITE_FAILED', describeError('mkdir', error));
  }
}

export interface VersionListing {
  readonly versions: readonly number[];
  /** Números ausentes entre 1 e a maior versão encontrada. */
  readonly gaps: readonly number[];
  /** Temporários de gravações interrompidas (nunca são snapshots). */
  readonly orphanTempFiles: readonly string[];
}

async function listDirectory(ops: FsOps, dir: string): Promise<StoreResult<VersionListing>> {
  const state = await ensureSafeDirectory(ops, dir, false);
  if (!state.ok) return state;
  if (state.value === 'MISSING') return { ok: true, value: { versions: [], gaps: [], orphanTempFiles: [] } };
  let names: string[];
  try {
    names = await ops.readdir(dir);
  } catch (error) {
    return fail('WRITE_FAILED', describeError('readdir', error));
  }
  const versions = names
    .map((name) => VERSION_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((version) => version >= 1)
    .sort((a, b) => a - b);
  const highest = versions[versions.length - 1] ?? 0;
  const gaps: number[] = [];
  for (let version = 1; version <= highest; version++) if (!versions.includes(version)) gaps.push(version);
  return {
    ok: true,
    value: { versions, gaps, orphanTempFiles: names.filter((name) => TEMP_FILE.test(name)).sort() },
  };
}

async function readVersionFile(ops: FsOps, location: Location, snapshotId: string, version: number): Promise<StoreResult<LinkAuditSnapshot>> {
  const file = path.join(location.dir, versionFileName(version));
  let info: FileInfo;
  try {
    info = await ops.lstat(file);
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? fail('NOT_FOUND', `Versão ${version} não encontrada.`)
      : fail('WRITE_FAILED', describeError('lstat', error));
  }
  if (info.isSymbolicLink() || !info.isFile()) return fail('UNSAFE_PATH', `A versão ${version} não é um arquivo comum.`);
  if (info.size > MAX_FILE_BYTES) return fail('CORRUPT', `A versão ${version} excede ${MAX_FILE_BYTES} bytes.`);

  let text: string;
  try {
    text = await ops.readFile(file, MAX_FILE_BYTES);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP' || code === 'ENOTFILE') return fail('UNSAFE_PATH', `A versão ${version} não é um arquivo comum.`);
    if (code === 'ETOOBIG') return fail('CORRUPT', `A versão ${version} excede ${MAX_FILE_BYTES} bytes.`);
    return fail('WRITE_FAILED', describeError('leitura', error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fail('CORRUPT', `A versão ${version} não é um JSON legível (arquivo incompleto ou corrompido): ${error instanceof Error ? error.message : String(error)}`);
  }
  const verified = verifySnapshot(raw);
  if (!verified.ok) return fail(verified.code, ...verified.issues);
  if (text !== serializeSnapshot(verified.value)) {
    return fail('CORRUPT', `Os bytes da versão ${version} não são a serialização canônica (chaves duplicadas, formatação ou normalização diferentes).`);
  }
  if (verified.value.content.snapshotId !== snapshotId || verified.value.content.version !== version) {
    return fail('CORRUPT', `O conteúdo da versão ${version} não corresponde ao nome do arquivo (snapshotId/versão divergentes).`);
  }
  return verified;
}

/** Lê e verifica todas as versões: lacunas, hashes, encadeamento, mesma identidade e datas crescentes. */
async function readChain(ops: FsOps, location: Location, snapshotId: string): Promise<StoreResult<readonly LinkAuditSnapshot[]>> {
  const listing = await listDirectory(ops, location.dir);
  if (!listing.ok) return listing;
  if (listing.value.versions.length === 0) return fail('NOT_FOUND', 'Nenhuma versão encontrada.');
  if (listing.value.gaps.length > 0) {
    return fail('CHAIN_BROKEN', `Faltam as versões: ${listing.value.gaps.join(', ')}.`);
  }
  const chain: LinkAuditSnapshot[] = [];
  for (const version of listing.value.versions) {
    const read = await readVersionFile(ops, location, snapshotId, version);
    if (!read.ok) return fail(read.code === 'NOT_FOUND' ? 'CHAIN_BROKEN' : read.code, `versão ${version}: ${read.issues.join(' ')}`);
    const snapshot = read.value;
    const before = chain[chain.length - 1];
    if (before) {
      if (snapshot.content.previous?.version !== before.content.version || snapshot.content.previous.hash !== before.hash.value) {
        return fail('CHAIN_BROKEN', `A versão ${version} não referencia o hash da versão ${before.content.version}.`);
      }
      if (
        !sameProfileIdentifiers(snapshot.content.identity.identifiers, before.content.identity.identifiers) ||
        snapshot.content.link.originalLink !== before.content.link.originalLink
      ) {
        return fail('IDENTITY_CHANGED', `A versão ${version} muda a identidade ou o link da versão anterior.`);
      }
      if (Date.parse(snapshot.content.frozenAt) < Date.parse(before.content.frozenAt)) {
        return fail('CHAIN_BROKEN', `A versão ${version} tem frozenAt anterior ao da versão ${before.content.version}.`);
      }
    }
    chain.push(snapshot);
  }
  return { ok: true, value: chain };
}

export interface FreezeOptions {
  /** Última versão que o chamador viu (`null` para a primeira). Diferente da atual ⇒ CONFLICT, sem gravar. */
  readonly expectedPreviousVersion: number | null;
  readonly fs?: FsOps;
}

export interface FrozenSnapshot {
  readonly snapshot: LinkAuditSnapshot;
  readonly version: number;
  readonly filePath: string;
}

export async function bestEffort(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    // limpeza e endurecimento são opcionais; falhar aqui não pode desfazer um snapshot já gravado
  }
}


export interface PublishInput {
  readonly dir: string;
  readonly finalPath: string;
  readonly tempPath: string;
  readonly data: string;
  /** Texto usado nas mensagens ("A versão 3", "O arquivo c0001…"). */
  readonly label: string;
}

export type PublishResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CONFLICT' | 'WRITE_FAILED'; readonly issues: readonly string[]; readonly errno?: string };

/**
 * Publicação exclusiva e atômica de UM arquivo imutável: temporário exclusivo (`wx`) + fsync, somente leitura,
 * `link()` para o nome final (criação exclusiva; sem `link`, criação `wx` do final: nunca substitui) e limpeza do
 * temporário. Qualquer erro de escrita (incluindo EIO/EROFS) NÃO é repetido; `errno` devolve o código do disco.
 * Usada pelo armazenamento de snapshots e pelo de evidências: é o único mecanismo de gravação da Fase 6.
 */
export async function publishExclusive(ops: FsOps, input: PublishInput): Promise<PublishResult> {
  const { dir, finalPath, tempPath, data, label } = input;
  const failure = (code: 'CONFLICT' | 'WRITE_FAILED', errno: string | undefined, ...issues: string[]): PublishResult => ({
    ok: false,
    code,
    issues,
    ...(errno ? { errno } : {}),
  });
  try {
    await ops.writeExclusive(tempPath, data);
  } catch (error) {
    await bestEffort(() => ops.unlink(tempPath));
    return failure('WRITE_FAILED', errorCode(error), describeError('escrita do temporário', error));
  }
  // Somente leitura ANTES de publicar: o `link` leva o mesmo modo e nenhum chmod toca o caminho final.
  await bestEffort(() => ops.chmod(tempPath, 0o444));

  try {
    await ops.link(tempPath, finalPath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      await bestEffort(() => ops.unlink(tempPath));
      return failure('CONFLICT', 'EEXIST', `${label} já existe; nada foi sobrescrito.`);
    }
    if (!LINK_UNSUPPORTED_CODES.has(errorCode(error))) {
      await bestEffort(() => ops.unlink(tempPath));
      return failure('WRITE_FAILED', errorCode(error), describeError('publicação (link)', error));
    }
    // Sem hard link: cria o arquivo final de forma EXCLUSIVA (nunca substitui). Não é atômico.
    try {
      await ops.writeExclusive(finalPath, data, 0o444);
    } catch (writeError) {
      await bestEffort(() => ops.unlink(tempPath));
      if (errorCode(writeError) === 'EEXIST') return failure('CONFLICT', 'EEXIST', `${label} já existe; nada foi sobrescrito.`);
      return failure(
        'WRITE_FAILED',
        errorCode(writeError),
        describeError('publicação (criação exclusiva)', writeError),
        'Um arquivo parcial pode ter ficado como versão; ele será reportado como CORRUPT e deve ser tratado pelo operador.',
      );
    }
  }

  await bestEffort(() => ops.unlink(tempPath));
  await bestEffort(() => ops.syncDirectory(dir));
  return { ok: true };
}


/**
 * Fecha uma nova versão do snapshot. Nunca sobrescreve: se a versão já existe, devolve CONFLICT.
 * Em qualquer erro de gravação (incluindo EIO/EROFS) não há nova tentativa: devolve WRITE_FAILED.
 */
export async function freezeSnapshot(baseDir: string, draft: unknown, options: FreezeOptions): Promise<StoreResult<FrozenSnapshot>> {
  const ops = options.fs ?? nodeFsOps;

  // O rascunho é lido UMA vez; tudo o que segue usa a cópia validada (sem getters, sem releitura).
  let parsedDraft: ReturnType<typeof snapshotDraftSchema.safeParse>;
  try {
    parsedDraft = snapshotDraftSchema.safeParse(draft);
  } catch {
    return fail('SCHEMA', '(raiz): rascunho ilegível (propriedade que lança exceção ou valor fora do contrato).');
  }
  if (!parsedDraft.success) {
    const idProblem = parsedDraft.error.issues.some((issue) => issue.path[0] === 'snapshotId');
    return fail(idProblem ? 'INVALID_ID' : 'SCHEMA', ...formatZodIssues(parsedDraft.error));
  }
  const draftData = parsedDraft.data;
  const located = locate(baseDir, draftData.snapshotId);
  if (!located.ok) return located;
  const { root, dir } = located.value;
  const snapshotId = draftData.snapshotId;

  let lockKey = dir;
  try {
    lockKey = path.join(await ops.realpath(root), snapshotId); // mesma pasta por caminhos diferentes (symlink, ./, ..)
  } catch {
    // a pasta base ainda pode não existir
  }

  return withLock(lockKey, async () => {
    const state = await ensureSafeDirectory(ops, dir, false);
    if (!state.ok) return state;

    let latest: LinkAuditSnapshot | null = null;
    if (state.value === 'EXISTS') {
      const chain = await readChain(ops, located.value, snapshotId);
      if (chain.ok) latest = chain.value[chain.value.length - 1] ?? null;
      else if (chain.code !== 'NOT_FOUND') return chain; // cadeia corrompida/lacunas/identidade trocada: nada é anexado
    }

    const currentVersion = latest?.content.version ?? null;
    if (options.expectedPreviousVersion !== currentVersion) {
      return fail('CONFLICT', `Versão esperada ${String(options.expectedPreviousVersion)}, mas a atual é ${String(currentVersion)}. Nada foi gravado.`);
    }
    const version = (currentVersion ?? 0) + 1;
    if (version > MAX_SNAPSHOT_VERSION) return fail('WRITE_FAILED', `Limite de ${MAX_SNAPSHOT_VERSION} versões atingido.`);

    const built = buildSnapshot(draftData, {
      version,
      previous: latest ? { version: latest.content.version, hash: latest.hash.value } : null,
    });
    if (!built.ok) return fail(built.code, ...built.issues);
    const snapshot = built.value;
    if (snapshot.content.snapshotId !== snapshotId) return fail('SCHEMA', 'snapshotId do conteúdo difere do diretório de destino.');

    if (latest) {
      if (
        !sameProfileIdentifiers(snapshot.content.identity.identifiers, latest.content.identity.identifiers) ||
        snapshot.content.link.originalLink !== latest.content.link.originalLink
      ) {
        return fail('IDENTITY_CHANGED', 'Uma nova versão não pode mudar a identidade nem o link da empresa; crie outro snapshot.');
      }
      if (Date.parse(snapshot.content.frozenAt) < Date.parse(latest.content.frozenAt)) {
        return fail('SCHEMA', 'frozenAt não pode ser anterior ao da versão anterior.');
      }
    }

    // Só agora, com tudo validado, o diretório do snapshot passa a existir.
    const created = await ensureSafeDirectory(ops, dir, true);
    if (!created.ok) return created;

    const finalPath = path.join(dir, versionFileName(version));
    const tempPath = path.join(dir, `.tmp-v${String(version).padStart(4, '0')}-${randomBytes(8).toString('hex')}.json`);
    const data = serializeSnapshot(snapshot);

    const published = await publishExclusive(ops, { dir, finalPath, tempPath, data, label: `A versão ${version}` });
    if (!published.ok) return fail(published.code, ...published.issues);

    // Só é sucesso se o que está em disco é um snapshot íntegro e igual ao gravado.
    const reread = await readVersionFile(ops, located.value, snapshotId, version);
    if (!reread.ok) return fail(reread.code, `A releitura da versão ${version} falhou: ${reread.issues.join(' ')}`);
    if (reread.value.hash.value !== snapshot.hash.value) {
      return fail('HASH_MISMATCH', `A releitura da versão ${version} difere do que foi gravado.`);
    }
    return { ok: true, value: { snapshot: reread.value, version, filePath: finalPath } };
  });
}

export async function readSnapshot(baseDir: string, snapshotId: string, version: number, options: { fs?: FsOps } = {}): Promise<StoreResult<LinkAuditSnapshot>> {
  const located = locate(baseDir, snapshotId);
  if (!located.ok) return located;
  if (!Number.isInteger(version) || version < 1 || version > MAX_SNAPSHOT_VERSION) return fail('NOT_FOUND', 'Versão inválida.');
  return readVersionFile(options.fs ?? nodeFsOps, located.value, snapshotId, version);
}

/** Última versão, depois de verificar a cadeia inteira. */
export async function readLatestSnapshot(baseDir: string, snapshotId: string, options: { fs?: FsOps } = {}): Promise<StoreResult<LinkAuditSnapshot>> {
  const located = locate(baseDir, snapshotId);
  if (!located.ok) return located;
  const chain = await readChain(options.fs ?? nodeFsOps, located.value, snapshotId);
  if (!chain.ok) return chain;
  const latest = chain.value[chain.value.length - 1];
  return latest ? { ok: true, value: latest } : fail('NOT_FOUND', 'Nenhuma versão encontrada.');
}

export async function verifySnapshotChain(baseDir: string, snapshotId: string, options: { fs?: FsOps } = {}): Promise<StoreResult<readonly LinkAuditSnapshot[]>> {
  const located = locate(baseDir, snapshotId);
  if (!located.ok) return located;
  return readChain(options.fs ?? nodeFsOps, located.value, snapshotId);
}

export async function listSnapshotVersions(baseDir: string, snapshotId: string, options: { fs?: FsOps } = {}): Promise<StoreResult<VersionListing>> {
  const located = locate(baseDir, snapshotId);
  if (!located.ok) return located;
  return listDirectory(options.fs ?? nodeFsOps, located.value.dir);
}

/**
 * Remove SOMENTE temporários `.tmp-*` de gravações interrompidas e mais antigos que `olderThanMs`.
 * Nunca toca em `vNNNN.json`. `now` vem do chamador (o módulo não lê o relógio).
 */
export async function cleanupOrphanTempFiles(
  baseDir: string,
  snapshotId: string,
  options: { readonly now: Date; readonly olderThanMs: number; readonly fs?: FsOps },
): Promise<StoreResult<readonly string[]>> {
  const located = locate(baseDir, snapshotId);
  if (!located.ok) return located;
  const ops = options.fs ?? nodeFsOps;
  let lockKey = located.value.dir;
  try {
    lockKey = path.join(await ops.realpath(located.value.root), snapshotId);
  } catch {
    // a pasta base pode não existir
  }
  return withLock(lockKey, async () => {
    const listing = await listDirectory(ops, located.value.dir);
    if (!listing.ok) return listing;
    const removed: string[] = [];
    for (const name of listing.value.orphanTempFiles) {
      const target = path.join(located.value.dir, name);
      try {
        const info = await ops.lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (options.now.getTime() - info.mtimeMs < options.olderThanMs) continue;
        await ops.unlink(target);
        removed.push(name);
      } catch (error) {
        return fail('WRITE_FAILED', describeError(`limpeza de ${name}`, error));
      }
    }
    return { ok: true as const, value: removed as readonly string[] };
  });
}
