import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { z } from 'zod';

/*
 * PSEUDÔNIMO DO OPERADOR nos logs da Fase 6 (spec de observabilidade §7, Q1 decidida em 16/11/2026: opção A; spec dos portões de
 * produção §5.3.4, critério PG-L01). O e-mail é a identidade gravada nas decisões e nos resultados, mas NUNCA vai para o log: o log
 * leva `operatorRef = <id da chave>:<12 hex do HMAC-SHA-256 do e-mail normalizado>`.
 *
 * CHAVE: `GMN_LINK_AUDIT_LOG_KEY` = `<id>:<64 hex minúsculos de um CSPRNG>`, EXCLUSIVA do log (mesma política de formato e de sanidade
 * das chaves de origem e do livro, reescrita aqui para não acoplar este módulo ao de origem). A chave entra por HKDF com rótulo e sal
 * próprios (`gmn.link-audit.log.*`): o material nunca é usado direto. Entregue por Swarm secret (`*_FILE`, lista fixa do entrypoint).
 *
 * FALHA FECHADA PARA PII (aberta para o log): sem chave, com chave fraca ou malformada, ou com chave que repete o id ou o material de uma
 * chave de origem ou do livro (atual ou aposentada), o valor é `UNAVAILABLE`. Essas outras chaves chegam por PARÂMETRO OBRIGATÓRIO, sem
 * padrão, e só como IMPRESSÕES DIGITAIS de mão única, em PARES (id público e SHA-256 do material com o rótulo `KEY_FINGERPRINT_LABEL`), nunca o
 * material: este módulo não cita os nomes das variáveis delas nem importa outro módulo da Fase 6. Quem compõe é o livro, com
 * `phase6KeyFingerprints(env)` de `link-audit-ledger/config.ts` (import direto, fora do barrel). Lista ausente ou inválida ⇒
 * `LOG_KEY_UNVERIFIED` (nunca `READY`). Ponto de composição futuro (com o `emit` das próximas fatias; nada liga isto a rota ou logger
 * nesta fatia): `operatorRefSourceFromEnv(phase6KeyFingerprints(env), env)`.
 * DECISÃO DO MANAGER (4ª rodada da revisão do PR #54): a lista vem do NOSSO código (`phase6KeyFingerprints`), não de entrada externa, e lista
 * vazia é legítima quando não há outras chaves configuradas. A garantia de que nenhuma chave fica de fora (origem e livro, atuais e
 * aposentadas) é o teste de completude em `tests/link-audit-ledger-key-fingerprints.test.ts`, não uma checagem aqui. Nunca se cai para hash sem chave (poucos e-mails: um
 * dicionário o reverteria) nem para o e-mail. Uma identidade que não parece e-mail também vira `UNAVAILABLE`.
 *
 * LIMITE DECLARADO: HMAC é pseudonimização, não anonimização (LGPD): quem tem a chave e a lista de operadores recalcula o pseudônimo.
 * Por isso a chave fica só no web e o acesso aos logs é restrito (decisão de 16/11/2026). O módulo é puro: não lê o ambiente sozinho
 * (só como padrão do parâmetro), não escreve nada e nunca expõe o material da chave.
 */
export const LOG_KEY_ENV = 'GMN_LINK_AUDIT_LOG_KEY';
/**
 * Rótulo de separação de domínio das impressões digitais de chave. DUPLICADO de propósito em `link-audit-ledger/config.ts` (nenhum módulo
 * importa o outro); `tests/link-audit-ledger-key-fingerprints.test.ts` trava a igualdade. Mudar aqui exige mudar lá.
 */
export const KEY_FINGERPRINT_LABEL = 'gmn.link-audit.key-fingerprint.v1';
export const OPERATOR_REF_UNAVAILABLE = 'UNAVAILABLE';
/** Tamanho do pseudônimo: 12 hex (48 bits) bastam para poucos operadores e não carregam o HMAC inteiro para o log. */
export const OPERATOR_REF_HEX_CHARS = 12;

const KEY_BYTES = 32;
const MIN_DISTINCT_BYTES = 16;
const MAX_REPEATED_BLOCK = 16;
const BYTE_VALUES = 256;
const MAX_EMAIL_CHARS = 320;
const HKDF_SALT = 'gmn.link-audit.log.salt';
const HKDF_INFO = 'gmn.link-audit.log.v1';
/** `<id>:<64 hex>`: o id é rótulo PÚBLICO (mesmo padrão das chaves de origem e do livro), independente do segredo. */
const LOG_KEY_PATTERN = /^([a-z0-9][a-z0-9-]{3,31}):([0-9a-f]{64})$/;

export type LogKeyStatus = 'READY' | 'LOG_KEY_NOT_CONFIGURED' | 'LOG_KEY_WEAK' | 'LOG_KEY_REUSED' | 'LOG_KEY_UNVERIFIED';

/** Impressão digital de UMA chave de OUTRA finalidade (origem, livro), que a de log não pode repetir: id público e digest em par, nunca material. */
export interface OtherKeyFingerprint {
  readonly id: string;
  readonly materialDigest: string;
}
export type OperatorRef = typeof OPERATOR_REF_UNAVAILABLE | `${string}:${string}`;

export interface OperatorRefSource {
  /** `READY` só com chave válida e exclusiva; os demais estados nunca revelam o material. */
  readonly status: LogKeyStatus;
  /** Id PÚBLICO da chave (nunca o material); `null` sem chave válida. */
  readonly keyId: string | null;
  /** Pseudônimo do operador; `UNAVAILABLE` sem chave válida ou com identidade inválida. Nunca lança. */
  operatorRef(email: unknown): OperatorRef;
}

/**
 * Filtro de SANIDADE (não prova entropia): recusa material repetitivo, em progressão aritmética ou com poucos bytes distintos — a mesma
 * regra de `isStrongKeyMaterial` das chaves de origem e do livro.
 */
function isStrongMaterial(hex: string): boolean {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== KEY_BYTES || new Set(bytes).size < MIN_DISTINCT_BYTES) return false;
  for (let period = 1; period <= MAX_REPEATED_BLOCK; period += 1) {
    if (bytes.every((value, index) => value === bytes[index % period])) return false;
  }
  const first = bytes[0] as number;
  const step = ((bytes[1] as number) - first + BYTE_VALUES) % BYTE_VALUES;
  return !bytes.every((value, index) => value === (first + step * index) % BYTE_VALUES);
}

const logKeySchema = z
  .string()
  .regex(LOG_KEY_PATTERN)
  .transform((spec) => {
    const [keyId, hex] = spec.split(':') as [string, string];
    return { keyId, hex };
  })
  .refine((key) => isStrongMaterial(key.hex));

/** E-mail normalizado como a sessão (`trim` + minúsculas); sem espaço, controle nem segundo `@`. `dev@localhost` é aceito. */
const emailSchema = z
  .string()
  .max(MAX_EMAIL_CHARS)
  .trim()
  .toLowerCase()
  .regex(/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u);

/**
 * Formato estrito da lista recebida: um PAR por chave (id no padrão das chaves e digest de 64 hex minúsculos), sem campo a mais (material, por
 * exemplo). Par incompleto, lista truncada ou listas paralelas ⇒ inválida: um digest omitido nunca deixa passar reúso por material.
 */
const otherKeysSchema = z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,31}$/), materialDigest: z.string().regex(/^[0-9a-f]{64}$/) }));

const fingerprintOf = (hex: string): string => createHash('sha256').update(`${KEY_FINGERPRINT_LABEL}\n`).update(Buffer.from(hex, 'hex')).digest('hex');

const unavailable = (status: Exclude<LogKeyStatus, 'READY'>): OperatorRefSource => ({ status, keyId: null, operatorRef: () => OPERATOR_REF_UNAVAILABLE });

/**
 * Lê a chave de log do ambiente do SERVIDOR (injetável nos testes) e a compara com `otherKeys` (obrigatório, sem padrão: uma lista vazia
 * explícita é aceita; ausente ou inválida falha fechada). O material fica só no fecho da função, nunca no objeto devolvido.
 */
export function operatorRefSourceFromEnv(otherKeys: ReadonlyArray<OtherKeyFingerprint>, env: Readonly<Record<string, string | undefined>> = process.env): OperatorRefSource {
  const others = otherKeysSchema.safeParse(otherKeys);
  if (!others.success) return unavailable('LOG_KEY_UNVERIFIED');
  const raw = env[LOG_KEY_ENV];
  if (raw === undefined || raw === '') return unavailable('LOG_KEY_NOT_CONFIGURED');
  const parsed = logKeySchema.safeParse(raw);
  if (!parsed.success) return unavailable('LOG_KEY_WEAK');
  const { keyId, hex } = parsed.data;
  const ownDigest = fingerprintOf(hex);
  if (others.data.some((other) => other.id === keyId || other.materialDigest === ownDigest)) return unavailable('LOG_KEY_REUSED');
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), HKDF_SALT, HKDF_INFO, KEY_BYTES));
  return {
    status: 'READY',
    keyId,
    operatorRef(email: unknown): OperatorRef {
      const normalized = emailSchema.safeParse(email);
      if (!normalized.success) return OPERATOR_REF_UNAVAILABLE;
      return `${keyId}:${createHmac('sha256', derived).update(normalized.data).digest('hex').slice(0, OPERATOR_REF_HEX_CHARS)}`;
    },
  };
}
