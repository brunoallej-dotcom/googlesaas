import { createHash } from 'node:crypto';
import path from 'node:path';
import { keyMaterialOf, keyringConfigFromEnv, ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV, type OriginAuthenticator } from '../link-audit-origin';

/*
 * CONFIGURAÇÃO do livro (Q2 e Q3, 01/11/2026). Pasta própria (`gmn-link-audit-ledger`, nada de Swarm/VPS alterado agora) e chave HMAC EXCLUSIVA,
 * separada da chave de origem: id e material DIFERENTES, com derivação (rótulo e sal) própria. Os valores vêm do AMBIENTE do processo; a entrega
 * por arquivo de segredo (`*_FILE`) é do entrypoint (lista fixa), ainda NÃO alterado. Nenhum valor real em repositório, log ou resposta.
 */
export const LEDGER_DIR_ENV = 'GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR';
export const LEDGER_KEY_ENV = 'GMN_LINK_AUDIT_LEDGER_KEY';
export const LEDGER_RETIRED_KEYS_ENV = 'GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS';
export const LEDGER_REVOKED_IDS_ENV = 'GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS';

export type LedgerConfig =
  | { readonly ok: true; readonly dir: string; readonly authenticator: OriginAuthenticator }
  | { readonly ok: false; readonly code: 'LEDGER_DIR_NOT_CONFIGURED' | 'LEDGER_KEY_NOT_CONFIGURED' | 'LEDGER_KEY_WEAK' | 'LEDGER_CONFIG_INVALID' };

/** Par id/material de uma chave HMAC da Fase 6, só INTERNO a este arquivo (conferir que famílias de chave não se repetem); nunca sai daqui. */
interface KeyMaterial {
  readonly id: string;
  readonly hex: string;
}

const specs = (raw: string | undefined, withDay: boolean): KeyMaterial[] => {
  if (!raw) return [];
  return raw.split(',').flatMap((item) => {
    const parts = keyMaterialOf(item, withDay);
    return parts ? [parts] : [];
  });
};

const originMaterials = (env: Readonly<Record<string, string | undefined>>): KeyMaterial[] => [...specs(env[ORIGIN_KEY_ENV], false), ...specs(env[ORIGIN_RETIRED_KEYS_ENV], true)];
const ledgerMaterials = (env: Readonly<Record<string, string | undefined>>): KeyMaterial[] => [...specs(env[LEDGER_KEY_ENV], false), ...specs(env[LEDGER_RETIRED_KEYS_ENV], true)];

/**
 * Rótulo de separação de domínio das impressões digitais de chave (G1.a, PG-L01). DUPLICADO de propósito em
 * `link-audit-observability/operator-ref.ts` (nenhum dos dois módulos importa o outro); `tests/link-audit-ledger-key-fingerprints.test.ts`
 * trava a igualdade. Mudar aqui exige mudar lá.
 */
export const KEY_FINGERPRINT_LABEL = 'gmn.link-audit.key-fingerprint.v1';

/** Impressão digital de mão única de UMA chave: o id PÚBLICO e o SHA-256 (com o rótulo acima) do material, sempre em par. Nunca o material. */
export interface KeyFingerprint {
  readonly id: string;
  readonly materialDigest: string;
}

const fingerprintOf = (hex: string): string => createHash('sha256').update(`${KEY_FINGERPRINT_LABEL}\n`).update(Buffer.from(hex, 'hex')).digest('hex');

/**
 * Impressões digitais das chaves SECRETAS de origem e do livro (atuais e aposentadas) presentes no ambiente informado: o que a chave de LOG
 * (observabilidade, PG-L01) recebe para recusar reúso de id ou de material, sem que o módulo de observabilidade cite os nomes destas variáveis,
 * importe o de origem ou veja material de outra chave. Pura (o ambiente vem por parâmetro, sem padrão); entradas malformadas ficam de fora (o
 * módulo dono já as recusa). Fora do barrel público do livro: o ponto de composição futuro importa direto deste arquivo e chama
 * `operatorRefSourceFromEnv(phase6KeyFingerprints(env), env)`.
 */
export const phase6KeyFingerprints = (env: Readonly<Record<string, string | undefined>>): ReadonlyArray<KeyFingerprint> =>
  [...originMaterials(env), ...ledgerMaterials(env)].map((key) => ({ id: key.id, materialDigest: fingerprintOf(key.hex) }));

/** Lê do AMBIENTE DO PROCESSO (as rotas não recebem nem repassam o ambiente inteiro: só este módulo o lê, como o de origem). */
export const ledgerConfigFromProcess = (now?: () => Date): LedgerConfig => ledgerConfigFromEnv(process.env, now);

/** Lê o caminho absoluto e a chave exclusiva do livro. Qualquer problema ⇒ `ok:false` (as escritas de decisão falham fechado, nunca "sem livro"). */
export function ledgerConfigFromEnv(env: Readonly<Record<string, string | undefined>>, now?: () => Date): LedgerConfig {
  const raw = env[LEDGER_DIR_ENV]?.trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return { ok: false, code: 'LEDGER_DIR_NOT_CONFIGURED' };
  const keys = keyringConfigFromEnv({ key: LEDGER_KEY_ENV, retired: LEDGER_RETIRED_KEYS_ENV, revoked: LEDGER_REVOKED_IDS_ENV }, 'ledger', env, now);
  if (!keys.ok) return { ok: false, code: keys.code === 'NOT_CONFIGURED' ? 'LEDGER_KEY_NOT_CONFIGURED' : keys.code === 'WEAK' ? 'LEDGER_KEY_WEAK' : 'LEDGER_CONFIG_INVALID' };
  // SEPARAÇÃO (Q3): nenhuma chave do livro (atual ou aposentada) pode repetir id ou material de uma chave de origem (atual ou aposentada).
  const ledger = ledgerMaterials(env);
  const origin = originMaterials(env);
  if (ledger.some((mine) => origin.some((theirs) => theirs.id === mine.id || theirs.hex === mine.hex))) return { ok: false, code: 'LEDGER_CONFIG_INVALID' };
  return { ok: true, dir: path.resolve(raw), authenticator: keys.authenticator };
}
