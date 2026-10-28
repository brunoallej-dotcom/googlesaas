import { normalizeCid } from '../link-audit/identifiers';
import type { MapsProvider, MapsSearchRequest, ProviderOutcome } from '../link-audit/collector/types';
import { safeFailureReason } from '../link-audit/url-redaction';

/*
 * Provedor REAL do Serper /maps para a Auditoria por Link (Onda 4B). Código só de servidor.
 *
 * Regras (todas testadas com transporte falso; NENHUMA chamada real foi feita ao escrevê-lo):
 *  - uma chamada por `search`, sem repetição automática (nem em erro, nem em "refresh");
 *  - a URL tem de ser https em *.serper.dev e o caminho /maps (a chave nunca vai para outro destino);
 *  - `redirect: 'error'`: a chave nunca acompanha um redirecionamento;
 *  - a chave só viaja no cabeçalho; nunca em log, erro, evidência ou relatório;
 *  - resposta lida com teto de bytes; respostas não-2xx não têm o corpo lido nem repetido;
 *  - nenhum /reviews. Este é o ÚNICO arquivo do projeto de coleta que usa `fetch`.
 */

export const DEFAULT_SERPER_MAPS_URL = 'https://google.serper.dev/maps';
export const SERPER_TIMEOUT_MS = 12_000;
export const SERPER_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_ZOOM = 14;

export interface SerperTransportInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

export interface SerperTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  /** Lê o corpo até `maxBytes`; acima disso deve lançar. */
  readText(maxBytes: number): Promise<string>;
}

export type SerperTransport = (url: string, init: SerperTransportInit) => Promise<SerperTransportResponse>;

/** Transporte padrão: o `fetch` global, com leitura em fluxo e teto de tamanho. */
export const fetchTransport: SerperTransport = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    async readText(maxBytes: number): Promise<string> {
      const reader = response.body?.getReader();
      if (!reader) return '';
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('resposta acima do tamanho máximo');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
  };
};

/** O que o provedor entrega ao gancho de captura: NUNCA cabeçalhos nem a chave. */
export interface ProviderCaptureInfo {
  readonly url: string;
  readonly requestBody: Record<string, unknown>;
  readonly httpStatus: number | null;
  /** Texto UTF-8 decodificado da resposta (só quando lido); `null` se não houve corpo. */
  readonly bodyText: string | null;
  readonly attempts: number;
  readonly failure: string | null;
  readonly capturedAt: string;
}

export interface SerperMapsProviderConfig {
  /** Chamado uma vez por consulta, assim que a resposta (ou a falha) é conhecida. Erros do gancho são engolidos. */
  readonly onCapture?: (info: ProviderCaptureInfo) => Promise<void> | void;
  readonly apiKey: string;
  readonly url?: string;
  readonly transport?: SerperTransport;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export function assertSerperMapsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL do Serper inválida.');
  }
  const host = url.hostname.toLowerCase();
  const hostOk = host === 'serper.dev' || host.endsWith('.serper.dev');
  if (url.protocol !== 'https:' || !hostOk || url.username || url.password || url.port !== '' || url.pathname !== '/maps' || url.search || url.hash) {
    throw new Error('URL do Serper recusada: só https://*.serper.dev/maps é aceito (a chave não é enviada a outro destino).');
  }
  return url;
}

export function buildSerperMapsBody(request: MapsSearchRequest): Record<string, unknown> {
  const zoom = request.viewport?.zoom;
  return {
    q: request.query,
    ...(request.viewport
      ? { ll: `@${request.viewport.latitude},${request.viewport.longitude},${Number.isFinite(zoom) && zoom ? zoom : DEFAULT_ZOOM}z` }
      : {}),
    // Só se o chamador pedir: o parâmetro `cid` de ENTRADA do /maps não está confirmado e o coletor não o usa.
    ...(request.cid !== undefined && normalizeCid(request.cid).ok ? { cid: (normalizeCid(request.cid) as { cid: string }).cid } : {}),
    gl: 'br',
    hl: 'pt-br',
    page: 1,
  };
}

export function createSerperMapsProvider(config: SerperMapsProviderConfig): MapsProvider {
  const url = assertSerperMapsUrl(config.url ?? DEFAULT_SERPER_MAPS_URL).toString();
  if (typeof config.apiKey !== 'string' || config.apiKey.trim().length <= 10) throw new Error('Chave do Serper ausente ou inválida.');
  const apiKey = config.apiKey.trim();
  const transport = config.transport ?? fetchTransport;
  const timeoutMs = Math.min(Math.max(1, config.timeoutMs ?? SERPER_TIMEOUT_MS), 60_000);
  const now = config.now ?? (() => new Date());
  const scrub = (text: string): string => text.split(apiKey).join('[REDACTED]');

  return {
    live: true,
    async search(request: MapsSearchRequest): Promise<ProviderOutcome<readonly unknown[]>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const requestBody = buildSerperMapsBody(request);
      const capture = async (httpStatus: number | null, bodyText: string | null, failure: string | null): Promise<void> => {
        if (!config.onCapture) return;
        try {
          await config.onCapture({ url, requestBody, httpStatus, bodyText, attempts: 1, failure, capturedAt: now().toISOString() });
        } catch {
          // a persistência trata os próprios erros; a consulta já foi feita e seu resultado não pode ser perdido aqui
        }
      };
      try {
        let response: SerperTransportResponse;
        try {
          response = await transport(url, {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            redirect: 'error',
            signal: controller.signal,
          });
        } catch (error) {
          const reason = scrub(controller.signal.aborted ? 'tempo limite da consulta excedido' : safeFailureReason(error));
          await capture(null, null, reason);
          return { state: 'FAILED', reason };
        }
        if (!response.ok) {
          await capture(response.status, null, null);
          return { state: 'FAILED', reason: `Serper /maps respondeu HTTP ${response.status}` };
        }

        let text: string;
        try {
          text = await response.readText(SERPER_MAX_RESPONSE_BYTES);
        } catch (error) {
          const reason = scrub(controller.signal.aborted ? 'tempo limite da consulta excedido' : safeFailureReason(error));
          await capture(response.status, null, reason);
          return { state: 'FAILED', reason };
        }
        await capture(response.status, text, null); // a resposta paga é entregue à persistência ANTES de qualquer processamento
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { state: 'FAILED', reason: 'A resposta do Serper /maps não é JSON.' };
        }
        const places = payload && typeof payload === 'object' ? (payload as { places?: unknown }).places : undefined;
        if (!Array.isArray(places)) return { state: 'FAILED', reason: 'A resposta do Serper /maps não traz a lista "places" esperada.' };
        return { state: 'OK', value: places, fetchedAt: now().toISOString() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
