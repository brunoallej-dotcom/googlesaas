import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { LEDGER_AUDIT_ID_PATTERN, readLedgerFiles } from '../link-audit-ledger';

/*
 * LEITURA DA RODADA DE BACKUP DO LIVRO (G1.b.2b, GE-E5; plano `deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md`, "Rotina diária"). A rodada é a
 * pasta `<DESTINO_BACKUP_LIVRO>/<RODADA>/`, com `dados/` (a cópia da raiz do livro, `<auditId>/lNNNNNN.json`), `SHA256SUMS` (manifesto da ORIGEM),
 * `CABECAS.json` e o marcador persistente. SOMENTE LEITURA: nada é gravado, renomeado ou apagado aqui.
 *
 * Só vale uma rodada VÁLIDA: rótulo no formato do plano (`AAAAMMDD-HHMMSS-<pid>`), `RODADA-VALIDA` presente, `RODADA-INCOMPLETA` ausente e a cópia
 * conferindo EXATAMENTE com o `SHA256SUMS` (mesmo conjunto de arquivos, mesmos hashes; nada além de arquivos regulares e pastas). A raiz copiada só
 * pode ter pastas de auditoria com id válido. Cada livro passa pelo leitor do próprio livro (`readLedgerFiles`: esquema, hash, bytes canônicos,
 * sequência sem lacuna) e pelo encadeamento (`prevSha256`); um livro ilegível vira `UNREADABLE` só daquela auditoria. A etiqueta HMAC dos registros
 * NÃO é conferida (a reconciliação não tem a chave do livro): o que a guarda testemunha é o `contentSha256`, e um registro forjado na cópia não bate
 * com a cabeça publicada. Mensagens nunca citam caminho nem conteúdo.
 */
export const ROUND_VALID_MARKER = 'RODADA-VALIDA';
export const ROUND_INCOMPLETE_MARKER = 'RODADA-INCOMPLETA';
export const ROUND_MANIFEST = 'SHA256SUMS';
export const ROUND_DATA_DIR = 'dados';
/** `RODADA="$(date -u +%Y%m%d-%H%M%S)-$$"` do plano. */
export const ROUND_LABEL = /^\d{8}-\d{6}-\d{1,10}$/;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_DATA_FILE_BYTES = 1024 * 1024;
export const MAX_BACKUP_AUDITS = 10_000;
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}\.\/(.+)$/;

export type BackupRefusalCode = 'BACKUP_NOT_A_ROUND' | 'BACKUP_ROUND_NOT_VALID' | 'BACKUP_MANIFEST_INVALID' | 'BACKUP_MANIFEST_MISMATCH' | 'BACKUP_UNEXPECTED_ENTRY';
/** Livro de uma auditoria na rodada: os `contentSha256` na ordem (índice `i` = posição `i + 1`), ou ilegível. */
export type BackupLedger = { readonly auditId: string; readonly status: 'OK'; readonly shas: readonly string[] } | { readonly auditId: string; readonly status: 'UNREADABLE'; readonly reason: string };
export interface LedgerBackup {
  readonly round: string;
  /** SHA-256 do `SHA256SUMS` da rodada (identifica a cópia conferida). */
  readonly manifestSha256: string;
  /** Em ordem de `auditId`. */
  readonly ledgers: readonly BackupLedger[];
}
export type BackupResult = { readonly ok: true; readonly value: LedgerBackup } | { readonly ok: false; readonly code: BackupRefusalCode; readonly message: string };

const MESSAGES: Readonly<Record<BackupRefusalCode, string>> = {
  BACKUP_NOT_A_ROUND: 'A pasta informada não é uma rodada de backup do livro (pasta comum com o rótulo AAAAMMDD-HHMMSS-<pid> do plano de backup).',
  BACKUP_ROUND_NOT_VALID: 'A rodada não está marcada como válida (sem RODADA-VALIDA ou com RODADA-INCOMPLETA): o plano de backup a recusa.',
  BACKUP_MANIFEST_INVALID: 'O SHA256SUMS da rodada está ausente ou malformado.',
  BACKUP_MANIFEST_MISMATCH: 'A cópia da rodada não confere com o SHA256SUMS (arquivo alterado, a mais ou a menos).',
  BACKUP_UNEXPECTED_ENTRY: 'A cópia do livro tem algo que não é pasta de auditoria nem arquivo regular (link simbólico, arquivo solto ou nome inválido).',
};
const refuse = (code: BackupRefusalCode): BackupResult => ({ ok: false, code, message: MESSAGES[code] });
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Lê um arquivo REGULAR (sem seguir link simbólico no último componente) até `maxBytes`; qualquer outra coisa ⇒ `null`. */
async function readRegular(file: string, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const data = await handle.readFile();
    return data.length > maxBytes ? null : data;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function kindOf(file: string): Promise<'DIR' | 'FILE' | 'MISSING' | 'OTHER'> {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) return 'OTHER';
    return info.isDirectory() ? 'DIR' : info.isFile() ? 'FILE' : 'OTHER';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'OTHER';
  }
}

/** `<hash>  ./<caminho>` por linha (saída do `sha256sum` sobre `find . -type f`). Repetido ou malformado ⇒ `null`. */
function parseManifest(text: string): Map<string, string> | null {
  const entries = new Map<string, string>();
  const lines = text.split('\n');
  if (lines.pop() !== '') return null; // termina em fim de linha (ou é vazio)
  for (const line of lines) {
    const match = MANIFEST_LINE.exec(line);
    if (!match) return null;
    const file = match[2] as string;
    if (entries.has(file) || file.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
    entries.set(file, match[1] as string);
  }
  return entries;
}

/** Arquivos da cópia (caminho relativo com `/`); link simbólico ou arquivo especial ⇒ `null`. */
async function listFiles(dir: string, rel = ''): Promise<string[] | null> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await listFiles(path.join(dir, entry.name), relPath);
      if (nested === null) return null;
      found.push(...nested);
    } else if (entry.isFile()) found.push(relPath);
    else return null;
  }
  return found;
}

/** A cópia confere EXATAMENTE com o manifesto: mesmos arquivos e o hash de cada um. */
async function copyMatches(dataDir: string, manifest: ReadonlyMap<string, string>): Promise<BackupRefusalCode | null> {
  const files = await listFiles(dataDir);
  if (files === null) return 'BACKUP_UNEXPECTED_ENTRY';
  if (files.length !== manifest.size || files.some((file) => !manifest.has(file))) return 'BACKUP_MANIFEST_MISMATCH';
  for (const file of files) {
    const bytes = await readRegular(path.join(dataDir, ...file.split('/')), MAX_DATA_FILE_BYTES);
    if (bytes === null) return 'BACKUP_UNEXPECTED_ENTRY';
    if (sha256(bytes) !== manifest.get(file)) return 'BACKUP_MANIFEST_MISMATCH';
  }
  return null;
}

/** Livro de uma auditoria: leitor do próprio livro + encadeamento + `auditId` interno igual ao da pasta. */
async function ledgerOf(dataDir: string, auditId: string, projectRoot: string): Promise<BackupLedger> {
  const read = await readLedgerFiles(dataDir, auditId, { projectRoot });
  if (!read.ok) return { auditId, status: 'UNREADABLE', reason: read.code };
  const shas: string[] = [];
  for (const [index, record] of read.value.records.entries()) {
    if (record.auditId !== auditId) return { auditId, status: 'UNREADABLE', reason: 'AUDIT_ID_MISMATCH' };
    if (record.prevSha256 !== (index === 0 ? null : shas[index - 1])) return { auditId, status: 'UNREADABLE', reason: 'CHAIN_BROKEN' };
    shas.push(record.contentSha256);
  }
  return { auditId, status: 'OK', shas };
}

/** Lê e confere a rodada do livro (somente leitura). `projectRoot` é a raiz do repositório (o leitor do livro recusa pastas dentro dela). */
export async function readLedgerBackup(roundDir: string, projectRoot: string): Promise<BackupResult> {
  const root = path.resolve(roundDir);
  if ((await kindOf(root)) !== 'DIR' || !ROUND_LABEL.test(path.basename(root))) return refuse('BACKUP_NOT_A_ROUND');
  if ((await kindOf(path.join(root, ROUND_VALID_MARKER))) !== 'FILE' || (await kindOf(path.join(root, ROUND_INCOMPLETE_MARKER))) !== 'MISSING') return refuse('BACKUP_ROUND_NOT_VALID');
  const manifestBytes = await readRegular(path.join(root, ROUND_MANIFEST), MAX_MANIFEST_BYTES);
  const manifest = manifestBytes === null ? null : parseManifest(manifestBytes.toString('utf8'));
  if (manifestBytes === null || manifest === null) return refuse('BACKUP_MANIFEST_INVALID');
  const dataDir = path.join(root, ROUND_DATA_DIR);
  if ((await kindOf(dataDir)) !== 'DIR') return refuse('BACKUP_NOT_A_ROUND');
  const top = await fs.readdir(dataDir, { withFileTypes: true });
  if (top.length > MAX_BACKUP_AUDITS || top.some((entry) => !entry.isDirectory() || !LEDGER_AUDIT_ID_PATTERN.test(entry.name))) return refuse('BACKUP_UNEXPECTED_ENTRY');
  const mismatch = await copyMatches(dataDir, manifest);
  if (mismatch) return refuse(mismatch);
  const ledgers: BackupLedger[] = [];
  for (const auditId of top.map((entry) => entry.name).sort()) ledgers.push(await ledgerOf(dataDir, auditId, projectRoot));
  return { ok: true, value: { round: path.basename(root), manifestSha256: sha256(manifestBytes), ledgers } };
}
