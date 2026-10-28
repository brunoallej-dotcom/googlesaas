import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashRows } from '@/lib/recovery-validation';
import { sha256, type StoragePort } from './migration';

/**
 * "Foto" do que NÃO pode mudar durante o G1: linhas das tabelas, arquivos de public/audits, objetos
 * e visibilidade do bucket antigo e o `.env.local`. Antes e depois são comparadas; só entradas
 * dos novos destinos (bucket privado e `.data/audits`) podem aparecer ou mudar.
 */
export interface MigrationSnapshot {
  readonly takenAt: string;
  readonly entries: Readonly<Record<string, string>>;
}

export const SNAPSHOT_TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'] as const;

export async function takeMigrationSnapshot(params: {
  readonly readTable: (table: string) => Promise<readonly Record<string, unknown>[]>;
  readonly storage: StoragePort;
  readonly sourceBucket: string;
  readonly privateBucket?: string;
  readonly publicDir: string;
  readonly privateDir: string;
  readonly envFile: string;
  readonly now?: Date;
}): Promise<MigrationSnapshot> {
  const entries: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = await params.readTable(table);
    entries[`db/${table}`] = `${rows.length}:${hashRows(rows as Record<string, unknown>[])}`;
  }
  const listDir = async (dir: string): Promise<string[]> => (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.pdf')).sort();
  for (const file of await listDir(params.publicDir)) entries[`public-audits/${file}`] = sha256(await fs.readFile(path.join(params.publicDir, file)));
  for (const file of await listDir(params.privateDir)) entries[`private-dir/${file}`] = sha256(await fs.readFile(path.join(params.privateDir, file)));

  const source = await params.storage.getBucket(params.sourceBucket);
  entries[`bucket-source/${params.sourceBucket}/public`] = String(source?.public ?? 'ausente');
  for (const object of await params.storage.listObjects(params.sourceBucket)) {
    const bytes = await params.storage.download(params.sourceBucket, object.key);
    entries[`bucket-source/${params.sourceBucket}/${object.key}`] = bytes ? sha256(bytes) : 'ilegível';
  }
  if (params.privateBucket) {
    const target = await params.storage.getBucket(params.privateBucket);
    entries[`private-bucket/${params.privateBucket}/public`] = String(target?.public ?? 'ausente');
    if (target) {
      for (const object of await params.storage.listObjects(params.privateBucket)) {
        const bytes = await params.storage.download(params.privateBucket, object.key);
        entries[`private-bucket/${params.privateBucket}/${object.key}`] = bytes ? sha256(bytes) : 'ilegível';
      }
    }
  }
  entries['env/.env.local'] = crypto.createHash('sha256').update(await fs.readFile(params.envFile).catch(() => Buffer.alloc(0))).digest('hex');
  return { takenAt: (params.now ?? new Date()).toISOString(), entries };
}

export interface SnapshotDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
  /** Mudanças fora dos destinos permitidos: qualquer uma reprova o G1. */
  readonly unexpected: string[];
}

export function diffSnapshots(before: MigrationSnapshot, after: MigrationSnapshot, allowedPrefixes: readonly string[]): SnapshotDiff {
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    const was = before.entries[key];
    const now = after.entries[key];
    if (was === undefined) added.push(key);
    else if (now === undefined) removed.push(key);
    else if (was !== now) changed.push(key);
  }
  const allowed = (key: string): boolean => allowedPrefixes.some((prefix) => key.startsWith(prefix));
  return { added, removed, changed, unexpected: [...added, ...removed, ...changed].filter((key) => !allowed(key)) };
}
