/**
 * Correção ISOLADA do metadado (pageCount e fileSizeBytes) de UMA auditoria, a partir do PDF oficial.
 *
 *   npm run pdf:fix-metadata -- --audit <id> --backup <pasta>                          (dry-run, somente leitura)
 *   npm run pdf:fix-metadata -- --audit <id> --backup <pasta> --apply --confirm-phrase CORRIGIR
 *   npm run pdf:fix-metadata -- --rollback <arquivo-de-backup> --apply --confirm-phrase CORRIGIR
 *
 * Só `diagrammer_payload.pageCount` e `.fileSizeBytes` podem mudar (e `updated_at`, pelo trigger do banco).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (apply && arg('--confirm-phrase') !== 'CORRIGIR') throw new Error('Frase de confirmação ausente (--confirm-phrase CORRIGIR). Nada foi alterado.');
  const { getSupabaseAdmin } = await import('@/lib/supabase');
  const metadata = await import('@/lib/pdf/metadata-fix');
  const { dumpRows, diffRows, checkAllowedChanges } = await import('@/lib/pdf/migration-rows');
  const { sha256, baseName } = await import('@/lib/pdf/migration');
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado.');

  const port: import('@/lib/pdf/metadata-fix').MetadataPort = {
    async read(id) {
      const { data, error } = await supabase.from('gmn_audits').select('diagrammer_payload, updated_at').eq('id', id).maybeSingle();
      if (error) throw new Error(`Falha ao ler ${id}: ${error.message}`);
      return data ? { diagrammer_payload: data.diagrammer_payload as Record<string, unknown> | null, updated_at: String(data.updated_at) } : null;
    },
    async update(id, payload, expectedUpdatedAt) {
      const { data, error } = await supabase.from('gmn_audits').update({ diagrammer_payload: payload }).eq('id', id).eq('updated_at', expectedUpdatedAt).select('id');
      if (error) throw new Error(`Falha ao atualizar ${id}: ${error.message}`);
      return (data ?? []).length === 1;
    },
  };
  const readTable = async (table: string): Promise<Record<string, unknown>[]> => {
    const { data, error } = await supabase.from(table).select('*').order('id', { ascending: true }).limit(5000);
    if (error) throw new Error(`Falha ao ler ${table}: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  };
  const out = path.join(process.cwd(), '.data', 'migration');
  await fs.mkdir(out, { recursive: true });

  const rollbackFile = arg('--rollback');
  if (rollbackFile) {
    const saved = JSON.parse(await fs.readFile(rollbackFile, 'utf8')) as { auditId: string; payloadBefore: Record<string, unknown>; payloadAfter: Record<string, unknown> };
    if (!apply) return console.log(`SIMULAÇÃO: restauraria o payload original da auditoria ${saved.auditId} (pageCount ${String(saved.payloadAfter.pageCount)} → ${String(saved.payloadBefore.pageCount)}, fileSizeBytes ${String(saved.payloadAfter.fileSizeBytes)} → ${String(saved.payloadBefore.fileSizeBytes)}).`);
    await metadata.rollbackMetadataFix(port, saved);
    return console.log('Reversão concluída.');
  }

  const auditId = arg('--audit');
  const backupArg = arg('--backup');
  if (!auditId || !backupArg) throw new Error('Informe --audit <id> e --backup <pasta do backup> (o manifesto define qual é o PDF oficial).');
  const manifest = JSON.parse(await fs.readFile(path.join(path.resolve(backupArg), 'manifest.json'), 'utf8')) as import('@/lib/pdf/migration').BackupManifest;
  const item = manifest.inventory.items.find((i) => i.auditId === auditId);
  if (!item?.local) throw new Error(`A auditoria ${auditId} não está no manifesto com um PDF oficial.`);

  const row = await port.read(auditId);
  if (!row?.diagrammer_payload) throw new Error('Auditoria sem diagrammer_payload.');
  const fileName = baseName(String(row.diagrammer_payload.pdfStoragePath ?? row.diagrammer_payload.pdfFileName ?? item.fileName));
  const officialBytes = await fs.readFile(path.join(process.cwd(), '.data', 'audits', fileName));
  const { supabaseStoragePort } = await import('@/lib/pdf/migration-supabase');
  const storage = supabaseStoragePort(supabase, process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, ''));
  const privateBucket = process.env.SUPABASE_PRIVATE_AUDIT_BUCKET?.trim();
  const privateCopy = privateBucket ? await storage.download(privateBucket, `audits/${auditId}/${fileName}`) : null;

  const plan = metadata.planMetadataFix({
    auditId,
    payload: row.diagrammer_payload,
    officialBytes,
    expectedOfficialSha256: item.local.sha256,
    ...(privateCopy ? { privateCopySha256: sha256(privateCopy) } : {}),
  });
  console.log(`Arquivo oficial: .data/audits/${fileName}\n  SHA-256 ${plan.officialSha256} (= manifesto${privateCopy ? ' = bucket privado' : ''})`);
  console.log(`  pageCount      : ${String(plan.before.pageCount)} → ${plan.after.pageCount}`);
  console.log(`  fileSizeBytes  : ${String(plan.before.fileSizeBytes)} → ${plan.after.fileSizeBytes}`);
  console.log('  demais chaves do payload (inclusive generatedAt): inalteradas');
  if (!plan.changed) return console.log('Nada a corrigir: o metadado já confere com o arquivo oficial.');
  if (!apply) return console.log('DRY-RUN (somente leitura): nada foi alterado.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(out, `metadata-fix-backup-${auditId.slice(0, 8)}-${stamp}.json`);
  await fs.writeFile(backupFile, JSON.stringify({ auditId, payloadBefore: plan.payloadBefore, payloadAfter: plan.payloadAfter, updatedAt: row.updated_at }, null, 2), { flag: 'wx' });
  const before = await dumpRows(readTable);
  const result = await metadata.applyMetadataFix(port, plan);
  const after = await dumpRows(readTable);
  const verdict = checkAllowedChanges(diffRows(before, after), [auditId], ['diagrammer_payload', 'updated_at'], ['pageCount', 'fileSizeBytes']);
  if (!verdict.ok) {
    console.error(`VERIFICAÇÃO REPROVADA:\n${verdict.violations.join('\n')}\nRevertendo…`);
    await metadata.rollbackMetadataFix(port, { auditId, payloadBefore: plan.payloadBefore, payloadAfter: plan.payloadAfter });
    process.exit(5);
  }
  console.log(`Correção aplicada. Backup: ${backupFile}\n  updated_at ${result.updatedAtBefore} → ${result.updatedAtAfter}\nVERIFICAÇÃO APROVADA: só a linha ${auditId.slice(0, 8)} e só pageCount/fileSizeBytes mudaram.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
