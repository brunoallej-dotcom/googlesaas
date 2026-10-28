import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import type { CriterionAssessment } from './report-evidence';
import { formatNumber, formatPercent } from './report-format';
import type { RivalRow, ScoreBreakdown, TerritoryAnalysis } from './report-metrics';
import type { DataOrigin, ReportSourceData } from './report-types';

export interface Diagnosis {
  readonly situation: readonly string[];
  readonly strengths: readonly string[];
  readonly opportunities: readonly string[];
  readonly risks: readonly string[];
  readonly priority: string;
  /** Áreas cujos dados não foram comprovados: ficam visíveis, nunca escondidas. */
  readonly toValidate: readonly string[];
}

/**
 * Diagnóstico por regras, escrito só com fatos comprovados desta empresa. Texto de agentes
 * (resumo executivo do Estrategista) não é usado: ele cita dados simulados como se fossem reais.
 */
export function buildDiagnosis(params: {
  readonly data: ReportSourceData;
  readonly criteria: readonly CriterionAssessment[];
  readonly model: BattlefieldMapModel;
  readonly territory: TerritoryAnalysis;
  readonly rivalRows: readonly RivalRow[];
  readonly score: ScoreBreakdown;
  readonly keyword: string;
  readonly territoryOrigin: DataOrigin;
}): Diagnosis {
  const { data, criteria, model, territory, rivalRows, score, keyword, territoryOrigin } = params;
  const { lead } = data;
  const geoVerified = territoryOrigin === 'COLLECTED' && model.coverage.valid > 0;
  const leader = rivalRows[0];

  const situation: string[] = [
    `Na busca por "${keyword}", a empresa apareceu na posição ${lead.frontierRank} (${lead.frontierPage}ª página) da prospecção na cidade.`,
  ];
  if (geoVerified) {
    const ranked = model.coverage.valid - model.counts.above20;
    situation.push(
      `Na grade de 49 pontos, aparece entre as 20 primeiras posições em ${ranked} de ${model.coverage.valid} pontos válidos (${formatPercent((ranked / model.coverage.valid) * 100)}), com índice de posição ${model.averagePosition === null ? 'não disponível' : formatNumber(model.averagePosition)} (pontos fora do Top 20 contam como 21${model.knownPositionAverage === null ? '' : `; média nos pontos do Top 20: ${formatNumber(model.knownPositionAverage)}`}).`
    );
  } else {
    situation.push(
      territoryOrigin === 'SIMULATED'
        ? 'Os pontos do território desta auditoria são simulados e não sustentam conclusões sobre o posicionamento.'
        : 'Nenhum ponto do território teve leitura válida nesta auditoria: não há conclusões sobre o posicionamento.'
    );
  }

  const strengths = criteria
    .filter((c) => c.evidenceClass === 'VERIFIED' && c.displayStatus === 'APPROVED' && c.evidence)
    .map((c) => c.evidence as string);

  const opportunities: string[] = [];
  if (geoVerified) {
    const reachable = model.counts.top4to7 + model.counts.rank8to20;
    if (reachable > 0) {
      opportunities.push(
        `${reachable} ${reachable === 1 ? 'ponto tem' : 'pontos têm'} a empresa entre as posições 4 e 20: é a oportunidade mais próxima de conversão em Top 3.`
      );
    }
  }
  const volume = criteria.find((c) => c.code === 'REP_11_VOLUME_VS_LEADER');
  if (volume?.evidenceClass === 'VERIFIED' && leader?.totalReviews != null && leader.totalReviews > lead.totalReviews) {
    opportunities.push(
      `Há ${leader.totalReviews - lead.totalReviews} avaliações de diferença para o líder territorial (${leader.name}): ${lead.totalReviews} contra ${leader.totalReviews}.`
    );
  }
  const site = criteria.find((c) => c.code === 'NAP_05_OWN_WEBSITE');
  if (site?.evidenceClass === 'VERIFIED' && lead.websiteStatus === 'SOCIAL_LINK_ONLY') {
    opportunities.push('A listagem aponta apenas para uma rede social: um site em domínio próprio é uma oportunidade de presença digital.');
  }
  if (opportunities.length === 0) {
    opportunities.push('As oportunidades mais relevantes dependem de dados ainda não comprovados (ver "Dados a validar").');
  }

  const risks: string[] = [];
  if (geoVerified && model.percentages.above20 !== null && model.percentages.above20 >= 50) {
    risks.push(
      `Em ${formatPercent(model.percentages.above20)} dos pontos válidos a empresa não aparece entre as 20 primeiras posições: a visibilidade territorial é baixa.`
    );
  }
  if (leader && leader.pointsLed > 0) {
    risks.push(
      `O concorrente ${leader.name} lidera ${leader.pointsLed} pontos (${formatPercent(leader.dominanceSharePercent)} da grade).`
    );
  }
  if (territory.companyPointLabel === 'acima de 20') {
    risks.push('No ponto da grade que coincide com a localização da empresa, ela não aparece entre as 20 primeiras posições.');
  }
  risks.push(
    `Esta auditoria é parcialmente verificada: ${score.verified.count} de ${score.totalCriteria} critérios têm evidência real (${formatPercent(score.verified.weightPercent, 0)} do peso).`
  );

  let priority: string;
  if (!geoVerified) {
    priority = 'Repetir a coleta territorial com dados reais antes de definir prioridades.';
  } else if (model.percentages.above20 !== null && model.percentages.above20 >= 50) {
    priority =
      'Ampliar a presença territorial: priorizar os pontos em que a empresa já aparece e fortalecer, com clientes reais, o volume de avaliações.';
  } else if (model.percentages.top3 !== null && model.percentages.top3 < 35) {
    priority = 'Converter a presença intermediária (posições 4 a 20) em Top 3.';
  } else {
    priority = 'Manter o desempenho atual e ampliar gradualmente o território coberto.';
  }

  const toValidate = score.groups
    .filter((group) => group.verifiedCount < group.criteria.length)
    .map((group) => {
      const simulated = group.criteria.filter((c) => c.evidenceClass === 'SIMULATED').length;
      const unverified = group.criteria.filter((c) => c.evidenceClass === 'NOT_VERIFIED').length;
      const parts = [
        simulated > 0 ? `${simulated} simulado${simulated > 1 ? 's' : ''}` : null,
        unverified > 0 ? `${unverified} não verificado${unverified > 1 ? 's' : ''}` : null,
      ].filter(Boolean);
      return `${group.label}: ${parts.join(' e ')} (${group.verifiedCount} de ${group.criteria.length} comprovados).`;
    });

  return { situation, strengths, opportunities, risks, priority, toValidate };
}
