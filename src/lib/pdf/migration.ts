import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Migração dos PDFs históricos para armazenamento privado. Lógica pura sobre portas injetáveis,
 * para testar sem Supabase real.
 *
 * GARANTIAS DE PROJETO
 *  - Não existe NENHUM caminho de exclusão aqui (nem de arquivo, nem de objeto, nem de bucket).
 *  - Nada é sobrescrito: cópias usam `wx`/`upsert: false`.
 *  - `inventory` e `backup` não escrevem em produção (o backup escreve só em disco local).
 *  - As fases que alteram produção (`copy`, `pointers`, `close-public`, `rollback`) só são chamadas
 *    pelo CLI com `--apply` e confirmação digitada.
 */
export const sha256 = (data: Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex');

export interface BucketObject {
  readonly key: string;
  readonly size: number | null;
}

export interface StoragePort {
  listObjects(bucket: string): Promise<readonly BucketObject[]>;
  download(bucket: string, key: string): Promise<Buffer | null>;
  upload(bucket: string, key: string, body: Buffer): Promise<'uploaded' | 'exists' | { readonly error: string }>;
  getBucket(bucket: string): Promise<{ readonly public: boolean; readonly fileSizeLimit?: number | null; readonly allowedMimeTypes?: readonly string[] | null } | null>;
  createPrivateBucket(bucket: string): Promise<void>;
  setBucketPublic(bucket: string, isPublic: boolean): Promise<void>;
  /** Status HTTP de uma requisição SEM credencial à URL pública do objeto. */
  headPublic(bucket: string, key: string): Promise<number>;
}

export interface AuditPointerRow {
  readonly id: string;
  readonly pdf_storage_path: string | null;
  readonly pdf_download_url: string | null;
  readonly diagrammer_payload: Record<string, unknown> | null;
}

export interface DatabasePort {
  listAuditsWithPdf(): Promise<readonly AuditPointerRow[]>;
  /**
   * Atualiza UMA linha. Com `expected`, o UPDATE é condicional (compare-and-set: só altera se os
   * ponteiros ainda forem os esperados). Devolve `true` somente se EXATAMENTE 1 linha foi alterada.
   */
  updatePointers(
    auditId: string,
    values: { pdf_storage_path: string; pdf_download_url: string; diagrammer_payload: Record<string, unknown> | null },
    expected?: { pdf_storage_path: string | null; pdf_download_url: string | null }
  ): Promise<boolean>;
}

export interface InventoryItem {
  readonly auditId: string;
  readonly fileName: string;
  readonly dbStoragePath: string | null;
  readonly dbDownloadUrl: string | null;
  readonly local: { readonly path: string; readonly size: number; readonly sha256: string } | null;
  readonly bucket: { readonly key: string; readonly size: number; readonly sha256: string; readonly publicHttpStatus: number } | null;
  /** `true`/`false` quando os dois lados existem; `null` quando só um existe. */
  readonly sameContent: boolean | null;
}

export interface Inventory {
  readonly generatedAt: string;
  readonly sourceBucket: string;
  readonly sourceBucketPublic: boolean | null;
  readonly items: readonly InventoryItem[];
  readonly orphanBucketObjects: readonly string[];
  readonly summary: {
    readonly audits: number;
    readonly localFiles: number;
    readonly bucketObjects: number;
    readonly publiclyReachable: number;
    readonly divergent: number;
    readonly totalBytes: number;
  };
}

export const baseName = (value: string): string => value.split(/[\\/]/).pop() ?? '';

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** Inventário SOMENTE LEITURA do que está público: arquivos de `public/audits` e objetos do bucket. */
export async function buildInventory(params: {
  readonly storage: StoragePort;
  readonly database: DatabasePort;
  readonly sourceBucket: string;
  readonly publicDir: string;
  readonly now?: Date;
}): Promise<Inventory> {
  const { storage, database, sourceBucket, publicDir } = params;
  const [rows, objects, bucketInfo] = await Promise.all([
    database.listAuditsWithPdf(),
    storage.listObjects(sourceBucket),
    storage.getBucket(sourceBucket),
  ]);
  const seen = new Set<string>();
  const items: InventoryItem[] = [];
  let totalBytes = 0;

  for (const row of rows) {
    const fileName = baseName(row.pdf_storage_path ?? '') || baseName(String(row.diagrammer_payload?.pdfFileName ?? ''));
    if (!fileName) continue;
    const localPath = path.join(publicDir, fileName);
    const localBytes = await readIfExists(localPath);
    const object = objects.find((o) => o.key.startsWith(`audits/${row.id}/`) && baseName(o.key) === fileName)
      ?? objects.find((o) => o.key.startsWith(`audits/${row.id}/`));
    let bucketItem: InventoryItem['bucket'] = null;
    if (object) {
      seen.add(object.key);
      const bytes = await storage.download(sourceBucket, object.key);
      if (bytes) {
        totalBytes += bytes.byteLength;
        bucketItem = { key: object.key, size: bytes.byteLength, sha256: sha256(bytes), publicHttpStatus: await storage.headPublic(sourceBucket, object.key) };
      }
    }
    if (localBytes) totalBytes += localBytes.byteLength;
    const local = localBytes ? { path: localPath, size: localBytes.byteLength, sha256: sha256(localBytes) } : null;
    items.push({
      auditId: row.id,
      fileName,
      dbStoragePath: row.pdf_storage_path,
      dbDownloadUrl: row.pdf_download_url,
      local,
      bucket: bucketItem,
      sameContent: local && bucketItem ? local.sha256 === bucketItem.sha256 : null,
    });
  }

  return {
    generatedAt: (params.now ?? new Date()).toISOString(),
    sourceBucket,
    sourceBucketPublic: bucketInfo ? bucketInfo.public : null,
    items,
    orphanBucketObjects: objects.filter((o) => !seen.has(o.key)).map((o) => o.key),
    summary: {
      audits: items.length,
      localFiles: items.filter((i) => i.local).length,
      bucketObjects: items.filter((i) => i.bucket).length,
      publiclyReachable: items.filter((i) => i.bucket?.publicHttpStatus === 200).length,
      divergent: items.filter((i) => i.sameContent === false).length,
      totalBytes,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Backup local (nenhuma escrita em produção)                                  */
/* -------------------------------------------------------------------------- */

export interface BackupManifest {
  readonly kind: 'gmn-pdf-migration-backup';
  readonly createdAt: string;
  readonly inventory: Inventory;
  readonly files: readonly { readonly origin: 'public/audits' | 'bucket'; readonly source: string; readonly backupPath: string; readonly sha256: string; readonly size: number }[];
  /** Valores originais dos ponteiros no banco, para reversão. */
  readonly databaseSnapshot: readonly AuditPointerRow[];
  /** Preenchido pelas fases de aplicação, para o `rollback`. */
  readonly applied: { copied: string[]; pointersUpdated: string[]; closedBuckets: string[] };
}

export async function runBackup(params: {
  readonly storage: StoragePort;
  readonly database: DatabasePort;
  readonly inventory: Inventory;
  readonly backupDir: string;
}): Promise<BackupManifest> {
  const { storage, inventory, backupDir } = params;
  const files: BackupManifest['files'][number][] = [];
  const write = async (origin: 'public/audits' | 'bucket', source: string, relative: string, bytes: Buffer): Promise<void> => {
    const target = path.join(backupDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' }); // nunca sobrescreve
    const check = await fs.readFile(target);
    if (sha256(check) !== sha256(bytes)) throw new Error(`Backup corrompido em ${target}`);
    files.push({ origin, source, backupPath: relative, sha256: sha256(bytes), size: bytes.byteLength });
  };

  for (const item of inventory.items) {
    if (item.local) await write('public/audits', item.local.path, path.join('public-audits', item.fileName), await fs.readFile(item.local.path));
    if (item.bucket) {
      const bytes = await storage.download(inventory.sourceBucket, item.bucket.key);
      if (!bytes) throw new Error(`Objeto ${item.bucket.key} não pôde ser baixado para o backup.`);
      await write('bucket', `${inventory.sourceBucket}/${item.bucket.key}`, path.join('bucket', item.bucket.key), bytes);
    }
  }
  const manifest: BackupManifest = {
    kind: 'gmn-pdf-migration-backup',
    createdAt: new Date().toISOString(),
    inventory,
    files,
    databaseSnapshot: await params.database.listAuditsWithPdf(),
    applied: { copied: [], pointersUpdated: [], closedBuckets: [] },
  };
  await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

/* -------------------------------------------------------------------------- */
/* Fases que ALTERAM produção (só com --apply + confirmação)                   */
/* -------------------------------------------------------------------------- */

export interface CopyOperation {
  readonly auditId: string;
  readonly kind: 'official-to-private-bucket' | 'older-bucket-version-to-private-bucket' | 'official-to-private-dir';
  readonly target: string;
}

/** Descreve o que a fase `copy` faria (usada também no modo simulação). */
export function planCopy(inventory: Inventory, privateBucket: string, privateDir: string): CopyOperation[] {
  const operations: CopyOperation[] = [];
  for (const item of inventory.items) {
    const official = item.local ?? null;
    const bucketVersion = item.bucket ?? null;
    if (official) {
      operations.push({ auditId: item.auditId, kind: 'official-to-private-dir', target: path.join(privateDir, item.fileName) });
      operations.push({ auditId: item.auditId, kind: 'official-to-private-bucket', target: `${privateBucket}/audits/${item.auditId}/${item.fileName}` });
    }
    // Quando o bucket guarda uma versão DIFERENTE da oficial, ela é preservada à parte (nunca descartada).
    if (bucketVersion && (!official || item.sameContent === false)) {
      operations.push({ auditId: item.auditId, kind: 'older-bucket-version-to-private-bucket', target: `${privateBucket}/audits/${item.auditId}/versao-anterior-do-bucket/${item.fileName}` });
    }
  }
  return operations;
}

export async function applyCopy(params: {
  readonly storage: StoragePort;
  readonly inventory: Inventory;
  readonly manifest: BackupManifest;
  readonly privateBucket: string;
  readonly privateDir: string;
}): Promise<{ uploaded: number; existing: number; failures: string[] }> {
  const { storage, inventory, manifest, privateBucket, privateDir } = params;
  if (privateBucket === inventory.sourceBucket) throw new Error('O bucket privado não pode ser o bucket público de origem.');
  const existing = await storage.getBucket(privateBucket);
  if (existing?.public) throw new Error(`O bucket ${privateBucket} é PÚBLICO: recuso copiar PDFs para ele.`);
  if (!existing) await storage.createPrivateBucket(privateBucket);

  const result = { uploaded: 0, existing: 0, failures: [] as string[] };
  await fs.mkdir(privateDir, { recursive: true });
  for (const item of inventory.items) {
    if (item.local) {
      const bytes = await fs.readFile(item.local.path);
      try {
        await fs.writeFile(path.join(privateDir, item.fileName), bytes, { flag: 'wx' });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await fs.readFile(path.join(privateDir, item.fileName));
        if (sha256(current) !== item.local.sha256) result.failures.push(`${item.fileName}: já existe em ${privateDir} com conteúdo diferente (não sobrescrito)`);
      }
      const key = `audits/${item.auditId}/${item.fileName}`;
      const outcome = await storage.upload(privateBucket, key, bytes);
      if (outcome === 'uploaded') { result.uploaded++; manifest.applied.copied.push(`${privateBucket}/${key}`); }
      else if (outcome === 'exists') result.existing++;
      else result.failures.push(`${key}: ${outcome.error}`);
    }
    if (item.bucket && (!item.local || item.sameContent === false)) {
      const bytes = await storage.download(inventory.sourceBucket, item.bucket.key);
      if (!bytes) { result.failures.push(`${item.bucket.key}: não foi possível baixar do bucket de origem`); continue; }
      const key = `audits/${item.auditId}/versao-anterior-do-bucket/${item.fileName}`;
      const outcome = await storage.upload(privateBucket, key, bytes);
      if (outcome === 'uploaded') { result.uploaded++; manifest.applied.copied.push(`${privateBucket}/${key}`); }
      else if (outcome === 'exists') result.existing++;
      else result.failures.push(`${key}: ${outcome.error}`);
    }
  }
  return result;
}

/** Confere por SHA-256 que cada cópia privada é idêntica à origem. */
export async function verifyCopies(params: {
  readonly storage: StoragePort;
  readonly inventory: Inventory;
  readonly privateBucket: string;
  readonly privateDir: string;
}): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const item of params.inventory.items) {
    if (!item.local) continue;
    const dirCopy = await readIfExists(path.join(params.privateDir, item.fileName));
    if (!dirCopy || sha256(dirCopy) !== item.local.sha256) problems.push(`${item.fileName}: cópia na pasta privada ausente ou diferente`);
    const bucketCopy = await params.storage.download(params.privateBucket, `audits/${item.auditId}/${item.fileName}`);
    if (!bucketCopy || sha256(bucketCopy) !== item.local.sha256) problems.push(`${item.fileName}: cópia no bucket privado ausente ou diferente`);
  }
  // Versões históricas distintas do bucket de origem devem existir, idênticas, na área de versões anteriores.
  for (const item of params.inventory.items) {
    if (!item.bucket || (item.local && item.sameContent !== false)) continue;
    const older = await params.storage.download(params.privateBucket, `audits/${item.auditId}/versao-anterior-do-bucket/${item.fileName}`);
    if (!older || sha256(older) !== item.bucket.sha256) problems.push(`${item.fileName}: versão anterior do bucket ausente ou diferente na cópia privada`);
  }
  return { ok: problems.length === 0, problems };
}

/** Referência PERMANENTE aceita: só a rota relativa protegida. Nunca URL pública nem assinada. */
export function permanentRouteUrl(auditId: string): string {
  return `/api/audit/${auditId}/pdf`;
}

const ROUTE_URL = /^\/api\/audit\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/pdf$/i;

export function assertPermanentRouteUrl(auditId: string, url: string): void {
  if (!ROUTE_URL.test(url) || url !== permanentRouteUrl(auditId) || /https?:|supabase|token=|signed|sign\//i.test(url)) {
    throw new Error(`Referência recusada para ${auditId}: só a rota /api/audit/<id>/pdf é permitida (nunca URL pública ou assinada). Recebido: ${url}`);
  }
}

export interface PointerChange {
  readonly auditId: string;
  readonly before: { readonly pdf_storage_path: string | null; readonly pdf_download_url: string | null; readonly diagrammer_payload: Record<string, unknown> | null };
  readonly after: { readonly pdf_storage_path: string; readonly pdf_download_url: string; readonly diagrammer_payload: Record<string, unknown> | null };
}

/** Valores novos de cada linha: só os ponteiros mudam; as demais chaves do payload ficam iguais. */
export function planPointerChanges(rows: readonly AuditPointerRow[], privateDir: string): PointerChange[] {
  const changes: PointerChange[] = [];
  for (const row of rows) {
    const name = baseName(row.pdf_storage_path ?? '') || baseName(String(row.diagrammer_payload?.pdfFileName ?? ''));
    if (!name) continue;
    const storagePath = path.join(privateDir, name);
    const downloadUrl = permanentRouteUrl(row.id);
    assertPermanentRouteUrl(row.id, downloadUrl);
    changes.push({
      auditId: row.id,
      before: { pdf_storage_path: row.pdf_storage_path, pdf_download_url: row.pdf_download_url, diagrammer_payload: row.diagrammer_payload },
      after: {
        pdf_storage_path: storagePath,
        pdf_download_url: downloadUrl,
        diagrammer_payload: row.diagrammer_payload ? { ...row.diagrammer_payload, pdfStoragePath: storagePath, pdfDownloadUrl: downloadUrl } : null,
      },
    });
  }
  return changes;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * (G3) Aponta os históricos para a rota autenticada. Proteções: as linhas atuais precisam ser
 * IDÊNTICAS ao snapshot do backup; cada UPDATE é condicional e altera exatamente 1 linha; na primeira
 * falha as linhas já alteradas são restauradas a partir do snapshot. Linhas já no valor final são puladas.
 */
export async function applyPointers(params: {
  readonly database: DatabasePort;
  readonly manifest: BackupManifest;
  readonly privateDir: string;
}): Promise<number> {
  const { database, manifest, privateDir } = params;
  const live = await database.listAuditsWithPdf();
  for (const snapshot of manifest.databaseSnapshot) {
    const now = live.find((row) => row.id === snapshot.id);
    if (!now) throw new Error(`Divergência: a auditoria ${snapshot.id} não existe mais no banco.`);
    const alreadyDone = now.pdf_download_url === permanentRouteUrl(snapshot.id);
    if (!alreadyDone && (now.pdf_storage_path !== snapshot.pdf_storage_path || now.pdf_download_url !== snapshot.pdf_download_url || !sameJson(now.diagrammer_payload, snapshot.diagrammer_payload))) {
      throw new Error(`Divergência: a linha ${snapshot.id} mudou desde o backup; nada foi escrito.`);
    }
  }
  const finished = new Set(live.filter((row) => row.pdf_download_url === permanentRouteUrl(row.id) && row.pdf_storage_path !== null && baseName(row.pdf_storage_path) !== '' && path.dirname(row.pdf_storage_path) === path.normalize(privateDir)).map((row) => row.id));
  const changes = planPointerChanges(manifest.databaseSnapshot, privateDir).filter((change) => !finished.has(change.auditId));
  const done: PointerChange[] = [];
  try {
    for (const change of changes) {
      const ok = await database.updatePointers(change.auditId, change.after, { pdf_storage_path: change.before.pdf_storage_path, pdf_download_url: change.before.pdf_download_url });
      if (!ok) throw new Error(`UPDATE condicional não alterou exatamente 1 linha em ${change.auditId}.`);
      done.push(change);
      manifest.applied.pointersUpdated.push(change.auditId);
    }
  } catch (error: unknown) {
    // Compensação: devolve as linhas já alteradas ao valor original (condicional ao valor novo).
    for (const change of done.reverse()) {
      await database.updatePointers(
        change.auditId,
        { pdf_storage_path: change.before.pdf_storage_path ?? '', pdf_download_url: change.before.pdf_download_url ?? '', diagrammer_payload: change.before.diagrammer_payload },
        { pdf_storage_path: change.after.pdf_storage_path, pdf_download_url: change.after.pdf_download_url }
      ).catch(() => false);
      manifest.applied.pointersUpdated = manifest.applied.pointersUpdated.filter((id) => id !== change.auditId);
    }
    throw new Error(`G3 revertido automaticamente (${done.length} linha(s) restauradas): ${error instanceof Error ? error.message : String(error)}`);
  }
  return done.length;
}

/** Fecha o bucket de origem (public=false). NÃO apaga nada; reversível por `rollback`. */
export async function closePublicBucket(params: { readonly storage: StoragePort; readonly manifest: BackupManifest; readonly bucket: string }): Promise<void> {
  await params.storage.setBucketPublic(params.bucket, false);
  params.manifest.applied.closedBuckets.push(params.bucket);
}

/**
 * Reversão por ESCOPO (nunca desfaz uma etapa que você não pediu):
 *  - `pointers`: restaura os ponteiros do banco (G3) a partir do snapshot do backup;
 *  - `buckets`: reabre os buckets fechados (G2), o que TORNA OS LINKS PÚBLICOS ANTIGOS ATIVOS de novo;
 *  - `all`: os dois.
 * Cópias e arquivos NÃO são apagados.
 */
export async function rollback(params: {
  readonly storage: StoragePort;
  readonly database: DatabasePort;
  readonly manifest: BackupManifest;
  readonly scope: 'pointers' | 'buckets' | 'all';
}): Promise<{ pointersRestored: number; bucketsReopened: string[] }> {
  let pointersRestored = 0;
  const bucketsReopened: string[] = [];
  if (params.scope === 'pointers' || params.scope === 'all') {
    for (const id of [...params.manifest.applied.pointersUpdated]) {
      const original = params.manifest.databaseSnapshot.find((row) => row.id === id);
      if (!original) continue;
      const ok = await params.database.updatePointers(id, {
        pdf_storage_path: original.pdf_storage_path ?? '',
        pdf_download_url: original.pdf_download_url ?? '',
        diagrammer_payload: original.diagrammer_payload,
      });
      if (!ok) throw new Error(`Rollback não alterou exatamente 1 linha em ${id}.`);
      params.manifest.applied.pointersUpdated = params.manifest.applied.pointersUpdated.filter((done) => done !== id);
      pointersRestored++;
    }
  }
  if (params.scope === 'buckets' || params.scope === 'all') {
    for (const bucket of [...params.manifest.applied.closedBuckets]) {
      await params.storage.setBucketPublic(bucket, true);
      params.manifest.applied.closedBuckets = params.manifest.applied.closedBuckets.filter((done) => done !== bucket);
      bucketsReopened.push(bucket);
    }
  }
  return { pointersRestored, bucketsReopened };
}

/* -------------------------------------------------------------------------- */
/* Pré-condições do G1: backup íntegro, inventário sem deriva, destino seguro  */
/* -------------------------------------------------------------------------- */

/** Confere cada arquivo do backup (local OU cópia externa) contra o SHA-256 e o tamanho do manifesto. */
export async function verifyBackup(dir: string): Promise<{ ok: boolean; checked: number; problems: string[]; extraFiles: string[]; manifest: BackupManifest | null }> {
  const problems: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, checked: 0, problems: [`manifest.json ausente ou ilegível em ${dir}`], extraFiles: [], manifest: null };
  }
  if (manifest.kind !== 'gmn-pdf-migration-backup') problems.push('manifest.json não é de um backup de migração GMN');
  const expected = new Set<string>();
  for (const file of manifest.files) {
    expected.add(path.normalize(file.backupPath));
    const bytes = await readIfExists(path.join(dir, file.backupPath));
    if (!bytes) problems.push(`${file.backupPath}: arquivo ausente`);
    else if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) problems.push(`${file.backupPath}: conteúdo diferente do manifesto (SHA-256/tamanho)`);
  }
  const extraFiles: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const relative = path.relative(dir, full);
        if (relative !== 'manifest.json' && relative !== 'applied.json' && !expected.has(path.normalize(relative))) extraFiles.push(relative);
      }
    }
  };
  await walk(dir);
  return { ok: problems.length === 0, checked: manifest.files.length, problems, extraFiles, manifest };
}

/** Inventário ao vivo × o do manifesto: qualquer diferença impede a migração. */
export function compareInventoryToManifest(live: Inventory, manifest: BackupManifest): { ok: boolean; differences: string[] } {
  const differences: string[] = [];
  const saved = manifest.inventory;
  if (live.sourceBucket !== saved.sourceBucket) differences.push(`bucket de origem mudou: ${saved.sourceBucket} → ${live.sourceBucket}`);
  if (live.sourceBucketPublic !== saved.sourceBucketPublic) differences.push(`visibilidade do bucket mudou: ${saved.sourceBucketPublic} → ${live.sourceBucketPublic}`);
  if (live.items.length !== saved.items.length) differences.push(`quantidade de auditorias com PDF mudou: ${saved.items.length} → ${live.items.length}`);
  for (const before of saved.items) {
    const now = live.items.find((item) => item.auditId === before.auditId);
    if (!now) { differences.push(`${before.auditId}: sumiu do inventário`); continue; }
    if (now.local?.sha256 !== before.local?.sha256) differences.push(`${before.fileName}: SHA-256 de public/audits mudou`);
    if (now.bucket?.sha256 !== before.bucket?.sha256) differences.push(`${before.fileName}: SHA-256 do objeto no bucket mudou`);
    if (now.dbStoragePath !== before.dbStoragePath || now.dbDownloadUrl !== before.dbDownloadUrl) differences.push(`${before.auditId}: ponteiros no banco mudaram`);
  }
  for (const item of live.items) if (!saved.items.some((before) => before.auditId === item.auditId)) differences.push(`${item.auditId}: PDF novo que não está no backup`);
  const orphansBefore = [...saved.orphanBucketObjects].sort().join('|');
  if ([...live.orphanBucketObjects].sort().join('|') !== orphansBefore) differences.push('objetos órfãos no bucket mudaram');
  return { ok: differences.length === 0, differences };
}

/** Tudo que o `copy` exige antes de escrever qualquer coisa em produção. */
export async function preflightCopy(params: {
  readonly storage: StoragePort;
  readonly database: DatabasePort;
  readonly backupDir: string;
  readonly sourceBucket: string;
  readonly privateBucket: string;
  readonly publicDir: string;
}): Promise<{ ok: boolean; problems: string[]; manifest: BackupManifest | null; live: Inventory | null }> {
  const problems: string[] = [];
  if (params.privateBucket === params.sourceBucket) problems.push('o bucket privado não pode ser o bucket de origem');
  const backup = await verifyBackup(params.backupDir);
  problems.push(...backup.problems);
  if (!backup.manifest) return { ok: false, problems, manifest: null, live: null };
  const live = await buildInventory({ storage: params.storage, database: params.database, sourceBucket: params.sourceBucket, publicDir: params.publicDir });
  problems.push(...compareInventoryToManifest(live, backup.manifest).differences);
  const destination = await params.storage.getBucket(params.privateBucket);
  if (destination?.public) problems.push(`o bucket de destino ${params.privateBucket} é PÚBLICO`);
  return { ok: problems.length === 0, problems, manifest: backup.manifest, live };
}

/** O backup (`manifest.json`) é imutável; o que foi aplicado fica em `applied.json`, ao lado. */
export async function loadAppliedState(dir: string): Promise<BackupManifest['applied']> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'applied.json'), 'utf8')) as Partial<BackupManifest['applied']>;
    return { copied: parsed.copied ?? [], pointersUpdated: parsed.pointersUpdated ?? [], closedBuckets: parsed.closedBuckets ?? [] };
  } catch {
    return { copied: [], pointersUpdated: [], closedBuckets: [] };
  }
}

export async function saveAppliedState(dir: string, applied: BackupManifest['applied']): Promise<void> {
  await fs.writeFile(path.join(dir, 'applied.json'), JSON.stringify({ updatedAt: new Date().toISOString(), ...applied }, null, 2));
}
