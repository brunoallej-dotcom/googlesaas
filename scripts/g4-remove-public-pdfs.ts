/**
 * G4: remove os PDFs históricos de public/audits, UM A UM, por caminho exato.
 *
 *   npm run g4:remove -- --backup <pasta> --bucket <privado> --external-hashes <arquivo>          (simulação)
 *   npm run g4:remove -- ... --apply --confirm-phrase REMOVER                                     (executa)
 *
 * --external-hashes: linhas "<sha256> <tamanho> <caminho/relativo>" da CÓPIA EXTERNA do backup.
 * Não existe exclusão genérica, recursiva, de pasta, de backup, de .data/audits, de bucket ou de banco.
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
  const backupArg = arg('--backup');
  const bucket = arg('--bucket');
  const hashesFile = arg('--external-hashes');
  if (!backupArg || !bucket || !hashesFile) throw new Error('Informe --backup <pasta>, --bucket <privado> e --external-hashes <arquivo>.');
  const backupDir = path.resolve(backupArg);

  const { getSupabaseAdmin } = await import('@/lib/supabase');
  const migration = await import('@/lib/pdf/migration');
  const { supabaseStoragePort } = await import('@/lib/pdf/migration-supabase');
  const removal = await import('@/lib/pdf/public-removal');
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado.');
  const storage = supabaseStoragePort(supabase, process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, ''));

  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8')) as import('@/lib/pdf/migration').BackupManifest;
  const publicDir = path.resolve(process.cwd(), 'public', 'audits');
  const privateDir = path.resolve(process.cwd(), '.data', 'audits');
  const externalHashes = removal.parseExternalHashes(await fs.readFile(hashesFile, 'utf8'));
  const privateInfo = await storage.getBucket(bucket);
  const plan = await removal.planPublicRemoval({ manifest, backupDir, publicDir, privateDir, storage, privateBucket: bucket, externalHashes });
  if (!privateInfo || privateInfo.public) plan.problems.push(`o bucket ${bucket} não existe ou é público`);

  console.log(`Inventário EXATO dos arquivos a remover de ${publicDir}:`);
  for (const t of plan.targets) {
    console.log(`- ${t.fileName}\n    ${t.size} B | sha256 ${t.sha256} | modificado ${t.modifiedAt}\n    mesmo conteúdo confirmado em: ${t.confirmedIn.join(', ')}`);
  }
  if (plan.alreadyRemoved.length) console.log(`Já removidos (ignorados): ${plan.alreadyRemoved.join(', ')}`);
  console.log(`Não tocados (fora do manifesto): ${plan.untouched.length ? plan.untouched.join(', ') : 'nenhum'}`);
  for (const problem of plan.problems) console.log(`  ! ${problem}`);
  if (plan.problems.length > 0 || !plan.ok) { console.error('PRÉ-CONDIÇÃO FALHOU. Nada foi removido.'); process.exit(4); }

  const out = path.join(process.cwd(), '.data', 'migration');
  await fs.mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const planFile = path.join(out, `g4-remocao-plano-${stamp}.json`);
  if (!apply) {
    await fs.writeFile(planFile, JSON.stringify({ simulacao: true, targets: plan.targets }, null, 2));
    console.log(`SIMULAÇÃO: nada foi removido. Inventário gravado em ${planFile}`);
    return;
  }

  console.log(`\nA remoção exclui ${plan.targets.length} arquivo(s) de public/audits (um por vez). Frase de confirmação: ${arg('--confirm-phrase') === 'REMOVER' ? 'recebida' : 'AUSENTE'}.`);
  if (arg('--confirm-phrase') !== 'REMOVER') { console.error('Frase de confirmação ausente ou inválida. Nada foi removido.'); process.exit(3); }
  const result = await removal.executePublicRemoval(plan, {
    beforeStart: async () => { await fs.writeFile(planFile, JSON.stringify({ simulacao: false, targets: plan.targets }, null, 2), { flag: 'wx' }); },
  });
  await fs.writeFile(path.join(out, `g4-remocao-resultado-${stamp}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  void migration;
  for (const name of result.removed) console.log(`  removido: ${name}`);
  if (result.failed) { console.error(`FALHA: ${result.failed}. Interrompido; os demais arquivos não foram tocados.`); process.exit(1); }
  console.log(`G4 concluído: ${result.removed.length} arquivo(s) removido(s) de public/audits. A pasta foi mantida.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
