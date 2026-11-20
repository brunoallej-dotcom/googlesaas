import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { auditId as auditIdSchema, hex64, isoInstant, MAX_PACKAGE_ENTRIES, shortLabel } from './schemas';
import { MAX_SEAL_SEQ, SIGN_KEY_ID_PATTERN, type SignRefusal, type SignRefusalCode } from './sign-core';

/*
 * P1 W4.5 — o REGISTRO EXTERNO do comando de fecho `close-key` (spec §5.5.1 item 9; contrato do verificador v2 §6 "Procedimento", passos 2 e 3;
 * V2-46). O registro é a pasta de RECIBOS de assinatura (o recibo do passo 16 do `sign`, um JSON por assinatura), indicada por `--receipts-dir`; as
 * `heads` do fecho vêm SÓ daqui, nunca da pasta do servidor: ela é a RAIZ DE CONFIANÇA do fecho. Regras (onde a spec era ambígua, vale o lado que
 * falha fechado; notas da W4.5 e da revisão da W4.5):
 *  - a pasta é aberta UMA vez (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`) e TUDO sai desse descritor: o `fstat` (diretório do próprio usuário, sem escrita
 *    para grupo e outros), a enumeração e cada leitura, por `/proc/self/fd/<fd>/…` (Linux, a estação da W5). Trocar a pasta por um link depois de
 *    aberta não desvia nada (revisão da W4.5, TOCTOU);
 *  - as pastas ACIMA (pelo caminho real do descritor) não podem ser graváveis por grupo ou outros, salvo com sticky bit (como `/tmp`); a pasta não
 *    pode estar dentro da cópia do servidor nem contê-la, pela identidade `dev`/`ino`;
 *  - não vazia; no máximo `MAX_RECEIPT_FILES` entradas, contadas DURANTE a enumeração (para na entrada máximo + 1);
 *  - TODA entrada é um arquivo comum `*.json` (nome simples, sem oculto), aberto DENTRO da pasta sem seguir link e conferido no próprio descritor
 *    (arquivo comum, do próprio usuário, sem escrita para grupo e outros, até `MAX_RECEIPT_BYTES`): link, diretório, FIFO, oculto ou outra extensão é
 *    recusa, nunca ignorado em silêncio;
 *  - cada recibo passa pelo texto estrito (UTF-8 estrito, sem BOM, sem barra invertida, sem chave repetida) e pelo esquema zod ESTRITO do recibo;
 *  - recibos IDÊNTICOS para a mesma posição `{auditId, seq}` são um só; DIVERGENTES (qualquer campo) ⇒ recusa, também em posição sem a chave R;
 *  - nenhuma mensagem ecoa o NOME de um arquivo de recibo (pode carregar dado de cliente): cita a posição ordinal na ordem alfabética.
 * A escolha das cabeças (`closureHeads`) é PURA. Só LEITURA; nunca importa o verificador (nem por transitividade).
 */

/** Um recibo do passo 16 tem menos de 1 KiB (identado, menos de 1,2 KiB); 4 KiB deixa folga sem aceitar um arquivo arbitrário. */
export const MAX_RECEIPT_BYTES = 4096;
/** Um recibo por assinatura: 10 000 cobre anos de rotação (uma chave assina por no máximo 12 meses, D12) e limita a leitura a 40 MiB. */
export const MAX_RECEIPT_FILES = 10_000;
/** Nome de recibo: simples, sem oculto, extensão `.json` em minúsculas. */
const RECEIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.json$/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BYTE_ORDER_MARK = 0xfeff;

/** O recibo do passo 16 (`SignReceipt` do `sign-cli.ts`), estrito: exatamente estes campos. */
const receiptShape = {
  ok: z.literal(true),
  auditId: auditIdSchema,
  seq: z.number().int().min(1).max(MAX_SEAL_SEQ),
  schemaVersion: z.literal(2),
  keyId: z.string().regex(SIGN_KEY_ID_PATTERN),
  sealedAt: isoInstant,
  sealSha256: hex64,
  prevSealSha256: hex64.nullable(),
  packageSha256: hex64,
  dossierSha256: hex64,
  entries: z.number().int().min(1).max(MAX_PACKAGE_ENTRIES),
  approvedBy: shortLabel,
  operator: shortLabel,
  custodian: shortLabel,
  roleException: z.boolean(),
  requiresLaterReview: z.boolean(),
  artifactSha256: hex64.nullable(),
};
const receiptSchema = z
  .object(receiptShape)
  .strict()
  .refine((receipt) => (receipt.seq === 1) === (receipt.prevSealSha256 === null)); // "null se e somente se seq = 1" (contrato v2 §2)
export type SignatureReceipt = z.infer<typeof receiptSchema>;
const RECEIPT_FIELDS = Object.keys(receiptShape) as ReadonlyArray<keyof SignatureReceipt>;

/**
 * Um recibo dos BYTES lidos: UTF-8 estrito, sem BOM, sem barra invertida (nenhum campo válido precisa de escape), JSON de um objeto PLANO cujo número
 * de chaves no TEXTO é o do objeto lido (sem escapes, cada chave é um `"…"` seguido de `:`; a mais ⇒ chave repetida, que o `JSON.parse` engoliria) e
 * o esquema estrito. `null` = recusa. Nunca lança.
 */
export function parseReceiptBytes(bytes: Uint8Array): SignatureReceipt | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_BYTES) return null;
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === BYTE_ORDER_MARK || text.includes('\\')) return null;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  if ([...text.matchAll(/"[^"]*"\s*:/g)].length !== Object.keys(json).length) return null;
  const parsed = receiptSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------------------------------------------------------- disco (só leitura, por descritor) */

/** Metadados (de `lstat`/`fstat`) que as conferências usam: tipo, dono, permissões e identidade. */
export interface DirEntryStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
  readonly uid: number;
  readonly dev: number;
  readonly ino: number;
}
export interface ReceiptFileStat {
  isFile(): boolean;
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
}
/** A pasta de recibos ABERTA: tudo o que se confere e se lê dela sai deste descritor. */
export interface OpenedDir {
  stat(): Promise<DirEntryStat>;
  /** Caminho real do descritor (Linux: `readlink('/proc/self/fd/<fd>')`). */
  realPath(): Promise<string>;
  /** Até `limit` nomes, enumerados pelo descritor; `null` se houver mais (a enumeração para na entrada `limit + 1`). */
  list(limit: number): Promise<readonly string[] | null>;
  /** Abre `name` DENTRO da pasta aberta (nunca pelo caminho dado), sem seguir link e sem travar em FIFO; o `fstat` desse descritor e, se for arquivo comum até `maxBytes`, os bytes lidos por ele. */
  read(name: string, maxBytes: number): Promise<{ readonly stat: ReceiptFileStat; readonly bytes: Uint8Array }>;
  close(): Promise<void>;
}
/** O disco do `close-key` fora do snapshot da cópia do servidor. Injetável nos testes; nada aqui escreve. */
export interface CloseFsOps {
  /** Abre a pasta de recibos UMA vez: `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`. */
  openDir(target: string): Promise<OpenedDir>;
  /** Metadados de uma pasta ACIMA (e da cópia do servidor e das dela), sem seguir link. */
  lstat(target: string): Promise<DirEntryStat>;
  /** A raiz da cópia do servidor, enumerada com teto (`null` acima dele; para na entrada `limit + 1`). */
  listDir(target: string, limit: number): Promise<readonly string[] | null>;
}

/** Até `limit` nomes de uma enumeração iterativa (`opendir`); na entrada `limit + 1`, para e devolve `null` (a saída do laço fecha a enumeração). */
export async function collectUpTo(entries: AsyncIterable<{ readonly name: string }>, limit: number): Promise<string[] | null> {
  const names: string[] = [];
  for await (const entry of entries) {
    if (names.length >= limit) return null;
    names.push(entry.name);
  }
  return names;
}

/** Lê pelo descritor do recibo: até o tamanho do `fstat` + 1 (um arquivo que cresce é recusado por quem confere o tamanho). */
async function readThrough(file: fsPromises.FileHandle, size: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(size + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0 || total + bytesRead >= buffer.length) return buffer.subarray(0, total + bytesRead);
    total += bytesRead;
  }
}

export const nodeCloseFsOps: CloseFsOps = {
  lstat: (target) => fsPromises.lstat(target),
  listDir: async (target, limit) => collectUpTo(await fsPromises.opendir(target), limit),
  async openDir(target) {
    const { constants } = fsPromises;
    const handle = await fsPromises.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const base = `/proc/self/fd/${handle.fd}`;
    return {
      stat: () => handle.stat(),
      realPath: () => fsPromises.readlink(base),
      list: async (limit) => collectUpTo(await fsPromises.opendir(base), limit),
      async read(name, maxBytes) {
        const file = await fsPromises.open(`${base}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          return { stat, bytes: stat.isFile() && stat.size <= maxBytes ? await readThrough(file, stat.size) : new Uint8Array(0) };
        } finally {
          await file.close();
        }
      },
      close: () => handle.close(),
    };
  },
};

/* ------------------------------------------------------------------------------------------------------------------- leitura da pasta de recibos */

const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message });
const NOTHING = 'Nada foi assinado nem gravado.';
const invalid = (why: string): SignRefusal => refuse('CLOSE_RECEIPTS_INVALID', `Pasta de recibos (--receipts-dir, o registro externo do fecho): ${why}. ${NOTHING}`);
/** Posição ordinal (1º, 2º…) na ordem alfabética: o NOME do arquivo nunca é ecoado (revisão da W4.5). */
const nth = (index: number): string => `o ${index + 1}º arquivo (em ordem alfabética)`;

const NOT_A_DIRECTORY = invalid('inexistente, não é diretório ou é link simbólico (provável erro de digitação; nunca "sem recibos")');
const UNREADABLE = invalid('não pôde ser lida (erro de E/S ou permissão)');
const EMPTY = invalid('está vazia (sem recibo não há o que fechar; uma chave que nunca assinou pode ficar só retired ou revoked)');
const OVERLAPS = invalid('não pode estar dentro da cópia do servidor (--seals-dir) nem contê-la: as cabeças vêm do registro EXTERNO, nunca da pasta do servidor');
const NOT_OWNED = invalid('não é do usuário que roda o comando, ou é gravável por grupo ou outros (o registro externo é a raiz de confiança do fecho)');
const UNSAFE_ANCESTOR = invalid('uma pasta acima é gravável por grupo ou outros sem sticky bit, ou não pôde ser conferida (a pasta poderia ser trocada)');
const NO_DESCRIPTOR_PATH = invalid('não foi possível obter o caminho real da pasta ABERTA (/proc/self/fd indisponível: fora do Linux)');

export interface ReceiptsRead {
  readonly ok: true;
  /** Um recibo por posição `{auditId, seq}` (duplicados idênticos já fundidos), em ordem de auditId e seq. */
  readonly receipts: readonly SignatureReceipt[];
  /** Quantos arquivos foram lidos. */
  readonly files: number;
}
export interface ReceiptsInput {
  readonly receiptsDir: string;
  /** Caminho real da cópia do servidor (já resolvido): a pasta de recibos não pode estar dentro dela nem contê-la (identidade `dev`/`ino`). */
  readonly sealsRoot: string;
  /** O usuário que roda o comando (`process.getuid()`); `undefined` (fora do Linux) ⇒ recusa. */
  readonly uid: number | undefined;
  /** Teto de arquivos; padrão `MAX_RECEIPT_FILES` (só os testes o mudam, para provar o limite exato). */
  readonly maxFiles?: number;
}

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;
const errorCode = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined);
const sameNode = (left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean => left.dev === right.dev && left.ino === right.ino;
/** A pasta e todas as acima dela, até a raiz. */
const selfAndAncestors = (dir: string): string[] => (dir === path.dirname(dir) ? [dir] : [dir, ...selfAndAncestors(path.dirname(dir))]);
const isRealAbsolute = (value: string): boolean => path.isAbsolute(value) && path.normalize(value) === value && !value.endsWith(' (deleted)');

/**
 * As pastas ACIMA da pasta aberta (pelo caminho real do descritor): diretórios sem escrita para grupo e outros, salvo com sticky bit (como `/tmp`,
 * onde ninguém troca a entrada de outro usuário). Devolve as identidades delas (para a sobreposição) ou `null` se alguma falhou.
 */
async function ancestorIdentities(ops: CloseFsOps, real: string): Promise<DirEntryStat[] | null> {
  const found: DirEntryStat[] = [];
  for (const dir of selfAndAncestors(path.dirname(real))) {
    const info = await ops.lstat(dir);
    const writableByOthers = (info.mode & GROUP_OR_OTHER_WRITE) !== 0 && (info.mode & STICKY) === 0;
    if (info.isSymbolicLink() || !info.isDirectory() || writableByOthers) return null;
    found.push(info);
  }
  return found;
}

/** A cópia do servidor dentro da pasta de recibos (ou a mesma), ou a pasta de recibos dentro dela: pela identidade, nunca pelo texto do caminho. */
async function overlapsSeals(ops: CloseFsOps, receipts: DirEntryStat, receiptsAncestors: readonly DirEntryStat[], sealsRoot: string): Promise<boolean> {
  const seals = await Promise.all(selfAndAncestors(sealsRoot).map((dir) => ops.lstat(dir)));
  const sealsSelf = seals[0];
  return seals.some((dir) => sameNode(dir, receipts)) || (sealsSelf !== undefined && receiptsAncestors.some((dir) => sameNode(dir, sealsSelf)));
}

/** Conferências da pasta ABERTA (antes de enumerar): dono e permissões pelo `fstat`, pastas acima e sobreposição com a cópia do servidor. */
async function openedDirRefusal(ops: CloseFsOps, opened: OpenedDir, input: ReceiptsInput): Promise<SignRefusal | null> {
  const self = await opened.stat();
  if (!self.isDirectory() || input.uid === undefined || self.uid !== input.uid || (self.mode & GROUP_OR_OTHER_WRITE) !== 0) return NOT_OWNED;
  let real: string;
  try {
    real = await opened.realPath();
  } catch {
    return NO_DESCRIPTOR_PATH;
  }
  if (!isRealAbsolute(real)) return NO_DESCRIPTOR_PATH;
  let ancestors: DirEntryStat[] | null;
  try {
    ancestors = await ancestorIdentities(ops, real);
  } catch {
    ancestors = null;
  }
  if (ancestors === null) return UNSAFE_ANCESTOR;
  return (await overlapsSeals(ops, self, ancestors, input.sealsRoot)) ? OVERLAPS : null;
}

/** Um recibo, aberto DENTRO da pasta pelo descritor e conferido no próprio descritor: arquivo comum, do usuário, sem escrita para grupo e outros, até o limite. */
async function readOneReceipt(opened: OpenedDir, name: string, index: number, uid: number): Promise<SignatureReceipt | SignRefusal> {
  if (!RECEIPT_NAME.test(name)) return invalid(`${nth(index)} não é um arquivo de recibo (nome simples terminado em .json, sem oculto); nada é ignorado em silêncio`);
  let read: { readonly stat: ReceiptFileStat; readonly bytes: Uint8Array };
  try {
    read = await opened.read(name, MAX_RECEIPT_BYTES);
  } catch {
    return invalid(`${nth(index)} não pôde ser aberto como arquivo comum (link simbólico, removido ou ilegível)`);
  }
  const { stat, bytes } = read;
  if (!stat.isFile()) return invalid(`${nth(index)} não é arquivo comum (diretório, FIFO…)`);
  if (stat.uid !== uid || (stat.mode & GROUP_OR_OTHER_WRITE) !== 0) return invalid(`${nth(index)} não é do usuário que roda o comando ou é gravável por grupo ou outros`);
  if (stat.size > MAX_RECEIPT_BYTES || bytes.byteLength !== stat.size) return invalid(`${nth(index)} acima de ${MAX_RECEIPT_BYTES} bytes ou mudou durante a leitura`);
  return parseReceiptBytes(bytes) ?? invalid(`${nth(index)} não segue o recibo do passo 16 (esquema estrito; UTF-8 sem BOM, sem barra invertida nem chave repetida)`);
}

const positionKey = (receipt: { readonly auditId: string; readonly seq: number }): string => `${receipt.auditId}\u0000${receipt.seq}`;
const sameReceipt = (left: SignatureReceipt, right: SignatureReceipt): boolean => RECEIPT_FIELDS.every((field) => left[field] === right[field]);
const byPosition = (left: SignatureReceipt, right: SignatureReceipt): number => (left.auditId < right.auditId ? -1 : left.auditId > right.auditId ? 1 : left.seq - right.seq);

/** Enumera (com teto) e lê cada recibo pelo descritor; funde os idênticos e recusa os divergentes. */
async function readAll(opened: OpenedDir, maxFiles: number, uid: number): Promise<ReceiptsRead | SignRefusal> {
  const listed = await opened.list(maxFiles);
  if (listed === null) return invalid(`mais de ${maxFiles} arquivos`);
  if (listed.length === 0) return EMPTY;
  const names = [...listed].sort();
  const byKey = new Map<string, SignatureReceipt>();
  for (const [index, name] of names.entries()) {
    const receipt = await readOneReceipt(opened, name, index, uid);
    if ('code' in receipt) return receipt;
    const known = byKey.get(positionKey(receipt));
    if (known && !sameReceipt(known, receipt)) {
      return refuse('CLOSE_RECEIPTS_CONFLICT', `Recibos DIVERGENTES para a mesma posição (auditoria ${receipt.auditId}, seq ${receipt.seq}): o registro externo está incoerente; resolva-o pelo runbook antes do fecho. ${NOTHING}`);
    }
    byKey.set(positionKey(receipt), receipt);
  }
  return { ok: true, receipts: [...byKey.values()].sort(byPosition), files: names.length };
}

/**
 * Lê `--receipts-dir` com as regras do cabeçalho: abre a pasta UMA vez, confere o descritor, as pastas acima e a sobreposição, e enumera e lê tudo
 * por ele. Recibos idênticos da mesma posição viram um só; divergentes ⇒ `CLOSE_RECEIPTS_CONFLICT` citando a posição (auditId e seq, públicos).
 * Qualquer outra falha ⇒ `CLOSE_RECEIPTS_INVALID`. Nunca lança; o descritor é fechado em qualquer saída.
 */
export async function readReceipts(ops: CloseFsOps, input: ReceiptsInput): Promise<ReceiptsRead | SignRefusal> {
  let opened: OpenedDir;
  try {
    opened = await ops.openDir(path.resolve(input.receiptsDir));
  } catch (error) {
    return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(errorCode(error))) ? NOT_A_DIRECTORY : UNREADABLE;
  }
  try {
    const refused = await openedDirRefusal(ops, opened, input);
    if (refused) return refused;
    return await readAll(opened, input.maxFiles ?? MAX_RECEIPT_FILES, input.uid as number);
  } catch {
    return UNREADABLE;
  } finally {
    await opened.close().catch(() => undefined); // fechar é só limpeza: o que foi lido já foi conferido
  }
}

/* ------------------------------------------------------------------------------------------------------------------- as cabeças do fecho (puro) */

/** Uma posição da cópia do servidor, como a varredura de `sign-closure.ts` a viu. */
export interface ServerPositionFacts {
  readonly seq: number;
  /** O `keyId` que o arquivo DECLARA (leitura leniente), ou `null` se não há (ilegível, não JSON, sem `keyId`). */
  readonly declaredKeyId: string | null;
  /** `sealSha256` do manifesto v2 estrito DESTA auditoria e DESTE seq, assinado por R com a pública da lista; `null` se não for isso. */
  readonly retiredSealSha256: string | null;
}
export interface ServerAuditFacts {
  readonly auditId: string;
  readonly positions: readonly ServerPositionFacts[];
}
export interface ClosureHead {
  readonly auditId: string;
  readonly seq: number;
  readonly sealSha256: string;
}
export interface ClosureHeadsResult {
  /** Uma por auditoria, estritamente ordenadas por auditId (contrato v2 §6). */
  readonly heads: readonly ClosureHead[];
  /** Cadeias com posição de R no servidor sem recibo correspondente: EXCLUÍDAS do fecho (V2-46). */
  readonly unknownSealsOnServer: ReadonlyArray<{ readonly auditId: string; readonly seqs: readonly number[] }>;
  /** Auditorias cuja cabeça do registro (maior seq de R) não está, idêntica e assinada por R, na cópia do servidor: EXCLUÍDAS (retrocesso, perda). */
  readonly receiptedHeadsNotOnServer: ReadonlyArray<{ readonly auditId: string; readonly seq: number }>;
}

const byAuditId = <T extends { readonly auditId: string }>(left: T, right: T): number => (left.auditId < right.auditId ? -1 : left.auditId > right.auditId ? 1 : 0);

/**
 * As cabeças do fecho de R (contrato v2 §6; spec §5.5.1 item 9), SÓ do registro externo:
 *  1. posição do servidor que declara `keyId = R` sem recibo de R da mesma posição com o MESMO `sealSha256` (e manifesto estrito assinado por R) ⇒ a
 *     cadeia inteira vai para `unknownSealsOnServer` e fica FORA (nada dela é coberto);
 *  2. de cada auditoria com recibos de R, a cabeça é o MAIOR `seq` de R no REGISTRO; ela tem de estar no servidor, idêntica e assinada por R. Senão a
 *     auditoria vai para `receiptedHeadsNotOnServer` e fica FORA: nunca se fecha numa cabeça menor tirada da pasta (um retrocesso viraria verdade).
 */
export function closureHeads(retiredKeyId: string, receipts: readonly SignatureReceipt[], server: readonly ServerAuditFacts[]): ClosureHeadsResult {
  const receiptAt = new Map(receipts.map((receipt) => [positionKey(receipt), receipt]));
  const unknown = server.flatMap(({ auditId, positions }) => {
    const seqs = positions
      .filter((position) => position.declaredKeyId === retiredKeyId)
      .filter((position) => {
        const receipt = receiptAt.get(positionKey({ auditId, seq: position.seq }));
        return !(receipt?.keyId === retiredKeyId && position.retiredSealSha256 !== null && position.retiredSealSha256 === receipt.sealSha256);
      })
      .map((position) => position.seq)
      .sort((a, b) => a - b);
    return seqs.length > 0 ? [{ auditId, seqs }] : [];
  });
  const excluded = new Set(unknown.map((entry) => entry.auditId));
  const latest = new Map<string, SignatureReceipt>();
  for (const receipt of receipts) if (receipt.keyId === retiredKeyId && (latest.get(receipt.auditId)?.seq ?? 0) < receipt.seq) latest.set(receipt.auditId, receipt);
  const onServer = new Map(server.map((audit) => [audit.auditId, audit]));
  const heads: ClosureHead[] = [];
  const missing: Array<{ auditId: string; seq: number }> = [];
  for (const receipt of latest.values()) {
    if (excluded.has(receipt.auditId)) continue;
    const position = onServer.get(receipt.auditId)?.positions.find((candidate) => candidate.seq === receipt.seq);
    if (position?.retiredSealSha256 === receipt.sealSha256) heads.push({ auditId: receipt.auditId, seq: receipt.seq, sealSha256: receipt.sealSha256 });
    else missing.push({ auditId: receipt.auditId, seq: receipt.seq });
  }
  return { heads: heads.sort(byAuditId), unknownSealsOnServer: unknown.sort(byAuditId), receiptedHeadsNotOnServer: missing.sort(byAuditId) };
}
