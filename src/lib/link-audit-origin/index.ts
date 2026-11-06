import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../link-audit/canonical';

/*
 * PROVA DE ORIGEM das operações gravadas (Onda 6C, remediação do MAJOR-1; ver `onda6c-adr-prova-de-origem.md`).
 *
 * PROBLEMA: um arquivo de decisão (6B) ou de resultado (6C) vive numa pasta que quem tem escrita nela controla por inteiro: o campo
 * "autor", o conteúdo, o selo SHA-256 e o encadeamento podem ser refeitos por essa pessoa (o selo é um hash, NÃO uma autenticação).
 * Se a CONCLUSÃO de uma pendente (a gravação do recibo) só conferisse "mesmo autor e mesmo pedido", um arquivo forjado viraria
 * registro confirmado quando o autor nomeado reenviasse o pedido, que a própria interface monta a partir do arquivo.
 *
 * SOLUÇÃO: cada entrada/resultado NOVO leva uma etiqueta HMAC-SHA-256 calculada pelo SERVIDOR com uma chave que NÃO está em nenhuma
 * pasta de dados (variável de ambiente injetada no processo). A etiqueta cobre o corpo inteiro da entrada (inclusive `auditId`,
 * `seq`, `prevSha256`, autor, hora e conteúdo) e é separada por DOMÍNIO (decisão × resultado). Quem escreve só numa pasta não
 * consegue produzir uma etiqueta válida; só o servidor, ao gravar de verdade, consegue. A conclusão de uma pendente EXIGE a
 * etiqueta válida; sem ela (arquivo anterior à proteção, forjado, adulterado, chave desconhecida, revogada ou vencida) a conclusão é recusada.
 *
 * CHAVES (política verificável):
 *  - Material: EXATAMENTE 32 bytes de um CSPRNG em 64 hexadecimais minúsculos (`openssl rand -hex 32`). Senha humana, base64, espaço ou
 *    quebra de linha são recusados; há ainda um filtro de sanidade contra material degenerado (repetição, sequência, poucos bytes distintos).
 *    O filtro NÃO prova entropia: só recusa o que é obviamente previsível; a geração correta é responsabilidade de quem provisiona.
 *  - Identificador: rótulo PÚBLICO escolhido por quem provisiona, INDEPENDENTE do segredo (nada no arquivo permite testar palpites do
 *    segredo offline). Formato da variável: `<id>:<64 hex>`.
 *  - Rotação PLANEJADA (chave antiga NÃO comprometida): a antiga entra em `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS` como `<id>:<64 hex>:<AAAA-MM-DD>`;
 *    vale SÓ para VERIFICAR (nunca assina) e SÓ até o fim do dia UTC indicado; depois disso o veredito é `KEY_EXPIRED`.
 *  - Rotação por COMPROMETIMENTO: a chave vazada é REMOVIDA por completo (nem a atual, nem aposentada) e seu identificador entra em
 *    `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` (só ids, nunca material). Etiquetas dela passam a `KEY_REVOKED`: nenhuma pendente assinada por
 *    ela é concluída. Manter o material de um id revogado na configuração é erro de configuração (falha fechada, as escritas respondem 503).
 *
 * O QUE ISTO NÃO FAZ (declarado): não protege contra quem tem a chave; não reautentica registros já CONFIRMADOS na leitura (para eles valem
 * o recibo e o encadeamento); não distingue uma gravação interrompida de um recibo removido (a etiqueta é válida nos dois casos); não
 * substitui a guarda externa do `head` contra o retrocesso coordenado das duas pastas; reassinar registros antigos NÃO os torna confiáveis
 * (a nova etiqueta atestaria só que o servidor de hoje os viu, sem fonte independente).
 *
 * A chave NUNCA é gravada em arquivo de dados, log, resposta ou mensagem de erro. Não existe chave padrão: sem chave válida o
 * módulo não assina e não comprova.
 */
export const ORIGIN_VERSION = 1 as const;
export const ORIGIN_KEY_ENV = 'GMN_LINK_AUDIT_ORIGIN_KEY';
export const ORIGIN_RETIRED_KEYS_ENV = 'GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS';
export const ORIGIN_REVOKED_IDS_ENV = 'GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS';
/** Tamanho do material: 32 bytes (256 bits) de um CSPRNG, escritos em 64 hexadecimais minúsculos. */
export const ORIGIN_KEY_BYTES = 32;

export type OriginDomain = 'DECISION' | 'RUN' | 'LEDGER';

/**
 * FINALIDADE da chave. `origin`: assina decisões e resultados (domínios DECISION/RUN). `ledger`: assina SÓ o livro de cabeças (domínio LEDGER), com
 * chave, rótulo e sal de derivação PRÓPRIOS (Q3, 01/11/2026): a chave de origem não autentica o livro e vice-versa. A derivação de `origin` é a de sempre
 * (nenhuma etiqueta existente muda).
 */
export type KeyPurpose = 'origin' | 'ledger';
const PURPOSE_DOMAINS: Readonly<Record<KeyPurpose, readonly OriginDomain[]>> = { origin: ['DECISION', 'RUN'], ledger: ['LEDGER'] };

/** Rótulo público da chave. Não deriva do segredo. */
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,31}$/;
const KEY_MATERIAL_PATTERN = /^[0-9a-f]{64}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** O que vai DENTRO do arquivo selado, em `origin`. */
export const originProofSchema = z.object({ v: z.literal(ORIGIN_VERSION), kid: z.string().regex(KEY_ID_PATTERN), tag: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type OriginProof = z.infer<typeof originProofSchema>;

/**
 * `PROVEN`: etiqueta válida. `MISSING`: arquivo sem etiqueta (anterior à proteção ou forjado). `INVALID`: etiqueta mal formada ou que
 * não confere (arquivo adulterado/forjado). `KEY_MISMATCH`: identificador de chave desconhecido deste servidor (chave trocada sem manter a
 * anterior, ou forjado). `KEY_REVOKED`: a chave foi revogada por comprometimento. `KEY_EXPIRED`: chave aposentada fora da validade.
 * `NO_KEY`: este servidor não tem chave para verificar (nada pode ser comprovado).
 */
export type OriginVerdict = 'PROVEN' | 'MISSING' | 'INVALID' | 'KEY_MISMATCH' | 'KEY_REVOKED' | 'KEY_EXPIRED' | 'NO_KEY';

export interface OriginAuthenticator {
  /** Identificador PÚBLICO da chave que assina (nunca derivado do segredo). */
  readonly keyId: string;
  /** Finalidade da chave: `origin` (decisões e resultados) ou `ledger` (só o livro de cabeças). */
  readonly purpose: KeyPurpose;
  /** Etiqueta para o corpo (SEM `origin` e SEM `contentSha256`). */
  sign(domain: OriginDomain, body: object): OriginProof;
  /** Confere a etiqueta de uma entrada completa (com `origin` e `contentSha256`). Nunca lança. */
  verify(domain: OriginDomain, entry: object): Exclude<OriginVerdict, 'NO_KEY'>;
}


/**
 * Filtro de SANIDADE (não prova entropia): recusa material nulo/repetitivo, em sequência ou com poucos bytes distintos. Um CSPRNG de 32
 * bytes tem em média ~30 valores distintos; menos de 16 tem probabilidade desprezível.
 */
export function isStrongKeyMaterial(hex: unknown): hex is string {
  if (typeof hex !== 'string' || !KEY_MATERIAL_PATTERN.test(hex)) return false;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== ORIGIN_KEY_BYTES) return false;
  if (new Set(bytes).size < 16) return false;
  for (let period = 1; period <= 16; period += 1) {
    if (bytes.every((value, index) => value === bytes[index % period])) return false; // repetição de um bloco curto
  }
  const step = (bytes[1]! - bytes[0]! + 256) % 256;
  if (bytes.every((value, index) => value === (bytes[0]! + step * index) % 256)) return false; // progressão aritmética (00 01 02…)
  return true;
}

interface Material {
  readonly id: string;
  readonly derived: Buffer;
  /** Último dia UTC (inclusive; dias desde 1970) em que uma chave APOSENTADA ainda verifica; `null` na chave atual. */
  readonly until: number | null;
}

function derive(id: string, hex: string, until: number | null, purpose: KeyPurpose): Material {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.from(`gmn.link-audit.${purpose}.salt`), `gmn.link-audit.${purpose}.v1`, 32));
  return { id, derived, until };
}

const tagOf = (material: Material, domain: OriginDomain, body: object): string => createHmac('sha256', material.derived).update(`${domain}\n${canonicalJson(body)}`).digest('hex');

/** Dias inteiros desde 1970 (UTC). Relógio inválido ⇒ `NaN` (tratado como VENCIDO: falha fechada). */
const dayNumber = (now: Date): number => Math.floor(now.getTime() / 86_400_000);
const dayOfString = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
/** Teto da validade de uma chave aposentada: rotação PLANEJADA é curta (uma chave "aposentada" para sempre seria uma segunda chave de assinatura). */
export const MAX_RETIRED_DAYS = 93;

/** Dia de calendário válido (AAAA-MM-DD, com anos bissextos), sem depender do relógio nem de `Date`. */
function isCalendarDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 2000 && last !== undefined && date >= 1 && date <= last;
}

/** `<id>:<64 hex>` → partes; `null` se o formato estrito não for obedecido. */
function splitKey(spec: string, withDay: boolean): { id: string; hex: string; day: string | null } | null {
  const parts = spec.split(':');
  if (parts.length !== (withDay ? 3 : 2)) return null;
  const [id, hex, day] = parts as [string, string, string | undefined];
  if (!KEY_ID_PATTERN.test(id) || !isStrongKeyMaterial(hex)) return null;
  if (withDay && (day === undefined || !isCalendarDay(day))) return null;
  return { id, hex, day: withDay ? (day as string) : null };
}

export interface OriginKeyring {
  /** Chave que ASSINA e verifica: `<id>:<64 hex>`. */
  readonly current: string;
  /** Rotação PLANEJADA: chaves antigas NÃO comprometidas, só para verificar, com validade: `<id>:<64 hex>:<AAAA-MM-DD>`. */
  readonly retired?: readonly string[];
  /** Rotação por COMPROMETIMENTO: identificadores de chaves revogadas (sem material). */
  readonly revokedIds?: readonly string[];
  /** Relógio de QUEM CHAMA (o módulo é puro e não lê o relógio): obrigatório quando há chave aposentada, pois só ele decide a validade. */
  readonly now?: () => Date;
  /** Finalidade da chave (padrão `origin`). */
  readonly purpose?: KeyPurpose;
}

/** Lança `Error` (sem nunca incluir material) se a configuração for fraca, malformada ou contraditória. */
export function createOriginAuthenticator(keyring: string | OriginKeyring): OriginAuthenticator {
  const ring: OriginKeyring = typeof keyring === 'string' ? { current: keyring } : keyring;
  const current = splitKey(ring.current, false);
  if (!current) throw new Error('chave de origem atual malformada ou fraca');
  const now = ring.now;
  const purpose: KeyPurpose = ring.purpose ?? 'origin';
  if ((ring.retired ?? []).length > 0 && !now) throw new Error('chave aposentada exige o relógio de quem chama');
  const known = new Map<string, Material>([[current.id, derive(current.id, current.hex, null, purpose)]]);
  const seenMaterial = new Set<string>([current.hex]);
  for (const spec of ring.retired ?? []) {
    const parts = splitKey(spec, true);
    if (!parts) throw new Error('chave aposentada malformada, fraca ou sem validade');
    if (known.has(parts.id)) throw new Error('identificador de chave repetido');
    if (seenMaterial.has(parts.hex)) throw new Error('o mesmo material aparece sob dois identificadores');
    seenMaterial.add(parts.hex);
    const until = dayOfString(parts.day as string);
    const today = now ? dayNumber(now()) : Number.NaN;
    if (!Number.isFinite(today) || until > today + MAX_RETIRED_DAYS) throw new Error('validade da chave aposentada acima do teto');
    known.set(parts.id, derive(parts.id, parts.hex, until, purpose));
  }
  const revoked = new Set<string>();
  for (const id of ring.revokedIds ?? []) {
    if (!KEY_ID_PATTERN.test(id)) throw new Error('identificador revogado malformado');
    if (known.has(id)) throw new Error('uma chave revogada não pode continuar configurada (remova o material)');
    revoked.add(id);
  }
  const signer = known.get(current.id) as Material;
  return {
    keyId: current.id,
    purpose,
    sign(domain, body) {
      if (!PURPOSE_DOMAINS[purpose].includes(domain)) throw new Error('domínio não permitido para esta chave');
      return { v: ORIGIN_VERSION, kid: signer.id, tag: tagOf(signer, domain, body) };
    },
    verify(domain, entry) {
      if (!PURPOSE_DOMAINS[purpose].includes(domain)) return 'INVALID';
      const { origin, contentSha256, ...body } = entry as { origin?: unknown; contentSha256?: unknown };
      void contentSha256;
      if (origin === undefined) return 'MISSING';
      const proof = originProofSchema.safeParse(origin);
      if (!proof.success) return 'INVALID';
      if (revoked.has(proof.data.kid)) return 'KEY_REVOKED';
      const material = known.get(proof.data.kid);
      if (!material) return 'KEY_MISMATCH';
      if (material.until !== null) {
        const today = now ? dayNumber(now()) : Number.NaN;
        if (!Number.isFinite(today) || today > material.until) return 'KEY_EXPIRED';
      }
      const expected = Buffer.from(tagOf(material, domain, body), 'hex');
      const given = Buffer.from(proof.data.tag, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given) ? 'PROVEN' : 'INVALID';
    },
  };
}

export type OriginConfig =
  | { readonly ok: true; readonly authenticator: OriginAuthenticator }
  | { readonly ok: false; readonly code: 'ORIGIN_KEY_NOT_CONFIGURED' | 'ORIGIN_KEY_WEAK' | 'ORIGIN_CONFIG_INVALID' };

const list = (raw: string | undefined): string[] | null => {
  if (raw === undefined || raw === '') return [];
  const items = raw.split(',');
  return items.some((item) => item === '' || item !== item.trim()) ? null : items; // sem espaço nem item vazio: representação estrita
};

export interface KeyringEnvNames {
  readonly key: string;
  readonly retired: string;
  readonly revoked: string;
}
export type KeyringConfig =
  | { readonly ok: true; readonly authenticator: OriginAuthenticator }
  | { readonly ok: false; readonly code: 'NOT_CONFIGURED' | 'WEAK' | 'INVALID' };

/** Material hexadecimal de uma especificação `<id>:<hex>[:<dia>]` (ou `null` se malformada): serve para conferir que duas famílias de chaves NÃO compartilham material. */
export const keyMaterialOf = (spec: string, withDay: boolean): { readonly id: string; readonly hex: string } | null => {
  const parts = splitKey(spec, withDay);
  return parts ? { id: parts.id, hex: parts.hex } : null;
};

/** Lê um chaveiro do ambiente do SERVIDOR (nomes, finalidade e ambiente informados por quem chama: o módulo não lê o ambiente). Nenhum código revela material. */
export function keyringConfigFromEnv(names: KeyringEnvNames, purpose: KeyPurpose, env: Readonly<Record<string, string | undefined>>, now?: () => Date): KeyringConfig {
  const raw = env[names.key];
  if (raw === undefined || raw === '') return { ok: false, code: 'NOT_CONFIGURED' };
  if (!splitKey(raw, false)) return { ok: false, code: 'WEAK' };
  const retired = list(env[names.retired]);
  const revokedIds = list(env[names.revoked]);
  if (retired === null || revokedIds === null) return { ok: false, code: 'INVALID' };
  if (retired.some((spec) => !splitKey(spec, true))) return { ok: false, code: 'WEAK' };
  try {
    return { ok: true, authenticator: createOriginAuthenticator({ current: raw, retired, revokedIds, purpose, ...(now ? { now } : {}) }) };
  } catch {
    return { ok: false, code: 'INVALID' };
  }
}

/**
 * Lê as chaves de ORIGEM do ambiente do SERVIDOR. Sem chave ⇒ `ORIGIN_KEY_NOT_CONFIGURED`; chave atual ou aposentada malformada/fraca ⇒ `ORIGIN_KEY_WEAK`;
 * configuração contraditória (id repetido, revogada ainda configurada, validade inválida) ⇒ `ORIGIN_CONFIG_INVALID`. Em qualquer `ok:false` as
 * escritas respondem 503 e nada é gravado. Nenhum código revela material.
 */
export function originConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, now?: () => Date): OriginConfig {
  const config = keyringConfigFromEnv({ key: ORIGIN_KEY_ENV, retired: ORIGIN_RETIRED_KEYS_ENV, revoked: ORIGIN_REVOKED_IDS_ENV }, 'origin', env, now);
  if (config.ok) return config;
  return { ok: false, code: config.code === 'NOT_CONFIGURED' ? 'ORIGIN_KEY_NOT_CONFIGURED' : config.code === 'WEAK' ? 'ORIGIN_KEY_WEAK' : 'ORIGIN_CONFIG_INVALID' };
}

/** Veredito para uma entrada, com o caso "este servidor não tem autenticador". */
export function judgeOrigin(authenticator: OriginAuthenticator | undefined, domain: OriginDomain, entry: object): OriginVerdict {
  return authenticator ? authenticator.verify(domain, entry) : 'NO_KEY';
}

/** Rótulo seguro para a interface/API (nunca revela a chave nem a etiqueta). */
export type OriginStatus = 'PROVEN' | 'UNPROVEN' | 'UNVERIFIABLE';
export const originStatusOf = (verdict: OriginVerdict): OriginStatus => (verdict === 'PROVEN' ? 'PROVEN' : verdict === 'NO_KEY' ? 'UNVERIFIABLE' : 'UNPROVEN');
