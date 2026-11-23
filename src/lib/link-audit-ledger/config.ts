import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { keyMaterialOf, keyringConfigFromEnv, ORIGIN_KEY_ENV, ORIGIN_RETIRED_KEYS_ENV, type OriginAuthenticator } from '../link-audit-origin';
import type { GuardDbTarget, GuardSettings } from './guard-pg';
import { createGuardPseudonyms } from './guard-pseudonym';

/*
 * CONFIGURAÇÃO do livro (Q2 e Q3, 01/11/2026). Pasta própria (`gmn-link-audit-ledger`, nada de Swarm/VPS alterado agora) e chave HMAC EXCLUSIVA,
 * separada da chave de origem: id e material DIFERENTES, com derivação (rótulo e sal) própria. Os valores vêm do AMBIENTE do processo; a entrega
 * por arquivo de segredo (`*_FILE`) é do entrypoint (lista fixa). Nenhum valor real em repositório, log ou resposta.
 *
 * GUARDA EXTERNA (G1.b.2a, GE-E2; spec `link-audit-production-gates.md` §5.1.7 e §5.3.1): a credencial do papel `gmn_guard_writer`, a CA que ancora
 * o TLS e a chave do pseudônimo são lidas SÓ aqui, como as chaves do livro. Nenhuma das variáveis da guarda ⇒ sem guarda (`externalGuard:
 * NOT_CONFIGURED`, como antes, o que não passa no portão G-1). Alguma sem as outras, ou qualquer uma inválida ⇒ o LIVRO INTEIRO fica não
 * configurado (falha fechada: `LEDGER_NOT_CONFIGURED`, 503 nas escritas), porque rodar sem a guarda quando ela foi pedida esconderia a falta de
 * proteção. Política da URL: `postgres(ql)://usuário:senha@host[:porta]/banco?sslmode=verify-full` — `verify-full` é o ÚNICO modo aceito (o
 * conector verifica cadeia e nome de qualquer forma; a exigência na URL só torna a intenção visível) e nenhum outro parâmetro é aceito (`options`,
 * `host`, `sslrootcert`… mudariam a conexão por fora do código).
 */
export const LEDGER_DIR_ENV = 'GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR';
export const LEDGER_KEY_ENV = 'GMN_LINK_AUDIT_LEDGER_KEY';
export const LEDGER_RETIRED_KEYS_ENV = 'GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS';
export const LEDGER_REVOKED_IDS_ENV = 'GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS';
export const GUARD_DB_URL_ENV = 'GMN_LINK_AUDIT_GUARD_DB_URL';
export const GUARD_DB_CA_ENV = 'GMN_LINK_AUDIT_GUARD_DB_CA';
export const GUARD_KEY_ENV = 'GMN_LINK_AUDIT_GUARD_KEY';
export const GUARD_RETIRED_KEYS_ENV = 'GMN_LINK_AUDIT_GUARD_RETIRED_KEYS';
/**
 * Nome da variável da chave de LOG, DUPLICADO de propósito de `link-audit-observability` (`LOG_KEY_ENV`; nenhum dos dois módulos importa o outro):
 * a chave da guarda não pode repetir id nem material dela. `tests/link-audit-guard-config.test.ts` trava a igualdade.
 */
export const LOG_KEY_ENV_NAME = 'GMN_LINK_AUDIT_LOG_KEY';

export type GuardConfigCode = 'GUARD_CONFIG_PARTIAL' | 'GUARD_DB_URL_INVALID' | 'GUARD_DB_TLS_REQUIRED' | 'GUARD_DB_CA_INVALID' | 'GUARD_KEY_WEAK' | 'GUARD_KEY_REUSED' | 'GUARD_CONFIG_INVALID';
export type GuardConfig = { readonly status: 'NOT_CONFIGURED' } | { readonly status: 'READY'; readonly settings: GuardSettings } | { readonly status: 'INVALID'; readonly code: GuardConfigCode };

export type LedgerConfig =
  | { readonly ok: true; readonly dir: string; readonly authenticator: OriginAuthenticator; readonly guard: GuardSettings | null }
  | { readonly ok: false; readonly code: 'LEDGER_DIR_NOT_CONFIGURED' | 'LEDGER_KEY_NOT_CONFIGURED' | 'LEDGER_KEY_WEAK' | 'LEDGER_CONFIG_INVALID' }
  | { readonly ok: false; readonly code: 'LEDGER_GUARD_CONFIG_INVALID'; readonly guardCode: GuardConfigCode };

type Env = Readonly<Record<string, string | undefined>>;

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

const originMaterials = (env: Env): KeyMaterial[] => [...specs(env[ORIGIN_KEY_ENV], false), ...specs(env[ORIGIN_RETIRED_KEYS_ENV], true)];
const ledgerMaterials = (env: Env): KeyMaterial[] => [...specs(env[LEDGER_KEY_ENV], false), ...specs(env[LEDGER_RETIRED_KEYS_ENV], true)];
/** Chaves do pseudônimo da guarda: a atual e as aposentadas, ambas `<id>:<64 hex>` (as aposentadas só leem; saem quando a reconciliação confirma, sem data). */
const guardMaterials = (env: Env): KeyMaterial[] => [...specs(env[GUARD_KEY_ENV], false), ...specs(env[GUARD_RETIRED_KEYS_ENV], false)];

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
 * Impressões digitais das chaves SECRETAS de origem, do livro e do pseudônimo da guarda (atuais e aposentadas) presentes no ambiente informado: o
 * que a chave de LOG (observabilidade, PG-L01) recebe para recusar reúso de id ou de material, sem que o módulo de observabilidade cite os nomes destas
 * variáveis, importe o de origem ou veja material de outra chave. Pura (o ambiente vem por parâmetro, sem padrão); entradas malformadas ficam de fora
 * (o módulo dono já as recusa). Fora do barrel público do livro: o ponto de composição futuro importa direto deste arquivo e chama
 * `operatorRefSourceFromEnv(phase6KeyFingerprints(env), env)`.
 */
export const phase6KeyFingerprints = (env: Env): ReadonlyArray<KeyFingerprint> =>
  [...originMaterials(env), ...ledgerMaterials(env), ...guardMaterials(env)].map((key) => ({ id: key.id, materialDigest: fingerprintOf(key.hex) }));

/** Lê do AMBIENTE DO PROCESSO (as rotas não recebem nem repassam o ambiente inteiro: só este módulo o lê, como o de origem). */
export const ledgerConfigFromProcess = (now?: () => Date): LedgerConfig => ledgerConfigFromEnv(process.env, now);

/** Lê o caminho absoluto, a chave exclusiva do livro e a guarda. Qualquer problema ⇒ `ok:false` (as escritas de decisão falham fechado, nunca "sem livro"). */
export function ledgerConfigFromEnv(env: Env, now?: () => Date): LedgerConfig {
  const raw = env[LEDGER_DIR_ENV]?.trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return { ok: false, code: 'LEDGER_DIR_NOT_CONFIGURED' };
  const keys = keyringConfigFromEnv({ key: LEDGER_KEY_ENV, retired: LEDGER_RETIRED_KEYS_ENV, revoked: LEDGER_REVOKED_IDS_ENV }, 'ledger', env, now);
  if (!keys.ok) return { ok: false, code: keys.code === 'NOT_CONFIGURED' ? 'LEDGER_KEY_NOT_CONFIGURED' : keys.code === 'WEAK' ? 'LEDGER_KEY_WEAK' : 'LEDGER_CONFIG_INVALID' };
  // SEPARAÇÃO (Q3): nenhuma chave do livro (atual ou aposentada) pode repetir id ou material de uma chave de origem (atual ou aposentada).
  const ledger = ledgerMaterials(env);
  const origin = originMaterials(env);
  if (ledger.some((mine) => origin.some((theirs) => theirs.id === mine.id || theirs.hex === mine.hex))) return { ok: false, code: 'LEDGER_CONFIG_INVALID' };
  const guard = guardConfigFromEnv(env);
  if (guard.status === 'INVALID') return { ok: false, code: 'LEDGER_GUARD_CONFIG_INVALID', guardCode: guard.code };
  return { ok: true, dir: path.resolve(raw), authenticator: keys.authenticator, guard: guard.status === 'READY' ? guard.settings : null };
}

/* ------------------------------------------------------------------ guarda externa */

const present = (value: string | undefined): value is string => value !== undefined && value !== '';
/** Lista estrita `a,b,c` (sem espaço nem item vazio), como as listas de aposentadas das outras chaves. */
const strictList = (raw: string | undefined): string[] | null => {
  if (!present(raw)) return [];
  const items = raw.split(',');
  return items.some((item) => item === '' || item !== item.trim()) ? null : items;
};
const DEFAULT_PORT = 5432;
const MAX_PORT = 65_535;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** Destino da conexão a partir da URL (política no cabeçalho). A senha vira propriedade NÃO enumerável. */
function targetOf(rawUrl: string, caPem: string): GuardDbTarget | 'GUARD_DB_URL_INVALID' | 'GUARD_DB_TLS_REQUIRED' {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'GUARD_DB_URL_INVALID';
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hash !== '') return 'GUARD_DB_URL_INVALID';
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? DEFAULT_PORT : Number(url.port);
  const database = decode(url.pathname.replace(/^\//, ''));
  const user = decode(url.username);
  const password = decode(url.password);
  if (!host || host.includes('%') || host.includes('/') || !Number.isInteger(port) || port < 1 || port > MAX_PORT) return 'GUARD_DB_URL_INVALID';
  if (!database || database.includes('/') || !user || !password) return 'GUARD_DB_URL_INVALID';
  const params = [...url.searchParams.keys()];
  if (params.some((name) => name !== 'sslmode') || params.length > 1) return 'GUARD_DB_URL_INVALID';
  if (url.searchParams.get('sslmode') !== 'verify-full') return 'GUARD_DB_TLS_REQUIRED';
  return Object.freeze(Object.defineProperty({ host, port, database, user, caPem }, 'password', { value: password, enumerable: false })) as GuardDbTarget;
}

/** CA em PEM: ao menos um certificado, todos legíveis como X.509, e nada de chave privada junto. */
function validCa(pem: string): boolean {
  if (/PRIVATE KEY/.test(pem)) return false;
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0) return false;
  try {
    for (const block of blocks) new X509Certificate(block);
    return true;
  } catch {
    return false;
  }
}

/** Lê a guarda do ambiente informado (puro). Nenhum código de erro nem resposta cita senha, URL ou material. */
export function guardConfigFromEnv(env: Env): GuardConfig {
  const url = env[GUARD_DB_URL_ENV];
  const ca = env[GUARD_DB_CA_ENV];
  const key = env[GUARD_KEY_ENV];
  const retiredRaw = env[GUARD_RETIRED_KEYS_ENV];
  const given = [url, ca, key, retiredRaw].filter(present).length;
  if (given === 0) return { status: 'NOT_CONFIGURED' };
  if (!present(url) || !present(ca) || !present(key)) return { status: 'INVALID', code: 'GUARD_CONFIG_PARTIAL' };
  const target = targetOf(url.trim(), ca);
  if (typeof target === 'string') return { status: 'INVALID', code: target };
  if (!validCa(ca)) return { status: 'INVALID', code: 'GUARD_DB_CA_INVALID' };
  const current = keyMaterialOf(key, false);
  const retiredList = strictList(retiredRaw);
  if (!current || retiredList === null) return { status: 'INVALID', code: 'GUARD_KEY_WEAK' };
  const retired = retiredList.map((spec) => keyMaterialOf(spec, false));
  if (retired.some((item) => item === null)) return { status: 'INVALID', code: 'GUARD_KEY_WEAK' };
  const mine: KeyMaterial[] = [current, ...(retired as KeyMaterial[])];
  // EXCLUSIVA (padrão das impressões digitais da G1.a): nenhuma chave da guarda repete id ou material de origem, livro (atuais e aposentadas) ou log
  const others = [...originMaterials(env), ...ledgerMaterials(env), ...specs(env[LOG_KEY_ENV_NAME], false)].map((other) => ({ id: other.id, digest: fingerprintOf(other.hex) }));
  if (mine.some((own) => others.some((other) => other.id === own.id || other.digest === fingerprintOf(own.hex)))) return { status: 'INVALID', code: 'GUARD_KEY_REUSED' };
  try {
    return { status: 'READY', settings: Object.freeze({ target, pseudonyms: createGuardPseudonyms(current, retired as KeyMaterial[]) }) };
  } catch {
    return { status: 'INVALID', code: 'GUARD_CONFIG_INVALID' }; // id repetido ou o mesmo material sob dois ids na própria guarda
  }
}
