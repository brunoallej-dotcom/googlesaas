import path from 'node:path';
import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { describeError, errorCode, type FsOps } from '../link-audit/snapshot-store';

/*
 * Primitivas NEUTRAS de armazenamento e integridade (Onda 6C, I0): selo SHA-256, leitura ESTRITA dos bytes, caminhos seguros,
 * bloqueio após erro fatal de disco e a garantia de que só se grava de forma atômica. Foram extraídas SEM mudança de
 * comportamento de `link-audit-decisions/files.ts` (Onda 6B), que as reexporta; o único ponto que deixou de ser fixo é o
 * padrão do identificador da auditoria (`locateIn` recebe a regra) e o prefixo dos nomes (`splitNames`). Este módulo não
 * conhece decisões, evidências nem o motor: quem o consome define os seus formatos.
 */
export type StoreErrorCode =
  | 'INVALID_ID'
  | 'UNSAFE_PATH'
  | 'STORAGE_MISSING'
  | 'ANCHOR_MISSING'
  | 'CORRUPT'
  | 'HASH_MISMATCH'
  | 'CHAIN_BROKEN'
  | 'SEQUENCE_GAP'
  | 'SCHEMA'
  | 'SEMANTIC'
  | 'TRUNCATED'
  | 'ANCHOR_MISMATCH'
  | 'ANCHOR_INTEGRITY'
  | 'CONFLICT'
  | 'LIMIT_REACHED'
  | 'WRITE_FAILED'
  | 'ANCHOR_WRITE_FAILED'
  | 'ATOMIC_WRITE_UNAVAILABLE'
  | 'STORAGE_FATAL'
  | 'INTERNAL';

export type StoreFailure = { readonly ok: false; readonly code: StoreErrorCode; readonly issues: readonly string[] };
export type StoreResult<T> = { readonly ok: true; readonly value: T } | StoreFailure;

/** Remove caminhos absolutos de mensagens, até o fim da linha (caminhos com espaço não deixam resto). */
export const scrubPaths = (text: string): string => text.replace(/(?<![\w.])(?:[A-Za-z]:\\|\/)[^"'`\r\n]*/g, '[caminho]');
export const fail = (code: StoreErrorCode, ...issues: string[]): StoreFailure => ({ ok: false, code, issues: issues.map(scrubPaths) });

export interface StoreOptions {
  readonly fs?: FsOps;
  /** Raiz do projeto: nenhuma base pode ficar em `public/`, `src/`, `.next/` nem `node_modules/` dela. */
  readonly projectRoot?: string;
}

/* ------------------------------------------------------------------ selo e serialização */

export function seal<T extends object>(body: T): T & { contentSha256: string } {
  const clean = JSON.parse(JSON.stringify(body)) as T;
  return { ...clean, contentSha256: sha256Hex(canonicalJson(clean)) };
}

export function hashOk(entry: { contentSha256: string }): boolean {
  const { contentSha256, ...rest } = entry;
  return sha256Hex(canonicalJson(rest)) === contentSha256;
}

export const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Contrato mínimo de um esquema (o Zod satisfaz): permite validar sem depender de uma biblioteca. */
export interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * Leitura ESTRITA de um arquivo selado. Além do esquema e do hash, exige que os BYTES do arquivo sejam exatamente os que
 * este módulo escreve: o hash é conferido sobre o JSON BRUTO (não sobre o objeto já normalizado pelo Zod) e o texto precisa
 * ser a serialização canônica do próprio JSON, o que recusa chaves duplicadas, espaços/quebras diferentes e campos omitidos.
 */
export async function readSealedFile<T extends { contentSha256: string }>(ops: FsOps, file: string, maxBytes: number, schema: Parser<T>): Promise<StoreResult<T>> {
  const name = path.basename(file);
  let text: string;
  try {
    text = await ops.readFile(file, maxBytes);
  } catch (error) {
    return fail('CORRUPT', `${name}: ${describeError('leitura', error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('SCHEMA', `${name} não é JSON válido.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail('SCHEMA', `${name} não segue o formato esperado.`);
  if (!hashOk(json as { contentSha256: string })) return fail('HASH_MISMATCH', `${name}: o hash não confere (arquivo alterado ou inconsistente).`);
  if (text !== serialize(json)) return fail('CORRUPT', `${name}: os bytes do arquivo não são os que este sistema grava (chave duplicada, espaços ou formatação alterados).`);
  if (canonicalJson(parsed.data) !== canonicalJson(json)) return fail('CORRUPT', `${name}: o conteúdo não corresponde ao formato canônico.`);
  return { ok: true, value: parsed.data };
}

/* ------------------------------------------------------------------ só se grava de forma atômica */

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

/**
 * `publishExclusive` tem um caminho alternativo, NÃO atômico, quando `link()` não é suportado (cria o arquivo final
 * direto). Uma queda no meio deixaria um arquivo parcial como entrada do histórico e travaria a auditoria. Para decisões
 * e âncoras esse caminho é RECUSADO: o erro vira um código que `publishExclusive` trata como falha de escrita.
 */
export function atomicOnly(ops: FsOps): FsOps {
  return {
    ...ops,
    async link(from, to) {
      try {
        await ops.link(from, to);
      } catch (error) {
        if (LINK_UNSUPPORTED.has(errorCode(error))) throw Object.assign(new Error('link atômico indisponível'), { code: 'ELINKUNAVAILABLE' });
        throw error;
      }
    },
  };
}

export const ATOMIC_UNAVAILABLE_ERRNO = 'ELINKUNAVAILABLE';

/** Leituras de arquivos de um histórico em paralelo LIMITADO (R7-10: o custo era 100% sequencial). */
export const READ_CONCURRENCY = 32;
/**
 * Aplica `task` a cada item com concorrência limitada e devolve os resultados NA ORDEM dos itens. Só para LEITURAS (sem efeito colateral): quem consome percorre os resultados
 * em ordem e para no primeiro que falha, então o veredito é o mesmo da leitura sequencial.
 */
export async function mapOrdered<T, R>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * DURABILIDADE OBSERVADA (R6-07). `publishExclusive` trata o `fsync` do DIRETÓRIO como melhor esforço (comportamento histórico da 6B, risco P-4): a falha é engolida e a
 * gravação é dada como feita. Com o livro de cabeças a ordem de durabilidade ENTRE pastas faz parte do protocolo (INTENT → entrada → recibo → CONFIRMED), então quem usa o
 * livro embrulha o `FsOps` aqui, olha `failure()` depois de cada publicação e NÃO devolve sucesso (e trava a base) quando o diretório não ficou comprovadamente durável.
 */
export function watchDurability(ops: FsOps): { readonly ops: FsOps; readonly failure: () => string | null } {
  let failure: string | null = null;
  return {
    ops: {
      ...ops,
      async syncDirectory(dir) {
        try {
          await ops.syncDirectory(dir);
        } catch (error) {
          failure = errorCode(error) || 'UNKNOWN';
          throw error;
        }
      },
    },
    failure: () => failure,
  };
}
/** Três resultados distintos (R7-04): DURÁVEL (sucesso), RECUPERÁVEL E PENDENTE (`ANCHOR_PENDING`, reenvio conclui) e DURABILIDADE DESCONHECIDA (esta mensagem; NUNCA sucesso). */
export const DURABILITY_UNPROVEN_MESSAGE = 'DURABILIDADE DESCONHECIDA: o armazenamento não comprovou a gravação (falha no fsync do diretório). Isto NÃO é sucesso: as escritas ficam interrompidas até o servidor reiniciar; depois, reenvie o MESMO pedido — ele só conclui depois de sincronizar de novo as pastas.';
export const FATAL_ERRNO = new Set(['EIO', 'EROFS']);

/* ------------------------------------------------------------------ bloqueio após erro fatal de disco */

const trippedBases = new Set<string>();
/**
 * Durabilidade PROVADA neste processo (chave = raiz + auditoria): um fsync de diretório bem-sucedido DEPOIS de o registro existir. Um reinício NÃO é comprovação: o processo novo começa sem nenhuma
 * prova e cada auditoria precisa ser provada de novo (uma vez) antes de ser lida como protegida. Travar a base (`tripBase`) invalida as provas daquela raiz.
 */
const provenKeys = new Set<string>();
export const markDurabilityProven = (key: string): void => void provenKeys.add(key);
export const isDurabilityProven = (key: string): boolean => provenKeys.has(key);
export function tripBase(root: string): void {
  trippedBases.add(root);
  for (const key of provenKeys) if (key.startsWith(`${root}\0`)) provenKeys.delete(key);
}
export const isBaseTripped = (root: string): boolean => trippedBases.has(root);

/** Depois de EIO/EROFS a base fica bloqueada para escrita até o processo reiniciar (ou `clearStorageFatal`, nos testes — que também esquece as provas de durabilidade, como um reinício de verdade). */
export function clearStorageFatal(baseDir?: string): void {
  if (baseDir === undefined) {
    trippedBases.clear();
    provenKeys.clear();
    return;
  }
  const root = path.resolve(baseDir);
  trippedBases.delete(root);
  for (const key of provenKeys) if (key.startsWith(`${root}\0`)) provenKeys.delete(key);
}
export const isStorageFatal = (baseDir: string): boolean => trippedBases.has(path.resolve(baseDir));

/* ------------------------------------------------------------------ caminhos seguros */

const forbiddenRoots = (projectRoot: string): string[] => ['public', 'src', '.next', 'node_modules'].map((name) => path.join(path.resolve(projectRoot), name));

export function assertBase(baseDir: unknown, projectRoot: string, label: string): StoreResult<string> {
  if (typeof baseDir !== 'string' || baseDir.length === 0 || baseDir.includes('\0') || !path.isAbsolute(baseDir)) {
    return fail('UNSAFE_PATH', `Diretório base de ${label} inválido (precisa ser um caminho absoluto).`);
  }
  const root = path.resolve(baseDir);
  const lowered = root.toLowerCase(); // drvfs/Windows ignoram a caixa
  for (const forbidden of forbiddenRoots(projectRoot)) {
    const lowerForbidden = forbidden.toLowerCase();
    if (lowered === lowerForbidden || lowered.startsWith(lowerForbidden + path.sep)) {
      return fail('UNSAFE_PATH', `O diretório de ${label} não pode ficar em ${path.basename(forbidden)}/ do projeto (área pública ou de código).`);
    }
  }
  return { ok: true, value: root };
}

export interface Location {
  readonly root: string;
  readonly dir: string;
}

/**
 * Cópia SEM ESTADO de um padrão. As flags `g` e `y` fazem `test()`/`exec()` lembrarem `lastIndex` entre chamadas (o mesmo
 * identificador válido seria aceito e recusado alternadamente). Como o consumidor escolhe o padrão, o módulo se protege.
 */
const stateless = (pattern: RegExp): RegExp => (pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : pattern);

/** Regra do identificador da auditoria: cada consumidor informa o seu padrão e a mensagem de recusa. */
export interface IdRule {
  readonly pattern: RegExp;
  readonly message: string;
}

export function locateIn(baseDir: unknown, auditId: unknown, projectRoot: string, label: string, idRule: IdRule): StoreResult<Location> {
  if (typeof auditId !== 'string' || !stateless(idRule.pattern).test(auditId)) {
    return fail('INVALID_ID', idRule.message);
  }
  const base = assertBase(baseDir, projectRoot, label);
  if (!base.ok) return base;
  const dir = path.join(base.value, auditId);
  if (!dir.startsWith(base.value + path.sep)) return fail('UNSAFE_PATH', 'O caminho da auditoria sai do diretório base.');
  return { ok: true, value: { root: base.value, dir } };
}

export type DirStatus = 'EXISTS' | 'MISSING' | 'UNSAFE' | 'ERROR';

export async function dirStatus(ops: FsOps, dir: string): Promise<DirStatus> {
  try {
    const info = await ops.lstat(dir);
    return info.isSymbolicLink() || !info.isDirectory() ? 'UNSAFE' : 'EXISTS';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'MISSING' : 'ERROR';
  }
}

export async function ensureDirectory(ops: FsOps, dir: string, label: string): Promise<StoreFailure | null> {
  const status = await dirStatus(ops, dir);
  if (status === 'EXISTS') return null;
  if (status !== 'MISSING') return fail(status === 'UNSAFE' ? 'UNSAFE_PATH' : 'WRITE_FAILED', `A pasta de ${label} da auditoria não está acessível.`);
  try {
    await ops.mkdir(dir);
  } catch (error) {
    return fail('WRITE_FAILED', describeError('mkdir', error));
  }
  return (await dirStatus(ops, dir)) === 'EXISTS' ? null : fail('UNSAFE_PATH', `A pasta de ${label} da auditoria não é um diretório comum.`);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Classifica os nomes de uma pasta: entradas válidas, temporários órfãos, nomes SUSPEITOS (parecem entrada mas não são) e o resto. */
export function splitNames(names: readonly string[], entry: RegExp, prefix: string): { numbers: number[]; orphanTempFiles: string[]; suspicious: string[]; unexpectedFiles: string[] } {
  const numbers: number[] = [];
  const orphanTempFiles: string[] = [];
  const suspicious: string[] = [];
  const unexpectedFiles: string[] = [];
  const matcher = stateless(entry);
  const looksLikeEntry = new RegExp(`^${escapeRegExp(prefix)}\\d`, 'i');
  for (const name of names) {
    const match = matcher.exec(name);
    if (match) numbers.push(Number(match[1]));
    else if (name.startsWith('.tmp-')) orphanTempFiles.push(name);
    else if (looksLikeEntry.test(name)) suspicious.push(name);
    else unexpectedFiles.push(name);
  }
  numbers.sort((a, b) => a - b);
  return { numbers, orphanTempFiles, suspicious, unexpectedFiles };
}
