import type { BattlefieldMapModel, MapMarker } from '@/lib/battlefield-map-adapter';
import { TIER_META } from '@/lib/battlefield-map-utils';
import type { GridPointVisualTier } from '@/types/gmn';
import { REPORT_COLORS } from '../report-theme';
import type { FontSet, TextSanitizer } from '../report-theme';
import type { BasemapProvider } from './basemap';
import { decodeVectorTile } from './mvt';
import type { MvtFeature, MvtLayer, MvtTile } from './mvt';
import { chooseZoom, fitView, lonLatToWorld, niceScaleLength } from './projection';
import type { MapView, Rect, TileCoord } from './projection';

type Doc = PDFKit.PDFDocument;

const MAP_PADDING = { top: 26, right: 26, bottom: 46, left: 26 } as const;
const MARKER_RADIUS = 8.6;

/** Estilo cartográfico claro, próprio para impressão (esquema OpenMapTiles). */
const STYLE = {
  background: '#E8EDF4',
  grass: '#DCEBD4',
  wood: '#CCE2C3',
  park: '#D9EBD0',
  water: '#B7D4F0',
  waterway: '#A5C8EC',
  hospital: '#F3DCDC',
  school: '#EDE9D6',
  industrial: '#E4E1EB',
  road: {
    casing: '#C4CFDE',
    minor: '#FFFFFF',
    major: '#FFF1CE',
    majorCasing: '#E2C98F',
    path: '#B7C2D2',
  },
  label: { place: '#7A8AA3', city: '#3A4760', road: '#6B7A90', water: '#5E8AB8', halo: '#FFFFFF' },
} as const;

/** Largura (pt) do traço por classe de via, no zoom em que o relatório é desenhado. */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 3.6,
  trunk: 3.4,
  primary: 3.0,
  secondary: 2.5,
  tertiary: 2.0,
  minor: 1.45,
  service: 0.9,
  busway: 1.2,
};
const ROAD_ORDER = ['service', 'busway', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
const MAJOR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

export interface PreparedBasemap {
  readonly view: MapView;
  readonly zoom: number;
  readonly tiles: readonly { readonly coord: TileCoord; readonly tile: MvtTile }[];
}

function viewCoordinates(model: BattlefieldMapModel): { longitude: number; latitude: number }[] {
  const coords = model.markers.map((m) => ({ longitude: m.longitude, latitude: m.latitude }));
  if (model.company) coords.push({ longitude: model.company.longitude, latitude: model.company.latitude });
  return coords;
}

export function buildMapView(model: BattlefieldMapModel, rect: Rect): MapView {
  return fitView(viewCoordinates(model), rect, MAP_PADDING);
}

/**
 * Busca e decodifica os tiles (etapa assíncrona). Qualquer falha aqui lança erro; o chamador
 * então emite o mapa sem base cartográfica, nunca um mapa falso.
 */
export async function prepareBasemap(
  model: BattlefieldMapModel,
  rect: Rect,
  provider: BasemapProvider
): Promise<PreparedBasemap> {
  if (provider.kind === 'none') throw new Error('Nenhum provedor de mapa-base configurado.');
  const view = buildMapView(model, rect);
  const { zoom, tiles } = chooseZoom(view.visibleWorld(), Math.min(provider.maxZoom, 14), provider.maxTilesPerReport);

  const loaded = await Promise.all(
    tiles.map(async (coord) => {
      const bytes = await provider.getTile(coord);
      return bytes ? { coord, tile: decodeVectorTile(bytes) } : null;
    })
  );
  const available = loaded.filter((entry): entry is { coord: TileCoord; tile: MvtTile } => entry !== null);
  if (available.length === 0) throw new Error('Nenhum tile do mapa-base estava disponível para a área.');
  return { view, zoom, tiles: available };
}

/* -------------------------------------------------------------------------- */
/* Geometria                                                                  */
/* -------------------------------------------------------------------------- */

interface Transform {
  readonly ax: number;
  readonly ay: number;
  readonly k: number;
}

function tileTransform(view: MapView, coord: TileCoord, extent: number): Transform {
  const n = 2 ** coord.z;
  return {
    ax: view.originPt.x + (coord.x / n - view.centerWorld.x) * view.scale,
    ay: view.originPt.y + (coord.y / n - view.centerWorld.y) * view.scale,
    k: view.scale / (extent * n),
  };
}

function tracePolylines(doc: Doc, feature: MvtFeature, tf: Transform, closed: boolean): void {
  for (const ring of feature.geometry) {
    const first = ring[0];
    if (!first || ring.length < 2) continue;
    doc.moveTo(tf.ax + first[0] * tf.k, tf.ay + first[1] * tf.k);
    for (let i = 1; i < ring.length; i++) {
      const p = ring[i] as readonly [number, number];
      doc.lineTo(tf.ax + p[0] * tf.k, tf.ay + p[1] * tf.k);
    }
    if (closed) doc.closePath();
  }
}

function eachFeature(prepared: PreparedBasemap, layerName: string, fn: (feature: MvtFeature, layer: MvtLayer, tf: Transform) => void): void {
  for (const { coord, tile } of prepared.tiles) {
    const layer = tile[layerName];
    if (!layer) continue;
    const tf = tileTransform(prepared.view, coord, layer.extent);
    for (const feature of layer.features) fn(feature, layer, tf);
  }
}

function stringProp(feature: MvtFeature, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = feature.properties[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Rótulos com controle de colisão                                            */
/* -------------------------------------------------------------------------- */

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

class Collisions {
  private readonly boxes: Box[] = [];

  add(box: Box): void {
    this.boxes.push(box);
  }

  free(box: Box): boolean {
    return !this.boxes.some((other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0);
  }
}

function insideRect(box: Box, rect: Rect, margin: number): boolean {
  return (
    box.x0 >= rect.x + margin &&
    box.x1 <= rect.x + rect.width - margin &&
    box.y0 >= rect.y + margin &&
    box.y1 <= rect.y + rect.height - margin
  );
}

function drawHaloText(doc: Doc, text: string, x: number, y: number, options: PDFKit.Mixins.TextOptions, color: string): void {
  doc.fillColor(STYLE.label.halo).opacity(0.9);
  for (const [dx, dy] of [[-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7], [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5]] as const) {
    doc.text(text, x + dx, y + dy, options);
  }
  doc.opacity(1).fillColor(color).text(text, x, y, options);
}

/* -------------------------------------------------------------------------- */
/* Camadas do mapa-base                                                       */
/* -------------------------------------------------------------------------- */

function drawBaseLayers(doc: Doc, prepared: PreparedBasemap): void {
  eachFeature(prepared, 'landcover', (feature, _layer, tf) => {
    if (feature.type !== 3) return;
    const cls = stringProp(feature, 'class');
    tracePolylines(doc, feature, tf, true);
    doc.fillColor(cls === 'wood' ? STYLE.wood : STYLE.grass).fill('even-odd');
  });

  eachFeature(prepared, 'landuse', (feature, _layer, tf) => {
    if (feature.type !== 3) return;
    const cls = stringProp(feature, 'class');
    const color =
      cls === 'pitch' || cls === 'playground' || cls === 'stadium' || cls === 'cemetery' || cls === 'park'
        ? STYLE.park
        : cls === 'hospital'
          ? STYLE.hospital
          : cls === 'school' || cls === 'college' || cls === 'university'
            ? STYLE.school
            : cls === 'industrial' || cls === 'commercial'
              ? STYLE.industrial
              : null;
    if (!color) return;
    tracePolylines(doc, feature, tf, true);
    doc.fillColor(color).fill('even-odd');
  });

  eachFeature(prepared, 'park', (feature, _layer, tf) => {
    if (feature.type !== 3) return;
    tracePolylines(doc, feature, tf, true);
    doc.fillColor(STYLE.park).fill('even-odd');
  });

  eachFeature(prepared, 'water', (feature, _layer, tf) => {
    if (feature.type !== 3) return;
    if (stringProp(feature, 'class') === 'swimming_pool') return;
    tracePolylines(doc, feature, tf, true);
    doc.fillColor(STYLE.water).fill('even-odd');
  });

  doc.lineCap('round').lineJoin('round');
  eachFeature(prepared, 'waterway', (feature, _layer, tf) => {
    if (feature.type !== 2) return;
    tracePolylines(doc, feature, tf, false);
    doc.lineWidth(stringProp(feature, 'class') === 'river' ? 1.6 : 0.6).strokeColor(STYLE.waterway).stroke();
  });
}

function drawRoads(doc: Doc, prepared: PreparedBasemap): void {
  doc.lineCap('round').lineJoin('round');

  // Trilhas e caminhos: finos e tracejados, sob as vias.
  doc.dash(1.6, { space: 1.4 });
  eachFeature(prepared, 'transportation', (feature, _layer, tf) => {
    const cls = stringProp(feature, 'class');
    if (feature.type !== 2 || (cls !== 'path' && cls !== 'track')) return;
    tracePolylines(doc, feature, tf, false);
  });
  doc.lineWidth(0.5).strokeColor(STYLE.road.path).stroke();
  doc.undash();

  const byClass = new Map<string, { feature: MvtFeature; tf: Transform }[]>();
  eachFeature(prepared, 'transportation', (feature, _layer, tf) => {
    const cls = stringProp(feature, 'class');
    if (feature.type !== 2 || !cls || !(cls in ROAD_WIDTH)) return;
    const list = byClass.get(cls) ?? [];
    list.push({ feature, tf });
    byClass.set(cls, list);
  });

  // Passada 1: contornos. Passada 2: preenchimento.
  for (const pass of ['casing', 'fill'] as const) {
    for (const cls of ROAD_ORDER) {
      const items = byClass.get(cls);
      if (!items) continue;
      for (const { feature, tf } of items) tracePolylines(doc, feature, tf, false);
      const width = ROAD_WIDTH[cls] as number;
      const major = MAJOR_CLASSES.has(cls);
      if (pass === 'casing') {
        doc.lineWidth(width + 0.9).strokeColor(major ? STYLE.road.majorCasing : STYLE.road.casing).stroke();
      } else {
        doc.lineWidth(width).strokeColor(major ? STYLE.road.major : STYLE.road.minor).stroke();
      }
    }
  }
}

interface PlaceCandidate {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
  readonly rank: number;
  readonly cls: string;
}

const PLACE_PRIORITY: Record<string, number> = { city: 0, town: 1, village: 2, suburb: 3, neighbourhood: 4, quarter: 5 };

function drawPlaceLabels(doc: Doc, prepared: PreparedBasemap, rect: Rect, fonts: FontSet, sanitize: TextSanitizer, collisions: Collisions): number {
  const seen = new Set<string>();
  const candidates: PlaceCandidate[] = [];
  eachFeature(prepared, 'place', (feature, _layer, tf) => {
    const cls = stringProp(feature, 'class');
    const name = stringProp(feature, 'name:latin', 'name');
    const point = feature.geometry[0]?.[0];
    if (!cls || !(cls in PLACE_PRIORITY) || !name || !point) return;
    const x = tf.ax + point[0] * tf.k;
    const y = tf.ay + point[1] * tf.k;
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) return;
    const key = `${name}|${Math.round(x / 4)}|${Math.round(y / 4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rank = typeof feature.properties.rank === 'number' ? feature.properties.rank : 99;
    candidates.push({ name, x, y, priority: PLACE_PRIORITY[cls] as number, rank, cls });
  });
  candidates.sort((a, b) => a.priority - b.priority || a.rank - b.rank);

  let placed = 0;
  let suburbs = 0;
  for (const c of candidates) {
    const isCity = c.cls === 'city' || c.cls === 'town';
    if (!isCity && suburbs >= 26) continue;
    const text = sanitize(isCity ? c.name : c.name.toUpperCase());
    const size = isCity ? 11 : 6.3;
    doc.font(isCity ? fonts.bold : fonts.semibold).fontSize(size);
    const options = { lineBreak: false, characterSpacing: isCity ? 0 : 0.45 } as const;
    const width = doc.widthOfString(text, options);
    const box: Box = { x0: c.x - width / 2 - 2, x1: c.x + width / 2 + 2, y0: c.y - size / 2 - 1.5, y1: c.y + size / 2 + 1.5 };
    if (!insideRect(box, rect, 3) || !collisions.free(box)) continue;
    collisions.add(box);
    drawHaloText(doc, text, c.x - width / 2, c.y - size / 2, options, isCity ? STYLE.label.city : STYLE.label.place);
    placed += 1;
    if (!isCity) suburbs += 1;
  }
  return placed;
}

function drawRoadLabels(doc: Doc, prepared: PreparedBasemap, rect: Rect, fonts: FontSet, sanitize: TextSanitizer, collisions: Collisions): number {
  interface Seg { name: string; cx: number; cy: number; len: number; angle: number; major: boolean }
  const segs: Seg[] = [];
  eachFeature(prepared, 'transportation_name', (feature, _layer, tf) => {
    if (feature.type !== 2) return;
    const name = stringProp(feature, 'name:latin', 'name');
    const cls = stringProp(feature, 'class');
    if (!name || !cls || cls === 'path' || cls === 'track') return;
    let best: Seg | null = null;
    for (const line of feature.geometry) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1] as readonly [number, number];
        const b = line[i] as readonly [number, number];
        const x0 = tf.ax + a[0] * tf.k;
        const y0 = tf.ay + a[1] * tf.k;
        const x1 = tf.ax + b[0] * tf.k;
        const y1 = tf.ay + b[1] * tf.k;
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (!best || len > best.len) {
          best = { name, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, len, angle: Math.atan2(y1 - y0, x1 - x0), major: MAJOR_CLASSES.has(cls) || cls === 'tertiary' };
        }
      }
    }
    if (best) segs.push(best);
  });
  segs.sort((a, b) => Number(b.major) - Number(a.major) || b.len - a.len);

  const placedNames = new Map<string, { x: number; y: number }[]>();
  let placed = 0;
  for (const seg of segs) {
    if (placed >= 34) break;
    const text = sanitize(seg.name);
    const size = 5.6;
    doc.font(fonts.medium).fontSize(size);
    const options = { lineBreak: false, characterSpacing: 0.1 } as const;
    const width = doc.widthOfString(text, options);
    if (seg.len < width + 6) continue;
    const previous = placedNames.get(text) ?? [];
    if (previous.some((p) => Math.hypot(p.x - seg.cx, p.y - seg.cy) < 110)) continue;

    let angle = seg.angle;
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    const halfW = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * size) / 2 + 1.5;
    const halfH = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * size) / 2 + 1.5;
    const box: Box = { x0: seg.cx - halfW, x1: seg.cx + halfW, y0: seg.cy - halfH, y1: seg.cy + halfH };
    if (!insideRect(box, rect, 4) || !collisions.free(box)) continue;
    collisions.add(box);
    previous.push({ x: seg.cx, y: seg.cy });
    placedNames.set(text, previous);

    doc.save();
    doc.translate(seg.cx, seg.cy);
    doc.rotate((angle * 180) / Math.PI);
    drawHaloText(doc, text, -width / 2, -size / 2, options, STYLE.label.road);
    doc.restore();
    placed += 1;
  }
  return placed;
}

function drawWaterLabels(doc: Doc, prepared: PreparedBasemap, rect: Rect, fonts: FontSet, sanitize: TextSanitizer, collisions: Collisions): void {
  eachFeature(prepared, 'water_name', (feature, _layer, tf) => {
    const name = stringProp(feature, 'name:latin', 'name');
    const point = feature.geometry[0]?.[0];
    if (!name || !point) return;
    const x = tf.ax + point[0] * tf.k;
    const y = tf.ay + point[1] * tf.k;
    const text = sanitize(name);
    doc.font(fonts.medium).fontSize(6);
    const options = { lineBreak: false, characterSpacing: 0.2 } as const;
    const width = doc.widthOfString(text, options);
    const box: Box = { x0: x - width / 2 - 2, x1: x + width / 2 + 2, y0: y - 5, y1: y + 5 };
    if (!insideRect(box, rect, 3) || !collisions.free(box)) return;
    collisions.add(box);
    drawHaloText(doc, text, x - width / 2, y - 3, options, STYLE.label.water);
  });
}

/* -------------------------------------------------------------------------- */
/* Sem mapa-base: grade georreferenciada                                      */
/* -------------------------------------------------------------------------- */

function drawBareGrid(doc: Doc, view: MapView, model: BattlefieldMapModel, fonts: FontSet): void {
  const lattice = new Map<number, { x: number; y: number }>();
  for (const marker of model.markers) {
    lattice.set(marker.pointIndex, view.toPt(lonLatToWorld(marker)));
  }
  doc.lineWidth(0.5).strokeColor('#D3DCEA').dash(2, { space: 2 });
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      const here = lattice.get(row * 7 + col);
      if (!here) continue;
      const right = col < 6 ? lattice.get(row * 7 + col + 1) : undefined;
      const down = row < 6 ? lattice.get((row + 1) * 7 + col) : undefined;
      if (right) doc.moveTo(here.x, here.y).lineTo(right.x, right.y).stroke();
      if (down) doc.moveTo(here.x, here.y).lineTo(down.x, down.y).stroke();
    }
  }
  doc.undash();

  const lats = model.markers.map((m) => m.latitude);
  const lngs = model.markers.map((m) => m.longitude);
  if (lats.length > 0) {
    doc.font(fonts.regular).fontSize(5.8).fillColor(REPORT_COLORS.muted);
    doc.text(
      `Grade georreferenciada · NO ${Math.max(...lats).toFixed(4)}, ${Math.min(...lngs).toFixed(4)} · SE ${Math.min(...lats).toFixed(4)}, ${Math.max(...lngs).toFixed(4)}`,
      view.rect.x + 10,
      view.rect.y + 9,
      { lineBreak: false }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Marcadores e empresa auditada                                              */
/* -------------------------------------------------------------------------- */

const TIER_DRAW_ORDER: readonly GridPointVisualTier[] = ['GRAY_UNREADABLE', 'INVISIBLE', 'RED_8_TO_20', 'YELLOW_TOP7', 'GREEN_TOP3'];

interface PlacedMarker {
  readonly marker: MapMarker;
  readonly x: number;
  readonly y: number;
}

function placeMarkers(view: MapView, model: BattlefieldMapModel): PlacedMarker[] {
  return model.markers.map((marker) => {
    const p = view.toPt(lonLatToWorld(marker));
    return { marker, x: p.x, y: p.y };
  });
}

function drawMarkers(doc: Doc, placed: readonly PlacedMarker[], fonts: FontSet, coincidesWith: number | null): void {
  for (const tier of TIER_DRAW_ORDER) {
    for (const { marker, x, y } of placed.filter((p) => p.marker.tier === tier)) {
      const meta = TIER_META[tier];
      if (marker.pointIndex === coincidesWith) {
        // Halo da empresa auditada: anel branco + anel tracejado azul-marinho, distinto de qualquer faixa.
        doc.circle(x, y, MARKER_RADIUS + 5.6).lineWidth(2.4).strokeColor('#FFFFFF').stroke();
        doc.circle(x, y, MARKER_RADIUS + 5.6).lineWidth(1.5).dash(3, { space: 2 }).strokeColor(REPORT_COLORS.navy).stroke();
        doc.undash();
      }
      doc.circle(x, y, MARKER_RADIUS).lineWidth(1.3).fillAndStroke(meta.color, '#FFFFFF');
      const compact = marker.label.length > 2;
      doc.font(fonts.bold).fontSize(compact ? 5.6 : 6.6).fillColor(meta.textColor);
      const w = doc.widthOfString(marker.label);
      doc.text(marker.label, x - w / 2, y - (compact ? 2.7 : 3.2), { lineBreak: false });
    }
  }
}

interface CalloutPlan {
  readonly here: { readonly x: number; readonly y: number };
  readonly label: string;
  /** Segunda linha: nome curto da empresa (cortado em limite de palavra). */
  readonly subLabel: string | null;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly ringRadius: number;
  readonly ownPin: boolean;
}

/**
 * Define onde fica a faixa "Empresa auditada" ANTES dos rótulos do mapa, para que o nome de um
 * bairro ou de uma rua nunca fique escondido embaixo dela.
 */
function planCompanyCallout(
  doc: Doc,
  view: MapView,
  model: BattlefieldMapModel,
  fonts: FontSet,
  sanitize: TextSanitizer,
  businessName: string | null,
  collisions: Collisions
): CalloutPlan | null {
  const company = model.company;
  if (!company) return null;
  const here = view.toPt(lonLatToWorld(company));
  const rect = view.rect;
  const pointNumber = model.companyCoincidesWithPointIndex === null ? null : model.companyCoincidesWithPointIndex + 1;
  const label = sanitize(`Empresa auditada${pointNumber === null ? '' : ` · ponto ${pointNumber}`}`);
  const subLabel = businessName ? sanitize(shortBusinessName(businessName)) : null;
  doc.font(fonts.semibold).fontSize(6.6);
  const labelWidth = doc.widthOfString(label);
  doc.font(fonts.regular).fontSize(6.2);
  const subWidth = subLabel ? doc.widthOfString(subLabel) : 0;
  const width = Math.max(labelWidth, subWidth) + 12;
  const height = subLabel ? 22 : 14;

  const candidates = [
    { x: here.x + 22, y: here.y - 33 },
    { x: here.x - 22 - width, y: here.y - 33 },
    { x: here.x + 22, y: here.y + 19 },
    { x: here.x - 22 - width, y: here.y + 19 },
    { x: here.x + 22, y: here.y - 7 },
    { x: here.x - 22 - width, y: here.y - 7 },
  ];
  const boxOf = (c: { x: number; y: number }): Box => ({ x0: c.x - 1, y0: c.y - 1, x1: c.x + width + 1, y1: c.y + height + 1 });
  const usable = candidates.filter((c) => insideRect(boxOf(c), rect, 5));
  const pick = usable.find((c) => collisions.free(boxOf(c))) ?? usable[0] ?? candidates[0]!;
  collisions.add(boxOf(pick));

  return {
    here,
    label,
    subLabel,
    width,
    height,
    x: pick.x,
    y: pick.y,
    ringRadius: model.companyCoincidesWithPointIndex === null ? 12.5 : MARKER_RADIUS + 6.5,
    ownPin: model.companyCoincidesWithPointIndex === null,
  };
}

/** Faixa informativa com linha-guia, para identificar a empresa sem depender de cor. */
function drawCompanyCallout(doc: Doc, plan: CalloutPlan, fonts: FontSet): void {
  const { here } = plan;
  if (plan.ownPin) {
    // Pino próprio: círculo azul-marinho com anel branco e um prédio estilizado.
    doc.circle(here.x, here.y, 11).lineWidth(2.6).fillAndStroke(REPORT_COLORS.navy, '#FFFFFF');
    doc.rect(here.x - 4, here.y - 4.5, 8, 9).fillColor('#FFFFFF').fill();
    doc.fillColor(REPORT_COLORS.navy);
    for (const [dx, dy] of [[-2.2, -2.6], [0.8, -2.6], [-2.2, 0], [0.8, 0]] as const) doc.rect(here.x + dx, here.y + dy, 1.4, 1.4).fill();
  }

  // A linha-guia sai da borda do anel (nunca do centro), para não cruzar o número do marcador.
  const endX = plan.x > here.x ? plan.x : plan.x + plan.width;
  const endY = plan.y + plan.height / 2;
  const dx = endX - here.x;
  const dy = endY - here.y;
  const length = Math.hypot(dx, dy) || 1;
  const startX = here.x + (dx / length) * plan.ringRadius;
  const startY = here.y + (dy / length) * plan.ringRadius;
  doc.moveTo(startX, startY).lineTo(endX, endY).lineWidth(1).strokeColor(REPORT_COLORS.navy).stroke();
  doc.roundedRect(plan.x, plan.y, plan.width, plan.height, 7).fillColor(REPORT_COLORS.navy).fill();
  doc.font(fonts.semibold).fontSize(6.6).fillColor('#FFFFFF').text(plan.label, plan.x + 6, plan.y + 4.2, { lineBreak: false });
  if (plan.subLabel) {
    doc.font(fonts.regular).fontSize(6.2).fillColor('#C9D9F2').text(plan.subLabel, plan.x + 6, plan.y + 13, { lineBreak: false });
  }
}

/** Nome curto para o mapa: primeiro trecho antes de separadores, cortado em limite de palavra. */
export function shortBusinessName(name: string, max = 30): string {
  const first = name.split(/\s+[|–—·]\s+|\s+-\s+/)[0]?.trim() || name.trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 12 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* Painel completo                                                            */
/* -------------------------------------------------------------------------- */

export interface MapPanelContext {
  readonly fonts: FontSet;
  readonly sanitize: TextSanitizer;
  readonly businessName: string | null;
  /** Aviso a imprimir quando não há mapa-base. */
  readonly notice: string | null;
  readonly attribution: string | null;
}

export interface MapRenderResult {
  readonly basemap: 'INCLUDED' | 'OMITTED';
  readonly zoom: number | null;
  readonly tilesUsed: number;
  readonly roadLabels: number;
  readonly placeLabels: number;
}

function drawNorthArrow(doc: Doc, rect: Rect, fonts: FontSet): void {
  const cx = rect.x + rect.width - 22;
  const cy = rect.y + 30;
  doc.circle(cx, cy, 13).fillColor('#FFFFFF').opacity(0.92).fill().opacity(1);
  doc.moveTo(cx, cy - 9).lineTo(cx + 4.5, cy + 5).lineTo(cx, cy + 2).lineTo(cx - 4.5, cy + 5).closePath().fillColor(REPORT_COLORS.navy).fill();
  doc.font(fonts.bold).fontSize(6).fillColor(REPORT_COLORS.navy).text('N', cx - 2.4, cy - 17.5, { lineBreak: false });
}

function drawScaleBar(doc: Doc, view: MapView, rect: Rect, fonts: FontSet): Box {
  const { meters, pt } = niceScaleLength(view.metersPerPt(), 72);
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  const x = rect.x + 12;
  const y = rect.y + rect.height - 22;
  doc.roundedRect(x - 6, y - 7, pt + 40, 22, 5).fillColor('#FFFFFF').opacity(0.92).fill().opacity(1);
  doc.lineWidth(1.4).strokeColor(REPORT_COLORS.navy);
  doc.moveTo(x, y + 2).lineTo(x, y + 9).lineTo(x + pt, y + 9).lineTo(x + pt, y + 2).stroke();
  doc.font(fonts.semibold).fontSize(6.4).fillColor(REPORT_COLORS.navy).text(label, x + pt + 6, y + 4, { lineBreak: false });
  return { x0: x - 6, y0: y - 7, x1: x + pt + 34, y1: y + 15 };
}

function drawAttribution(doc: Doc, rect: Rect, fonts: FontSet, text: string): Box {
  doc.font(fonts.regular).fontSize(5.8);
  const width = doc.widthOfString(text) + 10;
  const x = rect.x + rect.width - width - 4;
  const y = rect.y + rect.height - 15;
  doc.roundedRect(x, y, width, 11.5, 3).fillColor('#FFFFFF').opacity(0.92).fill().opacity(1);
  doc.fillColor(REPORT_COLORS.text).text(text, x + 5, y + 3, { lineBreak: false });
  return { x0: x, y0: y, x1: x + width, y1: y + 12 };
}

function drawNotice(doc: Doc, rect: Rect, fonts: FontSet, text: string, leftEdge: number): Box {
  const x = leftEdge;
  const width = rect.x + rect.width - 12 - x;
  doc.font(fonts.medium).fontSize(6.4);
  const textHeight = doc.heightOfString(text, { width: width - 16 });
  const height = Math.max(17, textHeight + 10);
  const y = rect.y + rect.height - 12 - height;
  doc.roundedRect(x, y, width, height, 8).fillColor(REPORT_COLORS.navy).opacity(0.94).fill().opacity(1);
  doc.fillColor('#FFFFFF').text(text, x + 8, y + 5, { width: width - 16 });
  return { x0: x, y0: y, x1: x + width, y1: y + height };
}

/**
 * Desenha o painel do mapa em `rect`: mapa-base vetorial (quando preparado) ou a grade
 * georreferenciada, os 49 marcadores, a empresa auditada, escala, norte e atribuição.
 * Nunca inventa dados: sem tiles, só aparecem as coordenadas reais da auditoria.
 */
export function drawMapPanel(
  doc: Doc,
  rect: Rect,
  model: BattlefieldMapModel,
  prepared: PreparedBasemap | null,
  ctx: MapPanelContext
): MapRenderResult {
  // A visão é recalculada para o retângulo real (a posição vertical na página só é conhecida agora);
  // os tiles buscados antes dependem só do tamanho do retângulo, que é o mesmo.
  const view = buildMapView(model, rect);
  const live: PreparedBasemap | null = prepared ? { ...prepared, view } : null;
  const { fonts, sanitize } = ctx;
  const collisions = new Collisions();
  let roadLabels = 0;
  let placeLabels = 0;

  doc.save();
  doc.roundedRect(rect.x, rect.y, rect.width, rect.height, 10).clip();
  doc.rect(rect.x, rect.y, rect.width, rect.height).fillColor(live ? STYLE.background : REPORT_COLORS.bgSoft).fill();

  const placed = placeMarkers(view, model);
  for (const { x, y } of placed) {
    collisions.add({ x0: x - MARKER_RADIUS - 2, x1: x + MARKER_RADIUS + 2, y0: y - MARKER_RADIUS - 2, y1: y + MARKER_RADIUS + 2 });
  }

  if (live) {
    drawBaseLayers(doc, live);
    drawRoads(doc, live);
  } else {
    drawBareGrid(doc, view, model, fonts);
  }

  // Áreas reservadas aos elementos de sobreposição: rótulos não passam por baixo deles.
  const scaleReserve = { x0: rect.x, y0: rect.y + rect.height - 30, x1: rect.x + 130, y1: rect.y + rect.height };
  const attributionText = live && ctx.attribution ? ctx.attribution : null;
  collisions.add(scaleReserve);
  collisions.add({ x0: rect.x + rect.width - 280, y0: rect.y + rect.height - 20, x1: rect.x + rect.width, y1: rect.y + rect.height });
  collisions.add({ x0: rect.x + rect.width - 44, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + 52 });
  collisions.add({ x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + 32 });

  const callout = planCompanyCallout(doc, view, model, fonts, sanitize, ctx.businessName, collisions);

  if (live) {
    placeLabels = drawPlaceLabels(doc, live, rect, fonts, sanitize, collisions);
    drawWaterLabels(doc, live, rect, fonts, sanitize, collisions);
    roadLabels = drawRoadLabels(doc, live, rect, fonts, sanitize, collisions);
  }

  drawMarkers(doc, placed, fonts, model.companyCoincidesWithPointIndex);
  if (callout) drawCompanyCallout(doc, callout, fonts);
  drawNorthArrow(doc, rect, fonts);
  const scaleBox = drawScaleBar(doc, view, rect, fonts);
  if (attributionText) drawAttribution(doc, rect, fonts, sanitize(attributionText));
  if (!live && ctx.notice) drawNotice(doc, rect, fonts, sanitize(ctx.notice), scaleBox.x1 + 10);
  doc.restore();

  doc.roundedRect(rect.x, rect.y, rect.width, rect.height, 10).lineWidth(0.8).strokeColor(REPORT_COLORS.borderStrong).stroke();

  return {
    basemap: live ? 'INCLUDED' : 'OMITTED',
    zoom: live?.zoom ?? null,
    tilesUsed: live?.tiles.length ?? 0,
    roadLabels,
    placeLabels,
  };
}
