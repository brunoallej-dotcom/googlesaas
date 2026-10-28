import { checkWebsite, nodeTransport, type SiteTransport } from '../site-check';
import { systemResolver, UnsafeUrlError, type HostResolver } from '../url-safety';
import type { SiteProvider } from '../link-audit/collector/types';
import type { SiteAccessSignals, SiteCheckOutcome } from '../link-audit/collector/site-access';

/*
 * Verificação segura do site próprio (Onda 4B). Reutiliza `checkWebsite` SEM alterá-lo e acrescenta um
 * transporte limitador: no máximo 8 requisições HTTP por verificação e nenhuma página de login ou área
 * autenticada. SSRF, DNS fixado (revalidado a cada redirecionamento), bloqueio de IPs privados, tempo
 * limite de 8 s, teto de 512 KB e leitura por expressões regulares (nenhum JavaScript do site é executado)
 * continuam vindo de `site-check.ts` e `url-safety.ts`.
 */

export const SITE_MAX_HTTP_REQUESTS = 8;

const LOGIN_OR_AUTH_PATH =
  /(^|\/)(wp-login|wp-admin|login|log-in|logon|signin|sign-in|signup|sign-up|auth|authenticate|oauth\d*|saml\d*|idp|sso|servicelogin|account|accounts|my-account|minha-conta|admin|administrator|dashboard|painel|entrar|acesso|cadastro|checkout)(\.[a-z0-9]+)?(\/|$)/i;

const LOGIN_HOST_LABEL = /^(login|logon|signin|sso|auth|accounts|id|idp)\./i;

export interface LimitedTransport {
  readonly transport: SiteTransport;
  count(): number;
  /** Sinais observados (limite, login bloqueado, desafio de autenticação). */
  signals(): SiteAccessSignals;
}

export function createLimitedSiteTransport(inner: SiteTransport, maxRequests: number = SITE_MAX_HTTP_REQUESTS): LimitedTransport {
  let requests = 0;
  let authChallenge = false;
  let loginPathBlocked = false;
  let requestLimitReached = false;
  const transport: SiteTransport = async (request) => {
    if (requests >= maxRequests) {
      requestLimitReached = true;
      throw new UnsafeUrlError(`Limite de ${maxRequests} requisições HTTP por verificação atingido.`);
    }
    requests += 1;
    if (LOGIN_OR_AUTH_PATH.test(request.url.pathname) || LOGIN_HOST_LABEL.test(request.url.hostname)) {
      loginPathBlocked = true;
      throw new UnsafeUrlError('Página de login ou área autenticada: não coletada.');
    }
    const response = await inner(request);
    // 401/403 NÃO são mais um erro de segurança: passam adiante com o código real. O desafio de autenticação
    // (WWW-Authenticate) é só registrado como sinal.
    const challenge = response.headers['www-authenticate'];
    // Vale o desafio da resposta MAIS RECENTE (a final, quando a página não deu 2xx): um desafio de um salto anterior não conta.
    authChallenge = Array.isArray(challenge) ? challenge.some((value) => value !== '') : challenge !== undefined && challenge !== '';
    return response;
  };
  return { transport, count: () => requests, signals: () => ({ requests, authChallenge, loginPathBlocked, requestLimitReached }) };
}

export interface SiteProviderConfig {
  readonly transport?: SiteTransport;
  readonly resolver?: HostResolver;
  readonly now?: () => Date;
}

export interface CountingSiteProvider extends SiteProvider {
  /** Requisições HTTP feitas na última verificação. */
  lastRequestCount(): number;
}

export function createSiteProvider(config: SiteProviderConfig = {}): CountingSiteProvider {
  let last = 0;
  return {
    live: true,
    async check(url: string): Promise<SiteCheckOutcome> {
      const limited = createLimitedSiteTransport(config.transport ?? nodeTransport);
      try {
        const result = await checkWebsite(url, {
          transport: limited.transport,
          resolver: config.resolver ?? systemResolver,
          ...(config.now ? { now: config.now } : {}),
        });
        return { ...result, access: limited.signals() };
      } finally {
        last = limited.count();
      }
    },
    lastRequestCount: () => last,
  };
}
