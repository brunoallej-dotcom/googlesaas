/**
 * Migração dos PDFs históricos para armazenamento privado.
 *
 *  SOMENTE LEITURA / LOCAL (nada em produção):
 *   inventory                         inventário (bucket + public/audits + banco), SHA-256 dos dois lados
 *   backup                            cópia LOCAL em .data/backups/<data>/ + manifest.json (imutável)
 *   verify-backup --backup <pasta>    confere SHA-256 do backup (use também na CÓPIA EXTERNA)
 *   verify-links [--base URL]         HEAD sem credencial nas URLs antigas e em /audits/*.pdf
 *   snapshot --label <antes|depois> [--bucket <privado>]   foto do que não pode mudar
 *   compare-snapshots --before <arq> --after <arq>         só os destinos novos podem mudar
 *   verify-private --backup <pasta> --bucket <privado>     integridade + acesso autenticado + anônimo negado
 *
 *  ALTERAM PRODUÇÃO (simulação por padrão; só com --apply e confirmação):
 *   copy        --backup <pasta> --bucket <privado> [--apply [--confirm-phrase MIGRAR]]      (G1)
 *   pointers    --backup <pasta> --bucket <privado> [--apply [--confirm-phrase MIGRAR]]      (G3)
 *   close-public --backup <pasta> --bucket <privado> [--apply]                               (G2)
 *   rollback    --backup <pasta> --scope pointers|buckets|all [--apply]
 *
 * NÃO existe nenhuma operação de exclusão neste programa. O manifest.json do backup nunca é
 * reescrito: o que foi aplicado fica em applied.json ao lado.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function confirm(summary: string): Promise<void> {
  console.log(`\n${summary}`);
  const given = arg('--confirm-phrase');
  if (given !== undefined) {
    if (given.trim() !== 'MIGRAR') { console.error('Frase de confirmação inválida. Nada foi alterado.'); process.exit(3); }
    console.log('Confirmação recebida por --confirm-phrase (execução autorizada).');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nEsta etapa ALTERA PRODUÇÃO. Digite exatamente MIGRAR para confirmar: ');
  rl.close();
  if (answer.trim() !== 'MIGRAR') { console.error('Confirmação não recebida. Nada foi alterado.'); process.exit(3); }
}

async function main(): Promise<void> {
  const first = process.argv[2];
  const phase = first && !first.startsWith('--') ? first : 'inventory';
  const apply = process.argv.includes('--apply');
  const migration = await import('@/lib/pdf/migration');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const publicDir = path.resolve(process.cwd(), 'public', 'audits');
  const privateDir = path.resolve(process.cwd(), '.data', 'audits');

  /* ----- fases que não precisam do Supabase ----- */
  if (phase === 'verify-backup') {
    const dir = arg('--backup');
    if (!dir) throw new Error('Informe --backup <pasta> (a local ou a cópia externa).');
    const result = await migration.verifyBackup(path.resolve(dir));
    console.log(`Backup em ${path.resolve(dir)}: ${result.checked} arquivo(s) conferidos por SHA-256 e tamanho.`);
    for (const problem of result.problems) console.log(`  ! ${problem}`);
    for (const extra of result.extraFiles) console.log(`  (arquivo extra, não listado no manifesto: ${extra})`);
    console.log(result.ok ? 'BACKUP ÍNTEGRO: todos os hashes conferem com o manifesto.' : 'BACKUP COM PROBLEMAS.');
    process.exit(result.ok ? 0 : 1);
  }
  if (phase === 'compare-snapshots') {
    const [beforeFile, afterFile] = [arg('--before'), arg('--after')];
    if (!beforeFile || !afterFile) throw new Error('Informe --before <arquivo> e --after <arquivo>.');
    const { diffSnapshots } = await import('@/lib/pdf/migration-snapshot');
    const before = JSON.parse(await fs.readFile(beforeFile, 'utf8'));
    const after = JSON.parse(await fs.readFile(afterFile, 'utf8'));
    const diff = diffSnapshots(before, after, ['private-bucket/', 'private-dir/']);
    console.log(`Entradas: antes ${Object.keys(before.entries).length}, depois ${Object.keys(after.entries).length}`);
    console.log(`Novas (destinos permitidos): ${diff.added.filter((k) => !diff.unexpected.includes(k)).length} | removidas: ${diff.removed.length} | alteradas: ${diff.changed.length}`);
    for (const key of diff.added) console.log(`  + ${key}`);
    for (const key of [...diff.removed, ...diff.changed]) console.log(`  ! ${key}`);
    console.log(diff.unexpected.length === 0 ? 'NADA ALÉM DO ESCOPO MUDOU: banco, public/audits, bucket antigo e .env.local idênticos.' : `MUDANÇAS INESPERADAS: ${diff.unexpected.join(', ')}`);
    process.exit(diff.unexpected.length === 0 ? 0 : 1);
  }

  /* ----- fases que usam o Supabase ----- */
  const { getSupabaseAdmin } = await import('@/lib/supabase');
  const { supabaseDatabasePort, supabaseStoragePort } = await import('@/lib/pdf/migration-supabase');
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado.');
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '');
  const storage = supabaseStoragePort(supabase, baseUrl);
  const database = supabaseDatabasePort(supabase);
  const sourceBucket = process.env.SUPABASE_AUDIT_BUCKET?.trim() || 'gmn-audit-pdfs';

  const readTable = async (table: string): Promise<Record<string, unknown>[]> => {
    const { data, error } = await supabase.from(table).select('*').order('id', { ascending: true }).limit(5000);
    if (error) throw new Error(`Falha ao ler ${table}: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  };

  const needBackupDir = (): string => {
    const dir = arg('--backup');
    if (!dir) throw new Error('Informe --backup <pasta do backup> (gerada pela fase backup).');
    return path.resolve(dir);
  };
  const needBucket = (): string => {
    const bucket = arg('--bucket') ?? process.env.SUPABASE_PRIVATE_AUDIT_BUCKET?.trim();
    if (!bucket) throw new Error('Informe --bucket <bucket privado>.');
    return bucket;
  };
  const loadManifest = async (dir: string): Promise<import('@/lib/pdf/migration').BackupManifest> => {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as import('@/lib/pdf/migration').BackupManifest;
    return { ...manifest, applied: await migration.loadAppliedState(dir) };
  };
  const printInventory = (inventory: import('@/lib/pdf/migration').Inventory): void => {
    console.log(`Inventário (${inventory.generatedAt}) | bucket de origem: ${inventory.sourceBucket} | público: ${inventory.sourceBucketPublic}`);
    for (const item of inventory.items) {
      console.log(`- ${item.auditId}`);
      console.log(`    arquivo: ${item.fileName}`);
      console.log(`    public/audits: ${item.local ? `${item.local.size} B sha256:${item.local.sha256}` : 'AUSENTE'}`);
      console.log(`    bucket       : ${item.bucket ? `${item.bucket.size} B sha256:${item.bucket.sha256} | acesso SEM credencial: HTTP ${item.bucket.publicHttpStatus}` : 'AUSENTE'}`);
      console.log(`    conteúdo     : ${item.sameContent === null ? 'só existe de um lado' : item.sameContent ? 'IDÊNTICO nos dois lugares' : 'DIFERENTE (versões distintas: ambas serão preservadas)'}`);
    }
    if (inventory.orphanBucketObjects.length) console.log(`Objetos no bucket sem auditoria: ${inventory.orphanBucketObjects.join(', ')}`);
    console.log(`Resumo: ${JSON.stringify(inventory.summary)}`);
  };

  if (phase === 'inventory' || phase === 'backup' || phase === 'verify-links') {
    const inventory = await migration.buildInventory({ storage, database, sourceBucket, publicDir });
    printInventory(inventory);
    if (phase === 'verify-links') {
      const base = arg('--base');
      if (base) {
        for (const item of inventory.items) {
          const response = await fetch(`${base.replace(/\/$/, '')}/audits/${item.fileName}`, { method: 'HEAD', redirect: 'manual' }).catch(() => null);
          console.log(`  ${base}/audits/${item.fileName.slice(0, 40)}… sem sessão: HTTP ${response?.status ?? 'sem resposta'}`);
        }
      }
      return;
    }
    if (phase === 'inventory') {
      const out = path.join(process.cwd(), '.data', 'migration');
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(path.join(out, `inventory-${stamp}.json`), JSON.stringify(inventory, null, 2));
      console.log(`Inventário gravado em ${path.join(out, `inventory-${stamp}.json`)} (somente local).`);
      return;
    }
    const backupDir = path.join(process.cwd(), '.data', 'backups', `pdf-migration-${stamp}`);
    await fs.mkdir(backupDir, { recursive: true });
    const manifest = await migration.runBackup({ storage, database, inventory, backupDir });
    console.log(`BACKUP LOCAL concluído em ${backupDir}: ${manifest.files.length} arquivo(s), hashes conferidos. Nada foi alterado em produção.`);
    console.log('Recomendação: copie esta pasta também para um disco externo ou nuvem sua e rode verify-backup na cópia.');
    return;
  }

  if (phase === 'snapshot') {
    const { takeMigrationSnapshot } = await import('@/lib/pdf/migration-snapshot');
    const label = arg('--label') ?? 'foto';
    const privateBucket = arg('--bucket');
    const snapshot = await takeMigrationSnapshot({
      readTable,
      storage, sourceBucket, publicDir, privateDir, envFile: path.join(process.cwd(), '.env.local'),
      ...(privateBucket ? { privateBucket } : {}),
    });
    const out = path.join(process.cwd(), '.data', 'migration');
    await fs.mkdir(out, { recursive: true });
    const file = path.join(out, `g1-snapshot-${label}-${stamp}.json`);
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2));
    console.log(`Foto "${label}" gravada: ${Object.keys(snapshot.entries).length} entradas (somente local).\n${file}`);
    return;
  }

  const backupDir = needBackupDir();

  if (phase === 'verify-private') {
    const bucket = needBucket();
    const { checkAnonymousDenied, checkBucketConfig } = await import('@/lib/pdf/private-verify');
    const { installFetchGuard } = await import('@/lib/recovery-validation');
    const { sha256 } = migration;
    const manifest = await loadManifest(backupDir);
    const inventory = manifest.inventory;
    const rows: { check: string; passed: boolean; detail: string }[] = [];
    const add = (check: string, passed: boolean, detail: string): void => { rows.push({ check, passed, detail }); };
    const guard = installFetchGuard([new URL(baseUrl).host]);
    try {
      // 1) Bucket
      for (const c of await checkBucketConfig(storage, bucket)) add(c.check, c.passed, c.detail);
      // 2) Integridade (cada objeto e cada cópia local)
      const copies = await migration.verifyCopies({ storage, inventory, privateBucket: bucket, privateDir });
      add('integridade SHA-256 de todas as cópias (bucket privado + .data/audits + versões anteriores)', copies.ok, copies.ok ? `${inventory.items.length} auditoria(s) conferidas` : copies.problems.join('; '));
      const objects = await storage.listObjects(bucket);
      add('quantidade de objetos no bucket privado', objects.length === migration.planCopy(inventory, bucket, privateDir).filter((o) => o.kind !== 'official-to-private-dir').length, `${objects.length} objeto(s)`);
      // 3) Fluxo protegido da aplicação
      process.env.SUPABASE_PRIVATE_AUDIT_BUCKET = bucket; // só no ambiente deste processo; .env.local não é tocado
      const { resolvePdfWithFallbacks } = await import('@/lib/pdf/download-chain');
      const { gmnRepository } = await import('@/lib/supabase');
      const { createSessionToken, SESSION_COOKIE } = await import('@/lib/auth/session');
      const operator = (process.env.GMN_OPERATOR_EMAILS ?? '').split(/[,;\s]+/)[0] ?? '';
      const token = await createSessionToken(operator, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
      const { GET } = await import('@/app/api/audit/[id]/pdf/route');
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-g1-vazio-'));
      for (const item of inventory.items) {
        if (!item.local) continue;
        const state = await gmnRepository.getAuditState(item.auditId);
        const diagrammer = state?.diagrammer as import('@/types/gmn').DiagrammerOutput | undefined;
        const chain = await resolvePdfWithFallbacks(item.auditId, diagrammer, { supabase, bucket, roots: [path.join(emptyDir, 'a'), path.join(emptyDir, 'b')], regenerate: async () => null });
        add(`cadeia de leitura só com o bucket privado: ${item.auditId.slice(0, 8)}`, chain.status === 200 && chain.source === 'private-bucket' && sha256(chain.body) === item.local.sha256, chain.status === 200 ? `fonte ${chain.source}, SHA ${sha256(chain.body).slice(0, 16)}` : chain.error);
        const request = (cookie: boolean): Request => new Request(`http://localhost/api/audit/${item.auditId}/pdf`, { headers: { host: 'localhost', ...(cookie ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) } });
        const ctx = { params: Promise.resolve({ id: item.auditId }) };
        const anonymous = await GET(request(false), ctx);
        add(`rota /api/audit/<id>/pdf SEM sessão: ${item.auditId.slice(0, 8)}`, anonymous.status === 401, `HTTP ${anonymous.status}`);
        const normal = await GET(request(true), ctx);
        const normalBytes = Buffer.from(await normal.arrayBuffer());
        add(`rota com sessão (estado normal): ${item.auditId.slice(0, 8)}`, normal.status === 200 && sha256(normalBytes) === item.local.sha256, `HTTP ${normal.status}, fonte ${normal.headers.get('x-gmn-pdf-source')}, SHA ${sha256(normalBytes).slice(0, 16)}`);
        const previous = process.cwd();
        process.chdir(emptyDir); // sem pastas locais: a rota real precisa servir do bucket privado
        try {
          const viaBucket = await GET(request(true), ctx);
          const bucketBytes = Buffer.from(await viaBucket.arrayBuffer());
          add(`rota com sessão servindo do BUCKET PRIVADO: ${item.auditId.slice(0, 8)}`, viaBucket.status === 200 && viaBucket.headers.get('x-gmn-pdf-source') === 'private-bucket' && sha256(bucketBytes) === item.local.sha256, `HTTP ${viaBucket.status}, fonte ${viaBucket.headers.get('x-gmn-pdf-source')}, SHA ${sha256(bucketBytes).slice(0, 16)}`);
        } finally {
          process.chdir(previous);
        }
      }
      // 4) Anônimo negado
      const keys = migration.planCopy(inventory, bucket, privateDir).filter((o) => o.kind !== 'official-to-private-dir').map((o) => o.target.slice(bucket.length + 1));
      for (const c of await checkAnonymousDenied({ baseUrl, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', bucket, keys })) add(c.check, c.passed, `HTTP ${c.status}; ${c.detail}`);
    } finally {
      guard.restore();
    }
    add('nenhuma chamada externa (Serper, LLM…)', guard.blocked.length === 0, `bloqueadas: ${guard.blocked.length}; leituras ao Supabase: ${guard.allowed}`);
    for (const r of rows) console.log(`${r.passed ? 'OK    ' : 'FALHOU'} ${r.check.padEnd(86)} ${r.detail}`);
    const failed = rows.filter((r) => !r.passed);
    console.log(`\n${failed.length === 0 ? 'VERIFICAÇÃO DO BUCKET PRIVADO APROVADA' : `${failed.length} verificação(ões) FALHARAM`}: ${rows.length} verificações.`);
    process.exit(failed.length === 0 ? 0 : 1);
  }

  const manifest = await loadManifest(backupDir);
  const inventory = manifest.inventory;

  if (phase === 'copy') {
    const bucket = needBucket();
    const operations = migration.planCopy(inventory, bucket, privateDir);
    const plan = operations.map((o) => `  - ${o.kind}: ${o.target}`).join('\n');
    const pre = await migration.preflightCopy({ storage, database, backupDir, sourceBucket, privateBucket: bucket, publicDir });
    console.log(`Pré-condições: ${pre.ok ? 'TODAS OK (backup íntegro, inventário sem deriva, destino seguro)' : 'FALHARAM'}`);
    for (const problem of pre.problems) console.log(`  ! ${problem}`);
    if (!pre.ok) { console.error('Nada foi alterado.'); process.exit(4); }
    if (!apply) return console.log(`SIMULAÇÃO (nada alterado). Fase copy faria:\n${plan}\nE criaria o bucket privado ${bucket} se não existir.`);
    await confirm(`Fase COPY (G1): cria o bucket privado "${bucket}" (se preciso) e copia sem sobrescrever:\n${plan}`);
    const result = await migration.applyCopy({ storage, inventory, manifest, privateBucket: bucket, privateDir });
    await migration.saveAppliedState(backupDir, manifest.applied);
    const check = await migration.verifyCopies({ storage, inventory, privateBucket: bucket, privateDir });
    console.log(`Cópias: ${result.uploaded} enviadas, ${result.existing} já existiam. Falhas: ${result.failures.length}. Verificação SHA-256: ${check.ok ? 'OK' : 'PROBLEMAS'}`);
    for (const problem of [...result.failures, ...check.problems]) console.log(`  ! ${problem}`);
    process.exit(result.failures.length === 0 && check.ok ? 0 : 1);
  }
  if (phase === 'pointers') {
    // G3: referências dos PDFs históricos no banco → rota protegida. Pré-checagens, backup, aplicação e verificação.
    const bucket = needBucket();
    const { dumpRows, diffRows, checkAllowedChanges } = await import('@/lib/pdf/migration-rows');
    const out = path.join(process.cwd(), '.data', 'migration');
    await fs.mkdir(out, { recursive: true });

    // 1) Pré-condições (qualquer divergência para ANTES de escrever)
    const pre = await migration.preflightCopy({ storage, database, backupDir, sourceBucket, privateBucket: bucket, publicDir });
    const problems = [...pre.problems.filter((p) => !/visibilidade do bucket mudou/.test(p))];
    const copies = await migration.verifyCopies({ storage, inventory, privateBucket: bucket, privateDir });
    problems.push(...copies.problems);
    const live = await migration.buildInventory({ storage, database, sourceBucket, publicDir });
    if (live.sourceBucketPublic !== false) problems.push('o bucket antigo ainda é público (G2 não aplicado)');
    if (live.summary.publiclyReachable !== 0) problems.push(`${live.summary.publiclyReachable} link(s) público(s) antigo(s) ainda respondem 200`);
    const changes = migration.planPointerChanges(manifest.databaseSnapshot, privateDir);
    for (const change of changes) {
      try { migration.assertPermanentRouteUrl(change.auditId, change.after.pdf_download_url); } catch (error: unknown) { problems.push(error instanceof Error ? error.message : String(error)); }
    }
    const publicUrlRows = (await database.listAuditsWithPdf()).filter((row) => /\/object\/public\//.test(row.pdf_download_url ?? ''));
    console.log(`Pré-condições: backup íntegro, cópias privadas conferem, ${publicUrlRows.length} linha(s) com URL pública antiga, ${changes.length} linha(s) previstas.`);
    for (const problem of problems) console.log(`  ! ${problem}`);
    if (problems.length > 0) { console.error('Divergência encontrada. NADA foi escrito.'); process.exit(4); }

    // 2) Backup dos valores originais + despejo completo ANTES
    const before = await dumpRows(readTable);
    const stampG3 = new Date().toISOString().replace(/[:.]/g, '-');
    const beforeRowsFile = path.join(out, `g3-rows-antes-${stampG3}.json`);
    await fs.writeFile(beforeRowsFile, JSON.stringify(before));
    const originals = manifest.databaseSnapshot.map((row) => ({ id: row.id, pdf_download_url: row.pdf_download_url, pdf_storage_path: row.pdf_storage_path, diagrammer_payload: row.diagrammer_payload, updated_at: before.tables.gmn_audits?.[row.id]?.updated_at }));
    const originalsFile = path.join(out, `g3-before-${stampG3}.json`);
    await fs.writeFile(originalsFile, JSON.stringify(originals, null, 2));
    console.log(`Backup dos valores originais: ${originalsFile}\nDespejo completo das 5 tabelas: ${beforeRowsFile}`);

    const table = (): void => {
      for (const change of changes) {
        console.log(`- ${change.auditId}`);
        console.log(`    pdf_download_url : ${change.before.pdf_download_url}\n                    → ${change.after.pdf_download_url}`);
        console.log(`    pdf_storage_path : ${change.before.pdf_storage_path}\n                    → ${change.after.pdf_storage_path}`);
      }
    };
    if (!apply) { console.log('SIMULAÇÃO (nada escrito). Fase pointers faria:'); table(); return; }
    await confirm(`Fase POINTERS (G3): altera ${changes.length} linha(s) de gmn_audits (pdf_download_url, pdf_storage_path e as chaves pdfDownloadUrl/pdfStoragePath do diagrammer_payload), com UPDATE condicional e reversão automática.`);
    table();

    // 3) Aplicação + verificação campo a campo (reverte sozinho se algo fugir do escopo)
    const applied = await migration.applyPointers({ database, manifest, privateDir });
    await migration.saveAppliedState(backupDir, manifest.applied);
    const after = await dumpRows(readTable);
    await fs.writeFile(path.join(out, `g3-rows-depois-${stampG3}.json`), JSON.stringify(after));
    const diff = diffRows(before, after);
    const verdict = checkAllowedChanges(diff, changes.map((c) => c.auditId), ['pdf_download_url', 'pdf_storage_path', 'diagrammer_payload', 'updated_at'], ['pdfDownloadUrl', 'pdfStoragePath']);
    console.log(`Linhas atualizadas: ${applied}. Diferenças campo a campo: ${diff.changed.length} linha(s) alterada(s), ${diff.added.length} nova(s), ${diff.removed.length} removida(s).`);
    for (const change of diff.changed) console.log(`  ~ ${change.table}/${change.id.slice(0, 8)}: ${change.columns.join(', ')}${change.payloadKeys.length ? ` [payload: ${change.payloadKeys.join(', ')}]` : ''}`);
    if (!verdict.ok) {
      console.error(`VERIFICAÇÃO REPROVADA:\n${verdict.violations.join('\n')}\nRevertendo ponteiros automaticamente…`);
      console.error(JSON.stringify(await migration.rollback({ storage, database, manifest, scope: 'pointers' })));
      await migration.saveAppliedState(backupDir, manifest.applied);
      process.exit(5);
    }
    console.log('VERIFICAÇÃO APROVADA: somente as 3 linhas e colunas previstas mudaram (updated_at pelo trigger do banco).');
    return;
  }
  if (phase === 'close-public') {
    const bucket = needBucket();
    const check = await migration.verifyCopies({ storage, inventory, privateBucket: bucket, privateDir });
    if (!check.ok) throw new Error(`Recuso fechar o bucket público: cópias privadas não conferem.\n${check.problems.join('\n')}`);
    if (!apply) return console.log(`SIMULAÇÃO: cópias privadas conferem. Fecharia (public=false) o bucket ${inventory.sourceBucket}; os links antigos deixariam de funcionar. Nada seria apagado.`);
    await confirm(`Fase CLOSE-PUBLIC (G2): torna o bucket "${inventory.sourceBucket}" PRIVADO. Links antigos deixam de funcionar. Reversível (rollback). Nada é apagado.`);
    await migration.closePublicBucket({ storage, manifest, bucket: inventory.sourceBucket });
    await migration.saveAppliedState(backupDir, manifest.applied);
    console.log('Bucket de origem fechado. Rode: npm run pdf:migrate -- verify-links');
    return;
  }
  if (phase === 'rollback') {
    const scope = arg('--scope');
    if (scope !== 'pointers' && scope !== 'buckets' && scope !== 'all') throw new Error('Informe --scope pointers | buckets | all. (buckets REABRE o bucket público e reativa os links antigos.)');
    if (!apply) return console.log(`SIMULAÇÃO (escopo ${scope}): restauraria ${scope === 'buckets' ? 0 : manifest.applied.pointersUpdated.length} ponteiro(s) e reabriria ${scope === 'pointers' ? 'nenhum bucket' : manifest.applied.closedBuckets.join(', ') || 'nenhum bucket'}. Cópias já feitas não são apagadas.`);
    await confirm(`Fase ROLLBACK (escopo ${scope}): ${scope === 'pointers' ? 'restaura ponteiros do banco' : scope === 'buckets' ? 'REABRE o bucket público (links antigos voltam a funcionar)' : 'restaura ponteiros E reabre buckets'}.`);
    console.log(JSON.stringify(await migration.rollback({ storage, database, manifest, scope })));
    await migration.saveAppliedState(backupDir, manifest.applied);
    return;
  }
  throw new Error(`Fase desconhecida: ${phase}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
