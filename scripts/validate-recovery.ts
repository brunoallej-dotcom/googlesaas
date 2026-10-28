/**
 * Valida a RECUPERAÇÃO das auditorias já existentes sem nenhuma busca paga e sem alterar dados.
 *   npm run validate:recovery
 *
 * Garantias verificadas: (1) nenhuma chamada fora do Supabase (guarda em fetch); (2) Redis, Serper e
 * Worker não são usados; (3) todas as linhas das 5 tabelas e os PDFs oficiais têm hash idêntico
 * antes e depois; (4) o Score Juiz histórico gravado é preservado; (5) 49 pontos do Battlefield.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

const TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'] as const;

async function main(): Promise<void> {
  const { getSupabaseAdmin, gmnRepository } = await import('@/lib/supabase');
  const { hashRows, installFetchGuard } = await import('@/lib/recovery-validation');
  const { hasReusableBattlefield, deriveAuditPhase, decideEnqueue } = await import('@/lib/audit-liveness');
  const { reportSourceFromAuditState } = await import('@/lib/pdf/report-source');
  const { buildReportModel } = await import('@/lib/pdf/report-model');
  const { renderReportPdf } = await import('@/lib/pdf/report-renderer');
  const { resolvePdfWithFallbacks } = await import('@/lib/pdf/download-chain');
  const { noBasemapProvider, NO_BASEMAP_NOTICE } = await import('@/lib/pdf/map/basemap');

  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado.');
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;

  const snapshot = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const table of TABLES) {
      const { data, error } = await supabase.from(table).select('*').order('id', { ascending: true }).limit(5000);
      if (error) throw new Error(`Falha ao ler ${table}: ${error.message}`);
      out[table] = `${(data ?? []).length}:${hashRows((data ?? []) as Record<string, unknown>[])}`;
    }
    const dir = path.join(process.cwd(), 'public', 'audits');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();
    for (const file of files) out[`public/audits/${file}`] = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, file))).digest('hex').slice(0, 16);
    return out;
  };

  const before = await snapshot();
  const guard = installFetchGuard([host]);
  const checks: { auditId: string; check: string; passed: boolean; detail: string }[] = [];
  const add = (auditId: string, check: string, passed: boolean, detail: string): void => { checks.push({ auditId: auditId.slice(0, 8), check, passed, detail }); };

  try {
    const { data: rows, error } = await supabase.from('gmn_audits').select('id, lead_id, place_id, target_keyword, status, judge_payload, battlefield_payload, updated_at').order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    const log = console.log;

    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      const id = String(row.id);
      const state = await gmnRepository.getAuditState(id);
      if (!state) { add(id, 'ler estado', false, 'não encontrado'); continue; }

      if (row.status !== 'COMPLETED') {
        add(id, 'estado terminal sem dados pagos', row.status === 'FAILED' && !hasReusableBattlefield(state), `status ${String(row.status)}; retomável: ${hasReusableBattlefield(state)}`);
        const phase = deriveAuditPhase({ status: String(row.status), updatedAt: String(row.updated_at), workerAlive: true });
        add(id, 'FAILED sem dados não oferece retomada', phase.phase === 'FAILED' && !(phase.resumable && hasReusableBattlefield(state)), `fase ${phase.phase}`);
        const decision = decideEnqueue([{ id, status: String(row.status), updatedAt: String(row.updated_at), hasBattlefield: hasReusableBattlefield(state) }], true);
        add(id, 'nova auditoria permitida (sem dado a reaproveitar)', decision.action === 'CREATE', decision.action);
        continue;
      }

      const raw = row.judge_payload as { overallScore?: number; scoreMethod?: string } | null;
      add(id, 'Battlefield com 49 pontos', hasReusableBattlefield(state), `pontos: ${(state.battlefield as { points?: unknown[] })?.points?.length}`);
      add(id, 'Score Juiz histórico preservado', (state.judge as { overallScore?: number })?.overallScore === raw?.overallScore && raw?.scoreMethod === undefined, `gravado ${raw?.overallScore}%, método ${raw?.scoreMethod ?? 'histórico (sem scoreMethod)'}`);

      const latest = await gmnRepository.getLatestCompletedAudits([String(row.place_id)], String(row.target_keyword));
      add(id, 'localizada pela empresa + palavra-chave (como a UI)', Boolean(latest[String(row.place_id)]), 'getLatestCompletedAudits');

      const lead = await gmnRepository.getLeadById(String(row.lead_id));
      add(id, 'lead e campanha reabertos', Boolean(lead) && Boolean(await gmnRepository.getCampaignWithLeads(lead!.campaignId)), lead?.businessName ?? 'lead ausente');
      if (!lead) continue;

      const source = reportSourceFromAuditState(state, lead);
      if (!source.ok) { add(id, 'relatório montável', false, `faltam ${source.missing.join(', ')}`); continue; }
      console.log = () => undefined;
      let rendered;
      let model;
      try {
        model = buildReportModel({ source: source.source, campaign: await gmnRepository.getCampaignSummary(lead.campaignId), generatedAt: new Date().toISOString(), regenerated: true, environment: { simulatedProviders: [] } as never });
        rendered = await renderReportPdf(model, { basemap: { provider: noBasemapProvider, status: 'NONE', notice: NO_BASEMAP_NOTICE } });
      } finally {
        console.log = log;
      }
      const stored = model.judge.scoreLines.find((l) => l.key === 'STORED_HISTORICAL');
      add(id, 'PDF recomposto em memória (legado)', rendered.pageCount > 0 && rendered.buffer.subarray(0, 5).toString() === '%PDF-', `${rendered.pageCount} páginas, ${rendered.buffer.byteLength} B`);
      add(id, 'relatório mostra o Score histórico gravado', stored?.value === raw?.overallScore, `linha histórica ${stored?.value}% = gravado ${raw?.overallScore}%`);

      const chain = await resolvePdfWithFallbacks(id, state.diagrammer as never, { supabase: null, bucket: null, regenerate: async () => null });
      add(id, 'PDF oficial servido do disco (cadeia de leitura)', chain.status === 200 && chain.source === 'local', chain.status === 200 ? `fonte ${chain.source}, ${chain.body.byteLength} B` : chain.error);
    }
  } finally {
    guard.restore();
  }

  const after = await snapshot();
  const changed = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]);
  add('(todas)', 'nenhuma linha/arquivo alterado', changed.length === 0, changed.length === 0 ? `${Object.keys(before).length} conjuntos idênticos` : `alterados: ${changed.join(', ')}`);
  add('(todas)', 'nenhuma chamada externa', guard.blocked.length === 0, `bloqueadas: ${guard.blocked.length}; chamadas ao Supabase (leitura): ${guard.allowed}`);

  for (const c of checks) console.log(`${c.passed ? 'OK    ' : 'FALHOU'} ${c.auditId.padEnd(8)} ${c.check.padEnd(58)} ${c.detail}`);
  const failed = checks.filter((c) => !c.passed);
  const out = path.join(process.cwd(), '.data', 'migration');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ before, after, checks }, null, 2));
  console.log(`\n${failed.length === 0 ? 'RECUPERAÇÃO VALIDADA' : `${failed.length} verificação(ões) FALHARAM`}: ${checks.length} verificações.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
