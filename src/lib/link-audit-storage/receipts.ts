import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describeError, publishExclusive, type FsOps } from '../link-audit/snapshot-store';
import {
  ATOMIC_UNAVAILABLE_ERRNO,
  atomicOnly,
  dirStatus,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  isBaseTripped,
  readSealedFile,
  seal,
  serialize,
  splitNames,
  tripBase,
  type Location,
  type Parser,
  type StoreFailure,
  type StoreResult,
} from './files';

/*
 * Protocolo de RECIBOS (âncoras), genérico (Onda 6C, I0). Extraído SEM mudança de comportamento de
 * `link-audit-decisions/anchor-store.ts` (Onda 6B): um recibo imutável por entrada, em pasta SEPARADA, que torna detectável a
 * perda do FIM do histórico (arquivos apagados), o refazer do hash do último arquivo e a restauração de um backup antigo.
 * O que varia entre consumidores (prefixo e padrão dos nomes, esquema, tamanho máximo e TEXTOS das mensagens) vem num
 * `ReceiptProfile`; a mecânica, a ordem das verificações e os códigos de erro são os mesmos para todos.
 *
 * Regras (inalteradas): sequência sem lacunas; mesmo `auditId`; número interno = nome; encadeamento; bytes canônicos; recibo à
 * frente do histórico = TRUNCATED; hash diferente = ANCHOR_MISMATCH; no máximo UMA entrada sem recibo (a pendente); o recibo
 * só é gravado de forma atômica e nunca sobrescreve (EEXIST ⇒ CONFLICT, e só vale se for idêntico ao esperado).
 */
export interface ReceiptShape {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly auditId: string;
  /** Recibo da entrada de mesmo número. */
  readonly seq: number;
  /** `contentSha256` da entrada no momento em que foi gravada. */
  readonly headSha256: string;
  readonly anchoredAt: string;
  readonly prevAnchorSha256: string | null;
  readonly contentSha256: string;
}

/** O que um recibo precisa saber da entrada que ele confirma. */
export interface ReceiptSubject {
  readonly auditId: string;
  readonly seq: number;
  readonly contentSha256: string;
}

export interface ReceiptSummary {
  readonly count: number;
  readonly lastSeq: number;
  /** Entradas ainda sem recibo (0 ou 1: janela entre gravar a entrada e gravar o recibo). */
  readonly unanchored: number;
}

export interface ReceiptsRead<R extends ReceiptShape> {
  readonly anchors: readonly R[];
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

/** Textos das mensagens (cada consumidor usa a sua linguagem de domínio; os códigos de erro são fixos). */
export interface ReceiptMessages {
  readonly storeMissing: string;
  readonly storeNotDirectory: string;
  readonly auditNotDirectory: string;
  /** Rótulo passado a `describeError` na listagem. */
  readonly listingLabel: string;
  /** Rótulo da pasta da auditoria em `ensureDirectory`. */
  readonly directoryLabel: string;
  readonly suspicious: (name: string) => string;
  readonly gap: (expected: string, found: string) => string;
  readonly otherAudit: (name: string) => string;
  readonly sequenceMismatch: (name: string, seq: number) => string;
  readonly notChained: (name: string) => string;
  readonly truncated: (entries: number, receipts: number) => string;
  readonly mismatch: (seq: number) => string;
  readonly tooManyUnanchored: (count: number) => string;
  readonly fatalBefore: string;
  readonly invalidContract: string;
  readonly label: (name: string) => string;
  readonly exists: (name: string) => string;
  readonly noAtomicLink: string;
  readonly fatalNow: (errno: string) => string;
  readonly noAttempt: string;
  readonly notLast: (name: string) => string;
  readonly notMatching: (name: string, seq: number) => string;
}

export interface ReceiptProfile<R extends ReceiptShape> {
  readonly schemaVersion: number;
  readonly kind: string;
  /** Prefixo dos nomes (`a` em `a0001.json`). */
  readonly prefix: string;
  /** Casa o nome de um recibo e captura o número (`/^a(\d{4})\.json$/`). */
  readonly filePattern: RegExp;
  readonly fileName: (seq: number) => string;
  readonly maxBytes: number;
  readonly schema: Parser<R>;
  /** Tentativas imediatas de gravar o recibo (erro transitório de volume). */
  readonly attempts: number;
  readonly messages: ReceiptMessages;
}

/** Lê e verifica TODOS os recibos da auditoria (sequência, esquema, bytes, hash, encadeamento). Pasta ausente da auditoria = nenhum. */
export async function readReceipts<R extends ReceiptShape>(profile: ReceiptProfile<R>, ops: FsOps, located: Location, auditId: string): Promise<StoreResult<ReceiptsRead<R>>> {
  const m = profile.messages;
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('ANCHOR_MISSING', m.storeMissing);
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', m.storeNotDirectory);
  const audit = await dirStatus(ops, located.dir);
  if (audit === 'MISSING') return { ok: true, value: { anchors: [], unexpectedFiles: [], orphanTempFiles: [] } };
  if (audit !== 'EXISTS') return fail('UNSAFE_PATH', m.auditNotDirectory);

  let names: string[];
  try {
    names = await ops.readdir(located.dir);
  } catch (error) {
    return fail('ANCHOR_INTEGRITY', describeError(m.listingLabel, error));
  }
  const { numbers, orphanTempFiles, suspicious, unexpectedFiles } = splitNames(names, profile.filePattern, profile.prefix);
  if (suspicious.length > 0) return fail('ANCHOR_INTEGRITY', m.suspicious(suspicious[0]?.slice(0, 80) as string));
  for (const [index, n] of numbers.entries()) {
    if (n !== index + 1) return fail('ANCHOR_INTEGRITY', m.gap(profile.fileName(index + 1), profile.fileName(n)));
  }
  const anchors: R[] = [];
  let previous: string | null = null;
  for (const n of numbers) {
    const name = profile.fileName(n);
    const file = await readSealedFile<R>(ops, path.join(located.dir, name), profile.maxBytes, profile.schema);
    if (!file.ok) return fail('ANCHOR_INTEGRITY', ...file.issues);
    const anchor = file.value;
    if (anchor.auditId !== auditId) return fail('ANCHOR_INTEGRITY', m.otherAudit(name));
    if (anchor.seq !== n) return fail('ANCHOR_INTEGRITY', m.sequenceMismatch(name, anchor.seq));
    if (anchor.prevAnchorSha256 !== previous) return fail('ANCHOR_INTEGRITY', m.notChained(name));
    previous = anchor.contentSha256;
    anchors.push(anchor);
  }
  return { ok: true, value: { anchors, unexpectedFiles, orphanTempFiles } };
}

/**
 * Confronta os recibos com o histórico. Recibo à frente do histórico (ou de um arquivo que não existe mais) = TRUNCADO; hash
 * diferente na mesma posição = reescrito. No máximo UMA entrada pode estar sem recibo.
 */
export function verifyReceipts<R extends ReceiptShape>(profile: ReceiptProfile<R>, entries: readonly { readonly contentSha256: string }[], anchors: readonly R[]): StoreResult<ReceiptSummary> {
  const m = profile.messages;
  if (anchors.length > entries.length) return fail('TRUNCATED', m.truncated(entries.length, anchors.length));
  for (const anchor of anchors) {
    const entry = entries[anchor.seq - 1];
    if (!entry || entry.contentSha256 !== anchor.headSha256) return fail('ANCHOR_MISMATCH', m.mismatch(anchor.seq));
  }
  const unanchored = entries.length - anchors.length;
  if (unanchored > 1) return fail('ANCHOR_INTEGRITY', m.tooManyUnanchored(unanchored));
  return { ok: true, value: { count: anchors.length, lastSeq: anchors.length, unanchored } };
}

/** Corpo (sem o selo) do recibo da entrada. A ORDEM das chaves define os bytes gravados: não alterar. */
export function receiptBody<R extends ReceiptShape>(profile: ReceiptProfile<R>, entry: ReceiptSubject, previous: R | undefined, anchoredAt: string): Omit<R, 'contentSha256'> {
  return {
    schemaVersion: profile.schemaVersion,
    kind: profile.kind,
    auditId: entry.auditId,
    seq: entry.seq,
    headSha256: entry.contentSha256,
    anchoredAt,
    prevAnchorSha256: previous?.contentSha256 ?? null,
  } as unknown as Omit<R, 'contentSha256'>;
}

export async function prepareReceiptDirectory<R extends ReceiptShape>(profile: ReceiptProfile<R>, ops: FsOps, located: Location): Promise<StoreFailure | null> {
  const m = profile.messages;
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('ANCHOR_MISSING', m.storeMissing);
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', m.storeNotDirectory);
  return ensureDirectory(ops, located.dir, m.directoryLabel);
}

/** Grava UM recibo (só de forma atômica). Nunca sobrescreve: EEXIST ⇒ CONFLICT (o chamador relê). */
export async function writeReceipt<R extends ReceiptShape>(profile: ReceiptProfile<R>, ops: FsOps, located: Location, anchor: Omit<R, 'contentSha256'>): Promise<StoreResult<R>> {
  const m = profile.messages;
  if (isBaseTripped(located.root)) return fail('STORAGE_FATAL', m.fatalBefore);
  const sealed = seal(anchor) as unknown as R;
  const checked = profile.schema.safeParse(sealed);
  if (!checked.success) return fail('INTERNAL', m.invalidContract);
  const name = profile.fileName(anchor.seq);
  const published = await publishExclusive(atomicOnly(ops), {
    dir: located.dir,
    finalPath: path.join(located.dir, name),
    tempPath: path.join(located.dir, `.tmp-${name}-${randomBytes(8).toString('hex')}`),
    data: serialize(sealed),
    label: m.label(name),
  });
  if (published.ok) return { ok: true, value: checked.data };
  if (published.code === 'CONFLICT') return fail('CONFLICT', m.exists(name));
  if (published.errno === ATOMIC_UNAVAILABLE_ERRNO) return fail('ATOMIC_WRITE_UNAVAILABLE', m.noAtomicLink);
  if (published.errno && FATAL_ERRNO.has(published.errno)) {
    tripBase(located.root);
    return fail('STORAGE_FATAL', m.fatalNow(published.errno));
  }
  return fail('ANCHOR_WRITE_FAILED', ...published.issues);
}

/**
 * ÚNICO ponto em que uma entrada deixa de ser PENDENTE e passa a ser CONFIRMADA: o recibo dela está durável na pasta separada.
 * `EEXIST` não é erro: outro processo (ou uma tentativa anterior que falhou depois do `link`) já gravou o recibo — só vale se
 * ele corresponde EXATAMENTE a esta entrada (mesmo número, mesmo hash, encadeado); qualquer diferença é adulteração.
 */
export async function confirmReceipt<R extends ReceiptShape>(profile: ReceiptProfile<R>, ops: FsOps, located: Location, entry: ReceiptSubject, previous: R | undefined, anchoredAt: string): Promise<StoreResult<R>> {
  let last: StoreFailure = fail('INTERNAL', profile.messages.noAttempt);
  for (let attempt = 0; attempt < profile.attempts; attempt++) {
    const written = await writeReceipt(profile, ops, located, receiptBody(profile, entry, previous, anchoredAt));
    if (written.ok) return written;
    if (written.code === 'CONFLICT') return adoptExistingReceipt(profile, ops, located, entry);
    if (written.code === 'STORAGE_FATAL' || written.code === 'ATOMIC_WRITE_UNAVAILABLE') return written;
    last = written;
  }
  return last;
}

async function adoptExistingReceipt<R extends ReceiptShape>(profile: ReceiptProfile<R>, ops: FsOps, located: Location, entry: ReceiptSubject): Promise<StoreResult<R>> {
  const m = profile.messages;
  const read = await readReceipts(profile, ops, located, entry.auditId);
  if (!read.ok) return read;
  const found = read.value.anchors[entry.seq - 1];
  const name = profile.fileName(entry.seq);
  if (read.value.anchors.length !== entry.seq || !found) return fail('ANCHOR_INTEGRITY', m.notLast(name));
  if (found.headSha256 !== entry.contentSha256) return fail('ANCHOR_MISMATCH', m.notMatching(name, entry.seq));
  return { ok: true, value: found };
}
