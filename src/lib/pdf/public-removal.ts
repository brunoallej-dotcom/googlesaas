import fs from 'node:fs/promises';
import path from 'node:path';
import { baseName, sha256, verifyBackup, type BackupManifest, type StoragePort } from './migration';

/**
 * (G4) Remoção dos PDFs históricos de `public/audits`.
 *
 * SEM exclusão genérica: os alvos vêm do manifesto do backup (um por auditoria), cada caminho é
 * recalculado como `public/audits/<nome>` e validado; a remoção é `fs.unlink` de UM arquivo por vez
 * (nunca `rm -r`, nunca glob, nunca a pasta). Cada arquivo só é removido se o SHA-256 for idêntico em
 * 5 lugares: manifesto, cópia em `.data/audits`, objeto no bucket privado, backup local e backup externo.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}\.pdf$/i;

export interface ExternalHash {
  readonly sha256: string;
  readonly size: number;
  readonly relativePath: string;
}

/** Linhas `<sha256> <tamanho> <caminho/relativo>` (a saída do PowerShell/sha256sum normalizada). */
export function parseExternalHashes(text: string): ExternalHash[] {
  const out: ExternalHash[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+(\d+)\s+(.+)$/i.exec(line.trim());
    if (match) out.push({ sha256: match[1]!.toLowerCase(), size: Number(match[2]), relativePath: match[3]!.replace(/\\/g, '/') });
  }
  return out;
}

export function verifyExternalBackup(manifest: BackupManifest, hashes: readonly ExternalHash[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (hashes.length === 0) problems.push('nenhum hash da cópia externa foi informado');
  for (const file of manifest.files) {
    const found = hashes.find((h) => h.relativePath === file.backupPath.replace(/\\/g, '/'));
    if (!found) problems.push(`cópia externa sem o arquivo ${file.backupPath}`);
    else if (found.sha256 !== file.sha256 || found.size !== file.size) problems.push(`cópia externa diferente do manifesto: ${file.backupPath}`);
  }
  return { ok: problems.length === 0, problems };
}

export interface RemovalTarget {
  readonly auditId: string;
  readonly fileName: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly modifiedAt: string;
  /** Onde o MESMO conteúdo (mesmo SHA-256) foi confirmado. */
  readonly confirmedIn: readonly string[];
}

export interface RemovalPlan {
  readonly ok: boolean;
  readonly problems: string[];
  readonly targets: RemovalTarget[];
  /** Arquivos que já não existem (execução repetida): ignorados, não são erro. */
  readonly alreadyRemoved: string[];
  /** Outros arquivos da pasta que NÃO estão no manifesto: nunca são tocados. */
  readonly untouched: string[];
}

export async function planPublicRemoval(params: {
  readonly manifest: BackupManifest;
  readonly backupDir: string;
  readonly publicDir: string;
  readonly privateDir: string;
  readonly storage: StoragePort;
  readonly privateBucket: string;
  readonly externalHashes: readonly ExternalHash[];
}): Promise<RemovalPlan> {
  const { manifest, publicDir, privateDir, storage, privateBucket } = params;
  const problems: string[] = [];
  const targets: RemovalTarget[] = [];
  const alreadyRemoved: string[] = [];
  const resolvedPublic = path.resolve(publicDir);

  const local = await verifyBackup(params.backupDir);
  if (!local.ok) problems.push(...local.problems.map((p) => `backup local: ${p}`));
  const external = verifyExternalBackup(manifest, params.externalHashes);
  if (!external.ok) problems.push(...external.problems);

  for (const item of manifest.inventory.items) {
    if (!item.local) continue;
    const name = item.fileName;
    if (!SAFE_NAME.test(name) || name !== baseName(name)) { problems.push(`${item.auditId}: nome de arquivo fora do padrão seguro (${name})`); continue; }
    const target = path.join(resolvedPublic, name);
    if (path.dirname(target) !== resolvedPublic) { problems.push(`${name}: caminho fora de public/audits`); continue; }

    const stat = await fs.lstat(target).catch(() => null);
    if (!stat) { alreadyRemoved.push(name); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { problems.push(`${name}: não é um arquivo regular (link ou diretório)`); continue; }

    const bytes = await fs.readFile(target);
    const confirmedIn: string[] = ['public/audits'];
    const check = async (label: string, other: Buffer | null | undefined): Promise<void> => {
      if (!other) problems.push(`${name}: cópia ausente em ${label}`);
      else if (sha256(other) !== item.local!.sha256) problems.push(`${name}: SHA-256 diferente em ${label}`);
      else confirmedIn.push(label);
    };
    if (sha256(bytes) !== item.local.sha256 || bytes.byteLength !== item.local.size) problems.push(`${name}: SHA-256/tamanho de public/audits difere do manifesto`);
    else confirmedIn.push('manifesto');
    await check('.data/audits', await fs.readFile(path.join(privateDir, name)).catch(() => null));
    await check(`bucket privado ${privateBucket}`, await storage.download(privateBucket, `audits/${item.auditId}/${name}`));
    await check('backup local', await fs.readFile(path.join(params.backupDir, 'public-audits', name)).catch(() => null));
    if (external.ok) confirmedIn.push('backup externo');

    targets.push({ auditId: item.auditId, fileName: name, path: target, size: bytes.byteLength, sha256: sha256(bytes), modifiedAt: stat.mtime.toISOString(), confirmedIn });
  }

  const planned = new Set([...targets.map((t) => t.fileName), ...alreadyRemoved]);
  const untouched = (await fs.readdir(resolvedPublic).catch(() => [])).filter((f) => !planned.has(f));
  return { ok: problems.length === 0, problems, targets, alreadyRemoved, untouched };
}

export interface RemovalResult {
  readonly removed: string[];
  readonly failed: string | null;
}

/**
 * Remove UM arquivo por vez; para na primeira falha. Antes de cada `unlink` recalcula o SHA-256
 * (evita remover algo que mudou depois do plano) e depois confirma que o arquivo não existe mais.
 */
export async function executePublicRemoval(
  plan: RemovalPlan,
  deps: { readonly unlink?: (file: string) => Promise<void>; readonly beforeStart?: (plan: RemovalPlan) => Promise<void> } = {}
): Promise<RemovalResult> {
  if (!plan.ok) throw new Error('Plano de remoção reprovado: nada será removido.');
  const unlink = deps.unlink ?? ((file: string) => fs.unlink(file));
  await deps.beforeStart?.(plan); // o inventário exato é gravado ANTES de excluir
  const removed: string[] = [];
  for (const target of plan.targets) {
    try {
      const stat = await fs.lstat(target.path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('deixou de ser um arquivo regular');
      if (sha256(await fs.readFile(target.path)) !== target.sha256) throw new Error('o conteúdo mudou depois do plano');
      await unlink(target.path);
      if (await fs.lstat(target.path).then(() => true, () => false)) throw new Error('o arquivo ainda existe depois de remover');
      removed.push(target.fileName);
    } catch (error: unknown) {
      return { removed, failed: `${target.fileName}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { removed, failed: null };
}
