import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicOnly, ATOMIC_UNAVAILABLE_ERRNO, assertBase, isDurabilityProven, mapOrdered, markDurabilityProven, READ_CONCURRENCY, DURABILITY_UNPROVEN_MESSAGE, watchDurability, dirStatus, ensureDirectory, fail, FATAL_ERRNO, isBaseTripped, locateIn, readSealedFile, serialize, splitNames, tripBase, type Location, type StoreOptions, type StoreResult } from '../link-audit-storage';
import { describeError, nodeFsOps, publishExclusive } from '../link-audit/snapshot-store';
import { LEDGER_AUDIT_ID_PATTERN, LEDGER_FILE, ledgerFileName, ledgerRecordSchema, MAX_LEDGER_RECORD_BYTES, MAX_LEDGER_RECORDS, type LedgerRecord } from './types';

/*
 * ARMAZENAMENTO do livro: `<LEDGER_DIR>/<auditId>/lNNNNNN.json`. É o único arquivo deste módulo que toca o disco (por `FsOps`). Só publica por
 * `link()` exclusivo (nunca sobrescreve, nunca apaga) e só lê arquivo comum (recusa FIFO, link simbólico e dispositivo). Uma pasta de auditoria
 * AUSENTE é "sem registros" (quem decide o que isso significa é o modelo: nunca "cabeça vazia"); uma raiz ausente é armazenamento INDISPONÍVEL.
 */
export type { Location, StoreOptions, StoreResult } from '../link-audit-storage';

const ID_RULE = { pattern: LEDGER_AUDIT_ID_PATTERN, message: 'auditId inválido (8 a 64 caracteres: letras minúsculas, números, _ e -).' };

export const assertLedgerBase = (baseDir: unknown, projectRoot: string): StoreResult<string> => assertBase(baseDir, projectRoot, 'livro de cabeças');
export const locateLedger = (baseDir: unknown, auditId: unknown, projectRoot: string): StoreResult<Location> => locateIn(baseDir, auditId, projectRoot, 'livro de cabeças', ID_RULE);

/** Identificador de operação (128 bits, CSPRNG). */
export const newOpId = (): string => randomBytes(16).toString('hex');

export interface LedgerRead {
  readonly records: readonly LedgerRecord[];
  readonly unexpectedFiles: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

const proofKey = (root: string, auditId: string): string => `${root}\0${auditId}`;

/** Relê TODO o livro da auditoria (bytes, esquema, hash, sequência). Nunca escreve. Pasta da auditoria ausente ⇒ nenhum registro. */
export async function readLedgerFiles(baseDir: unknown, auditId: unknown, options: StoreOptions = {}): Promise<StoreResult<LedgerRead>> {
  const ops = options.fs ?? nodeFsOps;
  const located = locateLedger(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const root = await dirStatus(ops, located.value.root);
  if (root === 'MISSING') return fail('STORAGE_MISSING', 'O armazenamento do livro de cabeças não existe neste servidor.');
  if (root !== 'EXISTS') return fail(root === 'ERROR' ? 'STORAGE_MISSING' : 'UNSAFE_PATH', root === 'ERROR' ? 'O armazenamento do livro de cabeças não está acessível.' : 'O armazenamento do livro de cabeças não é um diretório comum.');
  const dir = await dirStatus(ops, located.value.dir);
  if (dir === 'MISSING') return { ok: true, value: { records: [], unexpectedFiles: [], orphanTempFiles: [] } };
  if (dir !== 'EXISTS') return fail(dir === 'ERROR' ? 'STORAGE_MISSING' : 'UNSAFE_PATH', dir === 'ERROR' ? 'A pasta do livro da auditoria não está acessível.' : 'A pasta do livro da auditoria não é um diretório comum.');
  let names: string[];
  try {
    names = await ops.readdir(located.value.dir);
  } catch (error) {
    return fail('CORRUPT', describeError('listagem', error));
  }
  const { numbers, orphanTempFiles, suspicious, unexpectedFiles } = splitNames(names, LEDGER_FILE, 'l');
  if (suspicious.length > 0) return fail('CORRUPT', `Arquivo suspeito na pasta do livro: ${suspicious[0]?.slice(0, 80)}.`);
  // R7-07: nome que só se parece com um registro depois de normalizar (largura total, dígitos de outros alfabetos, letra "ℓ"): NUNCA é lido como registro, mas também não é
  // ignorado em silêncio — pasta com isso falha fechada (num sistema de arquivos que normaliza nomes ele PODERIA ser aberto como registro).
  const confusable = unexpectedFiles.find((name) => /^l\p{Nd}/u.test(name.normalize('NFKC').toLowerCase()));
  if (confusable !== undefined) return fail('CORRUPT', `Arquivo suspeito na pasta do livro: ${confusable.slice(0, 80)}.`);
  if (numbers.length > MAX_LEDGER_RECORDS) return fail('LIMIT_REACHED', 'O livro desta auditoria ultrapassa o limite de registros.');
  for (const [index, n] of numbers.entries()) {
    if (n !== index + 1) return fail('SEQUENCE_GAP', `Lacuna na sequência do livro (esperado ${ledgerFileName(index + 1)}, achado ${ledgerFileName(n)}).`);
  }
  const records: LedgerRecord[] = [];
  const files = await mapOrdered(numbers, READ_CONCURRENCY, (n) => readSealedFile<LedgerRecord>(ops, path.join(located.value.dir, ledgerFileName(n)), MAX_LEDGER_RECORD_BYTES, ledgerRecordSchema));
  for (const [position, n] of numbers.entries()) {
    const name = ledgerFileName(n);
    const file = files[position] as Awaited<ReturnType<typeof readSealedFile<LedgerRecord>>>;
    if (!file.ok) return file;
    if (file.value.ledgerSeq !== n) return fail('CHAIN_BROKEN', `${name}: a sequência interna (${file.value.ledgerSeq}) não corresponde ao nome do arquivo.`);
    records.push(file.value);
  }
  return { ok: true, value: { records, unexpectedFiles, orphanTempFiles } };
}

/**
 * R7-04: sincroniza (fsync) a pasta do livro da auditoria e SÓ responde `ok` se ficou comprovadamente durável. Serve às ações de MANUTENÇÃO (`RECOVER`) que podem não gravar nada
 * porque o registro já existe: depois de uma falha de fsync e um reinício, "o registro existe" não prova que ele sobreviveria a uma queda — o sucesso exige sincronizar de novo.
 */
export async function syncLedgerDirectory(baseDir: unknown, auditId: unknown, options: StoreOptions = {}): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: 'STORAGE_FATAL' | 'UNSAFE_PATH'; readonly issues: readonly string[] }> {
  const ops = options.fs ?? nodeFsOps;
  const located = locateLedger(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return { ok: false, code: 'UNSAFE_PATH', issues: located.issues };
  if (isBaseTripped(located.value.root)) return { ok: false, code: 'STORAGE_FATAL', issues: [DURABILITY_UNPROVEN_MESSAGE] };
  if ((await dirStatus(ops, located.value.dir)) !== 'EXISTS') return { ok: true };
  const watch = watchDurability(ops);
  try {
    await watch.ops.syncDirectory(located.value.dir);
  } catch {
    /* registrado por `watchDurability` */
  }
  // o fsync da pasta da auditoria não persiste o NOME dela: o pai também é sincronizado (a falha dele numa criação anterior pode ter sobrado; só uma sincronização AGORA a prova)
  try {
    await watch.ops.syncDirectory(located.value.root);
  } catch {
    /* idem */
  }
  if (watch.failure() === null) {
    markDurabilityProven(proofKey(located.value.root, auditId as string));
    return { ok: true };
  }
  tripBase(located.value.root);
  return { ok: false, code: 'STORAGE_FATAL', issues: [DURABILITY_UNPROVEN_MESSAGE] };
}

/**
 * REVALIDAÇÃO depois de um reinício: o livro de uma auditoria só é lido como protegido depois de ter a durabilidade PROVADA neste processo (fsync da pasta da auditoria e da raiz DEPOIS de os registros
 * existirem). Reiniciar não prova nada (o fsync de uma gravação anterior pode ter falhado e o processo morrido); a prova é feita UMA vez por processo e auditoria — custo: 2 fsyncs na primeira leitura.
 */
export async function ensureLedgerProven(baseDir: unknown, auditId: unknown, options: StoreOptions = {}): Promise<{ readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] }> {
  const located = locateLedger(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return { ok: false, issues: located.issues };
  if (isDurabilityProven(proofKey(located.value.root, auditId as string))) return { ok: true };
  const synced = await syncLedgerDirectory(baseDir, auditId, options);
  return synced.ok ? { ok: true } : { ok: false, issues: synced.issues };
}

export type PublishLedgerResult = { readonly ok: true } | { readonly ok: false; readonly code: 'CONFLICT' | 'STORAGE_FATAL' | 'ATOMIC_WRITE_UNAVAILABLE' | 'WRITE_FAILED' | 'STORAGE_MISSING' | 'UNSAFE_PATH' | 'LIMIT_REACHED'; readonly issues: readonly string[] };

/**
 * Publica UM registro já selado e assinado (`link()` exclusivo). `CONFLICT` = outro processo ocupou esta posição (o chamador relê e reavalia).
 * Nunca sobrescreve; o caminho não atômico é recusado; EIO/EROFS travam a base até reiniciar.
 */
export async function publishLedgerRecord(baseDir: unknown, record: LedgerRecord, options: StoreOptions = {}): Promise<PublishLedgerResult> {
  const ops = options.fs ?? nodeFsOps;
  const located = locateLedger(baseDir, record.auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return { ok: false, code: 'UNSAFE_PATH', issues: located.issues };
  const { root, dir } = located.value;
  if (record.ledgerSeq > MAX_LEDGER_RECORDS) return { ok: false, code: 'LIMIT_REACHED', issues: ['O livro desta auditoria atingiu o limite de registros.'] };
  if (isBaseTripped(root)) return { ok: false, code: 'STORAGE_FATAL', issues: ['Erro fatal de disco anterior: todas as escritas do livro estão interrompidas até reiniciar o servidor.'] };
  const base = await dirStatus(ops, root);
  if (base === 'MISSING') return { ok: false, code: 'STORAGE_MISSING', issues: ['O armazenamento do livro de cabeças não existe neste servidor.'] };
  if (base !== 'EXISTS') return { ok: false, code: 'UNSAFE_PATH', issues: ['O armazenamento do livro de cabeças não é um diretório comum acessível.'] };
  const ensured = await ensureDirectory(ops, dir, 'livro de cabeças');
  if (ensured) return { ok: false, code: ensured.code === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'WRITE_FAILED', issues: ensured.issues };
  const data = serialize(record);
  if (Buffer.byteLength(data) > MAX_LEDGER_RECORD_BYTES) return { ok: false, code: 'LIMIT_REACHED', issues: ['O registro do livro ultrapassa o tamanho máximo.'] };
  const name = ledgerFileName(record.ledgerSeq);
  const watch = watchDurability(ops);
  const durabilityUnknown = (): PublishLedgerResult => {
    tripBase(root);
    return { ok: false, code: 'STORAGE_FATAL', issues: [DURABILITY_UNPROVEN_MESSAGE] };
  };
  // M2: o fsync da pasta da auditoria NÃO persiste o NOME dela — quem o persiste é o fsync do diretório-PAI (a raiz). Por isso a raiz é sincronizada em TODA publicação (não só quando a pasta é
  // criada agora): depois de uma falha de fsync e de um reinício a pasta já existe e nada mais diria que o nome nunca foi comprovado. Feito ANTES de gravar: sem a raiz comprovada nada é publicado.
  try {
    await watch.ops.syncDirectory(root);
  } catch {
    /* registrado por `watchDurability` */
  }
  if (watch.failure() !== null) return durabilityUnknown();
  const published = await publishExclusive(atomicOnly(watch.ops), { dir, finalPath: path.join(dir, name), tempPath: path.join(dir, `.tmp-${name}-${randomBytes(8).toString('hex')}`), data, label: `O registro ${name}` });
  // PRECEDÊNCIA: uma falha de fsync observada em QUALQUER ponto desta publicação vale mais do que qualquer outro resultado (inclusive outro erro simultâneo, como ENOSPC ou conflito): depois de um
  // erro de fsync não se presume nada — a base trava e a resposta é "durabilidade desconhecida", nunca sucesso nem um erro de gravação comum que esconda a falha.
  if (watch.failure() !== null) return durabilityUnknown();
  if (published.ok) {
    markDurabilityProven(proofKey(root, record.auditId)); // a raiz e a pasta da auditoria foram sincronizadas DEPOIS de o registro existir
    return { ok: true };
  }
  if (published.code === 'CONFLICT') return { ok: false, code: 'CONFLICT', issues: published.issues };
  if (published.errno === ATOMIC_UNAVAILABLE_ERRNO) return { ok: false, code: 'ATOMIC_WRITE_UNAVAILABLE', issues: ['O armazenamento do livro não suporta link() atômico.'] };
  if (published.errno && FATAL_ERRNO.has(published.errno)) {
    tripBase(root);
    return { ok: false, code: 'STORAGE_FATAL', issues: [`Erro fatal de disco (${published.errno}): escritas do livro interrompidas.`] };
  }
  return { ok: false, code: 'WRITE_FAILED', issues: published.issues };
}

/** A base do livro está travada neste processo (falha de fsync ou erro fatal de disco)? Então o livro NÃO é lido como protegido (M2). */
export function ledgerDurabilityTripped(baseDir: unknown, options: StoreOptions = {}): boolean {
  const base = assertLedgerBase(baseDir, options.projectRoot ?? process.cwd());
  return base.ok && isBaseTripped(base.value);
}

/** Situação de uma pasta, para separar "não consigo ler" de "não é um diretório comum" (rótulo de diagnóstico; ambos falham fechado). */
export async function probeLedgerRoot(baseDir: unknown, options: StoreOptions = {}): Promise<'OK' | 'MISSING' | 'UNSAFE' | 'ERROR'> {
  const base = assertLedgerBase(baseDir, options.projectRoot ?? process.cwd());
  if (!base.ok) return 'UNSAFE';
  const status = await dirStatus(options.fs ?? nodeFsOps, base.value);
  return status === 'EXISTS' ? 'OK' : status;
}
