import crypto from 'node:crypto';

/**
 * Apoio à validação de recuperação: provar que reabrir auditorias EXISTENTES não faz nenhuma
 * consulta externa e não altera nenhum dado.
 */
export const sha256Json = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Hash estável (ordena por id) de um conjunto de linhas, incluindo `updated_at`. */
export function hashRows(rows: readonly Record<string, unknown>[]): string {
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return sha256Json(sorted);
}

export interface FetchGuard {
  readonly blocked: string[];
  readonly allowed: number;
  restore(): void;
}

/**
 * Instala uma guarda em `fetch`: só o host do Supabase passa; qualquer outro destino (Serper, LLM,
 * OpenStreetMap…) lança erro e é registrado. Usa-se em validações que NÃO podem gastar nada.
 */
export function installFetchGuard(allowedHosts: readonly string[]): FetchGuard {
  const original = globalThis.fetch;
  const state = { blocked: [] as string[], allowed: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    if (!allowedHosts.includes(host)) {
      state.blocked.push(`${init?.method ?? 'GET'} ${host}`);
      throw new Error(`Chamada externa bloqueada pela validação de recuperação: ${host}`);
    }
    state.allowed += 1;
    return original(input as never, init);
  }) as typeof fetch;
  return {
    blocked: state.blocked,
    get allowed() {
      return state.allowed;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

export interface RecoveryCheck {
  readonly auditId: string;
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}
