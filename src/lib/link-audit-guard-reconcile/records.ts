import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_LEDGER_RECORDS } from '../link-audit-ledger';
import { FINDING_CODES, type Analysis, type GuardRow } from './model';

/*
 * REGISTRO DA PRÓPRIA RECONCILIAÇÃO (G1.b.2b, GE-E5; spec §5.1.4 regra 6 e §5.1.5: a reconciliação guarda a PRÓPRIA cópia das cabeças). Uma pasta
 * do responsável, FORA da VPS e fora do repositório, com `reconcile-NNNNNN.json` em sequência sem lacuna, ENCADEADOS pelo SHA-256 dos bytes do
 * anterior. Cada rodada grava um arquivo NOVO por criação exclusiva (temporário `wx` + `link()` para o nome final + `fsync`): nunca sobrescreve,
 * nunca apaga, nunca renomeia um registro (só remove o próprio temporário). Pasta com lacuna, encadeamento quebrado, nome estranho ou registro
 * fora dos bytes que este módulo grava ⇒ recusada: a comparação com o "anterior" deixaria de valer.
 *
 * PASTA ESTRITA (revisão do PR #64): na pasta só cabem os registros e o temporário ÓRFÃO no padrão exato do gravador (que também não conta como
 * registro); qualquer outro nome (um LEIA-ME, um registro renomeado) ⇒ `RECORDS_INVALID` — senão, renomear todos os registros faria a pasta parecer
 * vazia e a cadeia recomeçar. A primeira reconciliação (`--first`) exige a pasta TOTALMENTE vazia (`entries` = 0, conferido pelo CLI). E a pasta
 * precisa ser SEGURA (`RECORDS_DIR_UNSAFE`): o caminho real fora do repositório (que é público), dona do usuário atual e sem escrita para grupo ou
 * outros (POSIX).
 *
 * Conteúdo: só pseudônimos, posições, hashes, ids PÚBLICOS de chave, o rótulo da rodada e o hash do manifesto dela. NUNCA `auditId`, caminho, URL
 * ou material de chave. As linhas são a marca d'água da análise (`model.ts`): as cabeças de agora mais as linhas que regrediram.
 */
export const RECORD_KIND = 'gmn-link-audit-guard-reconcile-record';
export const RECORD_VERSION = 1;
export const RECORD_FILE = /^reconcile-(\d{6})\.json$/;
const RECORD_PREFIX = 'reconcile-';
const TEMP_PREFIX = '.tmp-reconcile-';
/** O temporário que `writeRecord` gera (e que pode sobrar de uma execução interrompida): exatamente `.tmp-reconcile-NNNNNN-<16 hex>.json`. */
export const TEMP_FILE = /^\.tmp-reconcile-\d{6}-[0-9a-f]{16}\.json$/;
const GROUP_OR_OTHER_WRITE = 0o022;
const MAX_SEQUENCE = 999_999;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const recordFileName = (sequence: number): string => `${RECORD_PREFIX}${String(sequence).padStart(6, '0')}.json`;

const HEX_64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9-]{3,31}$/;
const rowSchema = z.object({ auditRef: z.string().regex(HEX_64), keyId: z.string().regex(KEY_ID), ledgerSeq: z.number().int().min(1).max(MAX_LEDGER_RECORDS), sha256: z.string().regex(HEX_64) }).strict();
const recordSchema = z
  .object({
    kind: z.literal(RECORD_KIND),
    version: z.literal(RECORD_VERSION),
    sequence: z.number().int().min(1).max(MAX_SEQUENCE),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    previousRecordSha256: z.string().regex(HEX_64).nullable(),
    backup: z.object({ round: z.string().regex(/^\d{8}-\d{6}-\d{1,10}$/), manifestSha256: z.string().regex(HEX_64) }).strict(),
    keyIds: z.array(z.string().regex(KEY_ID)).min(1),
    outcome: z.enum(['CLEAN', 'DIVERGENT']),
    findings: z.array(z.object({ code: z.enum(FINDING_CODES), auditRef: z.string().regex(HEX_64) }).strict()),
    heads: z.array(rowSchema),
  })
  .strict();
export type ReconcileRecord = z.infer<typeof recordSchema>;
export interface StoredRecord {
  readonly record: ReconcileRecord;
  /** SHA-256 dos bytes gravados (o que o registro seguinte encadeia). */
  readonly sha256: string;
  readonly fileName: string;
}
export type RecordsRefusal = 'RECORDS_DIR_INVALID' | 'RECORDS_DIR_UNSAFE' | 'RECORDS_INVALID' | 'RECORD_EXISTS' | 'RECORD_WRITE_FAILED';
export interface RecordsDirOptions {
  /** Raiz do repositório: a pasta dos registros nunca fica dentro dela (o repositório é público). */
  readonly projectRoot: string;
  /** Dono exigido da pasta (padrão: o usuário do processo; `null` = sem conferência de dono e de modo, plataforma sem uid). Só testes passam. */
  readonly uid?: number | null;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const byRefAndSeq = (x: GuardRow, y: GuardRow): number => (x.auditRef === y.auditRef ? x.ledgerSeq - y.ledgerSeq : x.auditRef < y.auditRef ? -1 : 1);

/** Bytes do registro: ordem FIXA das chaves (a do esquema), indentação de 2, fim de linha. */
export function serializeRecord(record: ReconcileRecord): string {
  const ordered: ReconcileRecord = {
    kind: record.kind,
    version: record.version,
    sequence: record.sequence,
    createdAt: record.createdAt,
    previousRecordSha256: record.previousRecordSha256,
    backup: { round: record.backup.round, manifestSha256: record.backup.manifestSha256 },
    keyIds: [...record.keyIds],
    outcome: record.outcome,
    findings: record.findings.map((item) => ({ code: item.code, auditRef: item.auditRef })),
    heads: record.heads.map((row) => ({ auditRef: row.auditRef, keyId: row.keyId, ledgerSeq: row.ledgerSeq, sha256: row.sha256 })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Monta o próximo registro a partir da análise (sem `auditId`: só código e pseudônimo de cada achado). */
export function buildRecord(input: { readonly previous: Pick<StoredRecord, 'record' | 'sha256'> | null; readonly createdAt: Date; readonly backup: { readonly round: string; readonly manifestSha256: string }; readonly keyIds: readonly string[]; readonly analysis: Analysis }): ReconcileRecord {
  return {
    kind: RECORD_KIND,
    version: RECORD_VERSION,
    sequence: (input.previous?.record.sequence ?? 0) + 1,
    createdAt: input.createdAt.toISOString(),
    previousRecordSha256: input.previous?.sha256 ?? null,
    backup: { round: input.backup.round, manifestSha256: input.backup.manifestSha256 },
    keyIds: [...input.keyIds],
    outcome: input.analysis.findings.length === 0 ? 'CLEAN' : 'DIVERGENT',
    findings: input.analysis.findings.map((item) => ({ code: item.code, auditRef: item.auditRef })),
    heads: [...input.analysis.witness].sort(byRefAndSeq).map((row) => ({ auditRef: row.auditRef, keyId: row.keyId, ledgerSeq: row.ledgerSeq, sha256: row.sha256 })),
  };
}

const inside = (child: string, parent: string): boolean => {
  const [c, p] = [child.toLowerCase(), parent.toLowerCase()]; // drvfs/Windows ignoram a caixa
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

/** A pasta existe, é diretório comum (não link), fica FORA do repositório pelo caminho real e, em POSIX, é do usuário sem escrita de grupo/outros. */
async function dirRefusal(dir: string, options: RecordsDirOptions): Promise<RecordsRefusal | null> {
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  let real: string;
  let root: string;
  try {
    info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return 'RECORDS_DIR_INVALID';
    real = await fs.realpath(dir);
    root = await fs.realpath(options.projectRoot);
  } catch {
    return 'RECORDS_DIR_INVALID';
  }
  if (inside(real, root)) return 'RECORDS_DIR_UNSAFE';
  const uid = options.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : options.uid;
  if (uid !== null && (info.uid !== uid || (Number(info.mode) & GROUP_OR_OTHER_WRITE) !== 0)) return 'RECORDS_DIR_UNSAFE';
  return null;
}

async function readRegular(file: string): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Um registro válido, com a posição e o encadeamento esperados e exatamente os bytes que este módulo grava. */
function validRecord(bytes: Buffer, sequence: number, previousSha: string | null): ReconcileRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.sequence !== sequence || record.previousRecordSha256 !== previousSha) return null;
  if (serializeRecord(record) !== bytes.toString('utf8')) return null;
  for (let index = 1; index < record.heads.length; index += 1) if (byRefAndSeq(record.heads[index - 1] as GuardRow, record.heads[index] as GuardRow) >= 0) return null; // ordem e unicidade
  return record;
}

/** Lê e confere a cadeia inteira; devolve o último (ou nenhum) e quantas entradas a pasta tem (o `--first` exige 0). Somente leitura. */
export async function readRecords(dir: string, options: RecordsDirOptions): Promise<{ readonly ok: true; readonly value: { readonly last: StoredRecord | null; readonly entries: number } } | { readonly ok: false; readonly code: RecordsRefusal }> {
  const refused = await dirRefusal(dir, options);
  if (refused) return { ok: false, code: refused };
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: false, code: 'RECORDS_DIR_INVALID' };
  }
  const numbers: number[] = [];
  for (const name of names) {
    const match = RECORD_FILE.exec(name);
    if (match) numbers.push(Number(match[1]));
    else if (!TEMP_FILE.test(name)) return { ok: false, code: 'RECORDS_INVALID' }; // nada além dos registros e do temporário órfão estrito
  }
  numbers.sort((x, y) => x - y);
  if (numbers.some((n, index) => n !== index + 1)) return { ok: false, code: 'RECORDS_INVALID' };
  const chain: StoredRecord[] = [];
  for (const n of numbers) {
    const bytes = await readRegular(path.join(dir, recordFileName(n)));
    const record = bytes === null ? null : validRecord(bytes, n, chain[chain.length - 1]?.sha256 ?? null);
    if (bytes === null || record === null) return { ok: false, code: 'RECORDS_INVALID' };
    chain.push({ record, sha256: sha256(bytes), fileName: recordFileName(n) });
  }
  return { ok: true, value: { last: chain[chain.length - 1] ?? null, entries: names.length } };
}

/** Grava o registro num arquivo NOVO (temporário exclusivo + `link()`): nunca sobrescreve. */
export async function writeRecord(dir: string, options: RecordsDirOptions, record: ReconcileRecord): Promise<{ readonly ok: true; readonly fileName: string; readonly sha256: string } | { readonly ok: false; readonly code: RecordsRefusal }> {
  const refused = await dirRefusal(dir, options);
  if (refused) return { ok: false, code: refused };
  const data = serializeRecord(record);
  const fileName = recordFileName(record.sequence);
  const temp = path.join(dir, `${TEMP_PREFIX}${String(record.sequence).padStart(6, '0')}-${randomBytes(8).toString('hex')}.json`);
  let linked: 'LINKED' | 'EXISTS' | 'FAILED' = 'FAILED';
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temp, path.join(dir, fileName));
      linked = 'LINKED';
    } catch (error) {
      linked = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'EXISTS' : 'FAILED';
    }
  } catch {
    linked = 'FAILED';
  } finally {
    await fs.unlink(temp).catch(() => undefined); // só o PRÓPRIO temporário (o nome final, se existir, é outro vínculo)
  }
  if (linked === 'EXISTS') return { ok: false, code: 'RECORD_EXISTS' };
  if (linked === 'FAILED') return { ok: false, code: 'RECORD_WRITE_FAILED' };
  try {
    const handle = await fs.open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, code: 'RECORD_WRITE_FAILED' }; // o arquivo existe, mas a durabilidade do nome não foi provada
  }
  return { ok: true, fileName, sha256: sha256(data) };
}
