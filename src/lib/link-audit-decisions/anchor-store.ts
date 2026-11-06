import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describeError, publishExclusive, type FsOps } from '../link-audit/snapshot-store';
import {
  ATOMIC_UNAVAILABLE_ERRNO,
  atomicOnly,
  splitNames,
  dirStatus,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  isBaseTripped,
  readSealedFile,
  seal,
  serialize,
  tripBase,
  type Location,
  type StoreFailure,
  type StoreResult,
} from './files';
import {
  ANCHOR_FILE,
  ANCHOR_FILE_KIND,
  anchorFileName,
  anchorSchema,
  DECISION_SCHEMA_VERSION,
  MAX_ENTRY_BYTES,
  type AnchorFile,
  type DecisionEntry,
} from './types';

/*
 * Âncoras: um recibo imutável por entrada de decisão, em uma pasta SEPARADA (outro local de gravação). Elas existem para
 * detectar o que a cadeia de hashes sozinha não detecta: perda do FIM do histórico (arquivo(s) apagado(s)), refazer o hash
 * do último arquivo e restaurar um backup antigo. Ver `docs/phase6-auditoria-link/onda6b-adr-ancora-externa.md`.
 */
export interface AnchorSummary {
  readonly count: number;
  readonly lastSeq: number;
  /** Entradas de decisão ainda sem âncora (0 ou 1: janela entre gravar a decisão e gravar o recibo). */
  readonly unanchored: number;
}

export interface AnchorsRead {
  readonly anchors: readonly AnchorFile[];
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

/** Lê e verifica TODAS as âncoras da auditoria (sequência, esquema, bytes, hash, encadeamento). Pasta ausente da auditoria = nenhuma. */
export async function readAnchors(ops: FsOps, located: Location, auditId: string): Promise<StoreResult<AnchorsRead>> {
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('ANCHOR_MISSING', 'O armazenamento de âncoras não existe neste servidor.');
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de âncoras não é um diretório comum.');
  const audit = await dirStatus(ops, located.dir);
  if (audit === 'MISSING') return { ok: true, value: { anchors: [], unexpectedFiles: [], orphanTempFiles: [] } };
  if (audit !== 'EXISTS') return fail('UNSAFE_PATH', 'A pasta de âncoras da auditoria não é um diretório comum.');

  let names: string[];
  try {
    names = await ops.readdir(located.dir);
  } catch (error) {
    return fail('ANCHOR_INTEGRITY', describeError('listagem das âncoras', error));
  }
  const { numbers, orphanTempFiles, suspicious, unexpectedFiles } = splitNames(names, ANCHOR_FILE, 'a');
  if (suspicious.length > 0) return fail('ANCHOR_INTEGRITY', `Arquivo suspeito na pasta de âncoras: ${suspicious[0]?.slice(0, 80)}.`);
  for (const [index, n] of numbers.entries()) {
    if (n !== index + 1) return fail('ANCHOR_INTEGRITY', `Lacuna na sequência de âncoras (esperado ${anchorFileName(index + 1)}, achado ${anchorFileName(n)}).`);
  }
  const anchors: AnchorFile[] = [];
  let previous: string | null = null;
  for (const n of numbers) {
    const name = anchorFileName(n);
    const file = await readSealedFile<AnchorFile>(ops, path.join(located.dir, name), MAX_ENTRY_BYTES, anchorSchema);
    if (!file.ok) return fail('ANCHOR_INTEGRITY', ...file.issues);
    const anchor = file.value;
    if (anchor.auditId !== auditId) return fail('ANCHOR_INTEGRITY', `${name} pertence a outra auditoria.`);
    if (anchor.seq !== n) return fail('ANCHOR_INTEGRITY', `${name}: a sequência interna (${anchor.seq}) não corresponde ao nome do arquivo.`);
    if (anchor.prevAnchorSha256 !== previous) return fail('ANCHOR_INTEGRITY', `${name}: não está encadeada à âncora anterior.`);
    previous = anchor.contentSha256;
    anchors.push(anchor);
  }
  return { ok: true, value: { anchors, unexpectedFiles, orphanTempFiles } };
}

/**
 * Confronta as âncoras com o histórico de decisões. Âncora à frente do histórico (ou de um arquivo que não existe mais) =
 * TRUNCADO; hash diferente na mesma posição = reescrito. No máximo UMA decisão pode estar sem âncora.
 */
export function verifyAnchors(entries: readonly DecisionEntry[], anchors: readonly AnchorFile[]): StoreResult<AnchorSummary> {
  if (anchors.length > entries.length) {
    return fail('TRUNCATED', `O histórico de decisões tem ${entries.length} arquivo(s), mas há âncora(s) até a posição ${anchors.length}: arquivos de decisão foram removidos ou o histórico foi restaurado de uma cópia antiga.`);
  }
  for (const anchor of anchors) {
    const entry = entries[anchor.seq - 1];
    if (!entry || entry.contentSha256 !== anchor.headSha256) {
      return fail('ANCHOR_MISMATCH', `A decisão ${anchor.seq} não confere com a âncora gravada na pasta separada (arquivo reescrito ou substituído).`);
    }
  }
  const unanchored = entries.length - anchors.length;
  if (unanchored > 1) return fail('ANCHOR_INTEGRITY', `${unanchored} decisões estão sem âncora (o máximo tolerado é 1): âncoras removidas ou pasta de âncoras trocada.`);
  return { ok: true, value: { count: anchors.length, lastSeq: anchors.length, unanchored } };
}

export function anchorBody(entry: DecisionEntry, previousAnchor: AnchorFile | undefined, anchoredAt: string): Omit<AnchorFile, 'contentSha256'> {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: ANCHOR_FILE_KIND,
    auditId: entry.auditId,
    seq: entry.seq,
    headSha256: entry.contentSha256,
    anchoredAt,
    prevAnchorSha256: previousAnchor?.contentSha256 ?? null,
  };
}

export async function prepareAnchorDirectory(ops: FsOps, located: Location): Promise<StoreFailure | null> {
  const base = await dirStatus(ops, located.root);
  if (base === 'MISSING') return fail('ANCHOR_MISSING', 'O armazenamento de âncoras não existe neste servidor.');
  if (base !== 'EXISTS') return fail('UNSAFE_PATH', 'O armazenamento de âncoras não é um diretório comum.');
  return ensureDirectory(ops, located.dir, 'âncoras');
}

/** Grava UMA âncora (só de forma atômica). Nunca sobrescreve: EEXIST ⇒ CONFLICT (o chamador relê). */
export async function writeAnchor(ops: FsOps, located: Location, anchor: Omit<AnchorFile, 'contentSha256'>): Promise<StoreResult<AnchorFile>> {
  if (isBaseTripped(located.root)) return fail('STORAGE_FATAL', 'Erro fatal de disco anterior na pasta de âncoras: escritas interrompidas até reiniciar o servidor.');
  const sealed = seal(anchor) as AnchorFile;
  const checked = anchorSchema.safeParse(sealed);
  if (!checked.success) return fail('INTERNAL', 'A âncora montada não segue o contrato (erro interno).');
  const name = anchorFileName(anchor.seq);
  const published = await publishExclusive(atomicOnly(ops), {
    dir: located.dir,
    finalPath: path.join(located.dir, name),
    tempPath: path.join(located.dir, `.tmp-${name}-${randomBytes(8).toString('hex')}`),
    data: serialize(sealed),
    label: `A âncora ${name}`,
  });
  if (published.ok) return { ok: true, value: checked.data };
  if (published.code === 'CONFLICT') return fail('CONFLICT', `A âncora ${name} já existe; nada foi sobrescrito.`);
  if (published.errno === ATOMIC_UNAVAILABLE_ERRNO) return fail('ATOMIC_WRITE_UNAVAILABLE', 'O armazenamento de âncoras não suporta link() atômico.');
  if (published.errno && FATAL_ERRNO.has(published.errno)) {
    tripBase(located.root);
    return fail('STORAGE_FATAL', `Erro fatal de disco (${published.errno}) na pasta de âncoras: escritas interrompidas.`);
  }
  return fail('ANCHOR_WRITE_FAILED', ...published.issues);
}

/** Tentativas imediatas de gravar o recibo (erro transitório de volume). Erros fatais e falta de `link()` atômico não se repetem. */
const ANCHOR_ATTEMPTS = 3;

/**
 * ÚNICO ponto em que uma decisão deixa de ser PENDENTE e passa a ser CONFIRMADA: o recibo dela está durável na pasta separada.
 * `EEXIST` não é erro: outro processo (ou uma tentativa anterior que falhou depois do `link`) já gravou o recibo — só vale se
 * ele corresponde EXATAMENTE a esta entrada (mesmo número, mesmo hash, encadeado); qualquer diferença é adulteração.
 */
export async function confirmAnchor(ops: FsOps, located: Location, entry: DecisionEntry, previous: AnchorFile | undefined, anchoredAt: string): Promise<StoreResult<AnchorFile>> {
  let last: StoreFailure = fail('INTERNAL', 'Nenhuma tentativa de gravar o recibo foi feita.');
  for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt++) {
    const written = await writeAnchor(ops, located, anchorBody(entry, previous, anchoredAt));
    if (written.ok) return written;
    if (written.code === 'CONFLICT') return adoptExistingAnchor(ops, located, entry);
    if (written.code === 'STORAGE_FATAL' || written.code === 'ATOMIC_WRITE_UNAVAILABLE') return written;
    last = written;
  }
  return last;
}

async function adoptExistingAnchor(ops: FsOps, located: Location, entry: DecisionEntry): Promise<StoreResult<AnchorFile>> {
  const read = await readAnchors(ops, located, entry.auditId);
  if (!read.ok) return read;
  const found = read.value.anchors[entry.seq - 1];
  if (read.value.anchors.length !== entry.seq || !found) return fail('ANCHOR_INTEGRITY', `A âncora ${anchorFileName(entry.seq)} existe, mas a pasta de âncoras não termina nela.`);
  if (found.headSha256 !== entry.contentSha256) return fail('ANCHOR_MISMATCH', `A âncora ${anchorFileName(entry.seq)} já existe e NÃO corresponde à decisão ${entry.seq}.`);
  return { ok: true, value: found };
}
