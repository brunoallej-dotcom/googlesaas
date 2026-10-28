import PDFDocument from 'pdfkit';
import { StructuredLogger } from '@/lib/logger';
import { resolveBasemap } from './map/basemap';
import type { BasemapResolution } from './map/basemap';
import { prepareBasemap } from './map/map-render';
import type { MapRenderResult, PreparedBasemap } from './map/map-render';
import { Canvas, createSanitizer, registerFonts } from './report-layout';
import type { FontMode } from './report-layout';
import type { ReportModel } from './report-model';
import { drawContentsOnCover, drawCoverPage, drawDiagnosisPage, drawMapPage, drawRunningHeader, stampFooters } from './report-pages';
import { drawCompetitionPage, drawJudgePages, drawMethodologyPages, drawPlanPages } from './report-pages-analysis';
import { PAGE } from './report-theme';

export interface RenderOptions {
  /** Provedor de mapa-base já resolvido. Padrão: lido do ambiente (desligado sem autorização). */
  readonly basemap?: BasemapResolution;
  /** `inter` embute a fonte do relatório; `standard` usa as fontes do PDF (testes). */
  readonly fonts?: FontMode;
  /** `false` deixa o conteúdo legível para os testes. */
  readonly compress?: boolean;
}

export interface RenderedReport {
  readonly buffer: Buffer;
  readonly pageCount: number;
  readonly map: MapRenderResult | null;
  readonly mapNotice: string | null;
  readonly basemapStatus: BasemapResolution['status'] | 'FAILED';
  readonly fontMode: FontMode;
}

const MAP_FAILURE_NOTICE =
  'Mapa-base indisponível nesta emissão: não foi possível carregar os tiles. Os pontos abaixo são reais e georreferenciados, sem ruas e bairros.';

const MAP_RECT_HEIGHT = 400;

/**
 * Gera o dossiê. A falha do mapa-base NUNCA derruba o PDF: o mapa sai só com os pontos reais,
 * com aviso claro. Nada é desenhado para "parecer" um mapa.
 */
export async function renderReportPdf(model: ReportModel, options: RenderOptions = {}): Promise<RenderedReport> {
  const logger = new StructuredLogger('DIAGRAMMER', model.meta.auditId);
  const resolution = options.basemap ?? (await resolveBasemap());

  // 1) Mapa-base (assíncrono): tiles buscados/decodificados antes de desenhar.
  let prepared: PreparedBasemap | null = null;
  let status: RenderedReport['basemapStatus'] = resolution.status;
  let notice = resolution.notice;
  const map = model.territory.map;
  const mapRect = { x: PAGE.marginX, y: 0, width: PAGE.width - PAGE.marginX * 2, height: MAP_RECT_HEIGHT };

  if (resolution.provider.kind !== 'none' && (map.markers.length > 0 || map.company)) {
    try {
      prepared = await prepareBasemap(map, mapRect, resolution.provider);
    } catch (error: unknown) {
      status = 'FAILED';
      notice = MAP_FAILURE_NOTICE;
      logger.warn('Mapa-base indisponível: o PDF será gerado sem ruas e bairros', {
        provider: resolution.provider.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2) Documento
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    bufferPages: true,
    compress: options.compress ?? true,
    autoFirstPage: false,
    info: {
      Title: `${model.meta.testFixture ? '[DOCUMENTO DE TESTE - DADOS SINTÉTICOS] ' : model.meta.demo ? '[MODO DEMONSTRAÇÃO] ' : ''}Dossiê de Auditoria e Inteligência Territorial - ${model.company.name}`,
      Author: 'GMN Intelligence Platform',
      Subject: 'Diagnóstico de posicionamento no Google Meu Negócio',
      Keywords: 'auditoria, google meu negócio, inteligência territorial',
      CreationDate: new Date(model.meta.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const { fonts, mode } = registerFonts(doc, options.fonts ?? 'inter');
  const sanitize = createSanitizer(doc, fonts, mode);
  const canvas = new Canvas(doc, fonts, sanitize);

  // Capa (sem cabeçalho corrido)
  doc.addPage();
  drawCoverPage(canvas, model);
  const coverBottom = canvas.y;

  // Páginas internas
  canvas.onNewPage = () => drawRunningHeader(canvas, model);
  drawDiagnosisPage(canvas, model);
  let mapResult: MapRenderResult | null = null;
  mapResult = drawMapPage(canvas, model, { prepared, notice, attribution: resolution.provider.attribution });
  drawCompetitionPage(canvas, model);
  drawJudgePages(canvas, model);
  drawPlanPages(canvas, model);
  drawMethodologyPages(canvas, model, {
    included: prepared !== null,
    attribution: prepared ? resolution.provider.attribution : null,
    notice,
  });
  drawContentsOnCover(canvas, coverBottom);

  const pageCount = doc.bufferedPageRange().count;
  stampFooters(canvas, model, pageCount, 0);
  doc.end();
  const buffer = await finished;

  return { buffer, pageCount, map: mapResult, mapNotice: notice, basemapStatus: status, fontMode: mode };
}
