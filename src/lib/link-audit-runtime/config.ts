import { DEFAULT_SERPER_MAPS_URL } from './serper-maps-provider';

/*
 * Leitura das variáveis de ambiente da coleta real (Onda 4B). Recebe o `env` como argumento e NUNCA o
 * imprime: o resultado só expõe se a chave existe, não o valor dela. É o único arquivo do runtime que
 * conhece os nomes das variáveis.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface RuntimeConfig {
  /** Chave do Serper, se utilizável. NUNCA registrar nem devolver ao cliente. */
  readonly apiKey: string | null;
  readonly mapsUrl: string;
  readonly live: {
    /** `GMN_LINK_AUDIT_LIVE=on` — sem isso o modo LIVE é recusado. */
    readonly enabled: boolean;
    /** `GMN_LINK_AUDIT_MAX_MAPS_CALLS`, de 0 a 1 (0 = nenhuma chamada autorizada). */
    readonly maxMapsCalls: number;
    /** `GMN_LINK_AUDIT_AUTH_ID` — identificador único da autorização, definido por quem autoriza. */
    readonly authorizationId: string | null;
  };
}

const AUTH_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function readRuntimeConfig(env: EnvLike): RuntimeConfig {
  const key = env.SERPER_API_KEY?.trim() ?? '';
  const usable = key.length > 10 && !key.includes('cole-sua-api-key');
  const max = Number(env.GMN_LINK_AUDIT_MAX_MAPS_CALLS ?? '0');
  const authId = env.GMN_LINK_AUDIT_AUTH_ID?.trim() ?? '';
  return {
    apiKey: usable ? key : null,
    mapsUrl: env.SERPER_MAPS_URL?.trim() || DEFAULT_SERPER_MAPS_URL,
    live: {
      enabled: env.GMN_LINK_AUDIT_LIVE === 'on',
      maxMapsCalls: Number.isInteger(max) && max >= 0 && max <= 1 ? max : 0,
      authorizationId: AUTH_ID.test(authId) ? authId : null,
    },
  };
}

/** Resumo SEGURO para exibir: só booleanos e limites; nunca a chave nem a URL completa. */
export function describeRuntimeConfig(config: RuntimeConfig): Record<string, string | number | boolean | null> {
  return {
    serperKeyPresent: config.apiKey !== null,
    liveEnabled: config.live.enabled,
    maxMapsCalls: config.live.maxMapsCalls,
    authorizationIdPresent: config.live.authorizationId !== null,
  };
}
