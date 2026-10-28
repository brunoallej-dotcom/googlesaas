import { gmnRepository } from '@/lib/supabase';
import { buildReportModel } from './report-model';
import { renderReportPdf } from './report-renderer';
import { detectProviderEnvironment, reportSourceFromAuditState } from './report-source';
import { safeDownloadName } from './serve';
import { buildPdfFileName } from './persist';

/**
 * Recompõe o PDF de uma auditoria concluída a partir dos resultados JÁ persistidos (sem Serper, sem
 * LLM, sem consultas externas). Usado quando o arquivo local sumiu (ex.: disco substituído). O
 * arquivo NÃO é gravado: nada é sobrescrito e o PDF original continua sendo o oficial.
 */
export async function regeneratePdfFromDatabase(auditId: string): Promise<{
  readonly body: Buffer<ArrayBuffer>;
  readonly headers: Record<string, string>;
} | null> {
  const audit = await gmnRepository.getAuditForReport(auditId);
  if (!audit) return null;
  const lead = await gmnRepository.getLeadById(audit.leadId);
  if (!lead) return null;
  const result = reportSourceFromAuditState(audit.state, lead);
  if (!result.ok) return null;

  const campaign = await gmnRepository.getCampaignSummary(lead.campaignId);
  const model = buildReportModel({
    source: result.source,
    campaign,
    generatedAt: new Date().toISOString(),
    regenerated: true,
    environment: detectProviderEnvironment(),
  });
  const rendered = await renderReportPdf(model);
  return {
    body: rendered.buffer as Buffer<ArrayBuffer>,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeDownloadName(buildPdfFileName(lead.businessName, auditId).replace(/\.pdf$/, '-regenerado.pdf'))}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-GMN-PDF-Regenerated': 'true',
    },
  };
}
