import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../link-audit/canonical';
import { nodeFsOps, type FsOps } from '../link-audit/snapshot-store';
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
  | 'VERIFICATION_ERROR';

export type EvidenceTrust =
  | { readonly status: 'AUTHENTICATED' }
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

export interface SealedEvidenceOptions {
  /** Pasta DOS MANIFESTOS (somente leitura para o web; NUNCA a pasta de evidências nem aninhada nela). */
  readonly sealsDir: string;
  readonly trustedKeys: ReadonlyMap<string, KeyObject>;
  readonly fs?: FsOps;
  /** Outras pastas (evidências, decisões, recibos, resultados): a de manifestos não pode ser nenhuma delas nem estar aninhada (considera link simbólico). */
  readonly otherDirs?: readonly string[];
}

/** Política que só autentica o que um manifesto ASSINADO por uma chave de confiança cobre, com os MESMOS hashes. */
export function createSealedEvidenceProvenance(options: SealedEvidenceOptions): EvidenceProvenancePolicy {
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
        const parsed = sealFileSchema.safeParse(JSON.parse(await ops.readFile(path.join(dir, latest.name), MAX_SEAL_BYTES)));
        if (!parsed.success) return unauthenticated('SEAL_INVALID');
        const { signature, ...body } = parsed.data;
        const key = options.trustedKeys.get(body.keyId);
        if (!key || body.auditId !== auditId || body.seq !== latest.seq) return unauthenticated('SEAL_INVALID');
        const refs = body.entries.map((entry) => entry.ref);
        if (new Set(refs).size !== refs.length || refs.some((ref, index) => index > 0 && (refs[index - 1] as string) >= ref)) return unauthenticated('SEAL_INVALID'); // ordenado e sem repetição
        if (!cryptoVerify(null, Buffer.from(canonicalJson(body), 'utf8'), key, Buffer.from(signature, 'base64url'))) return unauthenticated('SEAL_INVALID');
        const byRef = new Map(body.entries.map((entry) => [entry.ref, entry.contentSha256]));
        // (1) base ⊆ manifesto: tudo que é usado está atestado, com o MESMO hash
        for (const evidence of evidences) {
          const attested = byRef.get(evidence.ref);
          if (attested === undefined) return unauthenticated('EVIDENCE_NOT_SEALED');
          if (attested !== evidence.contentSha256) return unauthenticated('EVIDENCE_HASH_MISMATCH');
        }
        // (2) manifesto ⊆ base: nada que foi atestado pode ter DESAPARECIDO. Sem isto, apagar a captura mais recente faria uma captura antiga voltar a ser a "situação atual"
        // ainda autêntica (R3-MINOR-1). O manifesto é cumulativo: ele define o conjunto exato de capturas, relatórios e artefatos cobertos.
        const present = new Set(evidences.map((evidence) => evidence.ref));
        const missing = body.entries.map((entry) => entry.ref).filter((ref) => !present.has(ref));
        if (missing.length > 0) return { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: missing.slice(0, 5) };
        return { status: 'AUTHENTICATED' };
      } catch {
        return unauthenticated('VERIFICATION_ERROR');
      }
    },
  };
}

/**
 * Política a partir da CONFIGURAÇÃO do servidor (variáveis lidas por quem chama): pasta de manifestos + chaves públicas de confiança. Faltando
 * qualquer uma, ou chave malformada, a política é a FECHADA. Não existe valor que "confie em tudo".
 */
export function evidenceProvenanceFromConfig(config: { readonly sealsDir: string | null; readonly trustKeys: string | undefined; readonly otherDirs?: ReadonlyArray<string | null | undefined> }, fsOps?: FsOps): EvidenceProvenancePolicy {
  const keys = parseTrustKeys(config.trustKeys);
  if (!config.sealsDir || !keys) return CLOSED_EVIDENCE_PROVENANCE;
  // os manifestos NÃO podem morar em nenhuma outra pasta de dados (nem elas dentro deles): quem escreve lá não pode tocar na prova (nem para apagá-la).
  // Duas camadas: léxica aqui (já na configuração) e por caminho REAL (links simbólicos) a cada verificação.
  const others = (config.otherDirs ?? []).filter((dir): dir is string => typeof dir === 'string' && dir !== '');
  const a = path.resolve(config.sealsDir).toLowerCase();
  for (const dir of others) {
    const b = path.resolve(dir).toLowerCase();
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) return CLOSED_EVIDENCE_PROVENANCE;
  }
  return createSealedEvidenceProvenance({ sealsDir: config.sealsDir, trustedKeys: keys, otherDirs: others, ...(fsOps ? { fs: fsOps } : {}) });
}
