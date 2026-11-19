import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { nodeFsOps, type FileInfo, type FsOps } from '../link-audit/snapshot-store';
import { AUDIT_ID_PATTERN } from './types';

/*
 * PROVENIÊNCIA DAS EVIDÊNCIAS na fronteira com o Motor Lumos (Onda 6C, remediação de R2-MINOR-1; decisão do responsável).
 *
 * QUATRO COISAS DIFERENTES (nunca confundir; ver `onda6c-adr-proveniencia-evidencias.md`):
 *  - ORIGEM DA OPERAÇÃO: o servidor comprova que ELE gravou uma decisão/um resultado (etiqueta HMAC, `link-audit-origin`). NÃO diz nada sobre se os
 *    FATOS que o resultado usou são verdadeiros.
 *  - INTEGRIDADE DO ARQUIVO: SHA-256 + encadeamento + recibo provam que o arquivo não mudou DEPOIS de selado. Quem escreve na pasta de evidências
 *    sela o que quiser (o leitor recalcula o hash sobre os bytes que estão lá): integridade NÃO é autenticidade.
 *  - AUTENTICIDADE DA EVIDÊNCIA: prova INDEPENDENTE de que o conteúdo veio da coleta, feita por quem tem uma chave que NÃO está na pasta de evidências.
 *    É o que este módulo verifica: um MANIFESTO assinado (Ed25519) listando `ref → contentSha256` de cada evidência, guardado FORA da pasta de
 *    evidências. Quem só escreve na pasta de evidências não consegue produzir nem alterar o manifesto.
 *  - ATUALIDADE: se a informação ainda vale hoje (`stale`, data de referência). Um manifesto autêntico antigo continua autêntico.
 *
 * REGRAS (falha FECHADA): sem chave de confiança configurada, sem manifesto, com manifesto inválido/de outra auditoria/de chave desconhecida, ou com
 * QUALQUER evidência da base fora do manifesto ou com hash diferente ⇒ `UNAUTHENTICATED` e a finalização é bloqueada. Capturas legadas sem prova
 * independente NUNCA são tratadas como autênticas: só passam a ser se quem tem a chave as atestar, por ato explícito (sem migração silenciosa).
 *
 * Este módulo é o LADO VERIFICADOR. Quem PRODUZ o manifesto (na coleta, ou por um passo de atestação) é um passo de pipeline que depende de plano
 * aprovado (`createEvidenceSeal` é só a primitiva pura; a chave privada NUNCA existe no servidor web).
 */

export const SEAL_KIND = 'LINK_AUDIT_EVIDENCE_SEAL' as const;
export const SEAL_SCHEMA_VERSION = 1 as const;
export const SEAL_FILE = /^seal-(\d{4})\.json$/;
export const MAX_SEAL_BYTES = 256 * 1024;
const TRUST_KEY_ID = /^[a-z0-9][a-z0-9-]{3,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/; // Ed25519: 64 bytes em base64url sem preenchimento
const REF = /^(?:capture:c\d{4}|report:c\d{4}-r\d{4}|legacy-status:c\d{4})$/;
/** Prefixo DER SPKI de uma chave pública Ed25519 de 32 bytes. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Por que a evidência NÃO é tratada como autêntica (códigos fixos, sem dados do arquivo). */
export type EvidenceTrustReason =
  | 'PROOF_NOT_CONFIGURED'
  | 'NO_SEAL'
  | 'LEGACY_NO_SEAL'
  | 'SEAL_INVALID'
  | 'EVIDENCE_NOT_SEALED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'VERIFICATION_ERROR'
  // v2 (contract §8, additive): the chain does not close / omits or changes an earlier entry / a v1 after a v2 / a version the policy refuses /
  // a retired key outside its pinned closure / an authentic signature of a revoked key
  | 'SEAL_CHAIN_BROKEN'
  | 'SEAL_NOT_CUMULATIVE'
  | 'SEAL_DOWNGRADE'
  | 'SEAL_VERSION_NOT_ALLOWED'
  | 'SEAL_KEY_RETIRED_UNCOVERED'
  | 'SEAL_KEY_REVOKED';

/** Which chain head and which keys authenticated (contract §7.3, O6). Returned ONLY by the v2 path; result recording is wave R2. */
export interface EvidenceHeadProof {
  readonly headSeq: number;
  readonly headSealSha256: string;
  /** Distinct, sorted ids of the keys of the positions (plus the closure signer used, W3.4). Public labels, no PII. */
  readonly keyIds: readonly string[];
}

export type EvidenceTrust =
  /** v1 (compatible path): EXACTLY this object, as before W3 (contract §8.A, §9). */
  | { readonly status: 'AUTHENTICATED' }
  | ({ readonly status: 'AUTHENTICATED' } & EvidenceHeadProof)
  /** `missingRefs`: só em `EVIDENCE_MISSING` (no máximo 5 referências, sem conteúdo): o manifesto atesta algo que a base de hoje NÃO tem. */
  | { readonly status: 'UNAUTHENTICATED'; readonly reason: EvidenceTrustReason; readonly missingRefs?: readonly string[] };

/** O mínimo que a verificação precisa de cada evidência da base (o leitor já recalculou `contentSha256` sobre os bytes lidos). */
export interface EvidenceToProve {
  readonly ref: string;
  readonly contentSha256: string;
  readonly legacy: boolean;
}

export interface EvidenceProvenancePolicy {
  /** Nunca lança: qualquer falha é `UNAUTHENTICATED`. */
  classify(auditId: string, evidences: readonly EvidenceToProve[]): Promise<EvidenceTrust>;
}

const unauthenticated = (reason: EvidenceTrustReason): EvidenceTrust => ({ status: 'UNAUTHENTICATED', reason });

/** Política padrão de produção SEM prova configurada: nada é autêntico. */
export const CLOSED_EVIDENCE_PROVENANCE: EvidenceProvenancePolicy = {
  async classify() {
    return unauthenticated('PROOF_NOT_CONFIGURED');
  },
};

/* ------------------------------------------------------------------------------------------ o manifesto */

const entrySchema = z.object({ ref: z.string().regex(REF), contentSha256: z.string().regex(HEX64) }).strict();
const sealBodySchema = z
  .object({
    schemaVersion: z.literal(SEAL_SCHEMA_VERSION),
    kind: z.literal(SEAL_KIND),
    auditId: z.string().regex(AUDIT_ID_PATTERN),
    seq: z.number().int().min(1).max(9999),
    sealedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    keyId: z.string().regex(TRUST_KEY_ID),
    entries: z.array(entrySchema).min(1).max(2000),
  })
  .strict();
const sealFileSchema = sealBodySchema.extend({ signature: z.string().regex(SIGNATURE) }).strict();
export type EvidenceSealBody = z.infer<typeof sealBodySchema>;
export type EvidenceSealFile = z.infer<typeof sealFileSchema>;

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * Primitiva PURA de produção do manifesto (usada por testes e, no futuro, pelo passo de atestação que tem a chave privada). Cumulativo: cada
 * manifesto lista TODAS as evidências atestadas até ali; o verificador usa o de maior `seq`.
 */
export function createEvidenceSeal(input: { readonly auditId: string; readonly seq: number; readonly sealedAt: string; readonly keyId: string; readonly privateKey: KeyObject; readonly entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }> }): EvidenceSealFile {
  const entries = [...input.entries].map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256 })).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const body: EvidenceSealBody = sealBodySchema.parse({ schemaVersion: SEAL_SCHEMA_VERSION, kind: SEAL_KIND, auditId: input.auditId, seq: input.seq, sealedAt: input.sealedAt, keyId: input.keyId, entries });
  return { ...body, signature: b64url(cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), input.privateKey)) };
}

/* ----- chaves públicas de ORDEM PEQUENA (fraqueza do Ed25519): com uma delas como chave de confiança, qualquer pessoa forja assinaturas ----- */
const P = 2n ** 255n - 19n;
const D = (((P - 121665n) % P) * modPow(121666n, P - 2n)) % P;
function modPow(base: bigint, exp: bigint, mod = P): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
  }
  return result;
}
const inv = (value: bigint): bigint => modPow(value, P - 2n);

/** Decodifica um ponto Ed25519 (afim). `null` se o encoding não é canônico ou não está na curva. */
function decodePoint(raw: Buffer): readonly [bigint, bigint] | null {
  const sign = (raw[31] as number) >> 7;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? (raw[31] as number) & 0x7f : (raw[i] as number));
  if (y >= P) return null; // não canônico
  const y2 = (y * y) % P;
  const x2 = (((y2 - 1n + P) % P) * inv((D * y2 + 1n) % P)) % P;
  let x = modPow(x2, (P + 3n) / 8n);
  if ((x * x - x2 + P) % P !== 0n) x = (x * modPow(2n, (P - 1n) / 4n)) % P;
  if ((x * x - x2 + P) % P !== 0n) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = (P - x) % P;
  return [x, y];
}
function addPoints(a: readonly [bigint, bigint], b: readonly [bigint, bigint]): readonly [bigint, bigint] {
  const dxy = (D * a[0] * b[0] * a[1] * b[1]) % P;
  const x = ((a[0] * b[1] + b[0] * a[1]) % P) * inv((1n + dxy) % P);
  const y = ((a[1] * b[1] + a[0] * b[0]) % P) * inv((1n - dxy + P) % P);
  return [x % P, y % P];
}
/** Verdadeiro se o ponto tem ordem dividindo 8 (8·A = identidade) ou não é um ponto válido/canônico. */
export function isWeakEd25519PublicKey(raw: Buffer): boolean {
  const point = decodePoint(raw);
  if (!point) return true;
  let eight: readonly [bigint, bigint] = point;
  for (let i = 0; i < 3; i += 1) eight = addPoints(eight, eight);
  return eight[0] === 0n && eight[1] === 1n;
}

/** Chave pública Ed25519 a partir dos 32 bytes brutos em base64url. `null` se malformada ou de ordem pequena (forjável). */
export function publicKeyFromRaw(rawBase64Url: string): KeyObject | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawBase64Url)) return null;
  const raw = Buffer.from(rawBase64Url, 'base64url');
  if (raw.length !== 32 || b64url(raw) !== rawBase64Url) return null;
  if (isWeakEd25519PublicKey(raw)) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** `<id>:<32 bytes em base64url>,<id>:<…>` → chaves de confiança. Qualquer item malformado ou repetido invalida TUDO (falha fechada). */
export function parseTrustKeys(raw: string | undefined): ReadonlyMap<string, KeyObject> | null {
  if (raw === undefined || raw === '') return null;
  const keys = new Map<string, KeyObject>();
  for (const item of raw.split(',')) {
    const parts = item.split(':');
    if (parts.length !== 2) return null;
    const [id, material] = parts as [string, string];
    const key = TRUST_KEY_ID.test(id) ? publicKeyFromRaw(material) : null;
    if (!key || keys.has(id)) return null;
    keys.set(id, key);
  }
  return keys;
}

/* ------------------------------------------------------------------------------------------ a política que VERIFICA */

/** Manifest format versions a policy accepts at EVERY position (contract §4.2). */
export type AcceptedSealVersion = 1 | 2;
/**
 * LIBRARY default `[1,2]`, kept only so the v1 suite keeps passing unchanged (contract §4.3, C2). Every caller outside tests/ passes
 * `acceptedVersions` explicitly; production passes `[2]` (static test V2-19).
 */
export const DEFAULT_ACCEPTED_VERSIONS: readonly AcceptedSealVersion[] = Object.freeze([1, 2] as const);

/** Trust-list item with its state (contract §5). `active` signs; `retired` only verifies what its pinned closure covers (§6); `revoked` never counts. */
export interface TrustKeyringEntry {
  readonly key: KeyObject;
  readonly status: 'active' | 'retired' | 'revoked';
  /** Pinned SHA-256 of the DELIVERED bytes of the retirement closure (`retired:<hash>`), or null. Only a `retired` item may carry one. */
  readonly closureSha256: string | null;
}
export type TrustKeyring = ReadonlyMap<string, TrustKeyringEntry>;

/** Most items in the trust list; retired items stay listed (contract §5, O2). */
export const MAX_TRUST_KEYS = 16;
/** Most keys signing at the same time: holder and deputy, each with its own pair (D10, D12). */
const MAX_ACTIVE_KEYS = 2;
const KEY_STATUSES: ReadonlySet<string> = new Set(['active', 'retired', 'revoked']);

/**
 * `<id>:<pub>` (active) | `<id>:<pub>:active|retired|revoked` | `<id>:<pub>:retired:<closureSha256>` → keyring (contract §5). ANY malformed item,
 * repeated id, public key under two ids (RS-16), more than 2 `active` or more than 16 items ⇒ null (closed policy). Zero `active` is valid.
 * `parseTrustKeys` stays as it was.
 */
export function parseTrustKeyring(raw: string | undefined): TrustKeyring | null {
  if (raw === undefined || raw === '') return null;
  const items = raw.split(',');
  if (items.length > MAX_TRUST_KEYS) return null;
  const ring = new Map<string, TrustKeyringEntry>();
  const materials = new Set<string>();
  for (const item of items) {
    const parsed = parseKeyringItem(item);
    if (!parsed || ring.has(parsed.id) || materials.has(parsed.material)) return null;
    ring.set(parsed.id, parsed.entry);
    materials.add(parsed.material);
  }
  return [...ring.values()].filter((entry) => entry.status === 'active').length <= MAX_ACTIVE_KEYS ? ring : null;
}

function parseKeyringItem(item: string): { readonly id: string; readonly material: string; readonly entry: TrustKeyringEntry } | null {
  const parts = item.split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  const [id, material, status = 'active', pinned] = parts as [string, string, string?, string?];
  // 4 parts ONLY as `retired:<64 lowercase hex>`; the status is exact (no case folding, no blanks)
  if (!KEY_STATUSES.has(status) || (parts.length === 4 && !(status === 'retired' && HEX64.test(pinned ?? '')))) return null;
  const key = TRUST_KEY_ID.test(id) ? publicKeyFromRaw(material) : null;
  return key ? { id, material, entry: { key, status: status as TrustKeyringEntry['status'], closureSha256: parts.length === 4 ? (pinned as string) : null } } : null;
}

/** A keyring built in code is held to the same rules as a parsed one (fail-closed). */
function isValidKeyring(ring: unknown): ring is TrustKeyring {
  if (!(ring instanceof Map) || ring.size > MAX_TRUST_KEYS) return false;
  const materials = new Set<string>();
  let active = 0;
  for (const [id, entry] of ring as Map<unknown, TrustKeyringEntry>) {
    const shapeOk = typeof id === 'string' && TRUST_KEY_ID.test(id) && typeof entry === 'object' && entry !== null && isEd25519PublicKey(entry.key) && KEY_STATUSES.has(entry.status);
    if (!shapeOk || !(entry.closureSha256 === null || (entry.status === 'retired' && HEX64.test(entry.closureSha256)))) return false;
    const spki = entry.key.export({ format: 'der', type: 'spki' });
    // Same rule as the parser (publicKeyFromRaw): a small-order or non-canonical point lets anyone forge signatures.
    if (spki.length < 32 || isWeakEd25519PublicKey(spki.subarray(spki.length - 32))) return false;
    const material = spki.toString('base64');
    if (materials.has(material)) return false;
    materials.add(material);
    if (entry.status === 'active') active += 1;
  }
  return active <= MAX_ACTIVE_KEYS;
}

/** The one trust list the verifier uses: `keyring` (validated), or the TEST-ONLY `trustedKeys` as all `active`. Both, neither or invalid ⇒ null. */
function keyringOf(options: SealedEvidenceOptions): TrustKeyring | null {
  if (options.keyring !== undefined) return options.trustedKeys === undefined && isValidKeyring(options.keyring) ? options.keyring : null;
  if (options.trustedKeys === undefined) return null;
  return new Map([...options.trustedKeys].map(([id, key]) => [id, { key, status: 'active' as const, closureSha256: null }]));
}

export interface SealedEvidenceOptions {
  /** Pasta DOS MANIFESTOS (somente leitura para o web; NUNCA a pasta de evidências nem aninhada nela). */
  readonly sealsDir: string;
  /** TEST-ONLY trust list, every key `active` (contract §5). Together with `keyring` ⇒ closed policy. */
  readonly trustedKeys?: ReadonlyMap<string, KeyObject>;
  /** Production trust list with key states (contract §5), e.g. from `parseTrustKeyring`. Held to the same limits when built in code. */
  readonly keyring?: TrustKeyring;
  /** Versions accepted at every position; absent ⇒ library default `[1,2]`. Empty, unknown or repeated ⇒ closed policy (contract §4.2). */
  readonly acceptedVersions?: readonly AcceptedSealVersion[];
  readonly fs?: FsOps;
  /** Outras pastas (evidências, decisões, recibos, resultados): a de manifestos não pode ser nenhuma delas nem estar aninhada (considera link simbólico). */
  readonly otherDirs?: readonly string[];
}

/** `undefined` ⇒ library default; anything else must be a non-empty set of {1, 2} without repetition, or the policy is closed (fail-closed). */
function acceptedVersionsOf(value: unknown): readonly AcceptedSealVersion[] | null {
  if (value === undefined) return DEFAULT_ACCEPTED_VERSIONS;
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return null;
  return value.every((version) => version === 1 || version === 2) ? Object.freeze([...(value as AcceptedSealVersion[])]) : null;
}

/** Política que só autentica o que um manifesto ASSINADO por uma chave de confiança cobre, com os MESMOS hashes. */
export function createSealedEvidenceProvenance(options: SealedEvidenceOptions): EvidenceProvenancePolicy {
  const versions = acceptedVersionsOf(options.acceptedVersions);
  const ring = keyringOf(options);
  // keyring + trustedKeys together, neither, or an invalid keyring ⇒ nothing is authentic (contract §5, §8 row 1)
  if (versions === null || ring === null) return CLOSED_EVIDENCE_PROVENANCE;
  const ops = options.fs ?? nodeFsOps;
  const real = async (target: string): Promise<string> => {
    try {
      return (await ops.realpath(target)).toLowerCase();
    } catch {
      return path.resolve(target).toLowerCase();
    }
  };
  return {
    async classify(auditId, evidences) {
      try {
        if (!AUDIT_ID_PATTERN.test(auditId) || evidences.length === 0) return unauthenticated('NO_SEAL');
        if ((options.otherDirs ?? []).length > 0) {
          const seals = await real(options.sealsDir);
          for (const other of options.otherDirs ?? []) {
            const o = await real(other);
            if (seals === o || seals.startsWith(o + path.sep) || o.startsWith(seals + path.sep)) return unauthenticated('PROOF_NOT_CONFIGURED'); // sobreposição, inclusive por link simbólico
          }
        }
        const legacy = evidences.some((evidence) => evidence.legacy);
        const dir = path.join(options.sealsDir, auditId);
        let names: string[];
        try {
          const info = await ops.lstat(dir);
          if (!info.isDirectory() || info.isSymbolicLink()) return unauthenticated('SEAL_INVALID');
          names = await ops.readdir(dir);
        } catch {
          return unauthenticated(legacy ? 'LEGACY_NO_SEAL' : 'NO_SEAL');
        }
        const sealed = names.flatMap((name) => {
          const match = SEAL_FILE.exec(name);
          return match ? [{ name, seq: Number(match[1]) }] : [];
        });
        if (sealed.length === 0) return unauthenticated(legacy ? 'LEGACY_NO_SEAL' : 'NO_SEAL');
        // o de MAIOR seq: se ele não valer, não se recua para um mais antigo (o atacante escolheria qual versão do passado vale)
        const latest = sealed.reduce((best, item) => (item.seq > best.seq ? item : best));
        // `[2]` always walks: rows 4–5 decide before (and without) reading the latest separately
        const sealsDir = options.sealsDir;
        if (!versions.includes(1)) return await classifyWalked({ ops, sealsDir, dir, sealed, auditId, evidences, ring, versions, budget: { remaining: MAX_CLASSIFY_BYTES } });
        const budget: ReadBudget = { remaining: MAX_CLASSIFY_BYTES };
        const latestRead = await readPosition(ops, path.join(dir, latest.name), budget); // read ONCE; reused by whichever path is taken
        const declared = latestRead.kind === 'text' ? declaredSeal(latestRead.text) : null;
        // Path choice (contract §8): `[1]` emulates the old verifier, always. `[1,2]` with a v1 latest is path A, exactly today's behavior.
        // Everything else (latest v2, or a latest that is unreadable or of another version) is the WALKED path B (fail-closed).
        if (!versions.includes(2)) return declared ? classifyLatestV1(declared.json, latest.seq, auditId, evidences, ring) : unauthenticated('VERIFICATION_ERROR');
        if (declared?.schemaVersion === SEAL_SCHEMA_VERSION) return classifyLatestV1(declared.json, latest.seq, auditId, evidences, ring);
        return await classifyWalked({ ops, sealsDir, dir, sealed, auditId, evidences, ring, versions, budget, alreadyRead: { seq: latest.seq, read: latestRead } });
      } catch {
        return unauthenticated('VERIFICATION_ERROR');
      }
    },
  };
}

/** The latest file as JSON.parse sees it (as the v1 verifier always did), only to choose the path. `null` = not JSON. Never throws. */
function declaredSeal(text: string): { readonly json: unknown; readonly schemaVersion: unknown } | null {
  try {
    const json = JSON.parse(text) as unknown;
    return { json, schemaVersion: typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as { readonly schemaVersion?: unknown }).schemaVersion : undefined };
  } catch {
    return null;
  }
}

/** Path A (contract §8.A, §9): the v1 verifier of before W3, unchanged: only the latest manifest, answer EXACTLY `{status:'AUTHENTICATED'}`. */
function classifyLatestV1(json: unknown, latestSeq: number, auditId: string, evidences: readonly EvidenceToProve[], ring: TrustKeyring): EvidenceTrust {
  const parsed = sealFileSchema.safeParse(json);
  if (!parsed.success) return unauthenticated('SEAL_INVALID');
  const { signature, ...body } = parsed.data;
  const signer = ring.get(body.keyId);
  if (!signer || body.auditId !== auditId || body.seq !== latestSeq) return unauthenticated('SEAL_INVALID');
  const refs = body.entries.map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length || refs.some((ref, index) => index > 0 && (refs[index - 1] as string) >= ref)) return unauthenticated('SEAL_INVALID'); // ordenado e sem repetição
  if (!cryptoVerify(null, Buffer.from(canonicalJson(body), 'utf8'), signer.key, Buffer.from(signature, 'base64url'))) return unauthenticated('SEAL_INVALID');
  // the ONLY addition to the v1 path (contract §8.A, §9): the signer's state; a v1 is never covered by a retirement closure
  if (signer.status === 'revoked') return unauthenticated('SEAL_KEY_REVOKED');
  if (signer.status === 'retired') return unauthenticated('SEAL_KEY_RETIRED_UNCOVERED');
  return coverageVerdict(body.entries, evidences) ?? { status: 'AUTHENTICATED' };
}

/** Two-way coverage over the head manifest (`null` = covered). Same rule for v1 and v2 (contract §3, last paragraph). */
function coverageVerdict(entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>, evidences: readonly EvidenceToProve[]): EvidenceTrust | null {
  const byRef = new Map(entries.map((entry) => [entry.ref, entry.contentSha256]));
  // (1) base ⊆ manifesto: tudo que é usado está atestado, com o MESMO hash
  for (const evidence of evidences) {
    const attested = byRef.get(evidence.ref);
    if (attested === undefined) return unauthenticated('EVIDENCE_NOT_SEALED');
    if (attested !== evidence.contentSha256) return unauthenticated('EVIDENCE_HASH_MISMATCH');
  }
  // (2) manifesto ⊆ base: nada que foi atestado pode ter DESAPARECIDO. Sem isto, apagar a captura mais recente faria uma captura antiga voltar a ser a "situação atual"
  // ainda autêntica (R3-MINOR-1). O manifesto é cumulativo: ele define o conjunto exato de capturas, relatórios e artefatos cobertos.
  const present = new Set(evidences.map((evidence) => evidence.ref));
  const missing = entries.map((entry) => entry.ref).filter((ref) => !present.has(ref));
  return missing.length > 0 ? { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: missing.slice(0, 5) } : null;
}

/**
 * Política a partir da CONFIGURAÇÃO do servidor (variáveis lidas por quem chama): pasta de manifestos + chaves públicas de confiança. Faltando
 * qualquer uma, ou chave malformada, a política é a FECHADA. Não existe valor que "confie em tudo".
 */
export function evidenceProvenanceFromConfig(
  config: { readonly sealsDir: string | null; readonly trustKeys: string | undefined; readonly otherDirs?: ReadonlyArray<string | null | undefined>; readonly acceptedVersions?: readonly AcceptedSealVersion[] },
  fsOps?: FsOps,
): EvidenceProvenancePolicy {
  const ring = parseTrustKeyring(config.trustKeys);
  if (!config.sealsDir || !ring) return CLOSED_EVIDENCE_PROVENANCE;
  // os manifestos NÃO podem morar em nenhuma outra pasta de dados (nem elas dentro deles): quem escreve lá não pode tocar na prova (nem para apagá-la).
  // Duas camadas: léxica aqui (já na configuração) e por caminho REAL (links simbólicos) a cada verificação.
  const others = (config.otherDirs ?? []).filter((dir): dir is string => typeof dir === 'string' && dir !== '');
  const a = path.resolve(config.sealsDir).toLowerCase();
  for (const dir of others) {
    const b = path.resolve(dir).toLowerCase();
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) return CLOSED_EVIDENCE_PROVENANCE;
  }
  // the list in the new format (a superset of the old one) and `acceptedVersions` forwarded as given (absent ⇒ library default [1,2]; production
  // passes [2], V2-19). Contract §5: this function uses `parseTrustKeyring` and the `keyring` option.
  return createSealedEvidenceProvenance({ sealsDir: config.sealsDir, keyring: ring, acceptedVersions: config.acceptedVersions, otherDirs: others, ...(fsOps ? { fs: fsOps } : {}) });
}

/* ============================================================================== manifest v2 and key-retirement closure (wave W3.1) */
/*
 * PURE, ADDITIVE primitives of the v2 manifest and of the key-retirement closure (contract `p1-contrato-verificador-v2.md` §2 and §6).
 * Nothing above changes: the v1 schemas, `createEvidenceSeal`, `parseTrustKeys` and the v1 `classify` path stay exactly as they were.
 * `classify` walks v2 chains with them (`classifyWalked`, W3.2–W3.3); keyring states and closures are W3.4, the revocation pre-step W3.5.
 *
 * Signed bytes = UTF-8(canonicalJson(file without `signature`)); Ed25519 PURE (`crypto.sign/verify(null, …)`), no pre-hash, no context: the
 * same framing as v1 and the only one a K2 device can reproduce (RS-15). `schemaVersion` and `kind` are inside the signed bytes.
 */

export const SEAL_SCHEMA_VERSION_V2 = 2 as const;
/** Highest `seq` of a v2 manifest and most manifests per audit (contract §2, O7). v1 keeps 1…9999. */
export const MAX_CHAIN_SEALS = 256;
export const CLOSURE_KIND = 'LINK_AUDIT_KEY_RETIREMENT_CLOSURE' as const;
export const CLOSURE_SCHEMA_VERSION = 1 as const;
export const MAX_CLOSURE_BYTES = 256 * 1024;
export const MAX_CLOSURE_HEADS = 1000;
const MAX_SEAL_ENTRIES = 2000;
const SEALED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Short dossier label, never PII (contract §2). */
const DOSSIER_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** RFC 8032 §5.1: order L of the Ed25519 base point. */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const ED25519_SIGNATURE_BYTES = 64;
const BYTE_ORDER_MARK = 0xfeff;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type EvidenceSealErrorCode = 'SCHEMA_INVALID' | 'SIGNATURE_DOES_NOT_VERIFY' | 'PUBLIC_KEY_INVALID';
const SEAL_ERROR_MESSAGES: Readonly<Record<EvidenceSealErrorCode, string>> = {
  SCHEMA_INVALID: 'O manifesto ou o fecho não segue o esquema estrito.',
  SIGNATURE_DOES_NOT_VERIFY: 'A assinatura não confere com a chave pública informada.',
  PUBLIC_KEY_INVALID: 'A chave informada não é uma chave pública Ed25519.',
};

/** Typed producer-side failure. Fixed code and message: never key material, signatures or file data. */
export class EvidenceSealError extends Error {
  readonly code: EvidenceSealErrorCode;
  constructor(code: EvidenceSealErrorCode) {
    super(SEAL_ERROR_MESSAGES[code]);
    this.name = 'EvidenceSealError';
    this.code = code;
  }
}

/** Strictly increasing by `key` in UTF-16 code units (like the v1 check in `classify`): sorted AND without repetition. */
function isStrictlyOrdered<T>(items: readonly T[], key: (item: T) => string): boolean {
  return items.every((item, index) => index === 0 || key(items[index - 1] as T) < key(item));
}

function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Canonical base64url of exactly 64 bytes whose scalar half S is below L: no re-encoded text and no S+L malleability (contract §2). */
function isCanonicalSignatureText(text: string): boolean {
  if (!SIGNATURE.test(text)) return false;
  const raw = Buffer.from(text, 'base64url');
  if (raw.length !== ED25519_SIGNATURE_BYTES || b64url(raw) !== text) return false;
  let scalar = 0n;
  for (let index = ED25519_SIGNATURE_BYTES - 1; index >= ED25519_SIGNATURE_BYTES / 2; index -= 1) scalar = (scalar << 8n) | BigInt(raw[index] as number);
  return scalar < ED25519_ORDER;
}

const signatureSchema = z.string().refine(isCanonicalSignatureText);
const chainSeqSchema = z.number().int().min(1).max(MAX_CHAIN_SEALS);
const sealBodyShapeV2 = {
  schemaVersion: z.literal(SEAL_SCHEMA_VERSION_V2),
  kind: z.literal(SEAL_KIND),
  auditId: z.string().regex(AUDIT_ID_PATTERN),
  seq: chainSeqSchema,
  sealedAt: z.string().regex(SEALED_AT),
  keyId: z.string().regex(TRUST_KEY_ID),
  entries: z.array(entrySchema).min(1).max(MAX_SEAL_ENTRIES).refine((entries) => isStrictlyOrdered(entries, (entry) => entry.ref)),
  dossier: z.object({ id: z.string().regex(DOSSIER_ID), sha256: z.string().regex(HEX64) }).strict(),
  // "null iff seq = 1" is a CHAIN rule (SEAL_CHAIN_BROKEN: contract §3 item 3, §8 row 11, V2-11), deliberately not a schema rule (`withCoherentPrev`)
  prevSealSha256: z.string().regex(HEX64).nullable(),
};
const sealBodySchemaV2 = z.object(sealBodyShapeV2).strict();
const sealFileSchemaV2 = z.object({ ...sealBodyShapeV2, signature: signatureSchema }).strict();
export type EvidenceSealBodyV2 = z.infer<typeof sealBodySchemaV2>;
export type EvidenceSealFileV2 = z.infer<typeof sealFileSchemaV2>;

/** v1 as the v2-era code accepts it (`sealSha256`, walked path B): the UNCHANGED v1 schema plus canonical signature and strictly ordered entries. */
const sealFileSchemaV1Strict = sealFileSchema.refine((file) => isCanonicalSignatureText(file.signature) && isStrictlyOrdered(file.entries, (entry) => entry.ref));

const closureHeadSchema = z.object({ auditId: z.string().regex(AUDIT_ID_PATTERN), seq: chainSeqSchema, sealSha256: z.string().regex(HEX64) }).strict();
const closureBodyShape = {
  schemaVersion: z.literal(CLOSURE_SCHEMA_VERSION),
  kind: z.literal(CLOSURE_KIND),
  retiredKeyId: z.string().regex(TRUST_KEY_ID),
  signerKeyId: z.string().regex(TRUST_KEY_ID),
  sealedAt: z.string().regex(SEALED_AT),
  // 0…1000 heads, strictly ordered by auditId: one per audit (contract §6)
  heads: z.array(closureHeadSchema).max(MAX_CLOSURE_HEADS).refine((heads) => isStrictlyOrdered(heads, (head) => head.auditId)),
};
/** A key never closes itself (contract §6, `signerKeyId ≠ R`). In the schema because every closure failure has the same effect: R does not count. */
const signerIsNotRetired = (closure: { readonly retiredKeyId: string; readonly signerKeyId: string }): boolean => closure.signerKeyId !== closure.retiredKeyId;
const closureBodySchema = z.object(closureBodyShape).strict().refine(signerIsNotRetired);
const closureFileSchema = z.object({ ...closureBodyShape, signature: signatureSchema }).strict().refine(signerIsNotRetired);
export type KeyRetirementClosureBody = z.infer<typeof closureBodySchema>;
export type KeyRetirementClosureFile = z.infer<typeof closureFileSchema>;

function strictParse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EvidenceSealError('SCHEMA_INVALID');
  return parsed.data;
}

const signingBytesOf = (body: object): Buffer => Buffer.from(canonicalJson(body), 'utf8');
const isEd25519PublicKey = (key: KeyObject): boolean => typeof key === 'object' && key !== null && key.type === 'public' && key.asymmetricKeyType === 'ed25519';

/* ----------------------------------------------------------------------------------------- signature verification */

/**
 * Ed25519 PURE signature check by a public key (contract §2): canonical base64url of 64 bytes and S < L checked HERE (today's Node/OpenSSL also
 * refuse S+L, but the rule must not depend on the runtime), then `crypto.verify(null, …)`. Never throws.
 */
export function verifyEd25519PureSignature(message: Uint8Array, signature: string, publicKey: KeyObject): boolean {
  try {
    if (!isEd25519PublicKey(publicKey) || typeof signature !== 'string' || !isCanonicalSignatureText(signature)) return false;
    return cryptoVerify(null, message, publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Signature of a v2 manifest (re-validated by the strict schema first). Says nothing about the trust list, the chain or the evidence. */
export function verifyEvidenceSealV2Signature(file: EvidenceSealFileV2, publicKey: KeyObject): boolean {
  const parsed = sealFileSchemaV2.safeParse(file);
  if (!parsed.success) return false;
  const { signature, ...body } = parsed.data;
  return verifyEd25519PureSignature(signingBytesOf(body), signature, publicKey);
}

/** Signature of a retirement closure (re-validated first). Defense in depth only: the AUTHORITY is the hash pinned in the trust list (§6, W3.4). */
export function verifyKeyRetirementClosureSignature(file: KeyRetirementClosureFile, publicKey: KeyObject): boolean {
  const parsed = closureFileSchema.safeParse(file);
  if (!parsed.success) return false;
  const { signature, ...body } = parsed.data;
  return verifyEd25519PureSignature(signingBytesOf(body), signature, publicKey);
}

/* ----------------------------------------------------------------------------------------- raw text (contract §2 "Maleabilidade e texto") */

/** Why a manifest/closure TEXT was refused (fixed codes, no file data). For the verifier every one is `SEAL_INVALID` (contract §8 row 8). */
export type SealTextIssue = 'TOO_LARGE' | 'NOT_UTF8' | 'BOM' | 'BACKSLASH' | 'DUPLICATE_KEY' | 'NOT_JSON' | 'SCHEMA';
export type SealTextParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'SEAL_INVALID'; readonly issue: SealTextIssue };
type TextRejection = Extract<SealTextParse<never>, { readonly ok: false }>;
const textRejected = (issue: SealTextIssue): TextRejection => ({ ok: false, reason: 'SEAL_INVALID', issue });

/**
 * A repeated key inside any one JSON object, found by scanning the RAW text (JSON.parse keeps the last one silently). Sound only on text WITHOUT
 * backslashes (refused before): with no escapes a string is exactly `"` up to the next `"`, and the raw key equals the decoded key.
 * `null` = not well-formed (JSON.parse refuses it next).
 */
function hasDuplicateKey(text: string): boolean | null {
  const frames: Array<Set<string> | null> = []; // one per open container: keys seen so far (object) or null (array)
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      if (end < 0) return null;
      const keys = frames[frames.length - 1];
      if (expectKey && keys) {
        const key = text.slice(index + 1, end);
        if (keys.has(key)) return true;
        keys.add(key);
      }
      expectKey = false;
      index = end;
    } else if (char === '{' || char === '[') {
      frames.push(char === '{' ? new Set<string>() : null);
      expectKey = char === '{';
    } else if (char === '}' || char === ']') {
      if (frames.pop() === undefined) return null;
      expectKey = false;
    } else if (char === ',') {
      expectKey = frames[frames.length - 1] instanceof Set;
    }
  }
  return frames.length === 0 ? false : null;
}

/**
 * Raw-text gate shared by the v2 manifest and the closure, BEFORE JSON.parse: size, strict UTF-8, BOM, any backslash, duplicate key. The size
 * check is a backstop: the READER bounds each read itself and reports an overflow as VERIFICATION_ERROR (contract §2 "Limites", §8 row 7).
 */
function readStrictJsonText(raw: Uint8Array, maxBytes: number): { readonly ok: true; readonly json: unknown } | TextRejection {
  if (!(raw instanceof Uint8Array)) return textRejected('NOT_UTF8');
  if (raw.byteLength > maxBytes) return textRejected('TOO_LARGE');
  let text: string;
  try {
    text = STRICT_UTF8.decode(raw);
  } catch {
    return textRejected('NOT_UTF8');
  }
  if (text.charCodeAt(0) === BYTE_ORDER_MARK) return textRejected('BOM');
  // no valid field ever needs an escape: refusing every backslash keeps raw text = decoded text (and makes the key scan sound)
  if (text.includes('\\')) return textRejected('BACKSLASH');
  const duplicate = hasDuplicateKey(text);
  if (duplicate !== false) return textRejected(duplicate ? 'DUPLICATE_KEY' : 'NOT_JSON');
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return textRejected('NOT_JSON');
  }
}

function parseStrictText<S extends z.ZodType>(raw: Uint8Array, maxBytes: number, schema: S): SealTextParse<z.output<S>> {
  const read = readStrictJsonText(raw, maxBytes);
  if (!read.ok) return read;
  const parsed = schema.safeParse(read.json);
  return parsed.success ? { ok: true, value: parsed.data } : textRejected('SCHEMA');
}

/** v2 manifest from the bytes AS READ: raw-text gate, JSON, strict schema. Format only (no key, no chain). Never throws. */
export function parseEvidenceSealV2Text(raw: Uint8Array): SealTextParse<EvidenceSealFileV2> {
  return parseStrictText(raw, MAX_SEAL_BYTES, sealFileSchemaV2);
}

/** Retirement closure from the bytes AS READ (the pinned hash is over these same bytes, W3.4): raw-text gate, JSON, strict schema. Never throws. */
export function parseKeyRetirementClosureText(raw: Uint8Array): SealTextParse<KeyRetirementClosureFile> {
  return parseStrictText(raw, MAX_CLOSURE_BYTES, closureFileSchema);
}

/**
 * `sealSha256` (contract §2): SHA-256, lowercase hex, of UTF-8(canonicalJson(full file WITH `signature`)), computed only AFTER the strict parse of
 * its version (v1 or v2). Independent of whitespace, line endings and key order on disk; `schemaVersion` is inside, so v1 and v2 never collide.
 */
export function sealSha256(file: EvidenceSealFile | EvidenceSealFileV2): string {
  const version = typeof file === 'object' && file !== null ? (file as { readonly schemaVersion?: unknown }).schemaVersion : undefined;
  const parsed = version === SEAL_SCHEMA_VERSION_V2 ? sealFileSchemaV2.safeParse(file) : version === SEAL_SCHEMA_VERSION ? sealFileSchemaV1Strict.safeParse(file) : null;
  if (!parsed?.success) throw new EvidenceSealError('SCHEMA_INVALID');
  return sha256Hex(canonicalJson(parsed.data));
}

/* ----------------------------------------------------------------------------------------- walked path B: the chain (W3.3) */

/** Total bytes of manifests (and, from W3.4, closures) read by ONE `classify` (contract §2, O7). */
export const MAX_CLASSIFY_BYTES = 16 * 1024 * 1024;

interface ReadBudget {
  remaining: number;
}
/** One position as read: its text, NOT a regular file (link, directory, FIFO…: row 8), or a read FAILURE (I/O, > 256 KiB, budget: row 7). */
type PositionRead = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'not-regular' } | { readonly kind: 'failed' } | { readonly kind: 'over-budget' };

/**
 * Reads one file at most once, without following links and within the per-file and per-`classify` limits (contract §2, §7.2). Never throws.
 * Once the budget is exceeded nothing else is read. The text comes from `FsOps.readFile` (a lossy UTF-8 decode): an invalid byte can only become
 * U+FFFD, which no ASCII-only field or JSON token accepts, so the position is SEAL_INVALID as with a strict decode.
 */
async function readPosition(ops: FsOps, file: string, budget: ReadBudget, maxBytes = MAX_SEAL_BYTES): Promise<PositionRead> {
  if (budget.remaining < 0) return { kind: 'over-budget' };
  let info: FileInfo;
  try {
    info = await ops.lstat(file);
  } catch {
    return { kind: 'failed' };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { kind: 'not-regular' }; // checked BEFORE opening: a FIFO is never opened
  if (info.size > maxBytes) return { kind: 'failed' };
  try {
    const text = await ops.readFile(file, maxBytes);
    budget.remaining -= Math.max(info.size, Buffer.byteLength(text, 'utf8'));
    return budget.remaining < 0 ? { kind: 'over-budget' } : { kind: 'text', text };
  } catch {
    return { kind: 'failed' };
  }
}

type SealPosition = { readonly version: 1; readonly file: EvidenceSealFile } | { readonly version: 2; readonly file: EvidenceSealFileV2 };

/** One position of the walked path: raw-text gate, then the strict schema of ITS version (v1 or v2); any other version is refused. */
function parseSealPositionText(raw: Uint8Array): SealTextParse<SealPosition> {
  const read = readStrictJsonText(raw, MAX_SEAL_BYTES);
  if (!read.ok) return read;
  const version = typeof read.json === 'object' && read.json !== null ? (read.json as { readonly schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === SEAL_SCHEMA_VERSION_V2) {
    const parsed = sealFileSchemaV2.safeParse(read.json);
    return parsed.success ? { ok: true, value: { version: 2, file: parsed.data } } : textRejected('SCHEMA');
  }
  if (version === SEAL_SCHEMA_VERSION) {
    const parsed = sealFileSchemaV1Strict.safeParse(read.json);
    return parsed.success ? { ok: true, value: { version: 1, file: parsed.data } } : textRejected('SCHEMA');
  }
  return textRejected('SCHEMA');
}

interface VerifiedPosition {
  readonly seq: number;
  readonly version: AcceptedSealVersion;
  readonly status: TrustKeyringEntry['status'];
  readonly file: EvidenceSealFile | EvidenceSealFileV2;
}
interface Walk {
  readonly ops: FsOps;
  /** Root of the manifests (holds `_closures/`). */
  readonly sealsDir: string;
  readonly dir: string;
  readonly sealed: ReadonlyArray<{ readonly name: string; readonly seq: number }>;
  readonly auditId: string;
  readonly evidences: readonly EvidenceToProve[];
  readonly ring: TrustKeyring;
  readonly versions: readonly AcceptedSealVersion[];
  readonly budget: ReadBudget;
  /** The latest, already read to choose the path (never read twice). */
  readonly alreadyRead?: { readonly seq: number; readonly read: PositionRead };
}

/**
 * Path B (contract §3, §4, §8 rows 4–14): EVERY `seal-0001 … seal-N` is read once and judged, in the order of the precedence table. Row 6 (the
 * revocation pre-step, W3.5) is a fail-closed PLACEHOLDER here: an authentic position of a `revoked` key gives SEAL_KEY_REVOKED right after row 8;
 * W3.5 moves it before rows 7–8 with tolerant reads and `revokedKeyIds`. Row 13 is the retirement closure (`retiredCoverage`).
 */
async function classifyWalked(walk: Walk): Promise<EvidenceTrust> {
  const ordered = [...walk.sealed].sort((a, b) => a.seq - b.seq);
  const last = ordered[ordered.length - 1];
  if (!last || ordered[0]?.seq === 0 || last.seq > MAX_CHAIN_SEALS) return unauthenticated('SEAL_CHAIN_BROKEN'); // row 4 (7a): names only, no read
  const reads: Array<{ readonly seq: number; readonly read: PositionRead }> = [];
  for (const item of ordered) reads.push({ seq: item.seq, read: walk.alreadyRead?.seq === item.seq ? walk.alreadyRead.read : await readPosition(walk.ops, path.join(walk.dir, item.name), walk.budget) }); // row 5
  if (reads.some(({ read }) => read.kind === 'failed' || read.kind === 'over-budget')) return unauthenticated('VERIFICATION_ERROR'); // row 7
  const positions = verifiedPositions(reads, walk.auditId, walk.ring);
  if (!positions) return unauthenticated('SEAL_INVALID'); // row 8
  if (positions.some((position) => position.status === 'revoked')) return unauthenticated('SEAL_KEY_REVOKED'); // row 6 placeholder (W3.5)
  const order = chainOrderVerdict(positions, walk.versions); // rows 9–12
  if (order) return order;
  const retired = await retiredCoverage(walk, positions); // row 13
  if ('verdict' in retired) return retired.verdict;
  const head = positions[positions.length - 1] as VerifiedPosition;
  // contract §7.3: distinct, sorted ids of the position keys PLUS the signers of the closures used
  const keyIds = [...new Set([...positions.map((position) => position.file.keyId), ...retired.signers])].sort();
  return coverageVerdict(head.file.entries, walk.evidences) ?? { status: 'AUTHENTICATED', headSeq: head.seq, headSealSha256: sealSha256(head.file), keyIds }; // row 14
}

/** Name of the folder of retirement closures, `<sealsDir>/_closures/<id>.json` (no `auditId` matches it, contract §6). */
const CLOSURES_DIR = '_closures';

/**
 * Row 13 (contract §6): a position of a `retired` key counts ONLY inside the closure pinned for that key, and only when the closure has a head for
 * this audit, the chain CONTAINS that head with the same `sealSha256`, and the position is a v2 at or before it. A new audit, anything after the
 * head, truncation followed by re-signing, a regression below the head, a v1 position or a key without a pinned closure ⇒ uncovered.
 * Returns the signers of the closures used (they join `keyIds`).
 */
async function retiredCoverage(walk: Walk, positions: readonly VerifiedPosition[]): Promise<{ readonly signers: readonly string[] } | { readonly verdict: EvidenceTrust }> {
  const uncovered = { verdict: unauthenticated('SEAL_KEY_RETIRED_UNCOVERED') };
  const signers: string[] = [];
  for (const keyId of new Set(positions.filter((position) => position.status === 'retired').map((position) => position.file.keyId))) {
    const closure = await pinnedClosure(walk, keyId);
    if (closure === 'over-budget') return { verdict: unauthenticated('VERIFICATION_ERROR') }; // §2: the classify budget includes closures
    const head = closure?.heads.find((candidate) => candidate.auditId === walk.auditId);
    const anchor = head ? positions[head.seq - 1] : undefined;
    if (!closure || !head || !anchor || anchor.seq !== head.seq || sealSha256(anchor.file) !== head.sealSha256) return uncovered;
    if (positions.some((position) => position.file.keyId === keyId && (position.version !== SEAL_SCHEMA_VERSION_V2 || position.seq > head.seq))) return uncovered;
    signers.push(closure.signerKeyId);
  }
  return { signers };
}

/**
 * The closure PINNED for a retired key, or null when it does not count (contract §6). `_closures` must be a real directory and the file a regular
 * one (lstat, no link), read once within the classify budget. The AUTHORITY is the pin: SHA-256 of the delivered bytes = `closureSha256`. The
 * text comes from a lossy UTF-8 decode, so its UTF-8 encoding equals the bytes on disk for every valid UTF-8 file; an invalid byte changes the
 * hash and the closure is refused. After the pin: strict schema, `retiredKeyId` = file name, and the signature as DEFENSE IN DEPTH, checked only
 * while the signer is still listed (any state): a signer removed from the list leaves the pin as the sole authority (V2-47).
 */
async function pinnedClosure(walk: Walk, keyId: string): Promise<KeyRetirementClosureFile | null | 'over-budget'> {
  const pinned = walk.ring.get(keyId)?.closureSha256;
  if (!pinned) return null;
  const dir = path.join(walk.sealsDir, CLOSURES_DIR);
  try {
    const info = await walk.ops.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
  } catch {
    return null;
  }
  const read = await readPosition(walk.ops, path.join(dir, `${keyId}.json`), walk.budget, MAX_CLOSURE_BYTES);
  if (read.kind === 'over-budget') return 'over-budget';
  if (read.kind !== 'text' || sha256Hex(read.text) !== pinned) return null; // missing, not regular, > 256 KiB, unreadable or other bytes
  const parsed = parseKeyRetirementClosureText(Buffer.from(read.text, 'utf8'));
  if (!parsed.ok || parsed.value.retiredKeyId !== keyId) return null;
  const signer = walk.ring.get(parsed.value.signerKeyId);
  return !signer || verifyKeyRetirementClosureSignature(parsed.value, signer.key) ? parsed.value : null;
}

/** Row 8 at EVERY position: a regular file, raw text and strict schema of its version, same audit, `seq` = name, key in the list, signature. */
function verifiedPositions(reads: ReadonlyArray<{ readonly seq: number; readonly read: PositionRead }>, auditId: string, ring: TrustKeyring): VerifiedPosition[] | null {
  const positions: VerifiedPosition[] = [];
  for (const { seq, read } of reads) {
    if (read.kind !== 'text') return null;
    const parsed = parseSealPositionText(Buffer.from(read.text, 'utf8'));
    if (!parsed.ok) return null;
    const { version, file } = parsed.value;
    const signer = ring.get(file.keyId); // any state: a key absent from the list is SEAL_INVALID (V2-30); the state is judged later
    if (!signer || file.auditId !== auditId || file.seq !== seq) return null;
    const { signature, ...body } = file;
    if (!verifyEd25519PureSignature(signingBytesOf(body), signature, signer.key)) return null;
    positions.push({ seq, version, status: signer.status, file });
  }
  return positions;
}

/** Rows 9–12 over the verified positions (ascending `seq`), in this order: monotony, accepted versions, continuity (gaps and links), cumulativity. */
function chainOrderVerdict(positions: readonly VerifiedPosition[], versions: readonly AcceptedSealVersion[]): EvidenceTrust | null {
  const firstV2 = positions.find((position) => position.version === SEAL_SCHEMA_VERSION_V2)?.seq;
  if (firstV2 !== undefined && positions.some((position) => position.version === SEAL_SCHEMA_VERSION && position.seq > firstV2)) return unauthenticated('SEAL_DOWNGRADE'); // row 9
  if (positions.some((position) => !versions.includes(position.version))) return unauthenticated('SEAL_VERSION_NOT_ALLOWED'); // row 10
  for (const [index, position] of positions.entries()) {
    if (position.seq !== index + 1) return unauthenticated('SEAL_CHAIN_BROKEN'); // row 11: exactly 1…N (a gap)
    const previous = positions[index - 1];
    // row 11 (7b): a v2 links to sealSha256 of its predecessor (v1 or v2); `seq` 1 ⇔ `prev` null. A v1 has no link (only v1 v1 … under [1,2]).
    if ('prevSealSha256' in position.file && position.file.prevSealSha256 !== (previous ? sealSha256(previous.file) : null)) return unauthenticated('SEAL_CHAIN_BROKEN');
  }
  for (let index = 1; index < positions.length; index += 1) {
    const attested = new Map((positions[index] as VerifiedPosition).file.entries.map((entry) => [entry.ref, entry.contentSha256]));
    if (!(positions[index - 1] as VerifiedPosition).file.entries.every((entry) => attested.get(entry.ref) === entry.contentSha256)) return unauthenticated('SEAL_NOT_CUMULATIVE'); // row 12
  }
  return null;
}

/* ----------------------------------------------------------------------------------------- v2 manifest: build / assemble / create */

export interface EvidenceSealV2Input {
  readonly auditId: string;
  readonly seq: number;
  readonly sealedAt: string;
  readonly keyId: string;
  readonly entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
  readonly dossier: { readonly id: string; readonly sha256: string };
  readonly prevSealSha256: string | null;
}

/**
 * Producer-side guard (fail-closed reading of contract §2 "`null` if and only if `seq = 1`"): build and assemble never emit an incoherent
 * `prevSealSha256`. The PARSER does not apply it: the verifier must answer SEAL_CHAIN_BROKEN for it (§3 item 3, §8 row 11, V2-11; W3.3).
 */
function withCoherentPrev(body: EvidenceSealBodyV2): EvidenceSealBodyV2 {
  if ((body.seq === 1) !== (body.prevSealSha256 === null)) throw new EvidenceSealError('SCHEMA_INVALID');
  return body;
}

/** v2 body and the exact bytes to sign. Entries sorted like v1, validated by the strict schema; no key involved. */
export function buildEvidenceSealBodyV2(input: EvidenceSealV2Input): { readonly body: EvidenceSealBodyV2; readonly signingBytes: Buffer } {
  const entries = sortedBy(input.entries.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256 })), (entry) => entry.ref);
  const candidate = { schemaVersion: SEAL_SCHEMA_VERSION_V2, kind: SEAL_KIND, auditId: input.auditId, seq: input.seq, sealedAt: input.sealedAt, keyId: input.keyId, entries, dossier: { id: input.dossier.id, sha256: input.dossier.sha256 }, prevSealSha256: input.prevSealSha256 };
  const body = withCoherentPrev(strictParse(sealBodySchemaV2, candidate));
  return { body, signingBytes: signingBytesOf(body) };
}

/**
 * K2 path: a signature produced OUTSIDE (device) over `signingBytes`. Re-validates the body, recomputes its bytes and VERIFIES them with the public
 * key before returning anything; failure ⇒ `EvidenceSealError('SIGNATURE_DOES_NOT_VERIFY')`. Never takes a private key (`PUBLIC_KEY_INVALID`).
 */
export function assembleEvidenceSealV2(body: EvidenceSealBodyV2, signature: string, publicKey: KeyObject): EvidenceSealFileV2 {
  if (!isEd25519PublicKey(publicKey)) throw new EvidenceSealError('PUBLIC_KEY_INVALID');
  const checked = withCoherentPrev(strictParse(sealBodySchemaV2, body));
  if (!verifyEd25519PureSignature(signingBytesOf(checked), signature, publicKey)) throw new EvidenceSealError('SIGNATURE_DOES_NOT_VERIFY');
  return strictParse(sealFileSchemaV2, { ...checked, signature });
}

/** K1 path: build + `crypto.sign(null, …)` + assemble. Same key and body ⇒ bit for bit the file of the external path (Ed25519 is deterministic). */
export function createEvidenceSealV2(input: EvidenceSealV2Input & { readonly privateKey: KeyObject }): EvidenceSealFileV2 {
  const { body, signingBytes } = buildEvidenceSealBodyV2(input);
  return assembleEvidenceSealV2(body, b64url(cryptoSign(null, signingBytes, input.privateKey)), createPublicKey(input.privateKey));
}

/* ----------------------------------------------------------------------------------------- retirement closure: build / assemble / create */

export interface KeyRetirementClosureInput {
  readonly retiredKeyId: string;
  readonly signerKeyId: string;
  readonly sealedAt: string;
  readonly heads: ReadonlyArray<{ readonly auditId: string; readonly seq: number; readonly sealSha256: string }>;
}

/** Closure body and the exact bytes to sign. Heads sorted by `auditId`, validated by the strict schema; no key involved. */
export function buildKeyRetirementClosureBody(input: KeyRetirementClosureInput): { readonly body: KeyRetirementClosureBody; readonly signingBytes: Buffer } {
  const heads = sortedBy(input.heads.map((head) => ({ auditId: head.auditId, seq: head.seq, sealSha256: head.sealSha256 })), (head) => head.auditId);
  const body = strictParse(closureBodySchema, { schemaVersion: CLOSURE_SCHEMA_VERSION, kind: CLOSURE_KIND, retiredKeyId: input.retiredKeyId, signerKeyId: input.signerKeyId, sealedAt: input.sealedAt, heads });
  return { body, signingBytes: signingBytesOf(body) };
}

/** External signature over the closure bytes, verified before anything is returned (same contract as `assembleEvidenceSealV2`). */
export function assembleKeyRetirementClosure(body: KeyRetirementClosureBody, signature: string, publicKey: KeyObject): KeyRetirementClosureFile {
  if (!isEd25519PublicKey(publicKey)) throw new EvidenceSealError('PUBLIC_KEY_INVALID');
  const checked = strictParse(closureBodySchema, body);
  if (!verifyEd25519PureSignature(signingBytesOf(checked), signature, publicKey)) throw new EvidenceSealError('SIGNATURE_DOES_NOT_VERIFY');
  return strictParse(closureFileSchema, { ...checked, signature });
}

/** K1 path for the closure: build + `crypto.sign(null, …)` + assemble. */
export function createKeyRetirementClosure(input: KeyRetirementClosureInput & { readonly privateKey: KeyObject }): KeyRetirementClosureFile {
  const { body, signingBytes } = buildKeyRetirementClosureBody(input);
  return assembleKeyRetirementClosure(body, b64url(cryptoSign(null, signingBytes, input.privateKey)), createPublicKey(input.privateKey));
}
