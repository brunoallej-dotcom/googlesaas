import type { AuditDetailDto, AuditListItemDto } from '@/lib/link-audit-evidence';

/*
 * Cliente das rotas de LEITURA das evidências armazenadas (Onda 5B). Roda no navegador: só `fetch` GET para o
 * próprio servidor (mesma origem, com o cookie de sessão). Nunca envia caminhos, nunca fala com o Google nem
 * com o Serper, e valida o formato da resposta antes de a tela usá-la.
 */

export type EvidenceOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface AuditListPage {
  readonly audits: readonly AuditListItemDto[];
  readonly total: number;
}

export interface DetailSelection {
  readonly capture?: number;
  readonly revision?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isListItem(value: unknown): value is AuditListItemDto {
  if (!isObject(value)) return false;
  return typeof value.auditId === 'string' && typeof value.state === 'string' && isObject(value.integrity) && typeof value.captureCount === 'number';
}

export function isDetail(value: unknown): value is AuditDetailDto {
  if (!isObject(value)) return false;
  return (
    value.kind === 'EVIDENCE_COLLECTION' &&
    typeof value.auditId === 'string' &&
    isObject(value.source) &&
    isObject(value.identifiers) &&
    isObject(value.evidences) &&
    Array.isArray(value.evidences.verified) &&
    Array.isArray(value.evidences.unverified) &&
    Array.isArray(value.limitations) &&
    Array.isArray(value.versions) &&
    isObject(value.integrity)
  );
}

const UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  EVIDENCE_NOT_CONFIGURED: 'O armazenamento de evidências ainda não foi configurado neste servidor.',
  EVIDENCE_STORAGE_UNAVAILABLE: 'O armazenamento de evidências não está acessível ao servidor neste momento.',
};

async function get<T>(path: string, signal: AbortSignal | undefined, pick: (json: Record<string, unknown>) => T | null): Promise<EvidenceOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'same-origin', ...(signal ? { signal } : {}) });
  } catch {
    return { kind: 'error', message: 'Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.' };
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && json) {
    const value = pick(json);
    return value !== null ? { kind: 'ok', value } : { kind: 'error', message: 'Resposta inesperada do servidor.' };
  }
  const code = typeof json?.code === 'string' ? json.code : '';
  if (response.status === 503 && UNAVAILABLE_MESSAGES[code]) return { kind: 'unavailable', code, message: UNAVAILABLE_MESSAGES[code] as string };
  if (response.status === 403) return { kind: 'error', message: 'Acesso negado para esta consulta.' };
  if (response.status === 404) return { kind: 'error', message: 'Esta coleta não foi encontrada.' };
  if (response.status === 409) {
    return {
      kind: 'error',
      message: code === 'INTEGRITY_FAILED' ? 'A integridade desta coleta não pôde ser confirmada; por segurança os dados não são exibidos.' : 'Esta coleta está incompleta e não pode ser exibida.',
    };
  }
  if (response.status === 429) return { kind: 'error', message: 'Muitas consultas em pouco tempo. Aguarde um instante e tente novamente.' };
  return { kind: 'error', message: 'Não foi possível concluir a consulta. Tente novamente.' };
}

export function requestAuditList(signal?: AbortSignal): Promise<EvidenceOutcome<AuditListPage>> {
  return get('/api/link-audit/evidence?limit=50&offset=0', signal, (json) => {
    if (!Array.isArray(json.audits) || typeof json.total !== 'number' || !json.audits.every(isListItem)) return null;
    return { audits: json.audits, total: json.total };
  });
}

export function requestAuditDetail(auditId: string, selection: DetailSelection = {}, signal?: AbortSignal): Promise<EvidenceOutcome<AuditDetailDto>> {
  const params = new URLSearchParams();
  if (selection.capture !== undefined) params.set('capture', String(selection.capture));
  if (selection.revision !== undefined) params.set('revision', String(selection.revision));
  const query = params.toString();
  return get(`/api/link-audit/evidence/${encodeURIComponent(auditId)}${query ? `?${query}` : ''}`, signal, (json) => (isDetail(json.audit) ? json.audit : null));
}
