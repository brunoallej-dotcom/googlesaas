import type { CompanyIdentity } from '@/lib/link-audit/audit';
import type { MapsLinkParseResult } from '@/lib/link-audit/maps-link';
import { STATUS_VIEW } from './messages';

/*
 * Cliente das rotas internas da Auditoria por Link. Roda no navegador: só `fetch` para o próprio
 * servidor (mesma origem, com o cookie de sessão). Nunca fala com o Google nem com outro site.
 */

export type ApiOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'error'; readonly message: string };

async function post<T>(path: string, body: unknown, pick: (json: Record<string, unknown>) => T | null): Promise<ApiOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    return { kind: 'error', message: 'Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.' };
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && json) {
    const value = pick(json);
    if (value !== null) return { kind: 'ok', value };
    return { kind: 'error', message: 'Resposta inesperada do servidor.' };
  }
  if (response.status === 403) return { kind: 'error', message: 'Acesso negado para esta operação.' };
  if (response.status === 409 && typeof json?.error === 'string') return { kind: 'error', message: json.error };
  if (response.status === 413) return { kind: 'error', message: 'O texto enviado é grande demais.' };
  if (response.status === 503) return { kind: 'error', message: 'O servidor está indisponível no momento.' };
  return { kind: 'error', message: 'Não foi possível concluir a operação. Tente novamente.' };
}

function isParseResult(value: unknown): value is MapsLinkParseResult {
  if (!value || typeof value !== 'object') return false;
  const { status, code, originalInput } = value as Record<string, unknown>;
  return (
    typeof status === 'string' &&
    Object.prototype.hasOwnProperty.call(STATUS_VIEW, status) &&
    typeof code === 'string' &&
    typeof originalInput === 'string'
  );
}

function isIdentity(value: unknown): value is CompanyIdentity {
  if (!value || typeof value !== 'object') return false;
  const { identifiers, confirmation } = value as Record<string, unknown>;
  return (
    typeof identifiers === 'object' && identifiers !== null &&
    typeof confirmation === 'object' && confirmation !== null &&
    typeof (confirmation as Record<string, unknown>).confirmedBy === 'string'
  );
}

export function requestParse(link: string): Promise<ApiOutcome<MapsLinkParseResult>> {
  return post('/api/link-audit/parse', { link }, (json) => (isParseResult(json.result) ? json.result : null));
}

export interface ConfirmInput {
  readonly link: string;
  readonly name: string;
  readonly city: string;
  readonly stateCode: string;
}

export function requestConfirmation(input: ConfirmInput): Promise<ApiOutcome<CompanyIdentity>> {
  return post(
    '/api/link-audit/confirm',
    {
      link: input.link,
      acknowledged: true,
      ...(input.name.trim() ? { name: input.name.trim() } : {}),
      ...(input.city.trim() ? { city: input.city.trim() } : {}),
      ...(input.stateCode.trim() ? { stateCode: input.stateCode.trim().toUpperCase() } : {}),
    },
    (json) => (isIdentity(json.identity) ? json.identity : null),
  );
}
