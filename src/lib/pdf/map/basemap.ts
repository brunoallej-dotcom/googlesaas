import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TileCoord } from './projection';

/**
 * ============================================================================
 * MAPA-BASE DO PDF: provedor desacoplado.
 *
 * O renderizador do mapa só conhece `BasemapProvider`. Trocar de provedor (extrato próprio,
 * serviço pago com chave) não exige mexer no PDF.
 *
 * LICENCIAMENTO (ver docs/fase3-pdf-mapa-licenciamento.md):
 * - O servidor público do OpenStreetMap NÃO é usado: a política dele desencoraja busca
 *   automática de tiles fora de visualização ativa.
 * - Os termos do OpenFreeMap proíbem coleta automatizada, exceto "downloads offline" pequenos,
 *   e não tratam de PDFs gerados por um serviço comercial. Por isso a integração de rede fica
 *   DESLIGADA por padrão e só liga com autorização registrada no ambiente.
 * ============================================================================
 */

export interface BasemapProvider {
  readonly id: 'none' | 'local-dir' | 'openfreemap' | 'mbtiles';
  readonly kind: 'none' | 'vector-tiles';
  /** Texto de atribuição que deve ser impresso na moldura do mapa. Nulo quando não há base. */
  readonly attribution: string | null;
  readonly maxZoom: number;
  /** Teto de tiles por relatório (o renderizador reduz o zoom para respeitá-lo). */
  readonly maxTilesPerReport: number;
  /** Devolve o tile vetorial (MVT) ou nulo se não existir. */
  getTile(tile: TileCoord): Promise<Uint8Array | null>;
}

export type BasemapStatus = 'NONE' | 'ENABLED' | 'NOT_AUTHORIZED' | 'MISCONFIGURED';

export interface BasemapResolution {
  readonly provider: BasemapProvider;
  readonly status: BasemapStatus;
  /** Aviso a imprimir quando não há mapa-base. */
  readonly notice: string | null;
}

export class BasemapBudgetError extends Error {
  constructor(limit: number) {
    super(`Limite de ${limit} tiles por relatório atingido.`);
    this.name = 'BasemapBudgetError';
  }
}

export class BasemapNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BasemapNetworkError';
  }
}

export const NO_BASEMAP_NOTICE = 'Mapa-base (ruas e bairros) não incluído nesta emissão.';
const NOT_AUTHORIZED_NOTICE =
  'Mapa-base desativado: a integração com o provedor de mapas exige autorização registrada. Os pontos abaixo são reais e georreferenciados, sem ruas e bairros.';
const MISCONFIGURED_NOTICE =
  'Mapa-base indisponível: a fonte de tiles configurada não foi encontrada. Os pontos abaixo são reais e georreferenciados, sem ruas e bairros.';

export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
export const OPENFREEMAP_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_HOST = 'tiles.openfreemap.org';
export const DEFAULT_USER_AGENT = 'GMN-Intelligence-Platform/1.0 (relatorio PDF; uso individual por auditoria)';

const DEFAULT_MAX_TILES = 16;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_ZOOM = 14;

function assertValidTile(tile: TileCoord, maxZoom: number): void {
  const n = 2 ** tile.z;
  const ok =
    Number.isInteger(tile.z) &&
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.z >= 0 &&
    tile.z <= maxZoom &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x < n &&
    tile.y < n;
  if (!ok) throw new Error(`Tile inválido: ${tile.z}/${tile.x}/${tile.y}`);
}

/* -------------------------------------------------------------------------- */
/* Sem mapa-base (padrão): sempre disponível, sem terceiros                    */
/* -------------------------------------------------------------------------- */

export const noBasemapProvider: BasemapProvider = {
  id: 'none',
  kind: 'none',
  attribution: null,
  maxZoom: 0,
  maxTilesPerReport: 0,
  getTile: async () => null,
};

/* -------------------------------------------------------------------------- */
/* Pasta local de tiles (z/x/y.pbf): testes e extratos próprios/licenciados    */
/* -------------------------------------------------------------------------- */

export class LocalDirectoryProvider implements BasemapProvider {
  readonly id = 'local-dir' as const;
  readonly kind = 'vector-tiles' as const;
  readonly maxTilesPerReport: number;

  constructor(
    private readonly directory: string,
    readonly attribution: string,
    readonly maxZoom: number = DEFAULT_MAX_ZOOM,
    maxTilesPerReport: number = DEFAULT_MAX_TILES
  ) {
    this.maxTilesPerReport = maxTilesPerReport;
  }

  async getTile(tile: TileCoord): Promise<Uint8Array | null> {
    assertValidTile(tile, this.maxZoom);
    // z/x/y são inteiros validados: não há como sair da pasta.
    const file = path.join(this.directory, String(tile.z), String(tile.x), `${tile.y}.pbf`);
    try {
      return new Uint8Array(await fs.readFile(file));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* MBTiles local: extrato próprio do OpenStreetMap (ODbL), sem rede e sem custo */
/* -------------------------------------------------------------------------- */

export const OSM_MBTILES_ATTRIBUTION = '© OpenStreetMap contributors, © OpenMapTiles';

interface MbtilesDb {
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}

/**
 * Lê tiles vetoriais (MVT) de um arquivo `.mbtiles` (SQLite) gerado por nós a partir de um extrato
 * do OpenStreetMap, por exemplo com o Planetiler. Nenhuma requisição de rede é feita, portanto não
 * há limite de uso de servidores públicos; a licença dos dados (ODbL) exige a atribuição impressa
 * no mapa. Usa o `node:sqlite` nativo do Node 22 (sem dependência nova), somente leitura.
 */
export class MbtilesProvider implements BasemapProvider {
  readonly id = 'mbtiles' as const;
  readonly kind = 'vector-tiles' as const;
  readonly maxTilesPerReport: number;

  private constructor(
    private readonly db: MbtilesDb,
    readonly attribution: string,
    readonly maxZoom: number,
    maxTilesPerReport: number
  ) {
    this.maxTilesPerReport = maxTilesPerReport;
  }

  static async open(
    file: string,
    options: { readonly attribution?: string; readonly maxZoom?: number; readonly maxTilesPerReport?: number } = {}
  ): Promise<MbtilesProvider> {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => MbtilesDb;
    };
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.prepare('SELECT 1 FROM tiles LIMIT 1').get();
    } catch (error: unknown) {
      db.close();
      throw new BasemapNetworkError(`Arquivo MBTiles inválido: ${error instanceof Error ? error.message : String(error)}`);
    }
    let attribution = options.attribution?.trim();
    if (!attribution) {
      try {
        const row = db.prepare("SELECT value FROM metadata WHERE name = 'attribution'").get();
        attribution = typeof row?.value === 'string' && row.value.trim() ? row.value.replace(/<[^>]*>/g, '').trim() : undefined;
      } catch {
        attribution = undefined;
      }
    }
    return new MbtilesProvider(db, attribution || OSM_MBTILES_ATTRIBUTION, options.maxZoom ?? DEFAULT_MAX_ZOOM, options.maxTilesPerReport ?? DEFAULT_MAX_TILES);
  }

  async getTile(tile: TileCoord): Promise<Uint8Array | null> {
    assertValidTile(tile, this.maxZoom);
    // MBTiles guarda a linha em esquema TMS (eixo Y invertido).
    const tmsRow = 2 ** tile.z - 1 - tile.y;
    const row = this.db
      .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
      .get(tile.z, tile.x, tmsRow);
    const data = row?.tile_data;
    if (!(data instanceof Uint8Array)) return null;
    const bytes = new Uint8Array(data);
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(zlib.gunzipSync(bytes)) : bytes;
  }

  close(): void {
    this.db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* OpenFreeMap (rede): DESLIGADO por padrão; exige autorização registrada      */
/* -------------------------------------------------------------------------- */

export interface OpenFreeMapOptions {
  readonly fetchImpl?: typeof fetch;
  readonly cacheDir?: string | null;
  readonly userAgent?: string;
  readonly maxParallel?: number;
  readonly maxTilesPerReport?: number;
  readonly timeoutMs?: number;
}

export class OpenFreeMapProvider implements BasemapProvider {
  readonly id = 'openfreemap' as const;
  readonly kind = 'vector-tiles' as const;
  readonly attribution = OPENFREEMAP_ATTRIBUTION;
  readonly maxZoom = DEFAULT_MAX_ZOOM;
  readonly maxTilesPerReport: number;

  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string | null;
  private readonly userAgent: string;
  private readonly maxParallel: number;
  private readonly timeoutMs: number;
  private template: Promise<string> | null = null;
  private networkFetches = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: OpenFreeMapOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheDir = options.cacheDir ?? null;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.maxTilesPerReport = options.maxTilesPerReport ?? DEFAULT_MAX_TILES;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Lê o TileJSON (que traz a versão atual dos tiles) e valida o host do modelo de URL. */
  private loadTemplate(): Promise<string> {
    if (!this.template) {
      this.template = (async () => {
        const response = await this.request(OPENFREEMAP_TILEJSON_URL, 'application/json');
        const json = (await response.json()) as { tiles?: unknown };
        const template = Array.isArray(json.tiles) ? json.tiles[0] : undefined;
        if (typeof template !== 'string') throw new BasemapNetworkError('TileJSON sem modelo de URL de tiles.');
        const url = new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
        if (url.protocol !== 'https:' || url.hostname !== OPENFREEMAP_HOST) {
          throw new BasemapNetworkError(`Host de tiles não permitido: ${url.hostname}`);
        }
        return template;
      })();
      this.template.catch(() => {
        this.template = null;
      });
    }
    return this.template;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxParallel) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }

  private async request(url: string, accept: string): Promise<Response> {
    await this.acquire();
    try {
      const response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: accept },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response;
    } finally {
      this.release();
    }
  }

  async getTile(tile: TileCoord): Promise<Uint8Array | null> {
    assertValidTile(tile, this.maxZoom);
    const template = await this.loadTemplate();
    const version = /\/planet\/([0-9A-Za-z_.-]+)\//.exec(template)?.[1] ?? 'latest';
    const cacheFile = this.cacheDir
      ? path.join(this.cacheDir, version, String(tile.z), String(tile.x), `${tile.y}.pbf`)
      : null;

    if (cacheFile) {
      try {
        return new Uint8Array(await fs.readFile(cacheFile));
      } catch {
        /* sem cache: busca na rede */
      }
    }

    if (this.networkFetches >= this.maxTilesPerReport) throw new BasemapBudgetError(this.maxTilesPerReport);
    this.networkFetches += 1;

    const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
    const response = await this.request(url, 'application/x-protobuf');
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw new BasemapNetworkError(`Tile ${tile.z}/${tile.x}/${tile.y}: HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (cacheFile) {
      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, bytes);
      } catch {
        /* cache é opcional */
      }
    }
    return bytes;
  }
}

/* -------------------------------------------------------------------------- */
/* Seleção pelo ambiente                                                       */
/* -------------------------------------------------------------------------- */

export interface BasemapEnv {
  readonly GMN_PDF_BASEMAP?: string;
  readonly GMN_PDF_BASEMAP_AUTH_REF?: string;
  readonly GMN_PDF_TILES_DIR?: string;
  readonly GMN_PDF_MBTILES_PATH?: string;
  readonly GMN_PDF_TILES_ATTRIBUTION?: string;
  readonly GMN_PDF_TILE_CACHE_DIR?: string;
  readonly GMN_PDF_TILES_USER_AGENT?: string;
}

export async function resolveBasemap(
  env: BasemapEnv = process.env as BasemapEnv,
  deps: { readonly fetchImpl?: typeof fetch } = {}
): Promise<BasemapResolution> {
  const mode = (env.GMN_PDF_BASEMAP ?? 'none').trim().toLowerCase();

  if (mode === 'openfreemap') {
    const authRef = (env.GMN_PDF_BASEMAP_AUTH_REF ?? '').trim();
    if (authRef.length < 4) {
      return { provider: noBasemapProvider, status: 'NOT_AUTHORIZED', notice: NOT_AUTHORIZED_NOTICE };
    }
    const provider = new OpenFreeMapProvider({
      fetchImpl: deps.fetchImpl,
      cacheDir: env.GMN_PDF_TILE_CACHE_DIR?.trim() || path.join(process.cwd(), '.cache', 'gmn-map-tiles'),
      userAgent: env.GMN_PDF_TILES_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    });
    return { provider, status: 'ENABLED', notice: null };
  }

  if (mode === 'mbtiles') {
    const file = (env.GMN_PDF_MBTILES_PATH ?? '').trim();
    try {
      if (!file || !(await fs.stat(file)).isFile()) throw new Error('arquivo ausente');
      const provider = await MbtilesProvider.open(file, { attribution: env.GMN_PDF_TILES_ATTRIBUTION?.trim() || undefined });
      return { provider, status: 'ENABLED', notice: null };
    } catch {
      return { provider: noBasemapProvider, status: 'MISCONFIGURED', notice: MISCONFIGURED_NOTICE };
    }
  }

  if (mode === 'local-dir') {
    const dir = (env.GMN_PDF_TILES_DIR ?? '').trim();
    let exists = false;
    if (dir) {
      try {
        exists = (await fs.stat(dir)).isDirectory();
      } catch {
        exists = false;
      }
    }
    if (!exists) return { provider: noBasemapProvider, status: 'MISCONFIGURED', notice: MISCONFIGURED_NOTICE };
    const attribution = env.GMN_PDF_TILES_ATTRIBUTION?.trim() || OPENFREEMAP_ATTRIBUTION;
    return { provider: new LocalDirectoryProvider(dir, attribution), status: 'ENABLED', notice: null };
  }

  return { provider: noBasemapProvider, status: 'NONE', notice: NO_BASEMAP_NOTICE };
}
