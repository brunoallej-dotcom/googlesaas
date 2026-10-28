/**
 * Teste SINTÉTICO do Maestro + Worker com escrita real no banco e LIMPEZA imediata.
 *
 *   npm run g5:smoke                              (executa e limpa)
 *   npm run g5:smoke -- --cleanup-only <campanha> (só limpa uma campanha de teste interrompida)
 *
 * Prova que, depois da migration de RLS, a service_role continua inserindo, atualizando (trigger
 * updated_at), gravando rodada e 49 pontos do Battlefield e concluindo a auditoria, usando o
 * `processAuditJob` do Worker (claim atômico) e o pipeline do Maestro.
 *
 * Garantias: campanha de teste identificada (cidade "__G5_SMOKE__"); o Serper é SIMULADO (qualquer host
 * fora do Supabase é bloqueado; 0 chamadas externas); o PDF vai para pasta temporária; nenhum objeto é
 * enviado ao Storage; a limpeza roda em `finally`, apaga SÓ por ID exato (as FKs ON DELETE CASCADE
 * removem leads, auditoria, rodada e pontos) e o antes/depois das 5 tabelas precisa ser IDÊNTICO.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

const MARKER_CITY = '__G5_SMOKE__';
const MARKER_KEYWORD = '__g5_smoke__';

async function main(): Promise<void> {
  const cleanupOnly = process.argv.includes('--cleanup-only') ? process.argv[process.argv.indexOf('--cleanup-only') + 1] : undefined;
  const { getSupabaseAdmin, gmnRepository } = await import('@/lib/supabase');
  const { dumpRows, diffRows } = await import('@/lib/pdf/migration-rows');
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase não configurado.');
  const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;

  const readTable = async (table: string): Promise<Record<string, unknown>[]> => {
    const { data, error } = await supabase.from(table).select('*').order('id', { ascending: true }).limit(5000);
    if (error) throw new Error(`Falha ao ler ${table}: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  };

  /** Apaga a campanha de teste por ID exato (só se for mesmo uma campanha de teste) e confirma que nada restou. */
  const cleanup = async (campaignId: string): Promise<string[]> => {
    const problems: string[] = [];
    const { data: campaign } = await supabase.from('prospecting_campaigns').select('id, city').eq('id', campaignId).maybeSingle();
    if (campaign) {
      if (campaign.city !== MARKER_CITY) throw new Error(`Recuso apagar ${campaignId}: não é uma campanha de teste (cidade "${String(campaign.city)}").`);
      const { error } = await supabase.from('prospecting_campaigns').delete().eq('id', campaignId);
      if (error) problems.push(`falha ao apagar a campanha de teste: ${error.message}`);
    }
    const { data: leads } = await supabase.from('gmn_leads').select('id').eq('campaign_id', campaignId);
    const leadIds = (leads ?? []).map((l) => String(l.id));
    const { data: audits } = leadIds.length ? await supabase.from('gmn_audits').select('id').in('lead_id', leadIds) : { data: [] as { id: string }[] };
    if (leadIds.length || (audits ?? []).length) problems.push(`restaram ${leadIds.length} lead(s) e ${(audits ?? []).length} auditoria(s) de teste`);
    return problems;
  };

  if (cleanupOnly) {
    const left = await cleanup(cleanupOnly);
    console.log(left.length === 0 ? `Limpeza concluída: nada restou da campanha ${cleanupOnly}.` : `PROBLEMAS: ${left.join('; ')}`);
    process.exit(left.length === 0 ? 0 : 1);
  }

  // ---- ambiente isolado só deste processo (o .env.local não é tocado) ----
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-g5-smoke-'));
  process.env.GMN_PDF_OUTPUT_DIR = tempDir;
  process.env.SUPABASE_PRIVATE_AUDIT_BUCKET = ''; // nada vai ao Storage
  process.env.SERPER_API_KEY = 'chave-falsa-g5-smoke';
  process.env.SERPER_MAPS_URL = 'https://google.serper.dev/maps';
  process.env.BATTLEFIELD_POINT_RETRIES = '1';
  for (const key of ['GMN_DEMO_MODE', 'GMN_REVIEWS_PROVIDER', 'GMN_PDF_BASEMAP', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']) delete process.env[key];

  const campaignId = randomUUID();
  const auditId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const { buildReportFixtureLead } = await import('@/dev/report-fixture');
  const leads = Array.from({ length: 10 }, (_, i) =>
    buildReportFixtureLead({
      id: randomUUID(), campaignId, placeId: `ChIJ_G5_SMOKE_${suffix}_${i}`, cid: `9${suffix.replace(/\D/g, '1')}${i}`, featureId: `0xg5:0x${i}`,
      businessName: `G5 SMOKE ${i + 1}`, frontierRank: 11 + i, websiteStatus: 'MISSING', websiteUrl: null,
    })
  );
  const target = leads[0]!;

  // ---- guarda de rede: Supabase passa; Serper é SIMULADO; todo o resto é bloqueado ----
  const realFetch = globalThis.fetch;
  const blocked: string[] = [];
  let serperMockCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    if (host === supabaseHost) return realFetch(input as never, init);
    if (url.startsWith('https://google.serper.dev/maps')) {
      serperMockCalls += 1;
      return new Response(JSON.stringify({ places: [
        { position: 1, placeId: 'ChIJ_G5_CONCORRENTE', title: 'Concorrente de Teste', type: target.primaryCategory, rating: 4.7, ratingCount: 210, website: 'https://exemplo.invalid' },
        { position: 5, placeId: target.placeId, cid: target.cid, title: target.businessName },
      ] }), { status: 200 });
    }
    blocked.push(`${init?.method ?? 'GET'} ${host}`);
    throw new Error(`Chamada externa bloqueada pelo teste sintético: ${host}`);
  }) as typeof fetch;

  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const check = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };
  let before: Awaited<ReturnType<typeof dumpRows>> | null = null;
  let fatal: string | null = null;
  const log = console.log;
  try {
    before = await dumpRows(readTable);
    check('antes: despejo das 5 tabelas', true, Object.entries(before.tables).map(([t, r]) => `${t}=${Object.keys(r).length}`).join(' '));

    await gmnRepository.saveProspectingCampaign({
      campaignId, city: MARKER_CITY, stateCode: 'GO', nicheKeyword: MARKER_KEYWORD,
      centerCoordinates: target.coordinates, leads, executedAt: new Date().toISOString(),
    });
    check('INSERT: campanha e 10 leads de teste', true, `campanha ${campaignId.slice(0, 8)}`);

    const payload = { auditId, lead: target, targetKeyword: MARKER_KEYWORD, interestCenter: target.coordinates, gridZoom: '15z', gridStepMeters: 500 };
    await gmnRepository.createAuditJob(payload);
    check('INSERT: auditoria QUEUED (createAuditJob)', true, `auditoria ${auditId.slice(0, 8)}`);

    const { processAuditJob } = await import('@/workers/audit-worker');
    const progress: number[] = [];
    const job = { id: 'g5-smoke', data: payload, updateProgress: async (value: unknown) => { progress.push((value as { percent: number }).percent); } };
    console.log = () => undefined; // os agentes registram JSON
    const first = await processAuditJob(job as never);
    const second = await processAuditJob(job as never); // job duplicado/reentregue
    console.log = log;
    check('Worker: claim atômico + Maestro concluem a auditoria', 'status' in first && first.status === 'COMPLETED', `progresso ${progress.join('→')}`);
    check('Worker: job duplicado é ignorado (claim CAS)', 'skipped' in second && second.skipped === true, JSON.stringify(second));
    check('Serper simulado (49 pontos), 0 chamadas externas', serperMockCalls === 49 && blocked.length === 0, `simulado ${serperMockCalls}, bloqueadas ${blocked.length}`);

    const state = await gmnRepository.getAuditState(auditId);
    const points = (state?.battlefield as { points?: unknown[] } | undefined)?.points?.length ?? 0;
    check('UPDATE: estado final COMPLETED com 49 pontos e PDF', state?.status === 'COMPLETED' && points === 49 && Boolean(state?.diagrammer), `status ${String(state?.status)}, pontos ${points}`);
    const { data: auditRow } = await supabase.from('gmn_audits').select('created_at, updated_at').eq('id', auditId).maybeSingle();
    check('trigger updated_at disparou', Boolean(auditRow) && Date.parse(String(auditRow!.updated_at)) > Date.parse(String(auditRow!.created_at)), `${String(auditRow?.created_at)} → ${String(auditRow?.updated_at)}`);
    const { data: rounds } = await supabase.from('gmn_battlefield_rounds').select('id').eq('audit_id', auditId);
    const roundId = rounds?.[0]?.id;
    const { count: pointCount } = roundId ? await supabase.from('gmn_battlefield_points').select('id', { count: 'exact', head: true }).eq('round_id', roundId) : { count: 0 };
    check('INSERT: 1 rodada e 49 pontos do Battlefield', (rounds ?? []).length === 1 && pointCount === 49, `rodadas ${(rounds ?? []).length}, pontos ${String(pointCount)}`);
  } catch (error: unknown) {
    fatal = error instanceof Error ? error.message : String(error);
  } finally {
    console.log = log;
    globalThis.fetch = realFetch;
    let leftovers: string[] = [];
    try { leftovers = await cleanup(campaignId); } catch (error: unknown) { leftovers = [error instanceof Error ? error.message : String(error)]; }
    check('limpeza: nenhuma linha de teste restou', leftovers.length === 0, leftovers.join('; ') || 'campanha, leads, auditoria, rodada e pontos removidos por ID exato');
    for (const file of await fs.readdir(tempDir).catch(() => [])) await fs.unlink(path.join(tempDir, file)).catch(() => undefined);
    await fs.rmdir(tempDir).catch(() => undefined);
  }

  if (before) {
    const after = await dumpRows(readTable);
    const diff = diffRows(before, after);
    check('depois: as 5 tabelas idênticas ao antes (campo a campo)', diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0, `alteradas ${diff.changed.length}, novas ${diff.added.length}, removidas ${diff.removed.length}`);
  }
  if (fatal) check('execução sem erro', false, fatal);

  for (const c of checks) log(`${c.passed ? 'OK    ' : 'FALHOU'} ${c.name.padEnd(62)} ${c.detail}`);
  const failed = checks.filter((c) => !c.passed);
  log(failed.length === 0 ? '\nTESTE SINTÉTICO APROVADO (nada restou no banco).' : `\n${failed.length} verificação(ões) FALHARAM. Se restou algo: npm run g5:smoke -- --cleanup-only ${campaignId}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
