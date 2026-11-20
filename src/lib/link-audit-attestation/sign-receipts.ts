import path from 'node:path';
import { z } from 'zod';
import { errorCode, type BytesFsOps, type FileInfo } from '../link-audit/snapshot-store';
import { auditId as auditIdSchema, hex64, isoInstant, MAX_PACKAGE_ENTRIES, shortLabel } from './schemas';
import { SIGN_KEY_ID_PATTERN } from './sign-chain';
import { MAX_SEAL_SEQ, type SignRefusal, type SignRefusalCode } from './sign-core';

/*
 * P1 W4.5 — o REGISTRO EXTERNO do comando de fecho `close-key` (spec §5.5.1 item 9; contrato do verificador v2 §6 "Procedimento", passos 2 e 3;
 * V2-46). O registro é a pasta de RECIBOS de assinatura (o recibo do passo 16 do `sign`, um JSON por assinatura), indicada por `--receipts-dir`; as
 * `heads` do fecho vêm SÓ daqui, nunca da pasta do servidor. Regras (onde a spec era ambígua, vale o lado que falha fechado; notas da W4.5):
 *  - a pasta é um diretório real (pelo caminho real), não vazia, fora da cópia do servidor e sem contê-la; no máximo `MAX_RECEIPT_FILES` entradas;
 *  - TODA entrada é um arquivo comum `*.json` (nome simples, sem oculto) lido SEM seguir link e com limite (`MAX_RECEIPT_BYTES`): link simbólico,
 *    diretório, FIFO, oculto ou outra extensão é recusa, nunca ignorado em silêncio;
 *  - cada recibo passa pelo texto estrito (UTF-8 estrito, sem BOM, sem barra invertida, sem chave repetida) e pelo esquema zod ESTRITO do recibo;
 *  - recibos IDÊNTICOS para a mesma posição `{auditId, seq}` são um só; DIVERGENTES (qualquer campo) ⇒ recusa, também em posição sem a chave R
 *    (registro incoerente).
 * A escolha das cabeças (`closureHeads`) é PURA: recebe os recibos e os FATOS estruturais da varredura da cópia do servidor (`sign-closure.ts`).
 * Só LEITURA, pelo `FsOps` injetado; nunca importa o verificador. Mensagens em pt-BR sem caminho nem conteúdo de arquivo.
 */

/** Um recibo do passo 16 tem menos de 1 KiB (identado, menos de 1,2 KiB); 4 KiB deixa folga sem aceitar um arquivo arbitrário. */
export const MAX_RECEIPT_BYTES = 4096;
/** Um recibo por assinatura: 10 000 cobre anos de rotação (uma chave assina por no máximo 12 meses, D12) e limita a leitura a 40 MiB. */
export const MAX_RECEIPT_FILES = 10_000;
/** Nome de recibo: simples, sem oculto, extensão `.json` em minúsculas. */
const RECEIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.json$/;
const ECHOABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

/* ------------------------------------------------------------------------------------------------------------------- leitura da pasta de recibos */

const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message });
const NOTHING = 'Nada foi assinado nem gravado.';
const invalid = (why: string): SignRefusal => refuse('CLOSE_RECEIPTS_INVALID', `Pasta de recibos (--receipts-dir, o registro externo do fecho): ${why}. ${NOTHING}`);
const shown = (name: string): string => (ECHOABLE_NAME.test(name) ? `"${name}"` : 'uma entrada');

const NOT_A_DIRECTORY = invalid('inexistente, não é diretório ou é link simbólico (provável erro de digitação; nunca "sem recibos")');
const UNREADABLE = invalid('não pôde ser lida (erro de E/S ou permissão)');
const EMPTY = invalid('está vazia (sem recibo não há o que fechar; uma chave que nunca assinou pode ficar só retired ou revoked)');
const OVERLAPS = invalid('não pode estar dentro da cópia do servidor (--seals-dir) nem contê-la: as cabeças vêm do registro EXTERNO, nunca da pasta do servidor');
const TOO_MANY = invalid(`mais de ${MAX_RECEIPT_FILES} arquivos`);

export interface ReceiptsRead {
  readonly ok: true;
  /** Um recibo por posição `{auditId, seq}` (duplicados idênticos já fundidos), em ordem de auditId e seq. */
  readonly receipts: readonly SignatureReceipt[];
  /** Quantos arquivos foram lidos. */
  readonly files: number;
}

const isInside = (child: string, root: string): boolean => child === root || child.startsWith(root + path.sep);

/** O caminho real da pasta de recibos, se for um diretório real (não link) fora da cópia do servidor e sem contê-la. */
async function receiptsRoot(fs: BytesFsOps, receiptsDir: string, sealsRoot: string): Promise<string | SignRefusal> {
  let root: string;
  let info: FileInfo;
  try {
    info = await fs.lstat(path.resolve(receiptsDir));
    root = await fs.realpath(path.resolve(receiptsDir));
  } catch (error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR' ? NOT_A_DIRECTORY : UNREADABLE;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return NOT_A_DIRECTORY;
  return isInside(root, sealsRoot) || isInside(sealsRoot, root) ? OVERLAPS : root;
}

/** Um arquivo de recibo: arquivo comum (sem seguir link), até o limite, lido UMA vez como bytes e passado pelo texto e esquema estritos. */
async function readOneReceipt(fs: BytesFsOps, root: string, name: string): Promise<SignatureReceipt | SignRefusal> {
  if (!RECEIPT_NAME.test(name)) return invalid(`${shown(name)} não é um arquivo de recibo (nome simples terminado em .json, sem oculto); nada é ignorado em silêncio`);
  const file = path.join(root, name);
  let info: FileInfo;
  try {
    info = await fs.lstat(file);
  } catch {
    return UNREADABLE;
  }
  if (info.isSymbolicLink() || !info.isFile()) return invalid(`${shown(name)} não é arquivo comum (link simbólico, diretório, FIFO…)`);
  if (info.size > MAX_RECEIPT_BYTES) return invalid(`${shown(name)} acima de ${MAX_RECEIPT_BYTES} bytes`);
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFileBytes(file, MAX_RECEIPT_BYTES);
  } catch {
    return invalid(`${shown(name)} não pôde ser lido como arquivo comum`);
  }
  return parseReceiptBytes(bytes) ?? invalid(`${shown(name)} não segue o recibo do passo 16 (esquema estrito; UTF-8 sem BOM, sem barra invertida nem chave repetida)`);
}

const positionKey = (receipt: { readonly auditId: string; readonly seq: number }): string => `${receipt.auditId}\u0000${receipt.seq}`;
const sameReceipt = (left: SignatureReceipt, right: SignatureReceipt): boolean => RECEIPT_FIELDS.every((field) => left[field] === right[field]);
const byPosition = (left: SignatureReceipt, right: SignatureReceipt): number => (left.auditId < right.auditId ? -1 : left.auditId > right.auditId ? 1 : left.seq - right.seq);

/**
 * Lê `--receipts-dir`: cada arquivo uma vez, com as regras do cabeçalho. Recibos idênticos da mesma posição viram um só; divergentes ⇒
 * `CLOSE_RECEIPTS_CONFLICT` citando a posição (auditId e seq, públicos). Qualquer outra falha ⇒ `CLOSE_RECEIPTS_INVALID`. Nunca lança.
 */
export async function readReceipts(fs: BytesFsOps, input: { readonly receiptsDir: string; readonly sealsRoot: string }): Promise<ReceiptsRead | SignRefusal> {
  try {
    const root = await receiptsRoot(fs, input.receiptsDir, input.sealsRoot);
    if (typeof root !== 'string') return root;
    const names = [...(await fs.readdir(root))].sort();
    if (names.length === 0) return EMPTY;
    if (names.length > MAX_RECEIPT_FILES) return TOO_MANY;
    const byKey = new Map<string, SignatureReceipt>();
    for (const name of names) {
      const receipt = await readOneReceipt(fs, root, name);
      if ('code' in receipt) return receipt;
      const known = byKey.get(positionKey(receipt));
      if (known && !sameReceipt(known, receipt)) {
        return refuse('CLOSE_RECEIPTS_CONFLICT', `Recibos DIVERGENTES para a mesma posição (auditoria ${receipt.auditId}, seq ${receipt.seq}): o registro externo está incoerente; resolva-o pelo runbook antes do fecho. ${NOTHING}`);
      }
      byKey.set(positionKey(receipt), receipt);
    }
    return { ok: true, receipts: [...byKey.values()].sort(byPosition), files: names.length };
  } catch {
    return UNREADABLE;
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
