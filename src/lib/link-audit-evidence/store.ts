import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { METHODOLOGY_VERSION } from '../link-audit/methodology';
import { bestEffort, errorCode, nodeFsOps, publishExclusive, withLock, type FsOps } from '../link-audit/snapshot-store';
import { AUTH_PATTERNS, containsSecret } from './secrets';
import { isSimulatedCapture, SIMULATED_PROVIDER } from './simulated';
import {
  AUDIT_ID_PATTERN,
  CAPTURE_FILE,
  MAX_AUX_BYTES,
  MAX_CAPTURE_BYTES,
  REPORT_FILE,
  SITE_FILE,
  TEMP_FILE,
  captureName,
  captureSchema,
  pad,
  reportName,
  reportSchema,
  siteName,
  siteSchema,
  type CaptureFile,
  type ReportFile,
  type SiteFile,
} from './types';

/*
 * Armazenamento de evidências da Auditoria por Link (Onda 5A). UM mecanismo de gravação: o mesmo de snapshots
 * (`publishExclusive`: temporário exclusivo + fsync + link() exclusivo), sobre `FsOps` injetável. Cada arquivo
 * é imutável; nada é sobrescrito; EIO/EROFS ⇒ STORAGE_FATAL e nenhuma outra escrita nessa base.
 * Sem rede, ambiente ou relógio implícito (`now` vem de quem chama).
 */

export type EvidenceErrorCode =
  | 'INVALID'
  | 'INVALID_ID'
  | 'UNSAFE_PATH'
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'HASH_MISMATCH'
  | 'SCHEMA'
  | 'CONFLICT'
  | 'WRITE_FAILED'
  | 'STORAGE_FATAL'
  | 'STORAGE_NOT_READY'
  | 'SECRET_DETECTED'
  /** W5.2b (revisão do PR #62): a auditoria já está reservada no OUTRO modo (LIVE × SIMULATED); nada foi gravado nela. */
  | 'MODE_CONFLICT';

export type EvidenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EvidenceErrorCode; readonly issues: readonly string[] };

/** Mensagens nunca revelam caminhos do disco (nem do servidor, nem do Windows). */
export const scrubPaths = (text: string): string => text.replace(/(?<![\w.])(?:[A-Za-z]:\\|\/)[^\s"'`)]*/g, '[caminho]');

export const fail = (code: EvidenceErrorCode, ...issues: string[]): { readonly ok: false; readonly code: EvidenceErrorCode; readonly issues: readonly string[] } => ({ ok: false, code, issues: issues.map(scrubPaths) });

export interface StoreOptions {
  readonly fs?: FsOps;
  /** Raiz do projeto: a base de evidências não pode ficar em `public/`, `src/`, `.next/` nem `node_modules/` dela. */
  readonly projectRoot?: string;
  /** Valor literal da chave de API (se conhecido) para a varredura de segredos. */
  readonly apiKey?: string;
}

/** Descrição de erro de disco SEM a mensagem do Node (ela traz o caminho): só operação e código. */
const describeError = (operation: string, error: unknown): string => `${operation}: ${errorCode(error)}`;

const FATAL_ERRNO = new Set(['EIO', 'EROFS']);
const MAX_CAPTURE_NUMBER = 9999;
const WRITE_RETRIES = 5;
const MIN_ORPHAN_AGE_MS = 60_000;
const trippedBases = new Set<string>();

/** Depois de EIO/EROFS a base fica bloqueada para escrita até o processo reiniciar (ou `clearStorageFatal`, para testes/operador). */
/** Caminho informado → caminho real, guardado no momento do bloqueio (sem usar o disco para limpar). */
const realOf = new Map<string, string>();

export function clearStorageFatal(baseDir?: string): void {
  if (!baseDir) {
    trippedBases.clear();
    realOf.clear();
    return;
  }
  const resolved = path.resolve(baseDir);
  const real = realOf.get(resolved);
  trippedBases.delete(resolved);
  if (real) trippedBases.delete(real);
  realOf.delete(resolved);
}
export const isStorageFatal = (baseDir: string): boolean => trippedBases.has(path.resolve(baseDir));

/** Chave do bloqueio: o caminho REAL (symlinks e apelidos da mesma pasta compartilham o bloqueio). */
async function baseKey(ops: FsOps, root: string): Promise<string> {
  try {
    return await ops.realpath(root);
  } catch {
    return root;
  }
}
/** Bloqueia a base pelo caminho informado E pelo caminho real (apelidos/symlinks da mesma pasta). */
async function trip(ops: FsOps, root: string): Promise<void> {
  const real = await baseKey(ops, root);
  trippedBases.add(root);
  trippedBases.add(real);
  realOf.set(root, real);
}
const isTripped = async (ops: FsOps, root: string): Promise<boolean> => trippedBases.has(root) || trippedBases.has(await baseKey(ops, root));

async function writeFailure(ops: FsOps, root: string, errno: string | undefined, issues: readonly string[]): Promise<{ ok: false; code: EvidenceErrorCode; issues: readonly string[] }> {
  if (errno && FATAL_ERRNO.has(errno)) {
    await trip(ops, root);
    return fail('STORAGE_FATAL', `Erro fatal de disco (${errno}): todas as operações de escrita foram interrompidas.`, ...issues);
  }
  return fail('WRITE_FAILED', ...issues);
}

export const sealed = <T extends { contentSha256?: string }>(content: Omit<T, 'contentSha256'>): T => {
  const clean = JSON.parse(JSON.stringify(content)) as Omit<T, 'contentSha256'>;
  return { ...clean, contentSha256: sha256Hex(canonicalJson(clean)) } as T;
};

export function hashOk(file: { contentSha256: string }): boolean {
  const { contentSha256, ...rest } = file;
  return sha256Hex(canonicalJson(rest)) === contentSha256;
}

export const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export interface Location {
  readonly root: string;
  readonly dir: string;
}

const forbiddenRoots = (projectRoot: string): string[] => ['public', 'src', '.next', 'node_modules'].map((name) => path.join(path.resolve(projectRoot), name));

export function assertAllowedBase(baseDir: unknown, projectRoot: string): EvidenceResult<string> {
  if (typeof baseDir !== 'string' || baseDir.length === 0 || baseDir.includes('\0')) return fail('UNSAFE_PATH', 'Diretório base inválido.');
  const root = path.resolve(baseDir);
  const lowered = root.toLowerCase(); // drvfs/Windows ignoram a caixa
  for (const forbidden of forbiddenRoots(projectRoot)) {
    const lowerForbidden = forbidden.toLowerCase();
    if (lowered === lowerForbidden || lowered.startsWith(lowerForbidden + path.sep)) {
      return fail('UNSAFE_PATH', `O diretório de evidências não pode ficar em ${path.basename(forbidden)}/ do projeto (área pública ou de código).`);
    }
  }
  return { ok: true, value: root };
}

export function locate(baseDir: unknown, auditId: unknown, projectRoot: string): EvidenceResult<Location> {
  if (typeof auditId !== 'string' || !AUDIT_ID_PATTERN.test(auditId)) {
    return fail('INVALID_ID', 'auditId inválido (8 a 64 caracteres: letras minúsculas, números, _ e -).');
  }
  const base = assertAllowedBase(baseDir, projectRoot);
  if (!base.ok) return base;
  const dir = path.join(base.value, auditId);
  if (!dir.startsWith(base.value + path.sep)) return fail('UNSAFE_PATH', 'O caminho da auditoria sai do diretório base.');
  return { ok: true, value: { root: base.value, dir } };
}

async function ensureDirectory(ops: FsOps, dir: string, create: boolean): Promise<EvidenceResult<'EXISTS' | 'MISSING'>> {
  try {
    const info = await ops.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return fail('UNSAFE_PATH', 'A pasta da auditoria não é um diretório comum.');
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

// ------------------------------------------------------------------------------- reserva do modo (W5.2b)
/**
 * MODO da auditoria (W5.2b, spec do P1 §5.7, revisão do PR #62): `LIVE` (coleta real) ou `SIMULATED` (coleta sintética do ensaio). Reservado UMA vez,
 * antes da primeira captura, num marcador publicado com criação EXCLUSIVA (`publishExclusive`: temporário + `link()` que nunca sobrescreve), e
 * conferido no pré-voo e em cada gravação. Duas coletas concorrentes de modos diferentes: exatamente uma reserva; a outra é recusada. Falha fechada:
 * marcador ilegível ou capturas que não se leem ⇒ recusa. O marcador não é evidência (fora do conjunto atestado) e não é assinatura.
 */
export type AuditMode = 'LIVE' | 'SIMULATED';
export const AUDIT_MODE_FILE = 'audit-mode.json';
const auditModeSchema = z
  .object({ schemaVersion: z.literal(1), kind: z.literal('LINK_AUDIT_MODE'), auditId: z.string().regex(AUDIT_ID_PATTERN), mode: z.enum(['LIVE', 'SIMULATED']), contentSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
type AuditModeFile = z.infer<typeof auditModeSchema>;
const MODE_LABEL: Readonly<Record<AuditMode, string>> = { LIVE: 'LIVE (coleta real)', SIMULATED: 'SIMULADA (ensaio)' };
const modeConflict = (reserved: AuditMode): { readonly ok: false; readonly code: EvidenceErrorCode; readonly issues: readonly string[] } =>
  fail('MODE_CONFLICT', `Esta auditoria está reservada como ${MODE_LABEL[reserved]}: a coleta do outro modo não é misturada a ela; use outro id de auditoria. Nada foi gravado nesta auditoria.`);

/** O marcador gravado, ou `null` se ele comprovadamente não existe. Qualquer outro problema (ilegível, fora de forma, de outra auditoria) ⇒ recusa. */
async function readAuditMode(ops: FsOps, dir: string, auditId: string): Promise<EvidenceResult<AuditMode | null>> {
  const read = await readValidated<AuditModeFile>(ops, path.join(dir, AUDIT_MODE_FILE), MAX_AUX_BYTES, auditModeSchema);
  if (!read.ok) return read.code === 'NOT_FOUND' ? { ok: true, value: null } : fail('CORRUPT', `O marcador de modo desta auditoria não pôde ser lido (${read.code}); nada foi gravado.`);
  if (read.value.auditId !== auditId) return fail('CORRUPT', 'O marcador de modo não pertence a esta auditoria; nada foi gravado.');
  return { ok: true, value: read.value.mode };
}

/** Auditoria anterior ao marcador (capturas sem reserva): o modo vem das próprias capturas, todas legíveis e do mesmo modo; senão, recusa. */
async function modeOfCaptures(root: string, auditId: string, options: StoreOptions & { readonly fs: FsOps }): Promise<EvidenceResult<AuditMode | null>> {
  const listing = await listAuditFiles(options.fs, path.join(root, auditId));
  if (!listing.ok) return listing.code === 'NOT_FOUND' ? { ok: true, value: null } : fail('CORRUPT', 'A pasta desta auditoria não pôde ser listada; nada foi gravado.');
  const modes = new Set<AuditMode>();
  for (const n of listing.value.captures) {
    const capture = await readCapture(root, auditId, n, options);
    if (!capture.ok) return fail('CORRUPT', `A captura ${n} desta auditoria não pôde ser lida: o modo não pode ser provado; nada foi gravado.`);
    modes.add(isSimulatedCapture(capture.value) ? 'SIMULATED' : 'LIVE');
  }
  if (modes.size > 1) return fail('CORRUPT', 'Esta auditoria já mistura captura simulada e real: nada mais é gravado nela.');
  return { ok: true, value: modes.values().next().value ?? null };
}

/** Reserva (ou confere) o modo, com a pasta da auditoria já existente. Sem trava própria: quem chama segura a trava da auditoria. */
async function reserveMode(loc: Location, auditId: string, mode: AuditMode, options: StoreOptions & { readonly fs: FsOps }): Promise<EvidenceResult<AuditMode>> {
  const ops = options.fs;
  const current = await readAuditMode(ops, loc.dir, auditId);
  if (!current.ok) return current;
  if (current.value !== null) return current.value === mode ? { ok: true, value: mode } : modeConflict(current.value);
  const fromCaptures = await modeOfCaptures(loc.root, auditId, options);
  if (!fromCaptures.ok) return fromCaptures;
  if (fromCaptures.value !== null && fromCaptures.value !== mode) return modeConflict(fromCaptures.value);
  const marker = sealed<AuditModeFile>({ schemaVersion: 1, kind: 'LINK_AUDIT_MODE', auditId, mode });
  const published = await publish(ops, loc, AUDIT_MODE_FILE, 'modo', marker, 'A reserva de modo da auditoria');
  if (published.ok) return { ok: true, value: mode };
  if (published.code !== 'CONFLICT') return published;
  // outro processo reservou no mesmo instante: vale o que ficou gravado (exclusividade do `link()`)
  const winner = await readAuditMode(ops, loc.dir, auditId);
  if (!winner.ok) return winner;
  if (winner.value === null) return fail('CORRUPT', 'A reserva de modo desta auditoria sumiu durante a gravação; nada foi gravado.');
  return winner.value === mode ? { ok: true, value: mode } : modeConflict(winner.value);
}

/**
 * Reserva o MODO da auditoria ANTES da primeira captura (o runtime chama no pré-voo, antes de consumir a autorização e de pagar). Idempotente para o
 * mesmo modo; o outro modo ⇒ `MODE_CONFLICT`. Cria a pasta da auditoria se preciso.
 */
export async function reserveAuditMode(baseDir: string, auditId: string, mode: AuditMode, options: StoreOptions = {}): Promise<EvidenceResult<AuditMode>> {
  const ops = options.fs ?? nodeFsOps;
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  if (await isTripped(ops, located.value.root)) return fail('STORAGE_FATAL', 'Base bloqueada por erro fatal de disco anterior.');
  return withLock(await auditLockKey(ops, located.value, auditId), async () => {
    const state = await ensureDirectory(ops, located.value.dir, true);
    if (!state.ok) return state;
    return reserveMode(located.value, auditId, mode, { ...options, fs: ops });
  });
}

/** A mesma chave de trava de `writeCapture` (caminho real da base + auditId): reserva e gravação da mesma auditoria se excluem no processo. */
async function auditLockKey(ops: FsOps, loc: Location, auditId: string): Promise<string> {
  try {
    return path.join(await ops.realpath(loc.root), auditId);
  } catch {
    return loc.dir; // a base pode ainda não existir
  }
}

// ----------------------------------------------------------------------------------------- pré-voo
export interface StorageStatus {
  readonly baseDir: string;
  readonly linkSupported: boolean;
  readonly notes: readonly string[];
}

const ACL_NOTE = 'A proteção de acesso (ACL do Windows) não é verificável pelo Node: a pasta deve estar restrita ao operador antes do uso. Cópia no mesmo disco não é backup independente.';

/** Confirma que dá para publicar com segurança ANTES de qualquer consulta paga. Falha ⇒ a operação deve ser bloqueada. */
export async function checkStorage(baseDir: string, options: StoreOptions & { readonly auditId?: string; readonly simulated?: boolean } = {}): Promise<EvidenceResult<StorageStatus>> {
  const ops = options.fs ?? nodeFsOps;
  const allowed = assertAllowedBase(baseDir, options.projectRoot ?? process.cwd());
  if (!allowed.ok) return fail('STORAGE_NOT_READY', ...allowed.issues);
  if (await isTripped(ops, allowed.value)) return fail('STORAGE_FATAL', 'Esta base teve erro fatal de disco (EIO/EROFS) e está bloqueada para escrita.');
  const notes = [ACL_NOTE];
  let real = allowed.value;
  try {
    await ops.mkdir(allowed.value);
    real = await ops.realpath(allowed.value);
  } catch (error) {
    return notReady(ops, allowed.value, error, 'criação/resolução da pasta base');
  }
  const again = assertAllowedBase(real, options.projectRoot ?? process.cwd());
  if (!again.ok) return fail('STORAGE_NOT_READY', ...again.issues);

  if (options.auditId !== undefined) {
    const located = locate(real, options.auditId, options.projectRoot ?? process.cwd());
    if (!located.ok) return fail('STORAGE_NOT_READY', ...located.issues);
    try {
      await ops.lstat(path.join(located.value.dir, 'MANIFEST.json'));
      return fail('STORAGE_NOT_READY', 'Já existe uma pasta de auditoria no formato legado com este identificador; use outro id para não misturar formatos.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return notReady(ops, real, error, 'verificação da pasta da auditoria');
    }
    const reserved = await readAuditMode(ops, located.value.dir, options.auditId);
    if (!reserved.ok) return fail('STORAGE_NOT_READY', ...reserved.issues);
    const wanted: AuditMode = options.simulated === true ? 'SIMULATED' : 'LIVE';
    if (reserved.value !== null && reserved.value !== wanted) {
      return fail('STORAGE_NOT_READY', `Esta auditoria está reservada como ${MODE_LABEL[reserved.value]}: a coleta do outro modo não é misturada a ela; use outro id. Nada foi consultado.`);
    }
    const mixed = await mixesSimulation(real, options.auditId, options.simulated === true, { ...options, fs: ops });
    if (mixed) return fail('STORAGE_NOT_READY', mixed);
  }

  const probe = path.join(real, `.probe-${randomBytes(8).toString('hex')}`);
  const probeLink = `${probe}.lnk`;
  let linkSupported = true;
  try {
    await ops.writeExclusive(probe, 'gmn-link-audit-probe');
    if ((await ops.readFile(probe, 1024)) !== 'gmn-link-audit-probe') return fail('STORAGE_NOT_READY', 'A releitura da sonda de gravação não confere.');
    try {
      await ops.link(probe, probeLink);
    } catch (error) {
      if (FATAL_ERRNO.has(errorCode(error))) throw error;
      linkSupported = false;
      notes.push('O sistema de arquivos não suporta link(): a publicação usa criação exclusiva, que não é atômica em caso de queda.');
    }
  } catch (error) {
    await bestEffort(() => ops.unlink(probe));
    return notReady(ops, real, error, 'sonda de gravação');
  }
  await bestEffort(() => ops.unlink(probe));
  if (linkSupported) await bestEffort(() => ops.unlink(probeLink));
  return { ok: true, value: { baseDir: real, linkSupported, notes } };
}

/**
 * Captura SIMULADA (ensaio) e captura real nunca dividem uma auditoria (spec do P1 §5.7): o pré-voo recusa ANTES de qualquer consulta. Falha
 * FECHADA (revisão do PR #62): só a pasta da auditoria comprovadamente inexistente (ENOENT) conta como vazia; listagem que falha por qualquer outro
 * motivo, ou captura existente que não se lê, é recusa (não dá para provar que não há mistura).
 */
async function mixesSimulation(root: string, auditId: string, simulated: boolean, options: StoreOptions & { readonly fs: FsOps }): Promise<string | null> {
  const listing = await listAuditFiles(options.fs, path.join(root, auditId));
  if (!listing.ok) return listing.code === 'NOT_FOUND' ? null : 'A pasta desta auditoria existe mas não pôde ser listada: não dá para conferir se há captura simulada e real misturadas. Nada foi consultado.';
  for (const n of listing.value.captures) {
    const existing = await readCapture(root, auditId, n, options);
    if (!existing.ok) return `A captura ${n} desta auditoria não pôde ser lida (${existing.code}): não dá para conferir se há captura simulada e real misturadas. Nada foi consultado.`;
    if (isSimulatedCapture(existing.value) === simulated) continue;
    return simulated
      ? 'Esta auditoria tem captura real: a coleta SIMULADA (ensaio) não é misturada a ela; use outro id de auditoria.'
      : 'Esta auditoria tem captura SIMULADA (ensaio de homologação): a coleta real não é misturada a ela; use outro id. Nenhuma consulta foi feita e a autorização não foi consumida.';
  }
  return null;
}

async function notReady(ops: FsOps, root: string, error: unknown, step: string): Promise<EvidenceResult<never>> {
  const errno = errorCode(error);
  if (FATAL_ERRNO.has(errno)) {
    await trip(ops, root);
    return fail('STORAGE_FATAL', `Erro fatal de disco (${errno}) em ${step}: operações interrompidas.`);
  }
  return fail('STORAGE_NOT_READY', describeError(step, error));
}

// ------------------------------------------------------------------------------------------ leitura
async function readJson(ops: FsOps, file: string, maxBytes: number): Promise<EvidenceResult<unknown>> {
  let text: string;
  try {
    text = await ops.readFile(file, maxBytes);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? fail('NOT_FOUND', `${path.basename(file)} não existe.`) : fail('CORRUPT', describeError(`leitura de ${path.basename(file)}`, error));
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail('CORRUPT', `${path.basename(file)} não é JSON válido.`);
  }
}

async function readValidated<T extends { contentSha256: string }>(ops: FsOps, file: string, maxBytes: number, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<EvidenceResult<T>> {
  const raw = await readJson(ops, file, maxBytes);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) return fail('SCHEMA', `${path.basename(file)} não segue o formato esperado.`);
  if (!hashOk(parsed.data)) return fail('HASH_MISMATCH', `${path.basename(file)}: o hash não confere (arquivo alterado ou inconsistente).`);
  return { ok: true, value: parsed.data };
}

export interface AuditListing {
  readonly captures: readonly number[];
  readonly sites: readonly number[];
  readonly reports: readonly { readonly capture: number; readonly revision: number }[];
  readonly orphanTempFiles: readonly string[];
}

export async function listAuditFiles(ops: FsOps, dir: string): Promise<EvidenceResult<AuditListing>> {
  let names: string[];
  try {
    names = await ops.readdir(dir);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? fail('NOT_FOUND', 'Auditoria não encontrada.') : fail('CORRUPT', describeError('listagem', error));
  }
  const captures: number[] = [];
  const sites: number[] = [];
  const reports: { capture: number; revision: number }[] = [];
  const orphanTempFiles: string[] = [];
  for (const name of names) {
    const c = CAPTURE_FILE.exec(name);
    const s = SITE_FILE.exec(name);
    const r = REPORT_FILE.exec(name);
    if (c) captures.push(Number(c[1]));
    else if (s) sites.push(Number(s[1]));
    else if (r) reports.push({ capture: Number(r[1]), revision: Number(r[2]) });
    else if (TEMP_FILE.test(name)) orphanTempFiles.push(name);
  }
  captures.sort((a, b) => a - b);
  sites.sort((a, b) => a - b);
  reports.sort((a, b) => a.capture - b.capture || a.revision - b.revision);
  return { ok: true, value: { captures, sites, reports, orphanTempFiles } };
}

export async function readCapture(baseDir: string, auditId: string, n: number, options: StoreOptions = {}): Promise<EvidenceResult<CaptureFile>> {
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const read = await readValidated<CaptureFile>(options.fs ?? nodeFsOps, path.join(located.value.dir, captureName(n)), MAX_CAPTURE_BYTES, captureSchema);
  if (!read.ok) return read;
  if (read.value.auditId !== auditId || read.value.captureNumber !== n) return fail('CORRUPT', 'O conteúdo não pertence a esta auditoria/captura.');
  const body = read.value.response.bodyText;
  if (body !== null && sha256Hex(body) !== read.value.response.bodySha256) return fail('HASH_MISMATCH', 'O corpo da resposta não confere com o hash registrado.');
  return read;
}

export async function readSite(baseDir: string, auditId: string, n: number, options: StoreOptions = {}): Promise<EvidenceResult<SiteFile>> {
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const read = await readValidated<SiteFile>(options.fs ?? nodeFsOps, path.join(located.value.dir, siteName(n)), MAX_AUX_BYTES, siteSchema);
  if (read.ok && (read.value.auditId !== auditId || read.value.captureNumber !== n)) return fail('CORRUPT', 'O conteúdo não pertence a esta auditoria/captura.');
  return read;
}

export async function readReport(baseDir: string, auditId: string, n: number, revision: number, options: StoreOptions = {}): Promise<EvidenceResult<ReportFile>> {
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const read = await readValidated<ReportFile>(options.fs ?? nodeFsOps, path.join(located.value.dir, reportName(n, revision)), MAX_AUX_BYTES, reportSchema);
  if (read.ok && (read.value.auditId !== auditId || read.value.captureNumber !== n || read.value.revision !== revision)) return fail('CORRUPT', 'O conteúdo não pertence a esta auditoria/revisão.');
  return read;
}

// ----------------------------------------------------------------------------------------- escrita
async function publish(ops: FsOps, loc: Location, finalName: string, tempStem: string, file: unknown, label: string): Promise<EvidenceResult<string>> {
  const finalPath = path.join(loc.dir, finalName);
  const tempPath = path.join(loc.dir, `.tmp-${tempStem}-${randomBytes(8).toString('hex')}.json`);
  const published = await publishExclusive(ops, { dir: loc.dir, finalPath, tempPath, data: serialize(file), label });
  if (published.ok) return { ok: true, value: finalPath };
  if (published.code === 'CONFLICT') return fail('CONFLICT', ...published.issues);
  return writeFailure(ops, loc.root, published.errno, published.issues);
}

export interface CaptureInput {
  readonly auditId: string;
  readonly collectedAt: string;
  readonly methodologyVersion?: string;
  readonly request: { readonly url: string; readonly body: Record<string, unknown> };
  readonly response: {
    readonly httpStatus: number | null;
    readonly attempts: number;
    /** Texto UTF-8 decodificado da resposta; `null` quando não houve corpo lido. */
    readonly bodyText: string | null;
    readonly failure?: string | null;
  };
  readonly input: { readonly snapshotId: string; readonly originalLink: string; readonly identity: Record<string, unknown> };
  /** Coleta SIMULADA do ensaio (W5.2b, spec do P1 §5.7): grava `provider: "SIMULATED"` e `simulated: true`, dentro do hash. */
  readonly simulated?: true;
}

export interface WrittenCapture {
  readonly captureNumber: number;
  readonly filePath: string;
  readonly contentSha256: string;
  /** `true` se uma captura com o mesmo corpo já existia: nada novo foi gravado. */
  readonly duplicate: boolean;
}

function creditsOf(bodyText: string | null): number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { credits?: unknown };
    return typeof parsed.credits === 'number' && Number.isFinite(parsed.credits) ? parsed.credits : null;
  } catch {
    return null;
  }
}

export async function writeCapture(baseDir: string, input: CaptureInput, options: StoreOptions = {}): Promise<EvidenceResult<WrittenCapture>> {
  const ops = options.fs ?? nodeFsOps;
  const located = locate(baseDir, input.auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  if (await isTripped(ops, located.value.root)) return fail('STORAGE_FATAL', 'Base bloqueada por erro fatal de disco anterior.');
  const body = input.response.bodyText;
  // Parte PRÓPRIA (pedido, entrada, falha): segredo aqui é erro nosso e bloqueia (o pré-voo já a varre antes de pagar).
  const ownText = JSON.stringify({ request: input.request, input: input.input, failure: input.response.failure ?? null });
  if (containsSecret(ownText, 'BROAD', options.apiKey)) {
    return fail('SECRET_DETECTED', 'O pedido ou a identidade parecem conter chave ou cabeçalho de autenticação; nada foi gravado.');
  }
  if (body !== null && Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) return fail('INVALID', 'Corpo da resposta acima de 2 MiB.');
  // Corpo do provedor: a resposta PAGA nunca é descartada por suspeita. A chave literal (se ecoada) é trocada por
  // [REDACTED]; padrão de autenticação em texto legítimo é só sinalizado.
  const flags: Array<'KEY_REDACTED' | 'AUTH_PATTERN_IN_BODY'> = [];
  let storedBody = body;
  const key = options.apiKey?.trim();
  if (storedBody !== null && key && key.length > 10 && storedBody.includes(key)) {
    storedBody = storedBody.split(key).join('[REDACTED]');
    flags.push('KEY_REDACTED');
  }
  if (storedBody !== null && AUTH_PATTERNS.test(storedBody)) flags.push('AUTH_PATTERN_IN_BODY');

  return withLock(await auditLockKey(ops, located.value, input.auditId), async () => {
    const state = await ensureDirectory(ops, located.value.dir, true);
    if (!state.ok) return state;
    const bodySha = storedBody === null ? null : sha256Hex(storedBody);
    const simulated = input.simulated === true;
    // W5.2b (revisão do PR #62): reserva/confere o MODO antes de numerar; o outro modo ⇒ MODE_CONFLICT nos dois sentidos (quem chama preserva a resposta paga)
    const mode = await reserveMode(located.value, input.auditId, simulated ? 'SIMULATED' : 'LIVE', { ...options, fs: ops });
    if (!mode.ok) return mode;
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      const listing = await listAuditFiles(ops, located.value.dir);
      if (!listing.ok) return listing;
      if (bodySha !== null || simulated) {
        for (const n of listing.value.captures) {
          const existing = await readCapture(baseDir, input.auditId, n, options);
          // uma captura SIMULADA nunca entra numa auditoria real (a resposta real paga, ao contrário, nunca é descartada: o pré-voo a barra antes de pagar)
          if (simulated && !existing.ok) return fail('INVALID', `A captura ${n} desta auditoria não pôde ser lida: a captura simulada (ensaio) não é gravada sem provar que não há mistura; nada foi gravado.`);
          if (simulated && existing.ok && !isSimulatedCapture(existing.value)) return fail('INVALID', 'Esta auditoria tem captura real: uma captura simulada (ensaio) não é misturada a ela; nada foi gravado.');
          if (bodySha !== null && existing.ok && existing.value.response.bodySha256 === bodySha) {
            return { ok: true, value: { captureNumber: n, filePath: path.join(located.value.dir, captureName(n)), contentSha256: existing.value.contentSha256, duplicate: true } };
          }
        }
      }
      const number = (listing.value.captures[listing.value.captures.length - 1] ?? 0) + 1;
      if (number > MAX_CAPTURE_NUMBER) return fail('WRITE_FAILED', `Limite de ${MAX_CAPTURE_NUMBER} capturas atingido.`);
      const file = sealed<CaptureFile>({
        schemaVersion: 1,
        kind: 'LINK_AUDIT_CAPTURE',
        auditId: input.auditId,
        captureNumber: number,
        methodologyVersion: input.methodologyVersion ?? METHODOLOGY_VERSION,
        collectedAt: input.collectedAt,
        provider: simulated ? SIMULATED_PROVIDER : 'serper-maps',
        ...(simulated ? { simulated: true as const } : {}),
        request: { method: 'POST', url: input.request.url, body: input.request.body },
        response: {
          httpStatus: input.response.httpStatus,
          attempts: input.response.attempts,
          bodyText: storedBody,
          bodySha256: bodySha,
          bytes: storedBody === null ? 0 : Buffer.byteLength(storedBody, 'utf8'),
          creditsReportedByApi: creditsOf(storedBody),
          failure: input.response.failure ?? null,
          ...(flags.length > 0 ? { flags } : {}),
        },
        input: { snapshotId: input.input.snapshotId, originalLink: input.input.originalLink, identity: input.input.identity },
      });
      if (!captureSchema.safeParse(file).success) return fail('SCHEMA', 'A captura não segue o formato esperado; nada foi gravado.');
      const written = await publish(ops, located.value, captureName(number), `c${pad(number)}`, file, `A captura ${number}`);
      if (!written.ok) {
        if (written.code === 'CONFLICT') continue; // outro processo ocupou o número: tenta o próximo
        return written;
      }
      const reread = await readCapture(baseDir, input.auditId, number, options);
      if (!reread.ok) return fail(reread.code, `A releitura da captura ${number} falhou: ${reread.issues.join(' ')}`);
      if (reread.value.contentSha256 !== file.contentSha256) return fail('HASH_MISMATCH', 'A releitura difere do que foi gravado.');
      return { ok: true, value: { captureNumber: number, filePath: written.value, contentSha256: file.contentSha256, duplicate: false } };
    }
    return fail('CONFLICT', 'Não foi possível reservar um número de captura (disputa persistente).');
  });
}

export async function writeSiteObservation(
  baseDir: string,
  auditId: string,
  captureNumber: number,
  outcome: Record<string, unknown>,
  observedAt: string,
  options: StoreOptions = {},
): Promise<EvidenceResult<{ readonly filePath: string; readonly contentSha256: string }>> {
  const ops = options.fs ?? nodeFsOps;
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  if (await isTripped(ops, located.value.root)) return fail('STORAGE_FATAL', 'Base bloqueada por erro fatal de disco anterior.');
  const capture = await readCapture(baseDir, auditId, captureNumber, options);
  if (!capture.ok) return capture;
  if (containsSecret(JSON.stringify(outcome), 'BROAD', options.apiKey)) return fail('SECRET_DETECTED', 'A observação do site parece conter segredo; nada foi gravado.');
  const file = sealed<SiteFile>({ schemaVersion: 1, kind: 'LINK_AUDIT_SITE_OBSERVATION', auditId, captureNumber, captureSha256: capture.value.contentSha256, observedAt, outcome });
  if (!siteSchema.safeParse(file).success) return fail('SCHEMA', 'A observação do site não segue o formato esperado.');
  return withLock(path.join(located.value.dir, 'site'), async () => {
    const written = await publish(ops, located.value, siteName(captureNumber), `c${pad(captureNumber)}-site`, file, `A observação do site da captura ${captureNumber}`);
    if (!written.ok) return written;
    const reread = await readSite(baseDir, auditId, captureNumber, options);
    if (!reread.ok || reread.value.contentSha256 !== file.contentSha256) return fail('HASH_MISMATCH', 'A releitura da observação do site não confere.');
    return { ok: true, value: { filePath: written.value, contentSha256: file.contentSha256 } };
  });
}

export async function writeReport(
  baseDir: string,
  auditId: string,
  captureNumber: number,
  report: Record<string, unknown>,
  generatedAt: string,
  options: StoreOptions = {},
): Promise<EvidenceResult<{ readonly revision: number; readonly filePath: string; readonly contentSha256: string }>> {
  const ops = options.fs ?? nodeFsOps;
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  if (await isTripped(ops, located.value.root)) return fail('STORAGE_FATAL', 'Base bloqueada por erro fatal de disco anterior.');
  const capture = await readCapture(baseDir, auditId, captureNumber, options);
  if (!capture.ok) return capture;
  const site = await readSite(baseDir, auditId, captureNumber, options);
  if (!site.ok && site.code !== 'NOT_FOUND') return site;
  if (containsSecret(JSON.stringify(report), 'BROAD', options.apiKey)) return fail('SECRET_DETECTED', 'O relatório parece conter segredo; nada foi gravado.');
  return withLock(path.join(located.value.dir, `report-${captureNumber}`), async () => {
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      const listing = await listAuditFiles(ops, located.value.dir);
      if (!listing.ok) return listing;
      const revision = Math.max(0, ...listing.value.reports.filter((r) => r.capture === captureNumber).map((r) => r.revision)) + 1;
      const file = sealed<ReportFile>({
        schemaVersion: 1,
        kind: 'LINK_AUDIT_REPORT',
        auditId,
        captureNumber,
        revision,
        methodologyVersion: capture.value.methodologyVersion,
        generatedAt,
        captureSha256: capture.value.contentSha256,
        siteSha256: site.ok ? site.value.contentSha256 : null,
        report,
      });
      if (!reportSchema.safeParse(file).success) return fail('SCHEMA', 'O relatório não segue o formato esperado.');
      const written = await publish(ops, located.value, reportName(captureNumber, revision), `c${pad(captureNumber)}-r${pad(revision)}`, file, `A revisão ${revision} do relatório`);
      if (!written.ok) {
        if (written.code === 'CONFLICT') continue;
        return written;
      }
      const reread = await readReport(baseDir, auditId, captureNumber, revision, options);
      if (!reread.ok || reread.value.contentSha256 !== file.contentSha256) return fail('HASH_MISMATCH', 'A releitura do relatório não confere.');
      return { ok: true, value: { revision, filePath: written.value, contentSha256: file.contentSha256 } };
    }
    return fail('CONFLICT', 'Não foi possível reservar uma revisão de relatório (disputa persistente).');
  });
}

// ---------------------------------------------------------------------------------------- verificação
export type AuditState = 'COMPLETE' | 'INCOMPLETE' | 'CORRUPT';

export interface AuditVerification {
  readonly state: AuditState;
  readonly captures: readonly number[];
  readonly reports: readonly { readonly capture: number; readonly revision: number }[];
  readonly issues: readonly string[];
  readonly orphanTempFiles: readonly string[];
}

/** Relê tudo: hashes, números sem lacunas, vínculo relatório↔captura↔site. COMPLETE = ao menos uma captura com relatório, sem problemas. */
export async function verifyAudit(baseDir: string, auditId: string, options: StoreOptions = {}): Promise<EvidenceResult<AuditVerification>> {
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const ops = options.fs ?? nodeFsOps;
  const listing = await listAuditFiles(ops, located.value.dir);
  if (!listing.ok) return listing;
  const issues: string[] = [];
  const { captures, sites, reports } = listing.value;
  captures.forEach((n, i) => {
    if (n !== i + 1) issues.push(`Lacuna na numeração das capturas (esperado ${i + 1}, achado ${n}).`);
  });
  const hashes = new Map<number, string>();
  for (const n of captures) {
    const c = await readCapture(baseDir, auditId, n, options);
    if (!c.ok) issues.push(`Captura ${n}: ${c.issues.join(' ')}`);
    else hashes.set(n, c.value.contentSha256);
  }
  for (const n of sites) {
    const s = await readSite(baseDir, auditId, n, options);
    if (!s.ok) issues.push(`Observação do site ${n}: ${s.issues.join(' ')}`);
    else if (s.value.captureSha256 !== hashes.get(n)) issues.push(`Observação do site ${n} não pertence à captura registrada.`);
    if (!captures.includes(n)) issues.push(`Observação do site ${n} sem captura correspondente.`);
  }
  for (const r of reports) {
    const f = await readReport(baseDir, auditId, r.capture, r.revision, options);
    if (!f.ok) issues.push(`Relatório ${r.capture}/r${r.revision}: ${f.issues.join(' ')}`);
    else if (f.value.captureSha256 !== hashes.get(r.capture)) issues.push(`Relatório ${r.capture}/r${r.revision} não pertence à captura registrada.`);
  }
  const state: AuditState = issues.length > 0 ? 'CORRUPT' : captures.length > 0 && reports.length > 0 ? 'COMPLETE' : 'INCOMPLETE';
  return { ok: true, value: { state, captures, reports, issues, orphanTempFiles: listing.value.orphanTempFiles } };
}

/** Remove SOMENTE temporários órfãos do padrão `.tmp-…` com idade mínima (nunca capturas, observações ou relatórios). */
export async function cleanupOrphans(
  baseDir: string,
  auditId: string,
  options: StoreOptions & { readonly now: Date; readonly olderThanMs: number },
): Promise<EvidenceResult<readonly string[]>> {
  const located = locate(baseDir, auditId, options.projectRoot ?? process.cwd());
  if (!located.ok) return located;
  const ops = options.fs ?? nodeFsOps;
  if (await isTripped(ops, located.value.root)) return fail('STORAGE_FATAL', 'Base bloqueada por erro fatal de disco anterior.');
  const minAge = Math.max(options.olderThanMs, MIN_ORPHAN_AGE_MS); // nunca apaga o temporário de uma gravação em curso
  return withLock(path.join(await baseKey(ops, located.value.root), auditId), async (): Promise<EvidenceResult<readonly string[]>> => {
    const listing = await listAuditFiles(ops, located.value.dir);
    if (!listing.ok) return listing;
    const removed: string[] = [];
    for (const name of listing.value.orphanTempFiles) {
      const target = path.join(located.value.dir, name);
      try {
        const info = await ops.lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (options.now.getTime() - info.mtimeMs < minAge) continue;
        await ops.unlink(target);
        removed.push(name);
      } catch (error) {
        return writeFailure(ops, located.value.root, errorCode(error), [describeError(`limpeza de ${name}`, error)]);
      }
    }
    return { ok: true, value: removed };
  });
}
