import type { CriterionAssessment } from './report-evidence';
import { formatDateTime, formatNumber, formatPercent, formatRating } from './report-format';
import {
  CLASS_STYLES,
  Canvas,
  CONTENT_WIDTH,
  PAGE,
  REPORT_COLORS,
  card,
  chip,
  classBadge,
  drawBullets,
  drawClassIcon,
  measureBullets,
  progressBar,
  sectionHeading,
  stackedBar,
} from './report-layout';
import type { GroupSummary } from './report-metrics';
import type { ReportModel } from './report-model';
import type { PlanAction, PlanWave } from './report-plan';
import { truncate } from './report-pages';
import type { CriterionDisplayStatus, EvidenceClass, SimulationOrigin } from './report-types';

const X = PAGE.marginX;
const W = CONTENT_WIDTH;

function subHeading(canvas: Canvas, title: string): void {
  canvas.line(title.toUpperCase(), X, canvas.y, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  canvas.doc.rect(X, canvas.y + 11, 22, 1.6).fillColor(REPORT_COLORS.primary).fill();
  canvas.y += 20;
}

/* -------------------------------------------------------------------------- */
/* Inteligência concorrencial                                                 */
/* -------------------------------------------------------------------------- */

const RIVAL_COLS = { rank: 22, name: 196, points: 70, share: 118, rating: 50, reviews: 59 } as const;

export function drawCompetitionPage(canvas: Canvas, model: ReportModel): void {
  canvas.newPage();
  canvas.mark('Inteligência concorrencial');
  sectionHeading(
    canvas,
    'Inteligência concorrencial',
    'Quem domina o território medido e como a empresa se compara. Só entram dados efetivamente coletados; estimativas não são exibidas.'
  );
  canvas.y += 4;
  const { doc } = canvas;
  const { rivals } = model.competition;

  // --- Dominadores do território
  subHeading(canvas, 'Dominadores do território');
  if (rivals.length === 0) {
    card(doc, X, canvas.y, W, 44, { fill: REPORT_COLORS.notVerifiedBg, border: REPORT_COLORS.borderStrong, radius: 8 });
    canvas.paragraph('Nenhum concorrente líder foi identificado nas leituras válidas desta auditoria.', X + 16, canvas.y + 16, W - 32, {
      size: 8.4, color: REPORT_COLORS.notVerified,
    });
    canvas.y += 56;
  } else {
    const rowH = 28;
    const headY = canvas.y;
    doc.roundedRect(X, headY, W, 18, 6).fillColor(REPORT_COLORS.bgSoft).fill();
    const heads: readonly (readonly [string, number])[] = [
      ['#', X + 10],
      ['CONCORRENTE', X + RIVAL_COLS.rank + 6],
      ['PONTOS LIDERADOS', X + RIVAL_COLS.rank + RIVAL_COLS.name + 6],
      ['DOMÍNIO DO TERRITÓRIO', X + RIVAL_COLS.rank + RIVAL_COLS.name + RIVAL_COLS.points + 6],
      ['NOTA', X + RIVAL_COLS.rank + RIVAL_COLS.name + RIVAL_COLS.points + RIVAL_COLS.share + 6],
      ['AVALIAÇÕES', X + RIVAL_COLS.rank + RIVAL_COLS.name + RIVAL_COLS.points + RIVAL_COLS.share + RIVAL_COLS.rating + 2],
    ];
    for (const [label, hx] of heads) canvas.line(label, hx, headY + 6, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
    let y = headY + 22;
    for (const rival of rivals) {
      const x1 = X + RIVAL_COLS.rank;
      const x2 = x1 + RIVAL_COLS.name;
      const x3 = x2 + RIVAL_COLS.points;
      const x4 = x3 + RIVAL_COLS.share;
      const x5 = x4 + RIVAL_COLS.rating;
      const nameText = truncate(rival.name, 70);
      const nameStyle = { weight: 'semibold', size: 8.2, color: REPORT_COLORS.navy, lineGap: 1.2 } as const;
      const nameLines = canvas.measure(nameText, RIVAL_COLS.name - 12, nameStyle) > 12 ? 2 : 1;
      const mid = y + 8;
      canvas.line(String(rival.rank), X + 10, mid, { weight: 'bold', size: 9, color: REPORT_COLORS.primary });
      canvas.paragraph(nameText, x1 + 6, nameLines === 1 ? mid : y + 3, RIVAL_COLS.name - 12, nameStyle);
      canvas.line(`${rival.pointsLed} ${rival.pointsLed === 1 ? 'ponto' : 'pontos'}`, x2 + 6, mid, { weight: 'medium', size: 8.2 });
      progressBar(doc, x3 + 6, mid + 2, 66, 5, rival.dominanceSharePercent, REPORT_COLORS.danger);
      canvas.line(formatPercent(rival.dominanceSharePercent), x3 + 78, mid, { weight: 'semibold', size: 7.8 });
      if (rival.ratingVerified && rival.rating !== null && rival.totalReviews !== null) {
        canvas.line(formatRating(rival.rating), x4 + 6, mid, { weight: 'semibold', size: 8.2 });
        canvas.line(String(rival.totalReviews), x5 + 2, mid, { weight: 'semibold', size: 8.2 });
      } else {
        classBadge(canvas, x4 + 2, mid - 3, 'NOT_VERIFIED', 'NÃO VERIF.');
      }
      doc.moveTo(X, y + rowH - 3).lineTo(X + W, y + rowH - 3).lineWidth(0.5).strokeColor(REPORT_COLORS.border).stroke();
      y += rowH;
    }
    y += 2;
    const note = model.competition.estimatedFieldsHidden
      ? 'Nota e avaliações: valores da listagem pública. Quando coincidem com o valor padrão do sistema (nota 4,8 e 140 avaliações), são marcados como não verificados. Fotos, ritmo de avaliações e taxa de resposta dos concorrentes não são exibidos porque o sistema os estima.'
      : 'Nota e avaliações: valores da listagem pública; sem valor informado, aparece "não verificado". Fotos, ritmo de avaliações e taxa de resposta dos concorrentes não são coletados e, por isso, não são exibidos.';
    const nh = canvas.paragraph(note, X, y, W, { size: 6.8, color: REPORT_COLORS.muted, lineGap: 1.3 });
    canvas.y = y + nh + 14;
  }

  // --- Visibilidade por região
  canvas.ensure(150);
  subHeading(canvas, 'Visibilidade por região da grade');
  const sectors = model.territory.analysis.sectors.filter((sector) => sector.points > 0);
  const sy = canvas.y;
  doc.roundedRect(X, sy, W, 18, 6).fillColor(REPORT_COLORS.bgSoft).fill();
  const sectorCols = { label: 130, points: 58, bar: 160, top3: 48, top7: 48, avg: 71 } as const;
  const sx = [X + 10, X + 10 + sectorCols.label, X + 10 + sectorCols.label + sectorCols.points, X + 10 + sectorCols.label + sectorCols.points + sectorCols.bar, X + 10 + sectorCols.label + sectorCols.points + sectorCols.bar + sectorCols.top3, X + 10 + sectorCols.label + sectorCols.points + sectorCols.bar + sectorCols.top3 + sectorCols.top7] as const;
  ['REGIÃO', 'PONTOS', 'COM PRESENÇA (ATÉ A 20ª POSIÇÃO)', 'TOP 3', 'TOP 7', 'POSIÇÃO MÉDIA'].forEach((label, i) => {
    canvas.line(label, sx[i] as number, sy + 6, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
  });
  let ry = sy + 22;
  for (const sector of sectors) {
    const share = sector.valid > 0 ? (sector.ranked / sector.valid) * 100 : 0;
    canvas.line(sector.label, sx[0], ry + 3, { weight: 'semibold', size: 8, color: REPORT_COLORS.navy });
    canvas.line(`${sector.valid} de ${sector.points}`, sx[1], ry + 3, { size: 8 });
    progressBar(doc, sx[2], ry + 5, 104, 5, share, REPORT_COLORS.primary);
    canvas.line(`${sector.ranked} de ${sector.valid}`, sx[2] + 112, ry + 3, { weight: 'medium', size: 7.6 });
    canvas.line(String(sector.top3), sx[3] + 4, ry + 3, { weight: 'semibold', size: 8 });
    canvas.line(String(sector.top7), sx[4] + 4, ry + 3, { weight: 'semibold', size: 8 });
    canvas.line(sector.averageRankedPosition === null ? '—' : formatNumber(sector.averageRankedPosition), sx[5] + 4, ry + 3, { weight: 'semibold', size: 8 });
    doc.moveTo(X, ry + 17).lineTo(X + W, ry + 17).lineWidth(0.5).strokeColor(REPORT_COLORS.border).stroke();
    ry += 21;
  }
  const sh = canvas.paragraph(
    'Regiões relativas à grade (norte no topo do mapa). As faixas se sobrepõem nos cantos e o centro da grade é um bloco 3 x 3. Nenhum nome de bairro é atribuído por aproximação.',
    X, ry + 2, W, { size: 6.8, color: REPORT_COLORS.muted, lineGap: 1.3 }
  );
  canvas.y = ry + sh + 16;

  // --- Reputação x líder
  const comparison = model.competition.comparison;
  const compText = comparison ?? 'Não verificado: a comparação de nota e avaliações com o líder territorial exige valores coletados de ambos, e eles não estão disponíveis nesta auditoria.';
  canvas.ensure(70);
  subHeading(canvas, 'Comparativo de reputação com o líder');
  const ch = canvas.measure(compText, W - 130, { size: 8.4, lineGap: 1.6 });
  card(doc, X, canvas.y, W, ch + 20, { fill: comparison ? '#FFFFFF' : REPORT_COLORS.notVerifiedBg, border: comparison ? REPORT_COLORS.border : REPORT_COLORS.borderStrong, radius: 8 });
  classBadge(canvas, X + 12, canvas.y + 9, comparison ? 'VERIFIED' : 'NOT_VERIFIED');
  canvas.paragraph(compText, X + 124, canvas.y + 10, W - 140, { size: 8.4, lineGap: 1.6 });
  canvas.y += ch + 34;

  // --- Oportunidades
  const opp = model.competition.opportunities;
  canvas.ensure(30 + measureBullets(canvas, opp, W, { size: 8.4, lineGap: 1.6 }));
  subHeading(canvas, 'Oportunidades territoriais prioritárias');
  canvas.y += drawBullets(canvas, opp, X, canvas.y, W, { size: 8.4, lineGap: 1.6 }, REPORT_COLORS.accent) + 12;

  // --- Histórico
  canvas.ensure(80);
  subHeading(canvas, 'Comparação histórica');
  const hh = canvas.measure(model.competition.historyText, W - 56, { weight: 'medium', size: 8.6, lineGap: 1.6 });
  card(doc, X, canvas.y, W, hh + 24, {
    fill: model.competition.hasRealHistory ? REPORT_COLORS.verifiedBg : REPORT_COLORS.bgSoft,
    border: model.competition.hasRealHistory ? '#BFE5CB' : REPORT_COLORS.border,
    radius: 8,
  });
  drawClassIcon(doc, model.competition.hasRealHistory ? 'VERIFIED' : 'NOT_VERIFIED', X + 20, canvas.y + 12 + hh / 2, 5);
  canvas.paragraph(model.competition.historyText, X + 38, canvas.y + 12, W - 56, { weight: 'medium', size: 8.6, lineGap: 1.6 });
  canvas.y += hh + 36;
}

/* -------------------------------------------------------------------------- */
/* Agente Juiz: checklist dos 21 critérios                                    */
/* -------------------------------------------------------------------------- */

const STATUS_CHIPS: Record<'APPROVED' | 'PARTIAL' | 'CRITICAL', { label: string; color: string; bg: string }> = {
  APPROVED: { label: 'APROVADO', color: REPORT_COLORS.verified, bg: REPORT_COLORS.verifiedBg },
  PARTIAL: { label: 'PARCIAL', color: '#9A6B00', bg: '#FFF4D6' },
  CRITICAL: { label: 'CRÍTICO', color: '#B42318', bg: '#FDECEC' },
};

const BAR_COLOR: Record<'APPROVED' | 'PARTIAL' | 'CRITICAL', string> = {
  APPROVED: REPORT_COLORS.success,
  PARTIAL: REPORT_COLORS.warning,
  CRITICAL: REPORT_COLORS.danger,
};

const SIMULATED_BADGE: Record<SimulationOrigin, string> = {
  LEGACY: 'SIMULADO (LEGADO) — NÃO É DADO REAL',
  DEMO: 'SIMULADO (DEMONSTRAÇÃO) — NÃO É REAL',
  FIXTURE: 'SINTÉTICO (TESTE) — NÃO É DADO REAL',
};

const JUDGE_RIGHT_W = 196;
const JUDGE_TEXT_X = X + 38;
const JUDGE_TEXT_W = W - 38 - JUDGE_RIGHT_W - 14;

/**
 * Limitação a imprimir em cada critério comprovado. Calculada uma vez por documento, sem repetir o
 * mesmo texto em critérios seguidos (por exemplo, os três critérios territoriais).
 */
let verifiedLimitations: ReadonlyMap<number, string> = new Map();

function planVerifiedLimitations(criteria: readonly CriterionAssessment[]): ReadonlyMap<number, string> {
  const seen = new Set<string>();
  const plan = new Map<number, string>();
  for (const item of criteria) {
    const limit = item.evidenceClass === 'VERIFIED' ? item.limitations.find((entry) => !seen.has(entry)) : undefined;
    if (limit) {
      seen.add(limit);
      plan.set(item.itemNumber, limit);
    }
  }
  return plan;
}

/** Garante ponto final em um trecho, para poder encadear frases sem quebra de linha. */
function sentence(text: string | null | undefined): string {
  const clean = (text ?? '').trim();
  return clean.length === 0 || /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function criterionLines(item: CriterionAssessment): { readonly detail: string; readonly detailColor: string; readonly action: string; readonly actionLabel: string } {
  const source = item.source ? ` Fonte: ${item.source}.` : '';
  if (item.evidenceClass === 'VERIFIED') {
    const limit = verifiedLimitations.get(item.itemNumber);
    return { detail: `Evidência: ${sentence(item.evidence)}${limit ? ` Limitação: ${sentence(limit)}` : ''}${source}`, detailColor: REPORT_COLORS.muted, action: item.recommendation, actionLabel: 'Recomendação' };
  }
  if (item.evidenceClass === 'PARTIAL') {
    const limit = item.limitations[0] ? ` Limitação: ${sentence(item.limitations[0])}` : '';
    return {
      detail: `Comprovado em parte: ${sentence(item.evidence)}${limit}${source}`,
      detailColor: REPORT_COLORS.partial,
      action: item.recommendation,
      actionLabel: 'Como confirmar',
    };
  }
  return { detail: `Por que não foi comprovado: ${item.reason ?? ''}`, detailColor: item.evidenceClass === 'SIMULATED' ? REPORT_COLORS.simulated : REPORT_COLORS.notVerified, action: item.recommendation, actionLabel: 'Como validar' };
}

function measureCriterion(canvas: Canvas, item: CriterionAssessment): number {
  const lines = criterionLines(item);
  const title = canvas.measure(item.title, JUDGE_TEXT_W, { weight: 'semibold', size: 8.2, lineGap: 1.2 });
  const detail = canvas.measure(lines.detail, JUDGE_TEXT_W, { size: 7.4, lineGap: 1.3 });
  const action = canvas.measure(`${lines.actionLabel}: ${lines.action}`, JUDGE_TEXT_W, { size: 7.4, lineGap: 1.3 });
  return Math.max(title + detail + action + 22, 44);
}

function drawCriterion(canvas: Canvas, item: CriterionAssessment, y: number, height: number): void {
  const { doc } = canvas;
  const lines = criterionLines(item);
  const style = CLASS_STYLES[item.evidenceClass];
  // número do critério
  doc.circle(X + 14, y + 14, 9).fillColor(item.evidenceClass === 'VERIFIED' ? REPORT_COLORS.navy : style.bg).fill();
  if (item.evidenceClass !== 'VERIFIED') doc.circle(X + 14, y + 14, 9).lineWidth(0.8).dash(1.6, { space: 1.2 }).strokeColor(style.color).stroke();
  doc.undash();
  const num = String(item.itemNumber);
  canvas.line(num, X + 14 - canvas.width(num, { weight: 'bold', size: 7.6 }) / 2, y + 10.6, { weight: 'bold', size: 7.6, color: item.evidenceClass === 'VERIFIED' ? '#FFFFFF' : style.color });

  let ty = y + 4;
  ty += canvas.paragraph(item.title, JUDGE_TEXT_X, ty, JUDGE_TEXT_W, { weight: 'semibold', size: 8.2, color: REPORT_COLORS.navy, lineGap: 1.2 }) + 3;
  ty += canvas.paragraph(lines.detail, JUDGE_TEXT_X, ty, JUDGE_TEXT_W, { size: 7.4, color: lines.detailColor, lineGap: 1.3 }) + 2.5;
  canvas.paragraph(`${lines.actionLabel}: ${lines.action}`, JUDGE_TEXT_X, ty, JUDGE_TEXT_W, { size: 7.4, color: REPORT_COLORS.text, lineGap: 1.3 });

  // coluna da direita: status, peso e (só comprovados) barra de pontuação
  const rx = X + W - JUDGE_RIGHT_W;
  if (item.evidenceClass === 'VERIFIED' && item.agentScore !== null && (item.displayStatus === 'APPROVED' || item.displayStatus === 'PARTIAL' || item.displayStatus === 'CRITICAL')) {
    const status = STATUS_CHIPS[item.displayStatus];
    chip(canvas, rx, y + 4, status.label, { color: status.color, bg: status.bg, size: 6.4 });
    canvas.line(`peso ${item.weight}`, rx + 74, y + 7, { size: 6.6, color: REPORT_COLORS.muted });
    progressBar(doc, rx, y + 24, 118, 5, item.agentScore, BAR_COLOR[item.displayStatus]);
    canvas.line(`${formatNumber(item.agentScore, 0)}%`, rx + 126, y + 21.8, { weight: 'semibold', size: 7.6 });
  } else if (item.evidenceClass === 'PARTIAL') {
    // Parcialmente verificado: sem verde/vermelho; a pontuação, quando existe, é só indicativa.
    classBadge(canvas, rx, y + 4, 'PARTIAL', 'PARCIALMENTE VERIFICADO');
    canvas.line(
      item.agentScore === null ? `peso ${item.weight} · sem pontuação` : `peso ${item.weight} · pontuação indicativa ${formatNumber(item.agentScore, 0)}%`,
      rx, y + 23, { size: 6.6, color: REPORT_COLORS.muted }
    );
  } else {
    classBadge(
      canvas,
      rx,
      y + 4,
      item.evidenceClass,
      item.evidenceClass === 'SIMULATED' ? SIMULATED_BADGE[item.simulationOrigin ?? 'LEGACY'] : 'NÃO VERIFICADO — EVIDÊNCIA INDISPONÍVEL'
    );
    canvas.line(`peso ${item.weight} · sem pontuação comprovada`, rx, y + 23, { size: 6.6, color: REPORT_COLORS.muted });
  }
  doc.moveTo(X, y + height - 2).lineTo(X + W, y + height - 2).lineWidth(0.5).strokeColor(REPORT_COLORS.border).stroke();
}

function drawGroupHeader(canvas: Canvas, group: GroupSummary, y: number): void {
  const { doc } = canvas;
  doc.roundedRect(X, y, W, 24, 7).fillColor(REPORT_COLORS.navy).fill();
  canvas.line(group.label, X + 14, y + 8, { weight: 'bold', size: 9, color: '#FFFFFF' });
  const partialCount = group.criteria.filter((c) => c.evidenceClass === 'PARTIAL').length;
  const count = `${group.verifiedCount} de ${group.criteria.length} comprovados${partialCount > 0 ? ` · ${partialCount} em parte` : ''}`;
  canvas.line(count, X + W - 14 - canvas.width(count, { weight: 'medium', size: 7.4 }), y + 8.6, { weight: 'medium', size: 7.4, color: '#B9CAE6' });
}

export function drawJudgePages(canvas: Canvas, model: ReportModel): void {
  canvas.newPage();
  canvas.mark('Agente Juiz: checklist de 21 critérios');
  sectionHeading(
    canvas,
    'Agente Juiz: checklist técnico de 21 critérios',
    'Cada critério mostra a pontuação, a evidência e a recomendação somente quando há dado comprovado. Sem comprovação, o critério fica neutro: nem aprovado nem reprovado. Critérios parcialmente verificados aparecem à parte e não entram no desempenho verificado.'
  );
  canvas.y += 2;
  const { doc } = canvas;
  const { score } = model.judge;
  verifiedLimitations = planVerifiedLimitations(model.judge.criteria);

  // Fórmula e cobertura
  const boxH = 92;
  card(doc, X, canvas.y, W, boxH, { fill: '#F7FAFF', border: '#D5E3F8', radius: 9 });
  canvas.line('COMO O SCORE É CALCULADO', X + 16, canvas.y + 12, { weight: 'bold', size: 6.6, color: REPORT_COLORS.primary, characterSpacing: 0.6 });
  canvas.paragraph(
    `Média ponderada: soma de (pontuação do critério x peso do critério) dividida pela soma dos pesos (${score.totalWeight}). Os pesos vão de 3 a 6 por critério e vêm do próprio agente Juiz. Abaixo, a mesma fórmula aplicada só aos critérios comprovados.`,
    X + 16, canvas.y + 25, 300, { size: 7.6, color: REPORT_COLORS.text, lineGap: 1.5 }
  );
  canvas.line('DESEMPENHO NOS CRITÉRIOS VERIFICADOS', X + 340, canvas.y + 12, { weight: 'bold', size: 6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
  canvas.line(score.verified.performance === null ? 'Não disponível' : formatPercent(score.verified.performance), X + 340, canvas.y + 24, { weight: 'bold', size: 22, color: REPORT_COLORS.navy });
  canvas.line(`${score.verified.count} de ${score.totalCriteria} critérios · ${formatPercent(score.verified.weightPercent, 0)} do peso`, X + 340, canvas.y + 52, { size: 7.4, color: REPORT_COLORS.muted });
  stackedBar(doc, X + 16, canvas.y + 70, W - 32, 7, [
    { value: score.verified.weight, color: REPORT_COLORS.success },
    { value: score.partial.weight, color: REPORT_COLORS.warning },
    { value: score.notVerified.weight, color: '#A9B6C9' },
    { value: score.simulated.weight, color: REPORT_COLORS.simulated, hatched: true },
  ]);
  canvas.y += boxH + 12;

  // Legenda dos status
  let lx = X;
  const ly = canvas.y;
  for (const key of ['APPROVED', 'PARTIAL', 'CRITICAL'] as const) {
    lx += chip(canvas, lx, ly, STATUS_CHIPS[key].label, { color: STATUS_CHIPS[key].color, bg: STATUS_CHIPS[key].bg, size: 6 }) + 5;
  }
  canvas.line('só para critérios comprovados', lx + 2, ly + 3, { size: 6.6, color: REPORT_COLORS.muted });
  canvas.y += 19;
  let bx = X;
  bx += classBadge(canvas, bx, canvas.y, 'PARTIAL') + 6;
  bx += classBadge(canvas, bx, canvas.y, 'NOT_VERIFIED') + 6;
  classBadge(canvas, bx, canvas.y, 'SIMULATED');
  canvas.y += 26;

  for (const group of score.groups) {
    const firstH = measureCriterion(canvas, group.criteria[0] as CriterionAssessment);
    canvas.ensure(34 + firstH);
    drawGroupHeader(canvas, group, canvas.y);
    canvas.y += 28;
    for (const item of group.criteria) {
      const h = measureCriterion(canvas, item);
      if (canvas.ensure(h)) {
        // Nova página no meio do grupo: repete o cabeçalho do grupo para dar contexto.
        drawGroupHeader(canvas, group, canvas.y);
        canvas.y += 28;
      }
      drawCriterion(canvas, item, canvas.y, h);
      canvas.y += h;
    }
    canvas.y += 12;
  }
}

/* -------------------------------------------------------------------------- */
/* Plano estratégico de ação                                                  */
/* -------------------------------------------------------------------------- */

/** Largura do indicador de acompanhamento (a coluna de confiança ocupa o canto direito). */
const indicatorWidth = (action: PlanAction): number => W - 190 - (action.confidence === undefined ? 16 : 76);

/** Altura do rodapé da ação: rótulo + valor (o indicador pode quebrar em duas linhas). */
function actionFooterHeight(canvas: Canvas, action: PlanAction): number {
  return 14 + Math.max(9, canvas.measure(action.indicator, indicatorWidth(action), { size: 7.2, lineGap: 1.2 })) + 3;
}

function measureAction(canvas: Canvas, action: PlanAction): number {
  const w = W - 32;
  return (
    8 +
    canvas.measure(action.title, w - 120, { weight: 'bold', size: 9, lineGap: 1.2 }) +
    4 +
    canvas.measure(`Objetivo: ${action.objective}`, w, { size: 7.8, lineGap: 1.3 }) +
    2 +
    canvas.measure(`Justificativa: ${action.justification}`, w - 14, { size: 7.8, lineGap: 1.3 }) +
    5 +
    actionFooterHeight(canvas, action) +
    6
  );
}

function drawAction(canvas: Canvas, action: PlanAction, y: number): number {
  const { doc } = canvas;
  const height = measureAction(canvas, action);
  const hypothesis = action.kind === 'HYPOTHESIS' || action.kind === 'NOT_APPLICABLE';
  card(doc, X, y, W, height - 6, { fill: '#FFFFFF', border: hypothesis ? REPORT_COLORS.borderStrong : '#BFD6F7', radius: 8 });
  doc.roundedRect(X, y + 8, 3.2, height - 22, 1.6).fillColor(hypothesis ? '#A9B6C9' : REPORT_COLORS.primary).fill();
  const w = W - 32;
  let ty = y + 8;
  const th = canvas.paragraph(action.title, X + 16, ty, w - 120, { weight: 'bold', size: 9, color: REPORT_COLORS.navy, lineGap: 1.2 });
  const notApplicable = action.kind === 'NOT_APPLICABLE';
  const kindLabel = notApplicable ? 'NÃO APLICÁVEL' : hypothesis ? 'HIPÓTESE: VALIDAR ANTES' : 'AÇÃO COMPROVADA';
  const kw = canvas.width(kindLabel, { weight: 'semibold', size: 6.2, characterSpacing: 0.3 }) + 14;
  chip(canvas, X + W - 12 - kw, ty - 2, kindLabel, hypothesis || notApplicable ? { color: REPORT_COLORS.notVerified, bg: REPORT_COLORS.notVerifiedBg, size: 6.2, dashed: true } : { color: '#0F5FD0', bg: '#E4EFFF', size: 6.2 });
  ty += th + 4;
  ty += canvas.paragraph(`Objetivo: ${action.objective}`, X + 16, ty, w, { size: 7.8, color: REPORT_COLORS.text, lineGap: 1.3 }) + 2;
  drawClassIcon(doc, action.evidenceClass, X + 20, ty + 4.2, 3.4);
  ty += canvas.paragraph(`Justificativa: ${action.justification}`, X + 30, ty, w - 14, { size: 7.8, color: REPORT_COLORS.text, lineGap: 1.3 }) + 5;

  doc.moveTo(X + 16, ty).lineTo(X + W - 16, ty).lineWidth(0.5).strokeColor(REPORT_COLORS.border).stroke();
  canvas.line('PRIORIDADE', X + 16, ty + 5, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
  canvas.line(action.priority, X + 16, ty + 14, { weight: 'semibold', size: 7.4, color: REPORT_COLORS.navy });
  canvas.line('PRAZO', X + 100, ty + 5, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
  canvas.line(action.timeframe, X + 100, ty + 14, { weight: 'semibold', size: 7.4, color: REPORT_COLORS.navy });
  canvas.line('INDICADOR DE ACOMPANHAMENTO', X + 190, ty + 5, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
  canvas.paragraph(action.indicator, X + 190, ty + 14, indicatorWidth(action), { size: 7.2, color: REPORT_COLORS.text, lineGap: 1.2 });
  if (action.confidence !== undefined) {
    canvas.line('CONFIANÇA', X + W - 64, ty + 5, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.4 });
    canvas.line(`${Math.round(action.confidence * 100)}%`, X + W - 64, ty + 14, { weight: 'semibold', size: 7.4, color: REPORT_COLORS.navy });
  }
  return height;
}

function drawWaveHeader(canvas: Canvas, wave: PlanWave, y: number): void {
  const { doc } = canvas;
  doc.roundedRect(X, y, W, 32, 8).fillColor(REPORT_COLORS.navy).fill();
  canvas.line(`${wave.title} · ${wave.timeframe}`, X + 14, y + 7, { weight: 'bold', size: 9.6, color: '#FFFFFF' });
  canvas.line(wave.summary, X + 14, y + 21, { size: 7, color: '#B9CAE6' });
}

export function drawPlanPages(canvas: Canvas, model: ReportModel): void {
  // O plano aproveita o fim da página do Juiz quando sobra espaço, em vez de deixá-la quase vazia.
  canvas.startSection(320);
  canvas.mark('Plano estratégico de ação');
  sectionHeading(canvas, 'Plano estratégico de ação', 'Quatro ondas de trabalho, em ordem de prioridade, com o indicador que mostra se a ação funcionou.');
  const { doc } = canvas;
  const dh = canvas.measure(model.planDisclaimer, W - 36, { size: 7.8, lineGap: 1.4 });
  card(doc, X, canvas.y + 2, W, dh + 18, { fill: '#FFF8E1', border: '#F2DFA0', radius: 8 });
  canvas.paragraph(model.planDisclaimer, X + 18, canvas.y + 11, W - 36, { size: 7.8, color: '#6B5200', lineGap: 1.4 });
  canvas.y += dh + 32;

  for (const wave of model.plan) {
    const first = wave.actions[0];
    canvas.ensure(42 + (first ? measureAction(canvas, first) : 40));
    drawWaveHeader(canvas, wave, canvas.y);
    canvas.y += 40;
    if (wave.actions.length === 0) {
      canvas.paragraph('Nenhuma ação nesta onda com os dados comprovados desta auditoria.', X + 4, canvas.y, W - 8, { size: 8, color: REPORT_COLORS.muted });
      canvas.y += 20;
    }
    for (const action of wave.actions) {
      const h = measureAction(canvas, action);
      if (canvas.ensure(h)) {
        drawWaveHeader(canvas, { ...wave, summary: `${wave.summary} (continuação)` }, canvas.y);
        canvas.y += 40;
      }
      canvas.y += drawAction(canvas, action, canvas.y);
    }
    if (wave.maintain.length > 0) {
      const text = `Manter: ${wave.maintain.join(' ')}`;
      const mh = canvas.measure(text, W - 32, { size: 7.4, lineGap: 1.3 });
      canvas.ensure(mh + 16);
      card(doc, X, canvas.y, W, mh + 14, { fill: REPORT_COLORS.verifiedBg, border: REPORT_COLORS.verifiedBg, radius: 7 });
      drawClassIcon(doc, 'VERIFIED', X + 14, canvas.y + 7 + mh / 2, 3.6);
      canvas.paragraph(text, X + 26, canvas.y + 7, W - 40, { size: 7.4, color: REPORT_COLORS.verified, lineGap: 1.3 });
      canvas.y += mh + 22;
    }
    canvas.y += 6;
  }
}

/* -------------------------------------------------------------------------- */
/* Metodologia e fontes                                                       */
/* -------------------------------------------------------------------------- */

export interface BasemapDisclosure {
  readonly included: boolean;
  readonly attribution: string | null;
  readonly notice: string | null;
}

function keyValueGrid(canvas: Canvas, rows: readonly (readonly [string, string])[], columns = 2): void {
  const colW = (W - 14 * (columns - 1)) / columns;
  const heights = rows.map(([, value]) => 9 + canvas.measure(value, colW, { size: 8, weight: 'medium' }) + 6);
  for (let i = 0; i < rows.length; i += columns) {
    const group = rows.slice(i, i + columns);
    const h = Math.max(...heights.slice(i, i + columns));
    canvas.ensure(h);
    group.forEach(([label, value], j) => {
      const x = X + j * (colW + 14);
      canvas.line(label.toUpperCase(), x, canvas.y, { size: 5.8, color: REPORT_COLORS.muted, characterSpacing: 0.5 });
      canvas.paragraph(value, x, canvas.y + 8, colW, { size: 8, weight: 'medium', color: REPORT_COLORS.text });
    });
    canvas.y += h;
  }
}

function drawCriteriaTable(canvas: Canvas, model: ReportModel): void {
  const cols = { num: 26, title: 246, weight: 42, score: 96, cls: 105 } as const;
  const header = (y: number): void => {
    canvas.doc.roundedRect(X, y, W, 17, 6).fillColor(REPORT_COLORS.bgSoft).fill();
    const hx = [X + 8, X + cols.num + 4, X + cols.num + cols.title + 4, X + cols.num + cols.title + cols.weight + 4, X + cols.num + cols.title + cols.weight + cols.score + 4];
    // A coluna só se chama "histórica" quando as notas são as gravadas; reavaliadas, são recalculadas.
    const scoreHeader = model.judge.scoreLines.some((line) => line.key === 'RECALCULATED') ? 'PONTUAÇÃO RECALCULADA' : 'PONTUAÇÃO HISTÓRICA';
    ['Nº', 'CRITÉRIO', 'PESO', scoreHeader, 'CLASSE'].forEach((label, i) => {
      canvas.line(label, hx[i] as number, y + 5.5, { weight: 'semibold', size: 5.4, color: REPORT_COLORS.muted, characterSpacing: 0.35 });
    });
  };
  canvas.ensure(60);
  header(canvas.y);
  canvas.y += 20;
  for (const item of model.judge.criteria) {
    if (canvas.ensure(15)) {
      header(canvas.y);
      canvas.y += 20;
    }
    const y = canvas.y;
    const style = CLASS_STYLES[item.evidenceClass];
    canvas.line(String(item.itemNumber), X + 8, y + 2.5, { weight: 'semibold', size: 7.2, color: REPORT_COLORS.navy });
    canvas.line(item.title, X + cols.num + 4, y + 2.5, { size: 7.2, color: REPORT_COLORS.text }, cols.title - 10);
    canvas.line(String(item.weight), X + cols.num + cols.title + 8, y + 2.5, { size: 7.2 });
    canvas.line(item.agentScore === null ? 'sem pontuação' : `${formatNumber(item.agentScore, 0)}%`, X + cols.num + cols.title + cols.weight + 8, y + 2.5, { size: 7.2, color: item.evidenceClass === 'VERIFIED' ? REPORT_COLORS.text : REPORT_COLORS.muted });
    drawClassIcon(canvas.doc, item.evidenceClass, X + cols.num + cols.title + cols.weight + cols.score + 8, y + 6, 3.4);
    canvas.line(item.evidenceClass === 'PARTIAL' ? 'EM PARTE' : style.label, X + cols.num + cols.title + cols.weight + cols.score + 16, y + 3.2, { weight: 'semibold', size: 6.2, color: style.color, characterSpacing: 0.3 });
    canvas.doc.moveTo(X, y + 12.5).lineTo(X + W, y + 12.5).lineWidth(0.4).strokeColor(REPORT_COLORS.border).stroke();
    canvas.y += 14;
  }
  canvas.y += 8;
}

export function drawMethodologyPages(canvas: Canvas, model: ReportModel, basemap: BasemapDisclosure): void {
  // A metodologia aproveita o espaço que sobrou no fim do plano, em vez de abrir uma página quase vazia.
  canvas.startSection(240);
  canvas.mark('Metodologia e fontes');
  sectionHeading(canvas, 'Metodologia e fontes', 'Como os dados foram coletados, de onde vêm e o que esta auditoria consegue (e não consegue) afirmar.');
  canvas.y += 4;
  const { doc } = canvas;
  const map = model.territory.map;
  const m = model.methodology;

  // --- Coleta territorial
  subHeading(canvas, 'Coleta territorial');
  keyValueGrid(canvas, [
    ['Matriz geográfica', '7 x 7 = 49 coordenadas ao redor do endereço da empresa'],
    ['Passo entre pontos', `${m.stepMeters} m (cerca de ${formatNumber(m.radiusMeters / 1000, 1)} km do centro até a borda)`],
    ['Palavra-chave pesquisada', model.company.keyword],
    ['Zoom da consulta', m.zoomLevel],
    ['Coordenadas coletadas', `${map.coverage.collected} de ${map.coverage.expected}`],
    ['Leituras válidas / sem leitura', `${map.coverage.valid} válidas · ${map.coverage.unreadable} sem leitura (fora da média)`],
    ['Data e hora da coleta', formatDateTime(model.meta.collectedAt)],
    ['Data e hora de geração do documento', `${formatDateTime(model.meta.generatedAt)}${model.meta.regenerated ? ' (regenerado a partir de resultados já coletados; nenhuma nova coleta foi feita)' : ''}`],
  ]);
  canvas.y += 8;

  // --- Fontes e provedores
  canvas.ensure(70);
  subHeading(canvas, 'Fontes e provedores efetivamente usados');
  for (const provider of m.providers) {
    const style = CLASS_STYLES[provider.origin === 'COLLECTED' ? 'VERIFIED' : provider.origin === 'SIMULATED' ? 'SIMULATED' : 'NOT_VERIFIED'];
    const cls: EvidenceClass = provider.origin === 'COLLECTED' ? 'VERIFIED' : provider.origin === 'SIMULATED' ? 'SIMULATED' : 'NOT_VERIFIED';
    const th = canvas.measure(provider.statement, W - 250, { size: 7.8, lineGap: 1.4 });
    const h = Math.max(th, 14) + 12;
    canvas.ensure(h);
    canvas.paragraph(provider.area, X, canvas.y + 3, 140, { weight: 'semibold', size: 8, color: REPORT_COLORS.navy, lineGap: 1.2 });
    classBadge(canvas, X + 148, canvas.y + 1.5, cls, provider.origin === 'COLLECTED' ? 'COLETADO' : style.label);
    canvas.paragraph(provider.statement, X + 250, canvas.y + 3, W - 250, { size: 7.8, color: REPORT_COLORS.text, lineGap: 1.4 });
    doc.moveTo(X, canvas.y + h - 4).lineTo(X + W, canvas.y + h - 4).lineWidth(0.4).strokeColor(REPORT_COLORS.border).stroke();
    canvas.y += h;
  }
  const apiNote = 'Esta auditoria não usou a API oficial do Google Business Profile. Os dados do perfil vêm da listagem pública do Google Maps e não incluem informações internas do painel do proprietário.';
  canvas.y += 4;
  canvas.y += canvas.paragraph(apiNote, X, canvas.y, W, { size: 7.4, color: REPORT_COLORS.muted, lineGap: 1.3 }) + 12;

  // --- Pontuações do Juiz: cada uma com a sua origem, metodologia e denominador (nunca misturadas)
  canvas.ensure(170);
  subHeading(canvas, 'Pontuações do Juiz nesta auditoria');
  const introHeight = canvas.paragraph(
    'São números diferentes, calculados de formas diferentes. Só o primeiro (quando existe) é o Score Juiz histórico gravado pela metodologia original; os demais são recalculados e não devem ser comparados com ele.',
    X, canvas.y, W, { size: 7.6, color: REPORT_COLORS.muted, lineGap: 1.4 }
  );
  canvas.y += introHeight + 8;
  for (const line of model.judge.scoreLines) {
    const textX = X + 150;
    const colW = W - 150 - 14;
    const method = `Metodologia: ${line.methodology}`;
    const hMethod = canvas.measure(method, colW, { size: 7.2, lineGap: 1.3 });
    const hNote = canvas.measure(line.note, colW, { size: 7.2, lineGap: 1.3 });
    const boxH = Math.max(hMethod + hNote + 4 + 32, 66);
    canvas.ensure(boxH + 8);
    const stored = line.key === 'STORED_HISTORICAL';
    card(doc, X, canvas.y, W, boxH, { fill: stored ? '#FFF8E1' : '#F7FAFF', border: stored ? '#F2DFA0' : '#D5E3F8', radius: 9 });
    // rótulo ocupa a largura toda (nunca invade o texto); valor e denominador ficam na coluna da esquerda
    canvas.line(line.label.toUpperCase(), X + 14, canvas.y + 11, { weight: 'bold', size: 6, color: stored ? '#8A6500' : REPORT_COLORS.primary, characterSpacing: 0.4 }, W - 28);
    canvas.line(line.value === null ? 'Não disponível' : formatPercent(line.value), X + 14, canvas.y + 26, { weight: 'bold', size: line.value === null ? 12 : 21, color: REPORT_COLORS.navy });
    canvas.paragraph(`denominador: peso ${line.denominatorWeight} (${formatPercent(line.denominatorPercent, line.denominatorPercent % 1 === 0 ? 0 : 1)} do total)`, X + 14, canvas.y + 54, 126, { size: 6.4, color: REPORT_COLORS.muted });
    canvas.paragraph(method, textX, canvas.y + 26, colW, { size: 7.2, color: REPORT_COLORS.text, lineGap: 1.3 });
    canvas.paragraph(line.note, textX, canvas.y + 26 + hMethod + 4, colW, { size: 7.2, color: stored ? '#5E4700' : REPORT_COLORS.muted, lineGap: 1.3 });
    canvas.y += boxH + 8;
  }
  canvas.y += 4;
  drawCriteriaTable(canvas, model);

  // --- Limitações
  canvas.ensure(40 + measureBullets(canvas, m.limitations, W, { size: 7.9, lineGap: 1.5 }));
  subHeading(canvas, 'Limitações dos dados');
  canvas.y += drawBullets(canvas, m.limitations, X, canvas.y, W, { size: 7.9, lineGap: 1.5 }, REPORT_COLORS.warning) + 10;

  // --- Controles de qualidade
  canvas.ensure(30 + model.quality.length * 14);
  subHeading(canvas, 'Controles de qualidade aplicados antes da geração');
  for (const check of model.quality) {
    canvas.ensure(14);
    drawClassIcon(doc, check.passed ? 'VERIFIED' : 'NOT_VERIFIED', X + 5, canvas.y + 4.4, 3.6);
    const text = check.passed ? check.label : `${check.label}: ${check.detail ?? 'falhou'}`;
    canvas.line(text, X + 14, canvas.y + 1.4, { size: 7.6, color: check.passed ? REPORT_COLORS.text : '#B42318' }, W - 20);
    canvas.y += 12.5;
  }
  canvas.y += 6;

  // --- Atribuições e licenças
  const attributionLines = [
    basemap.included && basemap.attribution
      ? `Mapa-base: ${basemap.attribution}. Dados do mapa © colaboradores do OpenStreetMap, licença ODbL (openstreetmap.org/copyright).`
      : `${basemap.notice ?? 'Esta emissão não inclui mapa-base.'} Quando incluído, o mapa-base traz as atribuições exigidas pelo provedor.`,
    'Fonte tipográfica: Inter, licença SIL Open Font License 1.1.',
    'Google e Google Meu Negócio são marcas do Google LLC. A GMN Intelligence Platform não é afiliada nem endossada pelo Google.',
  ];
  canvas.ensure(30 + measureBullets(canvas, attributionLines, W, { size: 7.6, lineGap: 1.4 }));
  subHeading(canvas, 'Atribuições e licenças');
  canvas.y += drawBullets(canvas, attributionLines, X, canvas.y, W, { size: 7.6, lineGap: 1.4 }, REPORT_COLORS.accent) + 4;
}

export type { CriterionDisplayStatus };
