import { judgeAgent } from '@/agents/judge-agent';
import { strategistAgent } from '@/agents/strategist-agent';
import type { FrontierLead } from '@/types/gmn';
import type { SiteCheckResult } from '@/lib/site-check';
import type { ReportSourceData } from './report-types';

/**
 * Reavalia o Juiz e o Estrategista (regras da Fase 4) a partir dos MESMOS resultados já gravados,
 * somente para gerar um documento. Nada é gravado e nenhuma coleta é refeita.
 *
 * O Score Juiz histórico gravado (metodologia original) é preservado em `storedJudge`; a nova
 * pontuação é, por definição, RECALCULADA e sai identificada como tal (ver `buildScoreLines`).
 * Fichas que já são da Fase 4 não têm score histórico a preservar.
 */
export async function reevaluateForReport(params: {
  readonly source: ReportSourceData;
  readonly lead: FrontierLead;
  readonly siteCheck?: SiteCheckResult | null;
}): Promise<ReportSourceData> {
  const { source, lead } = params;
  const judge = judgeAgent.evaluate({
    auditId: source.auditId,
    lead,
    reputation: source.reputation,
    vitrine: source.vitrine,
    battlefield: source.battlefield,
    rivals: source.rivals,
    siteCheck: params.siteCheck ?? null,
    ...(source.testFixture ? { syntheticTestData: true } : {}),
  });
  const strategist = await strategistAgent.synthesizeStrategy({
    auditId: source.auditId,
    lead,
    reputation: source.reputation,
    vitrine: source.vitrine,
    battlefield: source.battlefield,
    rivals: source.rivals,
    judge,
    revisionAttempt: 1,
  });
  const storedJudge =
    source.judge.scoreMethod === undefined
      ? { storedJudge: { overallScore: source.judge.overallScore, evaluatedAt: source.judge.evaluatedAt } }
      : source.storedJudge
        ? { storedJudge: source.storedJudge }
        : {};
  return { ...source, judge, strategist, ...storedJudge };
}
