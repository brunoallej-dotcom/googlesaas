/** Projeção Web Mercator (EPSG:3857) normalizada em [0,1) e seleção de tiles. */

export interface LonLat {
  readonly longitude: number;
  readonly latitude: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MAX_LATITUDE = 85.0511287798;
const EARTH_CIRCUMFERENCE_METERS = 40075016.686;

export function lonLatToWorld(point: LonLat): WorldPoint {
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point.latitude));
  const rad = (lat * Math.PI) / 180;
  return {
    x: (point.longitude + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI),
  };
}

export interface MapView {
  /** Pontos do PDF por unidade do mundo normalizado. */
  readonly scale: number;
  readonly centerWorld: WorldPoint;
  readonly rect: Rect;
  readonly latitude: number;
  /** Ponto do PDF onde fica o centro dos dados (centro da área útil). */
  readonly originPt: { readonly x: number; readonly y: number };
  toPt(world: WorldPoint): { readonly x: number; readonly y: number };
  /** Retângulo do mundo visível dentro de `rect`. */
  visibleWorld(): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  metersPerPt(): number;
}

export interface Padding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export function fitView(
  coordinates: readonly LonLat[],
  rect: Rect,
  padding: number | Padding
): MapView {
  const pad: Padding =
    typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding;
  if (coordinates.length === 0) throw new Error('Sem coordenadas para enquadrar o mapa.');
  const worlds = coordinates.map(lonLatToWorld);
  const xs = worlds.map((w) => w.x);
  const ys = worlds.map((w) => w.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const spanX = Math.max(x1 - x0, 1e-9);
  const spanY = Math.max(y1 - y0, 1e-9);
  const availableW = Math.max(1, rect.width - pad.left - pad.right);
  const availableH = Math.max(1, rect.height - pad.top - pad.bottom);
  const scale = Math.min(availableW / spanX, availableH / spanY);
  // O centro dos pontos fica no centro da área útil (descontadas as margens), não do retângulo.
  const originX = rect.x + pad.left + availableW / 2;
  const originY = rect.y + pad.top + availableH / 2;
  const centerWorld: WorldPoint = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const latitude = coordinates.reduce((sum, c) => sum + c.latitude, 0) / coordinates.length;

  return {
    scale,
    centerWorld,
    rect,
    latitude,
    originPt: { x: originX, y: originY },
    toPt: (world) => ({
      x: originX + (world.x - centerWorld.x) * scale,
      y: originY + (world.y - centerWorld.y) * scale,
    }),
    visibleWorld: () => ({
      x0: centerWorld.x - (originX - rect.x) / scale,
      x1: centerWorld.x + (rect.x + rect.width - originX) / scale,
      y0: centerWorld.y - (originY - rect.y) / scale,
      y1: centerWorld.y + (rect.y + rect.height - originY) / scale,
    }),
    metersPerPt: () => (EARTH_CIRCUMFERENCE_METERS * Math.cos((latitude * Math.PI) / 180)) / scale,
  };
}

export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export function tilesCovering(
  visible: { x0: number; y0: number; x1: number; y1: number },
  zoom: number
): readonly TileCoord[] {
  const n = 2 ** zoom;
  const clamp = (v: number): number => Math.max(0, Math.min(n - 1, v));
  const xMin = clamp(Math.floor(visible.x0 * n));
  const xMax = clamp(Math.floor(visible.x1 * n));
  const yMin = clamp(Math.floor(visible.y0 * n));
  const yMax = clamp(Math.floor(visible.y1 * n));
  const tiles: TileCoord[] = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) tiles.push({ z: zoom, x, y });
  }
  return tiles;
}

/**
 * Maior zoom (até `maxZoom`) cujo número de tiles não passa de `maxTiles`.
 * Garante um teto de tiles por relatório, em vez de depender do tamanho da área.
 */
export function chooseZoom(
  visible: { x0: number; y0: number; x1: number; y1: number },
  maxZoom: number,
  maxTiles: number
): { readonly zoom: number; readonly tiles: readonly TileCoord[] } {
  for (let zoom = maxZoom; zoom >= 0; zoom--) {
    const tiles = tilesCovering(visible, zoom);
    if (tiles.length <= maxTiles) return { zoom, tiles };
  }
  return { zoom: 0, tiles: tilesCovering(visible, 0) };
}

/** Converte coordenadas locais do tile (0..extent) em mundo normalizado. */
export function tilePointToWorld(tile: TileCoord, px: number, py: number, extent: number): WorldPoint {
  const n = 2 ** tile.z;
  return { x: (tile.x + px / extent) / n, y: (tile.y + py / extent) / n };
}

/** Comprimento "redondo" de barra de escala mais próximo de `targetPt`. */
export function niceScaleLength(metersPerPt: number, targetPt: number): { readonly meters: number; readonly pt: number } {
  const options = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  let best = options[0] as number;
  for (const meters of options) {
    if (Math.abs(meters / metersPerPt - targetPt) < Math.abs(best / metersPerPt - targetPt)) best = meters;
  }
  return { meters: best, pt: best / metersPerPt };
}
