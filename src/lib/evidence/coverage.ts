import type { JudgeTechnicalSheet } from '@/types/gmn';
import { toBattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { computeJudgeScores, type JudgeScoreSummary } from '@/lib/judge-scoring';
import { assessCriteria } from '@/lib/pdf/report-evidence';
import type { ReportSourceData } from '@/lib/pdf/report-types';
import type { EvidenceStatus } from './types';

/**
 * Cobertura de evidências de uma auditoria, para o dashboard e o PDF.
 *
 * Auditorias da Fase 4 trazem `scoreSummary` pronto. Auditorias anteriores são reavaliadas de forma
 * conservadora (a classe mais fraca entre a regra antiga e a atual), sem alterar nada do que foi
 * gravado e sem promover critérios a "verificados".
 */
export function resolveEvidenceCoverage(
  source: Omit<ReportSourceData, 'auditId' | 'strategist'> & { readonly auditId?: string }
): JudgeScoreSummary | null {
  const judge: JudgeTechnicalSheet = source.judge;
  if (judge.scoreSummary) return judge.scoreSummary;
  try {
    const data = { ...source, auditId: source.auditId ?? '' } as ReportSourceData;
    const model = toBattlefieldMapModel({ battlefield: data.battlefield, lead: data.lead });
    const criteria = assessCriteria(data, model);
    const statusOf = (cls: string): EvidenceStatus =>
      cls === 'VERIFIED' ? 'VERIFIED' : cls === 'PARTIAL' ? 'PARTIALLY_VERIFIED' : cls === 'SIMULATED' ? 'SIMULATED' : 'NOT_VERIFIED';
    return computeJudgeScores(
      criteria.map((item) => ({
        itemNumber: item.itemNumber,
        maxWeight: item.weight,
        scoreAwarded: item.agentScore,
        evidenceStatus: statusOf(item.evidenceClass),
      }))
    );
  } catch {
    return null;
  }
}
