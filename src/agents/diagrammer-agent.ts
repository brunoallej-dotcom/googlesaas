import type {
  BattlefieldMetrics,
  DiagrammerOutput,
  FrontierLead,
  JudgeTechnicalSheet,
  ReputationMetrics,
  ReviewerAuditResult,
  RivalsMetrics,
  StrategistOutput,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import { gmnRepository, getSupabaseAdmin } from '@/lib/supabase';
import { buildReportModel } from '@/lib/pdf/report-model';
import { buildPdfFileName, persistReportPdf } from '@/lib/pdf/persist';
import { renderReportPdf } from '@/lib/pdf/report-renderer';
import { detectProviderEnvironment } from '@/lib/pdf/report-source';

/**
 * ============================================================================
 * AGENTE 8: DIAGRAMADOR
 * Compila os resultados já produzidos pelos demais agentes em um dossiê PDF.
 *
 * A montagem do documento vive em `src/lib/pdf/*` (dados, validação, indicadores, mapa e
 * componentes visuais separados). O dossiê identifica a origem de cada dado (comprovado, não
 * verificado ou simulado) e nunca reexecuta coletas: usa somente os resultados recebidos.
 * ============================================================================
 */
export class DiagrammerAgent {
  private readonly logger = new StructuredLogger('DIAGRAMMER');

  public async compileAuditPdf(params: {
    readonly auditId: string;
    readonly lead: FrontierLead;
    readonly reputation: ReputationMetrics;
    readonly vitrine: VitrineMetrics;
    readonly battlefield: BattlefieldMetrics;
    readonly rivals: RivalsMetrics;
    readonly judge: JudgeTechnicalSheet;
    readonly strategist: StrategistOutput;
    /** Mantido por compatibilidade com o Maestro; o dossiê não imprime o log do Revisor. */
    readonly reviewerLogs: readonly ReviewerAuditResult[];
  }): Promise<DiagrammerOutput> {
    const { auditId, lead, reputation, vitrine, battlefield, rivals, judge, strategist } = params;

    this.logger.info('Iniciando compilação do dossiê PDF (Agente Diagramador)', {
      auditId,
      placeId: lead.placeId,
      businessName: lead.businessName,
    });

    // Cidade/UF/nicho vêm da campanha (o lead não os traz). Sem campanha, o relatório usa o endereço.
    const campaign = await gmnRepository.getCampaignSummary(lead.campaignId).catch(() => null);

    const model = buildReportModel({
      source: { auditId, lead, reputation, vitrine, battlefield, rivals, judge, strategist },
      campaign,
      generatedAt: new Date().toISOString(),
      environment: detectProviderEnvironment(),
    });

    const failedChecks = model.quality.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      this.logger.warn('Controles de qualidade do relatório com falha', {
        auditId,
        failed: failedChecks.map((check) => ({ id: check.id, detail: check.detail })),
      });
    }

    const rendered = await renderReportPdf(model);
    const pdfFileName = buildPdfFileName(lead.businessName, auditId);
    const persisted = await persistReportPdf(
      // `GMN_PDF_OUTPUT_DIR` (opcional) redireciona a gravação; o padrão é a pasta privada `.data/audits`.
      { auditId, pdfFileName, buffer: rendered.buffer, ...(process.env.GMN_PDF_OUTPUT_DIR?.trim() ? { outputDir: process.env.GMN_PDF_OUTPUT_DIR.trim() } : {}) },
      // Cópia durável só em bucket PRIVADO e opcional; nada vai ao bucket público.
      { supabase: getSupabaseAdmin(), bucket: process.env.SUPABASE_PRIVATE_AUDIT_BUCKET ?? null }
    );
    if (persisted.uploadError) {
      this.logger.warn('PDF gravado localmente, mas o envio ao bucket falhou', {
        auditId,
        uploadError: persisted.uploadError,
      });
    }

    const output: DiagrammerOutput = {
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
    };

    this.logger.info('Dossiê PDF compilado e disponibilizado para download', {
      auditId,
      pdfFileName,
      pageCount: output.pageCount,
      fileSizeBytes: output.fileSizeBytes,
      coverage: model.coverage.summary,
      basemap: rendered.basemapStatus,
      pdfDownloadUrl: output.pdfDownloadUrl,
    });

    return output;
  }
}

export const diagrammerAgent = new DiagrammerAgent();
