import { TIER_META, TIER_ORDER } from '@/lib/battlefield-map-utils';
import {
  CLASS_STYLES,
  Canvas,
  CONTENT_WIDTH,
  PAGE,
  REPORT_COLORS,
  card,
  chip,
  drawBullets,
  drawClassIcon,
  drawPin,
  measureBullets,
  sectionHeading,
  stackedBar,
} from './report-layout';
import { formatDate, formatDateTime, formatPercent } from './report-format';
import type { Kpi, ReportModel } from './report-model';
import type { EvidenceClass } from './report-types';
import { drawMapPanel } from './map/map-render';
import type { MapPanelContext, MapRenderResult, PreparedBasemap } from './map/map-render';

const X = PAGE.marginX;
const W = CONTENT_WIDTH;

/* -------------------------------------------------------------------------- */
/* Cabeçalho das páginas internas                                             */
/* -------------------------------------------------------------------------- */

export function drawRunningHeader(canvas: Canvas, model: ReportModel): number {
  const { doc } = canvas;
  drawPin(doc, X, 24, 9, REPORT_COLORS.primary, '#FFFFFF');
  canvas.line('GMN Intelligence Platform', X + 15, 24, { weight: 'bold', size: 8, color: REPORT_COLORS.navy });
  const right = `Dossiê de Auditoria · ${truncate(model.company.name, 46)}`;
  const width = canvas.width(right, { size: 7, color: REPORT_COLORS.muted });
  canvas.line(right, X + W - width, 25, { size: 7, color: REPORT_COLORS.muted });
  doc.moveTo(X, 42).lineTo(X + W, 42).lineWidth(0.6).strokeColor(REPORT_COLORS.border).stroke();
  drawIntegrityBand(canvas, model, 0, 12);
  return 58;
}

/** Faixa de topo quando o documento NÃO é o resultado de uma auditoria real (teste ou demonstração). */
export function integrityBandText(model: ReportModel): string | null {
  if (model.meta.testFixture) return 'DOCUMENTO DE TESTE · DADOS SINTÉTICOS · NÃO É O RESULTADO DE UMA AUDITORIA · NENHUMA CONSULTA REAL AO SERPER';
  if (model.meta.demo) return 'MODO DEMONSTRAÇÃO · DADOS SIMULADOS · NÃO REPRESENTAM A EMPRESA REAL';
  return null;
}

function drawIntegrityBand(canvas: Canvas, model: ReportModel, y: number, height: number): void {
  const text = integrityBandText(model);
  if (!text) return;
  canvas.doc.rect(0, y, PAGE.width, height).fillColor(REPORT_COLORS.simulated).fill();
  const style = { weight: 'bold', size: 6.4, color: '#FFFFFF', characterSpacing: 0.5 } as const;
  canvas.line(text, (PAGE.width - canvas.width(text, style)) / 2, y + 3.4, style);
}

export function stampFooters(canvas: Canvas, model: ReportModel, pageCount: number, firstPageIndex: number): void {
  const { doc } = canvas;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(firstPageIndex + i);
    const y = PAGE.height - 34;
    doc.moveTo(X, y - 8).lineTo(X + W, y - 8).lineWidth(0.6).strokeColor(REPORT_COLORS.border).stroke();
    const left = `GMN Intelligence Platform · Documento gerado em ${formatDateTime(model.meta.generatedAt)} · Dados coletados em ${formatDateTime(model.meta.collectedAt)}`;
    canvas.line(left, X, y, { size: 6.4, color: REPORT_COLORS.muted }, W - 70);
    const right = `Página ${i + 1} de ${pageCount}`;
    const width = canvas.width(right, { weight: 'semibold', size: 6.8 });
    canvas.line(right, X + W - width, y, { weight: 'semibold', size: 6.8, color: REPORT_COLORS.navy });
    const mark = model.meta.testFixture ? 'DOCUMENTO DE TESTE (dados sintéticos) · ' : model.meta.demo ? 'MODO DEMONSTRAÇÃO (dados simulados) · ' : '';
    canvas.line(`${mark}Auditoria ${model.meta.auditIdShort}`, X, y + 10, { size: 6, color: mark ? REPORT_COLORS.simulated : REPORT_COLORS.muted, weight: mark ? 'semibold' : 'regular' });
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Menor tamanho de fonte em que o nome cabe em até `maxLines` linhas; trunca só como último recurso. */
export function fitName(
  canvas: Canvas,
  name: string,
  width: number,
  maxLines: number,
  sizes: readonly number[] = [19, 17, 15, 13.5, 12]
): { readonly size: number; readonly text: string; readonly height: number } {
  for (const size of sizes) {
    const style = { weight: 'bold', size, lineGap: 1.2 } as const;
    const height = canvas.measure(name, width, style);
    if (height <= size * 1.22 * maxLines + 1) return { size, text: name, height };
  }
  const size = sizes[sizes.length - 1] as number;
  let text = name;
  while (text.length > 8 && canvas.measure(`${text}…`, width, { weight: 'bold', size, lineGap: 1.2 }) > size * 1.22 * maxLines + 1) {
    text = text.slice(0, -2).trimEnd();
  }
  const final = `${text}…`;
  return { size, text: final, height: canvas.measure(final, width, { weight: 'bold', size, lineGap: 1.2 }) };
}

/* -------------------------------------------------------------------------- */
/* Página 1: capa e diagnóstico executivo                                     */
/* -------------------------------------------------------------------------- */

const STAMP_COLORS = {
  PARTIAL: { bg: REPORT_COLORS.warning, fg: REPORT_COLORS.navy },
  FULL: { bg: REPORT_COLORS.success, fg: REPORT_COLORS.navy },
  NONE: { bg: REPORT_COLORS.danger, fg: '#FFFFFF' },
} as const;

const HERO_HEIGHT = 184;

function drawHero(canvas: Canvas, model: ReportModel): void {
  const { doc } = canvas;
  doc.rect(0, 0, PAGE.width, HERO_HEIGHT).fillColor(REPORT_COLORS.navy).fill();
  doc.rect(0, HERO_HEIGHT, PAGE.width, 3).fillColor(REPORT_COLORS.primary).fill();
  // Detalhe gráfico discreto: círculos concêntricos no canto superior direito.
  doc.save();
  doc.rect(0, 0, PAGE.width, HERO_HEIGHT).clip();
  for (const [r, o] of [[150, 0.05], [110, 0.06], [70, 0.08]] as const) {
    doc.circle(PAGE.width - 40, 20, r).lineWidth(1).strokeColor(REPORT_COLORS.accent).opacity(o).stroke();
  }
  doc.opacity(1).restore();

  drawIntegrityBand(canvas, model, 0, 14);
  drawPin(doc, X, 26, 17, REPORT_COLORS.accent, REPORT_COLORS.navy);
  canvas.line('GMN', X + 25, 24, { weight: 'bold', size: 15, color: '#FFFFFF' });
  canvas.line('Intelligence Platform', X + 25, 41, { size: 7.4, color: '#9FB4D4' });

  const meta = `Auditoria ${model.meta.auditIdShort}`;
  canvas.line(meta, X + W - canvas.width(meta, { size: 7.4 }), 28, { size: 7.4, color: '#9FB4D4' });
  const collected = `Coleta em ${formatDate(model.meta.collectedAt)}`;
  canvas.line(collected, X + W - canvas.width(collected, { size: 7.4 }), 39, { size: 7.4, color: '#9FB4D4' });

  const titleHeight = canvas.paragraph('Dossiê de Auditoria e Inteligência Territorial', X, 64, 400, {
    weight: 'bold',
    size: 25,
    color: '#FFFFFF',
    lineGap: 1.5,
  });
  canvas.paragraph(
    'Diagnóstico de posicionamento e oportunidades de crescimento no Google Meu Negócio.',
    X,
    64 + titleHeight + 6,
    W,
    { size: 9.4, color: '#B9CAE6' }
  );

  // Selo de cobertura: a auditoria nunca parece mais verificada do que é.
  const stamp = STAMP_COLORS[model.coverage.status];
  const stampY = HERO_HEIGHT - 34;
  const stampWidth = chip(canvas, X, stampY, model.coverage.stamp, { color: stamp.fg, bg: stamp.bg, size: 7.4 });
  canvas.line(model.coverage.summary, X + stampWidth + 12, stampY + 4.2, { weight: 'medium', size: 8.4, color: '#FFFFFF' });
  if (model.coverage.partialSummary) {
    canvas.line(model.coverage.partialSummary, X, stampY + 19, { size: 7.4, color: '#F5D07A' });
  }
}

function drawCompanyCard(canvas: Canvas, model: ReportModel, y: number): number {
  const { doc } = canvas;
  const leftW = 318;
  const rightX = X + 16 + leftW + 18;
  const rightW = X + W - 16 - rightX;
  const fit = fitName(canvas, model.company.name, leftW, 2);

  const place = [model.company.city, model.company.state].filter(Boolean).join(' - ') || 'Não disponível';
  const colW = (leftW - 12) / 2;
  const fields: readonly (readonly [string, string])[] = [
    ['Cidade / UF', place],
    ['Palavra-chave auditada', model.company.keyword],
    ['Categoria principal', model.company.category],
    ['Prospecção', model.company.frontier],
  ];
  const address = model.company.address ?? 'Não disponível';
  const fieldH = (value: string, width: number): number => 8 + canvas.measure(value, width, { size: 8.2, weight: 'medium' }) + 7;

  const nameTop = 25;
  const fieldsTop = nameTop + fit.height + 12;
  const row1 = Math.max(fieldH(fields[0]![1], colW), fieldH(fields[1]![1], colW));
  const row2 = Math.max(fieldH(fields[2]![1], colW), fieldH(fields[3]![1], colW));
  const addressH = fieldH(address, leftW);
  const leftHeight = fieldsTop + row1 + row2 + addressH + 8;

  const rightItems: readonly (readonly [string, string, number])[] = [
    ['Place ID', model.company.placeId, 6.6],
    ['Coleta territorial', formatDateTime(model.meta.collectedAt), 8],
    ['Documento gerado em', formatDateTime(model.meta.generatedAt), 8],
    ['Identificador da auditoria', model.meta.auditId, 6.2],
  ];
  const rightHeight = 14 + rightItems.reduce((sum, [, value, size]) => sum + 9 + canvas.measure(value, rightW, { size, weight: 'medium' }) + 6, 0) + 6;
  const height = Math.max(leftHeight, rightHeight);

  card(doc, X, y, W, height, { border: REPORT_COLORS.border });
  canvas.line('EMPRESA AUDITADA', X + 16, y + 13, { weight: 'semibold', size: 6.4, color: REPORT_COLORS.primary, characterSpacing: 0.7 });
  canvas.paragraph(fit.text, X + 16, y + nameTop, leftW, { weight: 'bold', size: fit.size, color: REPORT_COLORS.navy, lineGap: 1.2 });

  const drawField = (label: string, value: string, fx: number, fy: number, w: number): void => {
    canvas.line(label.toUpperCase(), fx, fy, { size: 5.8, color: REPORT_COLORS.muted, characterSpacing: 0.5 });
    canvas.paragraph(value, fx, fy + 8, w, { size: 8.2, weight: 'medium', color: REPORT_COLORS.text });
  };
  let fy = y + fieldsTop;
  drawField(fields[0]![0], fields[0]![1], X + 16, fy, colW);
  drawField(fields[1]![0], fields[1]![1], X + 16 + colW + 12, fy, colW);
  fy += row1;
  drawField(fields[2]![0], fields[2]![1], X + 16, fy, colW);
  drawField(fields[3]![0], fields[3]![1], X + 16 + colW + 12, fy, colW);
  fy += row2;
  drawField('Endereço', address, X + 16, fy, leftW);

  doc.moveTo(rightX - 9, y + 14).lineTo(rightX - 9, y + height - 14).lineWidth(0.6).strokeColor(REPORT_COLORS.border).stroke();
  let ry = y + 14;
  for (const [label, value, size] of rightItems) {
    canvas.line(label.toUpperCase(), rightX, ry, { size: 5.8, color: REPORT_COLORS.muted, characterSpacing: 0.5 });
    const h = canvas.paragraph(value, rightX, ry + 8, rightW, { size, weight: 'medium', color: REPORT_COLORS.text });
    ry += 9 + h + 6;
  }
  return height;
}

const KPI_HEIGHT = 70;

function drawKpiCard(canvas: Canvas, kpi: Kpi, x: number, y: number, w: number, highlight: boolean): void {
  const { doc } = canvas;
  card(doc, x, y, w, KPI_HEIGHT, {
    fill: highlight ? '#F1F6FF' : '#FFFFFF',
    border: highlight ? '#BCD3F7' : REPORT_COLORS.border,
  });
  if (highlight) doc.roundedRect(x, y + 10, 3.4, KPI_HEIGHT - 20, 1.7).fillColor(REPORT_COLORS.primary).fill();
  canvas.paragraph(kpi.label.toUpperCase(), x + 14, y + 9, w - 40, {
    weight: 'semibold',
    size: 6.1,
    color: REPORT_COLORS.muted,
    characterSpacing: 0.4,
    lineGap: 1.1,
  });
  drawClassIcon(doc, kpi.origin, x + w - 14, y + 14, 4.6);
  const numeric = /^[\d.,%\s-]+$/.test(kpi.value);
  canvas.line(kpi.value, x + 14, y + 27, {
    weight: 'bold',
    size: numeric ? 20 : 11.5,
    color: kpi.origin === 'VERIFIED' ? REPORT_COLORS.navy : REPORT_COLORS.notVerified,
  }, w - 24);
  canvas.paragraph(kpi.caption, x + 14, y + KPI_HEIGHT - 17, w - 24, { size: 6.6, color: REPORT_COLORS.muted });
}

/** Faixa de cobertura: quanto do peso total do Juiz tem evidência comprovada, não verificada ou simulada. */
function drawCoverageStrip(canvas: Canvas, model: ReportModel, y: number): number {
  const { score } = model.judge;
  canvas.line('COBERTURA DE EVIDÊNCIAS DOS 21 CRITÉRIOS, POR PESO NO SCORE', X, y, {
    weight: 'semibold', size: 6.2, color: REPORT_COLORS.muted, characterSpacing: 0.5,
  });
  stackedBar(canvas.doc, X, y + 11, W, 7, [
    { value: score.verified.weight, color: REPORT_COLORS.success },
    { value: score.partial.weight, color: REPORT_COLORS.warning },
    { value: score.notVerified.weight, color: '#A9B6C9' },
    { value: score.simulated.weight, color: REPORT_COLORS.simulated, hatched: true },
  ]);
  const items: readonly [EvidenceClass, string][] = [
    ['VERIFIED', `Comprovado: ${score.verified.count} ${score.verified.count === 1 ? 'critério' : 'critérios'} · ${formatPercent(score.verified.weightPercent, 0)} do peso`],
    ['PARTIAL', `Em parte: ${score.partial.count} · ${formatPercent(score.partial.weightPercent, 0)}`],
    ['NOT_VERIFIED', `Não verificado: ${score.notVerified.count} · ${formatPercent(score.notVerified.weightPercent, 0)}`],
    ['SIMULATED', `Simulado: ${score.simulated.count} · ${formatPercent(score.simulated.weightPercent, 0)}`],
  ];
  let cursor = X;
  for (const [cls, text] of items) {
    drawClassIcon(canvas.doc, cls, cursor + 4, y + 28, 3.6);
    canvas.line(text, cursor + 11, y + 25, { size: 6.6, color: REPORT_COLORS.text });
    cursor += 15 + canvas.width(text, { size: 6.6 }) + 16;
  }
  return 38;
}

interface BlockSpec {
  readonly title: string;
  readonly items: readonly string[];
  readonly dot: string;
}

const BULLET_STYLE = { size: 8.2, lineGap: 1.5, color: REPORT_COLORS.text } as const;

function blockHeight(canvas: Canvas, spec: BlockSpec, width: number): number {
  return 18 + measureBullets(canvas, spec.items, width, BULLET_STYLE) + 6;
}

function drawBlock(canvas: Canvas, spec: BlockSpec, x: number, y: number, width: number): void {
  canvas.line(spec.title.toUpperCase(), x, y, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  canvas.doc.rect(x, y + 11, 22, 1.6).fillColor(spec.dot).fill();
  drawBullets(canvas, spec.items, x, y + 18, width, BULLET_STYLE, spec.dot);
}

/** Desenha dois blocos lado a lado; se não couberem, a linha inteira vai para a página seguinte. */
function drawBlockRow(canvas: Canvas, left: BlockSpec, right: BlockSpec): void {
  const colW = (W - 24) / 2;
  const height = Math.max(blockHeight(canvas, left, colW), blockHeight(canvas, right, colW));
  canvas.ensure(height);
  drawBlock(canvas, left, X, canvas.y, colW);
  drawBlock(canvas, right, X + colW + 24, canvas.y, colW);
  canvas.y += height + 2;
}

export function drawCoverPage(canvas: Canvas, model: ReportModel): void {
  drawHero(canvas, model);
  let y = HERO_HEIGHT + 3 + 12;
  y += drawCompanyCard(canvas, model, y) + 10;

  const gap = 10;
  const kw = (W - gap * 2) / 3;
  model.kpis.forEach((kpi, index) => {
    drawKpiCard(canvas, kpi, X + (index % 3) * (kw + gap), y + Math.floor(index / 3) * (KPI_HEIGHT + gap), kw, index === 0);
  });
  y += KPI_HEIGHT * 2 + gap + 14;
  y += drawCoverageStrip(canvas, model, y) + 12;

  // Prioridade estratégica: a mensagem principal fica na capa.
  const { diagnosis } = model;
  const priorityH = canvas.measure(diagnosis.priority, W - 40, { weight: 'semibold', size: 9.6, lineGap: 1.8 });
  card(canvas.doc, X, y, W, priorityH + 34, { fill: REPORT_COLORS.navy, border: REPORT_COLORS.navy });
  canvas.doc.roundedRect(X, y, 4, priorityH + 34, 2).fillColor(REPORT_COLORS.warning).fill();
  canvas.line('PRIORIDADE ESTRATÉGICA RECOMENDADA', X + 18, y + 12, { weight: 'bold', size: 6.6, color: REPORT_COLORS.warning, characterSpacing: 0.7 });
  canvas.paragraph(diagnosis.priority, X + 18, y + 25, W - 40, { weight: 'semibold', size: 9.6, color: '#FFFFFF', lineGap: 1.8 });
  canvas.y = y + priorityH + 46;
}

/* -------------------------------------------------------------------------- */
/* Página 2: diagnóstico executivo e evidência por área                       */
/* -------------------------------------------------------------------------- */

function drawEvidenceByGroup(canvas: Canvas, model: ReportModel): void {
  const groups = model.judge.score.groups;
  const rowH = 30;
  const header = 38;
  canvas.ensure(header + rowH * groups.length + 12);
  canvas.line('EVIDÊNCIA POR ÁREA DO PERFIL', X, canvas.y, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  canvas.doc.rect(X, canvas.y + 11, 22, 1.6).fillColor(REPORT_COLORS.primary).fill();
  canvas.paragraph(
    'Quanto de cada área do perfil foi comprovado com dados reais. Áreas sem comprovação ficam visíveis aqui em vez de serem tratadas como aprovadas ou reprovadas.',
    X, canvas.y + 17, W, { size: 7.6, color: REPORT_COLORS.muted, lineGap: 1.4 }
  );
  let y = canvas.y + header;
  for (const group of groups) {
    const weight = (cls: EvidenceClass): number => group.criteria.filter((c) => c.evidenceClass === cls).reduce((sum, c) => sum + c.weight, 0);
    card(canvas.doc, X, y, W, rowH - 4, { border: REPORT_COLORS.border, radius: 7 });
    canvas.line(group.label, X + 12, y + 6, { weight: 'semibold', size: 8, color: REPORT_COLORS.navy }, 250);
    const simulated = group.criteria.filter((c) => c.evidenceClass === 'SIMULATED').length;
    const unverified = group.criteria.filter((c) => c.evidenceClass === 'NOT_VERIFIED').length;
    const partial = group.criteria.filter((c) => c.evidenceClass === 'PARTIAL').length;
    const detail = [partial > 0 ? `${partial} em parte` : null, simulated > 0 ? `${simulated} simulado${simulated > 1 ? 's' : ''}` : null, unverified > 0 ? `${unverified} não verificado${unverified > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
    canvas.line(detail || 'Todos os critérios comprovados', X + 12, y + 16.5, { size: 6.6, color: REPORT_COLORS.muted }, 250);
    canvas.line(`${group.verifiedCount} de ${group.criteria.length} comprovados`, X + 268, y + 6.5, { weight: 'semibold', size: 7.4, color: group.verifiedCount === group.criteria.length ? REPORT_COLORS.verified : REPORT_COLORS.text });
    stackedBar(canvas.doc, X + 268, y + 17, W - 268 - 14, 5, [
      { value: weight('VERIFIED'), color: REPORT_COLORS.success },
      { value: weight('PARTIAL'), color: REPORT_COLORS.warning },
      { value: weight('NOT_VERIFIED'), color: '#A9B6C9' },
      { value: weight('SIMULATED'), color: REPORT_COLORS.simulated, hatched: true },
    ]);
    y += rowH;
  }
  canvas.y = y + 6;
}

function drawHowToRead(canvas: Canvas): void {
  const items: readonly [EvidenceClass, string, string][] = [
    ['VERIFIED', 'Comprovado', 'O dado foi lido de uma fonte real (por exemplo, a listagem pública do Google Maps ou as buscas territoriais). Pode orientar decisões.'],
    ['PARTIAL', 'Parcialmente verificado', 'Há evidência real, mas ela não cobre todos os requisitos do critério (uma amostra, ou um dos canais). Contado à parte; nunca entra no desempenho verificado.'],
    ['NOT_VERIFIED', 'Não verificado', 'Não há fonte real para o dado, ou ele foi apenas inferido. Não é aprovação nem reprovação: é uma informação a confirmar no perfil.'],
    ['SIMULATED', 'Simulado', 'Gerado pelo sistema no lugar de ser coletado: legado (auditorias anteriores à Fase 4), demonstração ou fixture de teste. Nunca representa o perfil real.'],
  ];
  const textX = 150;
  const textW = W - textX - 14;
  const heights = items.map(([, , text]) => canvas.measure(text, textW, { size: 7.8, lineGap: 1.4 }) + 12);
  const total = heights.reduce((sum, h) => sum + h, 0) + 34;
  canvas.ensure(total + 6);
  const y0 = canvas.y;
  canvas.line('COMO LER AS MARCAS DE EVIDÊNCIA', X, y0, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  canvas.doc.rect(X, y0 + 11, 22, 1.6).fillColor(REPORT_COLORS.primary).fill();
  let y = y0 + 22;
  items.forEach(([cls, title, text], i) => {
    const style = CLASS_STYLES[cls];
    card(canvas.doc, X, y, W, (heights[i] as number) - 4, { fill: style.bg, border: style.bg, radius: 7 });
    drawClassIcon(canvas.doc, cls, X + 16, y + ((heights[i] as number) - 4) / 2, 5);
    canvas.line(title, X + 30, y + ((heights[i] as number) - 4) / 2 - 4, { weight: 'bold', size: 8.2, color: style.color });
    canvas.paragraph(text, X + textX, y + 5.5, textW, { size: 7.8, lineGap: 1.4, color: REPORT_COLORS.text });
    y += heights[i] as number;
  });
  canvas.y = y + 6;
}

export function drawDiagnosisPage(canvas: Canvas, model: ReportModel): void {
  canvas.newPage();
  canvas.mark('Diagnóstico executivo');
  sectionHeading(canvas, 'Diagnóstico executivo', 'Leitura objetiva do posicionamento da empresa, escrita somente com dados comprovados desta auditoria.');
  canvas.y += 4;
  const { diagnosis } = model;
  const strengths = diagnosis.strengths.length > 0 ? diagnosis.strengths : ['Nenhuma força pôde ser comprovada com os dados desta auditoria.'];
  drawBlockRow(
    canvas,
    { title: 'Situação atual', items: diagnosis.situation, dot: REPORT_COLORS.primary },
    { title: 'Oportunidades', items: diagnosis.opportunities, dot: REPORT_COLORS.accent }
  );
  drawBlockRow(
    canvas,
    { title: 'Principais forças', items: strengths, dot: REPORT_COLORS.success },
    { title: 'Riscos e gargalos', items: diagnosis.risks, dot: REPORT_COLORS.danger }
  );
  canvas.y += 6;
  drawEvidenceByGroup(canvas, model);
  drawHowToRead(canvas);
}

/* -------------------------------------------------------------------------- */
/* Página 2: Campo de Batalha Geográfico                                      */
/* -------------------------------------------------------------------------- */

export interface MapPageInput {
  readonly prepared: PreparedBasemap | null;
  readonly notice: string | null;
  readonly attribution: string | null;
}

export function drawMapPage(canvas: Canvas, model: ReportModel, input: MapPageInput): MapRenderResult | null {
  canvas.newPage();
  canvas.mark('Campo de Batalha Geográfico');
  const { doc } = canvas;
  sectionHeading(
    canvas,
    'Campo de Batalha Geográfico',
    `Posição da empresa em 49 pontos ao redor do endereço, para a busca por "${model.company.keyword}". Cada marcador mostra a posição em que a empresa aparece naquele ponto.`
  );

  const map = model.territory.map;
  let result: MapRenderResult | null = null;
  const rect = { x: X, y: canvas.y + 4, width: W, height: 400 };

  if (map.markers.length === 0 && !map.company) {
    card(doc, X, rect.y, W, 120, { fill: REPORT_COLORS.notVerifiedBg, border: REPORT_COLORS.borderStrong });
    canvas.paragraph('Nenhuma coordenada válida foi coletada nesta auditoria, portanto não há pontos para exibir no mapa.', X + 20, rect.y + 46, W - 40, {
      weight: 'medium', size: 9.5, color: REPORT_COLORS.notVerified, align: 'center',
    });
    canvas.y = rect.y + 136;
  } else {
    const context: MapPanelContext = {
      fonts: canvas.fonts,
      sanitize: canvas.sanitize,
      businessName: model.company.name,
      notice: input.notice,
      attribution: input.attribution,
    };
    result = drawMapPanel(doc, rect, map, input.prepared, context);
    canvas.y = rect.y + rect.height + 12;
  }

  // Legenda de cores (mesmas do dashboard) e do marcador da empresa.
  let lx = X;
  const ly = canvas.y;
  for (const tier of TIER_ORDER) {
    doc.circle(lx + 5, ly + 5, 4.6).fillColor(TIER_META[tier].color).fill();
    doc.circle(lx + 5, ly + 5, 4.6).lineWidth(0.8).strokeColor('#FFFFFF').stroke();
    canvas.line(TIER_META[tier].legendLabel, lx + 14, ly + 2, { size: 6.9, color: REPORT_COLORS.text });
    lx += 22 + canvas.width(TIER_META[tier].legendLabel, { size: 6.9 }) + 8;
  }
  doc.circle(lx + 5, ly + 5, 5.4).lineWidth(1.3).dash(2.4, { space: 1.6 }).strokeColor(REPORT_COLORS.navy).stroke();
  doc.undash();
  canvas.line('Empresa auditada', lx + 15, ly + 2, { size: 6.9, color: REPORT_COLORS.text });
  canvas.y = ly + 22;

  // Indicadores territoriais
  const kpis = model.territory.kpis;
  const gap = 8;
  const kw = (W - gap * 5) / 6;
  const kh = 58;
  kpis.forEach((kpi, i) => {
    const x = X + i * (kw + gap);
    card(doc, x, canvas.y, kw, kh, { border: REPORT_COLORS.border, radius: 8 });
    canvas.paragraph(kpi.label.toUpperCase(), x + 9, canvas.y + 8, kw - 14, { weight: 'semibold', size: 5.6, color: REPORT_COLORS.muted, characterSpacing: 0.3, lineGap: 1 });
    const big = /^[\d.,%\s]+(de\s\d+)?$/.test(kpi.value);
    canvas.line(kpi.value, x + 9, canvas.y + 24, { weight: 'bold', size: big ? 14 : 8.6, color: kpi.origin === 'VERIFIED' ? REPORT_COLORS.navy : REPORT_COLORS.notVerified }, kw - 14);
    canvas.paragraph(kpi.caption, x + 9, canvas.y + 42, kw - 14, { size: 5.8, color: REPORT_COLORS.muted, lineGap: 1 });
  });
  canvas.y += kh + 16;

  // Achados
  const findings = model.territory.analysis.findings;
  const coverage = map.coverage;
  const coverageLine = `Coordenadas processadas: ${coverage.collected} de ${coverage.expected} · leituras válidas: ${coverage.valid} · sem leitura: ${coverage.unreadable}${coverage.missing > 0 ? ` · ausentes: ${coverage.missing}` : ''}${coverage.invalid > 0 ? ` · sem coordenada válida: ${coverage.invalid}` : ''}. Os percentuais usam só as leituras válidas.`;
  const all = [...findings, coverageLine];
  const need = 24 + measureBullets(canvas, all, W, { size: 8.4, lineGap: 1.7 });
  canvas.ensure(need);
  canvas.line('PRINCIPAIS ACHADOS GEOGRÁFICOS', X, canvas.y, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  canvas.doc.rect(X, canvas.y + 11, 22, 1.6).fillColor(REPORT_COLORS.primary).fill();
  const h = drawBullets(canvas, all, X, canvas.y + 19, W, { size: 8.4, lineGap: 1.7 });
  canvas.y += 19 + h + 6;
  return result;
}


/**
 * Índice na capa. Desenhado ao final (as páginas de cada seção só são conhecidas depois de
 * renderizar tudo), voltando à primeira página do documento em memória.
 */
export function drawContentsOnCover(canvas: Canvas, coverBottomY: number): void {
  const entries = canvas.sections;
  if (entries.length === 0) return;
  const { doc } = canvas;
  const rows = Math.ceil(entries.length / 2);
  const needed = 26 + rows * 17;
  if (coverBottomY + needed > PAGE.height - PAGE.footerReserve) return; // sem espaço: a capa não é apertada
  doc.switchToPage(0);
  let y = coverBottomY;
  canvas.line('CONTEÚDO DO DOSSIÊ', X, y, { weight: 'bold', size: 6.9, color: REPORT_COLORS.navy, characterSpacing: 0.6 });
  doc.rect(X, y + 11, 22, 1.6).fillColor(REPORT_COLORS.primary).fill();
  y += 22;
  const colW = (W - 24) / 2;
  entries.forEach((entry, index) => {
    const col = Math.floor(index / rows);
    const row = index % rows;
    const ex = X + col * (colW + 24);
    const ey = y + row * 17;
    canvas.line(String(index + 1).padStart(2, '0'), ex, ey, { weight: 'bold', size: 7.6, color: REPORT_COLORS.primary });
    canvas.line(truncate(entry.title, 44), ex + 18, ey, { size: 7.8, color: REPORT_COLORS.text }, colW - 54);
    const page = `pág. ${entry.pageIndex + 1}`;
    canvas.line(page, ex + colW - canvas.width(page, { size: 7.4 }), ey + 0.3, { weight: 'semibold', size: 7.4, color: REPORT_COLORS.navy });
    doc.moveTo(ex, ey + 12).lineTo(ex + colW, ey + 12).lineWidth(0.4).strokeColor(REPORT_COLORS.border).stroke();
  });
}
