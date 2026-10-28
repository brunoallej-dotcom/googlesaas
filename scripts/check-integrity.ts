/**
 * Verificação de integridade SOMENTE LEITURA do banco e dos PDFs. Não escreve nada, não consulta o
 * Serper e não usa Redis. Uso: npm run db:check
 *
 * Verifica: auditorias concluídas sem payloads; place_id da auditoria diferente do lead; PDFs
 * registrados que não existem em disco; auditorias duplicadas ativas por empresa + palavra-chave;
 * auditorias "em andamento" sem atualização recente (candidatas a retomada).
 */
import fs from 'node:fs/promises';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const { getSupabaseAdmin } = await import('@/lib/supabase');
  const { normalizeAuditKeyword } = await import('@/lib/audit-state');
  const { deriveAuditPhase, staleMinutesFromEnv } = await import('@/lib/audit-liveness');
  const { pdfReadCandidates, allowedPdfRoots } = await import('@/lib/pdf/serve');
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado: nada a verificar.');

  const problems: string[] = [];
  const note = (message: string): void => {
    problems.push(message);
    console.log(`  ! ${message}`);
  };

  const { data: audits, error } = await supabase
    .from('gmn_audits')
    .select('id, lead_id, place_id, target_keyword, status, updated_at, pdf_storage_path, battlefield_payload, judge_payload, reputation_payload, diagrammer_payload')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`Falha ao ler auditorias: ${error.message}`);
  const rows = (audits ?? []) as Record<string, unknown>[];

  const { data: leads, error: leadsError } = await supabase.from('gmn_leads').select('id, place_id').limit(5000);
  if (leadsError) throw new Error(`Falha ao ler leads: ${leadsError.message}`);
  const leadPlace = new Map(((leads ?? []) as Record<string, unknown>[]).map((l) => [String(l.id), String(l.place_id)]));

  console.log(`Auditorias: ${rows.length} | leads: ${leadPlace.size}`);
  const roots = allowedPdfRoots();
  const active = new Map<string, string[]>();
  const stale = Number.isFinite(staleMinutesFromEnv()) ? staleMinutesFromEnv() : 15;

  for (const row of rows) {
    const id = String(row.id);
    const status = String(row.status);
    const leadPlaceId = leadPlace.get(String(row.lead_id));
    if (leadPlaceId === undefined) note(`${id}: lead ${String(row.lead_id)} não existe`);
    else if (leadPlaceId !== String(row.place_id)) note(`${id}: place_id da auditoria (${String(row.place_id)}) difere do lead (${leadPlaceId})`);

    if (status === 'COMPLETED') {
      for (const [column, label] of [['battlefield_payload', 'Battlefield'], ['judge_payload', 'Juiz'], ['reputation_payload', 'Reputação'], ['diagrammer_payload', 'PDF']] as const) {
        if (row[column] === null || row[column] === undefined) note(`${id}: concluída sem payload de ${label}`);
      }
      const file = typeof row.pdf_storage_path === 'string' ? row.pdf_storage_path : '';
      if (!file) note(`${id}: concluída sem caminho de PDF`);
      else {
        let found = false;
        for (const candidate of pdfReadCandidates(file, roots)) {
          if (await fs.stat(candidate).then((s) => s.isFile(), () => false)) { found = true; break; }
        }
        if (!found) note(`${id}: arquivo PDF ausente em disco (${file}) — será regenerado do banco ao baixar`);
      }
    } else if (status !== 'FAILED') {
      const live = deriveAuditPhase({ status, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null, workerAlive: true, staleMinutes: stale });
      const key = `${String(row.lead_id)}|${normalizeAuditKeyword(String(row.target_keyword))}`;
      active.set(key, [...(active.get(key) ?? []), id]);
      if (live.phase === 'INTERRUPTED') note(`${id}: ${status} parada (${live.reason ?? 'sem atualização'}) — pode ser retomada`);
    }
  }
  for (const [key, ids] of active) if (ids.length > 1) note(`duplicidade ativa (${key}): ${ids.join(', ')}`);

  console.log(problems.length === 0 ? 'Nenhum problema encontrado.' : `${problems.length} ponto(s) de atenção (nada foi alterado).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
