import type {
  BattlefieldMetrics,
  BullMQAuditJobPayload,
  CompleteAuditDossier,
  MathematicalDiscrepancy,
  ReputationMetrics,
  ReviewerAuditResult,
  StrategistOutput,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import { gmnRepository } from '@/lib/supabase';
import { reputationAgent } from './reputation-agent';
import { vitrineAgent } from './vitrine-agent';
import { battlefieldAgent } from './battlefield-agent';
import { rivalsAgent } from './rivals-agent';
import { judgeAgent } from './judge-agent';
import { strategistAgent } from './strategist-agent';
import { reviewerAgent } from './reviewer-agent';
import { diagrammerAgent } from './diagrammer-agent';
import { checkWebsite } from '@/lib/site-check';
import type { ProviderFailure } from '@/lib/evidence/types';
import { assertNoSimulatedDataOutsideDemo } from '@/lib/evidence/guards';

/**
 * ============================================================================
 * AGENTE MAESTRO — MOTOR DE ORQUESTRAÇÃO DE AUDITORIA
 * Dispara a cadeia de 8 agentes em paralelo controlado e sequência estrita:
 * - Fase 1 (Paralelo Controlado): Reputação + Vitrine + Campo de Batalha (49 pontos)
 * - Fase 2 (Sequencial Dependente): Rivais (alimentado pelos #1 da grade) -> Juiz (21 itens + Regra SAB)
 * - Fase 3 (Loop Determinístico de Qualidade): Estrategista <-> Revisor (até 3 iterações)
 * - Fase 4 (Compilação Final): Diagramador (gera PDF e persiste URL de download)
 * ============================================================================
 */
export class MaestroOrchestrator {
  private readonly logger = new StructuredLogger('MAESTRO');

  /**
   * Resultados já gravados de uma tentativa anterior da MESMA auditoria. O Battlefield só é
   * reaproveitado se estiver completo (49 pontos) e pertencer à mesma empresa.
   */
  private async loadReusableResults(
    auditId: string,
    placeId: string
  ): Promise<{ reputation?: ReputationMetrics; vitrine?: VitrineMetrics; battlefield?: BattlefieldMetrics }> {
    const state = await gmnRepository.getAuditState(auditId);
    if (!state) return {};
    const battlefield = state.battlefield as BattlefieldMetrics | undefined;
    const reputation = state.reputation as ReputationMetrics | undefined;
    const vitrine = state.vitrine as VitrineMetrics | undefined;
    const battlefieldComplete =
      battlefield !== undefined &&
      battlefield.placeId === placeId &&
      Array.isArray(battlefield.points) &&
      battlefield.points.length === 49;
    return {
      ...(reputation ? { reputation } : {}),
      ...(vitrine ? { vitrine } : {}),
      ...(battlefieldComplete ? { battlefield } : {}),
    };
  }

  public async runAuditPipeline(
    payload: BullMQAuditJobPayload,
    onProgressCallback?: (percent: number, stageLabel: string) => Promise<void>
  ): Promise<CompleteAuditDossier> {
    const startedAt = new Date().toISOString();
    const { auditId, lead, targetKeyword, interestCenter, gridZoom, gridStepMeters } = payload;

    this.logger.info('Maestro iniciou pipeline de auditoria assíncrona', {
      auditId,
      placeId: lead.placeId,
      businessName: lead.businessName,
      targetKeyword,
    });

    try {
      // ----------------------------------------------------------------------
      // FASE 1: Extração Paralela Controlada (Reputação, Vitrine e Campo de Batalha 49 pts)
      // ----------------------------------------------------------------------
      await gmnRepository.updateAuditProgress(
        auditId,
        'RUNNING_EXTRACTION',
        15,
        'BATTLEFIELD'
      );
      if (onProgressCallback) {
        await onProgressCallback(15, 'Executando Reputação, Vitrine e Matriz 49 Pontos');
      }

      const cityGuessed =
        lead.businessName.split('-').pop()?.trim() ?? 'Anápolis';

      // A verificação técnica do site não tem custo de API e nunca interrompe a auditoria
      // (qualquer falha vira "não verificado" no critério correspondente).
      // Retomada explícita: o que já foi coletado e gravado NÃO é consultado de novo (sem custo extra).
      const reusable = payload.resume ? await this.loadReusableResults(auditId, lead.placeId) : {};
      if (payload.resume) {
        this.logger.info('Retomada: reaproveitando resultados persistidos', {
          auditId,
          reuse: {
            reputation: Boolean(reusable.reputation),
            vitrine: Boolean(reusable.vitrine),
            battlefield: Boolean(reusable.battlefield),
          },
        });
      }

      const [siteCheck, reputation, vitrine, battlefield] = await Promise.all([
        checkWebsite(lead.websiteStatus === 'OWN_DOMAIN' ? lead.websiteUrl : null),
        reusable.reputation ?? reputationAgent.analyze(lead, auditId),
        reusable.vitrine ?? vitrineAgent.analyze(lead, auditId),
        reusable.battlefield ?? battlefieldAgent.executeBattlefieldGrid({
          auditId,
          lead,
          rawKeyword: targetKeyword,
          city: cityGuessed,
          interestCenter,
          zoomLevel: gridZoom,
          stepMeters: gridStepMeters,
        }),
      ]);

      // Nenhum dado simulado entra como evidência real em auditorias novas (só no modo demonstração).
      assertNoSimulatedDataOutsideDemo({ placeId: lead.placeId, reputation, vitrine, battlefield });

      await gmnRepository.updateAuditProgress(
        auditId,
        'RUNNING_RIVALS_AND_JUDGE',
        55,
        'RIVALS',
        {
          reputation,
          vitrine,
          battlefield,
        }
      );
      if (onProgressCallback) {
        await onProgressCallback(55, 'Consolidando Rivais #1 da Grade e Checklist 21 Itens do Juiz');
      }

      // ----------------------------------------------------------------------
      // FASE 2: Agente de Rivais + Agente Juiz (21 Itens com Regra de Exceção SAB)
      // ----------------------------------------------------------------------
      const rivals = await rivalsAgent.analyze({
        auditId,
        lead,
        battlefield,
        reputation,
        vitrine,
      });

      // Falhas de provedores ficam registradas junto das evidências, sem derrubar dados válidos.
      const providerFailures: ProviderFailure[] = [
        ...(battlefield.providerFailures ?? []),
        ...(reputation.reviewsAvailability?.state === 'UNAVAILABLE' && reputation.reviewsAvailability.provider
          ? [
              {
                provider: reputation.reviewsAvailability.provider,
                operation: 'avaliações datadas',
                reason: reputation.reviewsAvailability.reason ?? 'Falha desconhecida.',
                at: reputation.reviewsAvailability.collectedAt ?? reputation.extractedAt,
              },
            ]
          : []),
      ];

      const judge = judgeAgent.evaluate({
        auditId,
        lead,
        reputation,
        vitrine,
        battlefield,
        rivals,
        siteCheck,
        providerFailures,
      });

      await gmnRepository.updateAuditProgress(
        auditId,
        'RUNNING_STRATEGIST',
        72,
        'STRATEGIST',
        {
          rivals,
          judge,
        }
      );
      if (onProgressCallback) {
        await onProgressCallback(72, 'Sintetizando Diagnóstico e Ondas Táticas P0–P3');
      }

      // ----------------------------------------------------------------------
      // FASE 3: Loop Autônomo Estrategista <-> Revisor (Auditoria Matemática)
      // ----------------------------------------------------------------------
      const maxReviewIterations = 3;
      const reviewerLogs: ReviewerAuditResult[] = [];
      let previousDiscrepancies: readonly MathematicalDiscrepancy[] = [];
      let strategistOutput: StrategistOutput | null = null;

      for (let iteration = 1; iteration <= maxReviewIterations; iteration++) {
        strategistOutput = await strategistAgent.synthesizeStrategy({
          auditId,
          lead,
          reputation,
          vitrine,
          battlefield,
          rivals,
          judge,
          revisionAttempt: iteration,
          previousDiscrepancies,
        });

        await gmnRepository.updateAuditProgress(
          auditId,
          'RUNNING_REVIEWER',
          82,
          'REVIEWER',
          {
            strategist: strategistOutput,
          }
        );

        const reviewAudit = reviewerAgent.auditMathematically({
          auditId,
          judgeSheet: judge,
          strategistOutput,
          iterationNumber: iteration,
        });

        reviewerLogs.push(reviewAudit);

        if (reviewAudit.approved) {
          this.logger.info('Agente Revisor aprovou 100% da paridade matemática do Estrategista', {
            auditId,
            iteration,
          });
          break;
        }

        previousDiscrepancies = reviewAudit.discrepancies;
        this.logger.warn(
          'Divergência matemática detectada pelo Revisor — devolvendo ao Estrategista',
          {
            auditId,
            iteration,
            discrepancies: reviewAudit.discrepancies,
          }
        );
      }

      if (!strategistOutput) {
        throw new Error('Falha crítica: Estrategista não produziu saída.');
      }

      // ----------------------------------------------------------------------
      // FASE 4: Agente Diagramador (Compilação PDF de Alta Conversão)
      // ----------------------------------------------------------------------
      await gmnRepository.updateAuditProgress(
        auditId,
        'RUNNING_DIAGRAMMER',
        92,
        'DIAGRAMMER',
        {
          strategist: strategistOutput,
          reviewerLogs,
        }
      );
      if (onProgressCallback) {
        await onProgressCallback(92, 'Diagramando Documento PDF de Alta Conversão');
      }

      const diagrammer = await diagrammerAgent.compileAuditPdf({
        auditId,
        lead,
        reputation,
        vitrine,
        battlefield,
        rivals,
        judge,
        strategist: strategistOutput,
        reviewerLogs,
      });

      const completedAt = new Date().toISOString();

      await gmnRepository.updateAuditProgress(auditId, 'COMPLETED', 100, 'MAESTRO', {
        diagrammer,
      });
      if (onProgressCallback) {
        await onProgressCallback(100, 'Auditoria Concluída e PDF Disponível');
      }

      const dossier: CompleteAuditDossier = {
        auditId,
        lead,
        targetKeyword,
        status: 'COMPLETED',
        progressPercent: 100,
        currentAgent: 'MAESTRO',
        reputation,
        vitrine,
        battlefield,
        rivals,
        judge,
        strategist: strategistOutput,
        reviewerLogs,
        diagrammer,
        startedAt,
        completedAt,
      };

      this.logger.info('Pipeline Maestro finalizado com sucesso de ponta a ponta', {
        auditId,
        pdfDownloadUrl: diagrammer.pdfDownloadUrl,
      });

      return dossier;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Falha na execução do Pipeline Maestro', {
        auditId,
        errorMessage,
      });

      try {
        await gmnRepository.markAuditFailed(auditId, errorMessage);
      } catch (persistError: unknown) {
        this.logger.error('Falha ao registrar erro da auditoria no Supabase', {
          auditId,
          persistError: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
      throw error;
    }
  }
}

export const maestroOrchestrator = new MaestroOrchestrator();
