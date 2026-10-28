/**
 * Regenera o PDF de uma auditoria JÁ CONCLUÍDA a partir dos resultados persistidos.
 * NÃO reexecuta Battlefield, Serper nem LLM: só lê o banco e desenha o documento.
 *
 * Uso:
 *   npm run pdf:regenerate -- <auditId> [--out <pasta>] [--store] [--reevaluate] [--check-site]
 *
 * --reevaluate  Reavalia o Juiz e o Estrategista (Fase 4) a partir dos mesmos resultados guardados,
 *               sem nenhuma consulta externa, e usa essa ficha SÓ no PDF gerado. O que está gravado
 *               na auditoria nunca é alterado; sem --reevaluate o PDF reavalia a classificação de
 *               forma conservadora e mantém a pontuação histórica gravada.
 *
 * --check-site Com --reevaluate, faz UMA verificação técnica pública do site do lead (requisições HTTP
 *               GET ao próprio site, sem API paga) e a usa nos critérios 3, 4 e 5 do PDF gerado.
 *
 * Por padrão grava fora do armazenamento oficial (./.cache/pdf-regenerated). Com --store,
 * grava uma NOVA revisão (-r2…) na pasta privada, sem sobrescrever o PDF anterior, e atualiza o ponteiro.
 * O mapa-base segue as variáveis GMN_PDF_BASEMAP* (desligado por padrão).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const store = args.includes('--store');
  const reevaluate = args.includes('--reevaluate');
  const checkSite = args.includes('--check-site');
  if (checkSite && !reevaluate) {
    console.error('--check-site só vale junto de --reevaluate.');
    process.exit(1);
  }
  if (store && reevaluate) {
    console.error('--store e --reevaluate não podem ser usados juntos: a ficha reavaliada nunca substitui a gravada.');
    process.exit(1);
  }
  const outValue = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const auditId = args.find((arg, index) => !arg.startsWith('--') && index !== outIndex + 1);
  if (!auditId) {
    console.error('Uso: npm run pdf:regenerate -- <auditId> [--out <pasta>] [--store]');
    process.exit(1);
  }
  const outDir = outValue ?? path.join(process.cwd(), '.cache', 'pdf-regenerated');

  // Importações depois do loadEnvConfig: os módulos leem o ambiente ao carregar.
  const { gmnRepository, getSupabaseAdmin } = await import('@/lib/supabase');
  const { buildReportModel } = await import('@/lib/pdf/report-model');
  const { buildPdfFileName, persistReportPdf } = await import('@/lib/pdf/persist');
  const { renderReportPdf } = await import('@/lib/pdf/report-renderer');
  const { detectProviderEnvironment, reportSourceFromAuditState } = await import('@/lib/pdf/report-source');

  const audit = await gmnRepository.getAuditForReport(auditId);
  if (!audit) throw new Error(`Auditoria ${auditId} não encontrada (ou Supabase não configurado).`);
  const lead = await gmnRepository.getLeadById(audit.leadId);
  if (!lead) throw new Error(`Lead ${audit.leadId} da auditoria não encontrado.`);

  const result = reportSourceFromAuditState(audit.state, lead);
  if (!result.ok) throw new Error(`Resultados incompletos para o relatório: faltam ${result.missing.join(', ')}.`);

  let source = result.source;
  if (reevaluate) {
    const { reevaluateForReport } = await import('@/lib/pdf/reevaluate');
    const log = console.log;
    console.log = () => undefined; // os agentes registram logs JSON
    try {
      let siteCheck = null;
      if (checkSite) {
        const { checkWebsite } = await import('@/lib/site-check');
        siteCheck = await checkWebsite(lead.websiteStatus === 'OWN_DOMAIN' ? lead.websiteUrl : null);
        log(`  verificação do site: ${siteCheck.status}${siteCheck.httpStatus ? ` (HTTP ${siteCheck.httpStatus})` : ''}${siteCheck.failureReason ? ` — ${siteCheck.failureReason}` : ''}`);
        log(`    URL final: ${siteCheck.finalUrl ?? '—'} | noindex: ${siteCheck.noindex} | robots.txt: ${siteCheck.robotsTxt} | LocalBusiness: ${siteCheck.localBusiness ? siteCheck.localBusiness.types.join(', ') : 'não encontrado'}`);
        log(`    contatos públicos: ${siteCheck.telLinks.length} tel, ${siteCheck.whatsappLinks.length} WhatsApp, ${siteCheck.emailLinks.length} e-mail`);
      }
      // O Score Juiz histórico GRAVADO é preservado ao lado da pontuação recalculada.
      source = await reevaluateForReport({ source, lead, siteCheck });
    } finally {
      console.log = log;
    }
    console.log('  (ficha do Juiz e plano REAVALIADOS para este PDF; a auditoria gravada não foi alterada)');
  }

  const campaign = await gmnRepository.getCampaignSummary(lead.campaignId);
  const model = buildReportModel({
    source,
    campaign,
    generatedAt: new Date().toISOString(),
    regenerated: true,
    environment: detectProviderEnvironment(),
  });
  const rendered = await renderReportPdf(model);
  const pdfFileName = buildPdfFileName(lead.businessName, auditId);

  console.log(`Auditoria ${auditId}`);
  console.log(`  coleta: ${model.meta.collectedAt} | geração: ${model.meta.generatedAt}`);
  console.log(`  ${model.coverage.stamp}: ${model.coverage.summary}`);
  for (const line of model.judge.scoreLines) {
    console.log(`  ${line.label}: ${line.value === null ? 'não disponível' : `${line.value}%`} (denominador: peso ${line.denominatorWeight}, ${line.denominatorPercent}% do total)`);
  }
  console.log(`  páginas: ${rendered.pageCount} | mapa-base: ${rendered.basemapStatus}${rendered.mapNotice ? ` (${rendered.mapNotice})` : ''}`);
  for (const check of model.quality.filter((c) => !c.passed)) console.warn(`  CONTROLE FALHOU: ${check.label} ${check.detail ?? ''}`);

  if (store) {
    const persisted = await persistReportPdf(
      { auditId, pdfFileName, buffer: rendered.buffer },
      { supabase: getSupabaseAdmin(), bucket: process.env.SUPABASE_PRIVATE_AUDIT_BUCKET ?? null }
    );
    await gmnRepository.saveRegeneratedPdf(auditId, {
      auditId,
      pdfFileName: persisted.fileName,
      pdfStoragePath: persisted.localPath,
      pdfDownloadUrl: persisted.downloadUrl,
      pageCount: rendered.pageCount,
      fileSizeBytes: rendered.buffer.byteLength,
      generatedAt: model.meta.generatedAt,
      ...(model.meta.collectedAt ? { dataCollectedAt: model.meta.collectedAt } : {}),
      evidenceCoverage: {
        verifiedCriteria: model.coverage.verifiedCriteria,
        totalCriteria: model.coverage.totalCriteria,
        verifiedWeightPercent: model.coverage.verifiedWeightPercent,
      },
    });
    console.log(`  ARMAZENADO (nova revisão, sem sobrescrever): ${persisted.localPath}${persisted.uploadError ? ` | upload falhou: ${persisted.uploadError}` : ''}`);
  } else {
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, pdfFileName);
    await fs.writeFile(file, rendered.buffer);
    console.log(`  gravado (fora do armazenamento oficial): ${file}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
