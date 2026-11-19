import { createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import path from 'node:path';
import type { FileInfo, FsOps } from '../link-audit/snapshot-store';
import {
  assembleEvidenceSealV2,
  buildEvidenceSealBodyV2,
  createSealedEvidenceProvenance,
  MAX_CLOSURE_BYTES,
  MAX_SEAL_BYTES,
  parseEvidenceSealV2Text,
  parseTrustKeyring,
  SEAL_FILE,
  type EvidenceSealBodyV2,
  type EvidenceSealFileV2,
  type EvidenceToProve,
} from '../link-audit-evidence/provenance';
import { auditId as auditIdSchema } from './schemas';
import { runSignCore, type SealChainFacts, type SignCoreDeps, type SignCoreInput, type SignCoreResult, type SignPlan, type SignRefusal } from './sign-core';

/*
 * P1 W4.2 — a CADEIA e o MANIFESTO do `sign` (spec §5.5 passos 7 e 13; §5.5.1 item 2; §7.1; contrato do verificador v2 §2–§6). Único arquivo do
 * `sign` que importa o verificador: o núcleo (`sign-core.ts`) recebe daqui só FATOS estruturais (§5.5.1 item 7; o artefato único separa o núcleo
 * do verificador na W4.6). Disco SÓ pelo `FsOps` injetado e só leitura; a gravação (temporário + `link()` exclusivo) é da W4.3, a chave real e o
 * CLI da W4.4, o autoteste da W4.5.
 *
 * A cadeia é verificada pelo VERIFICADOR v2 REAL em modo produção: a lista de chaves com estado (`--trust-keys`, `parseTrustKeyring`), os fechos
 * de `<seals-dir>/_closures/` e `acceptedVersions: [2]`, com as evidências = entradas da própria cabeça (prova formato, cadeia, estados e fechos;
 * a coerência com a pasta de evidências é do `export` e da verificação pós-entrega, §5.5 passo 14). Cada arquivo é lido do disco UMA vez: a
 * cabeça que dá `entries`/`sealedAt` e a que o verificador julga são os MESMOS bytes, e `seq`/`prevSealSha256` saem do que ele autenticou.
 */

/** Código fixo de uma cadeia que não serve para assinar por cima: as razões do verificador v2 (`EvidenceTrustReason`) e estas, do próprio `sign`. */
type SignChainReason = 'AUDIT_ID_INVALID' | 'PROOF_NOT_CONFIGURED' | 'SEALS_DIR_UNREADABLE' | 'SEAL_NAME_CASE_VARIANT' | 'SEAL_INVALID' | 'VERIFICATION_ERROR' | 'HEAD_NOT_V2_PATH';
const invalid = (reason: string): SealChainFacts => ({ status: 'INVALID', reason });
const EMPTY: SealChainFacts = { status: 'EMPTY' };
const reason = (code: SignChainReason): SealChainFacts => invalid(code);

/** O mesmo nome que `SEAL_FILE`, sem diferenciar caixa: `SEAL-0002.json`/`seal-0002.JSON` colidiriam num disco que ignora a caixa (§7.1). */
const SEAL_FILE_ANY_CASE = new RegExp(SEAL_FILE.source, 'i');
const MAX_SNAPSHOT_BYTES = Math.max(MAX_SEAL_BYTES, MAX_CLOSURE_BYTES);
/** Só para escolher o caminho do verificador quando a cabeça nem é um `v2` legível: nunca autentica nada (a cabeça já é recusa). */
const PLACEHOLDER_EVIDENCE: readonly EvidenceToProve[] = [{ ref: 'capture:c0001', contentSha256: '0'.repeat(64), legacy: false }];

export interface SealChainInput {
  /** `--seals-dir`: a cópia da estação; tem de existir como diretório (inexistente = provável erro de digitação, nunca "sem manifesto"). */
  readonly sealsDir: string;
  /** `--audit` (já no padrão; se não estiver, nada é lido). */
  readonly auditId: string;
  /** `--trust-keys`: a lista com estado do contrato v2 (§5). Inválida ⇒ a política é fechada, mesmo com a pasta vazia. */
  readonly trustKeys: string;
}

/**
 * Lê e verifica `<seals-dir>/<auditId>/` (passo 7). `EMPTY` só para a subpasta AUSENTE (ENOENT) ou sem nenhum `seal-NNNN.json`; `VERIFIED` com a
 * cabeça que o verificador v2 autenticou; qualquer outra coisa ⇒ `INVALID` com código fixo. Nunca lança e nunca escreve.
 */
export async function readSealChain(input: SealChainInput, deps: { readonly fs: FsOps }): Promise<SealChainFacts> {
  try {
    if (!auditIdSchema.safeParse(input.auditId).success) return reason('AUDIT_ID_INVALID'); // nunca vira caminho
    const keyring = parseTrustKeyring(input.trustKeys);
    if (!keyring) return reason('PROOF_NOT_CONFIGURED');
    const ops = readOnceSnapshot(deps.fs);
    const root = await sealsRoot(ops, input.sealsDir);
    if (root === null) return reason('SEALS_DIR_UNREADABLE');
    const dir = path.join(root, input.auditId);
    const listed = await listSeals(ops, dir);
    if ('status' in listed) return listed;
    const head = await readHead(ops, path.join(dir, listed.headName));
    // `sealsDir: root` ⇒ o verificador monta os MESMOS caminhos que esta leitura (e lê pela mesma fotografia)
    const verdict = await createSealedEvidenceProvenance({ sealsDir: root, keyring, acceptedVersions: [2], fs: ops }).classify(input.auditId, head ? evidencesOf(head) : PLACEHOLDER_EVIDENCE);
    if (verdict.status !== 'AUTHENTICATED') return invalid(verdict.reason);
    if (head === null) return reason('SEAL_INVALID'); // inalcançável pelo verificador real; falha fechada
    if (!('headSeq' in verdict)) return reason('HEAD_NOT_V2_PATH'); // com [2] o verificador sempre percorre a cadeia (contrato §8-B)
    return { status: 'VERIFIED', last: { auditId: head.auditId, seq: verdict.headSeq, sealSha256: verdict.headSealSha256, sealedAt: head.sealedAt, entries: head.entries } };
  } catch {
    return reason('VERIFICATION_ERROR');
  }
}

const evidencesOf = (head: EvidenceSealFileV2): EvidenceToProve[] => head.entries.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256, legacy: false }));
const errorCode = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined);

/** Raiz da cópia da estação pelo caminho real (como o `delta` do `export`); `null` se não existe ou não é diretório. */
async function sealsRoot(ops: FsOps, sealsDir: string): Promise<string | null> {
  try {
    const real = await ops.realpath(path.resolve(sealsDir));
    return (await ops.lstat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Os `seal-NNNN.json` da subpasta (sem seguir link). ENOENT ⇒ `EMPTY`; outro erro, link, não diretório ou nome em outra caixa ⇒ `INVALID`. */
async function listSeals(ops: FsOps, dir: string): Promise<{ readonly headName: string } | SealChainFacts> {
  let info: FileInfo;
  try {
    info = await ops.lstat(dir);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? EMPTY : reason('VERIFICATION_ERROR'); // EACCES/EIO nunca viram "sem manifesto"
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return reason('SEAL_INVALID');
  const names = await ops.readdir(dir);
  if (names.some((name) => SEAL_FILE_ANY_CASE.test(name) && !SEAL_FILE.test(name))) return reason('SEAL_NAME_CASE_VARIANT');
  const seals = names.flatMap((name) => {
    const match = SEAL_FILE.exec(name);
    return match ? [{ name, seq: Number(match[1]) }] : [];
  });
  if (seals.length === 0) return EMPTY;
  return { headName: seals.reduce((best, item) => (item.seq > best.seq ? item : best)).name };
}

/** A cabeça como `v2` estrito (o mesmo parser do verificador), de um arquivo comum até 256 KiB. `null` se não é isso (o verificador dá o porquê). */
async function readHead(ops: FsOps, file: string): Promise<EvidenceSealFileV2 | null> {
  try {
    const info = await ops.lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SEAL_BYTES) return null;
    const parsed = parseEvidenceSealV2Text(Buffer.from(await ops.readFile(file, MAX_SEAL_BYTES), 'utf8'));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

const READ_ONLY = async (): Promise<never> => {
  throw Object.assign(new Error('a leitura da cadeia do sign é somente leitura'), { code: 'EROFS' });
};

/**
 * Fotografia SOMENTE LEITURA do `FsOps` injetado: cada consulta (lstat, readdir, realpath, readFile) chega ao disco no máximo UMA vez e a resposta
 * (ou a falha) é reaproveitada. Assim a cabeça que esta leitura analisa e a que o verificador julga são os mesmos bytes (sem corrida entre as duas
 * leituras) e cada manifesto é lido uma única vez. `readFile` respeita o limite pedido por quem chama, como o original.
 */
function readOnceSnapshot(ops: FsOps): FsOps {
  const seen = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const cached = seen.get(key) as Promise<T> | undefined;
    if (cached) return cached;
    const loaded = load();
    seen.set(key, loaded);
    return loaded;
  };
  return {
    lstat: (target) => once(`lstat:${target}`, () => ops.lstat(target)),
    readdir: (dir) => once(`readdir:${dir}`, () => ops.readdir(dir)),
    realpath: (target) => once(`realpath:${target}`, () => ops.realpath(target)),
    readFile: async (target, maxBytes) => {
      const text = await once(`readFile:${target}`, () => ops.readFile(target, MAX_SNAPSHOT_BYTES));
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Object.assign(new Error(`excede ${maxBytes} bytes`), { code: 'ETOOBIG' });
      return text;
    },
    mkdir: READ_ONLY,
    writeExclusive: READ_ONLY,
    link: READ_ONLY,
    unlink: READ_ONLY,
    chmod: READ_ONLY,
    syncDirectory: READ_ONLY,
  };
}

/* ------------------------------------------------------------------------------------------------------------------- passos 1–10 com a cadeia */

export interface SignWithChainInput extends Omit<SignCoreInput, 'chain'> {
  readonly sealsDir: string;
  readonly trustKeys: string;
}
export interface SignWithChainDeps<K> extends SignCoreDeps<K> {
  /** Leitura da cópia da estação (nunca escreve). */
  readonly fs: FsOps;
}

/** A cadeia é lida e verificada ANTES, e julgada pelo núcleo na posição do passo 7: as recusas dos passos 1–6 continuam vindo primeiro. */
export async function runSignWithChain<K>(input: SignWithChainInput, deps: SignWithChainDeps<K>): Promise<SignCoreResult<K>> {
  const { sealsDir, trustKeys, ...core } = input;
  const chain = await readSealChain({ sealsDir, auditId: core.auditId, trustKeys }, { fs: deps.fs });
  return runSignCore({ ...core, chain }, { now: deps.now, openKey: deps.openKey });
}

/* ------------------------------------------------------------------------------------------------------------------- passo 13: corpo e assinatura */

export type SealBodyResult = { readonly ok: true; readonly body: EvidenceSealBodyV2; readonly signingBytes: Buffer } | SignRefusal;
export type SignedSealResult = { readonly ok: true; readonly seal: EvidenceSealFileV2 } | SignRefusal;

const BODY_FAILED: SignRefusal = { ok: false, code: 'UNEXPECTED', message: 'Não foi possível montar o corpo do manifesto v2 a partir do plano (plano ou --key-id fora de forma). Nada foi assinado.' };
const SIGN_FAILED: SignRefusal = { ok: false, code: 'UNEXPECTED', message: 'Falha ao assinar o manifesto. Nada foi assinado.' };

/** Estritamente crescente por `ref` (unidades de código, como o verificador): ordenado E sem repetição. */
const isStrictlyOrdered = (entries: SignPlan['entries']): boolean => entries.every((entry, index) => index === 0 || (entries[index - 1] as { readonly ref: string }).ref < entry.ref);

/**
 * Corpo `v2` (contrato §2) a partir do plano: `entries` = EXATAMENTE as do pacote lido, já ordenadas e sem repetição (um plano fora disso é recusado,
 * nunca reordenado ou deduplicado em silêncio), `seq`/`prevSealSha256` da cadeia verificada, `dossier` dos bytes lidos e o `--key-id`. Sem chave.
 */
export function buildSealManifestBody(plan: SignPlan, keyId: string): SealBodyResult {
  if (!isStrictlyOrdered(plan.entries)) return BODY_FAILED;
  try {
    const { body, signingBytes } = buildEvidenceSealBodyV2({ auditId: plan.auditId, seq: plan.seq, sealedAt: plan.sealedAt, keyId, entries: plan.entries, dossier: plan.dossier, prevSealSha256: plan.prevSealSha256 });
    return { ok: true, body, signingBytes };
  } catch {
    return BODY_FAILED; // EvidenceSealError tipado do construtor do verificador (esquema estrito, `prev` incoerente com `seq`)
  }
}

/**
 * Assina o corpo (Ed25519 puro, `crypto.sign(null, …)`) e monta o arquivo, que o verificador CONFERE com a pública derivada antes de devolver
 * (`assembleEvidenceSealV2`). Nesta fatia a chave é só a de teste (ida e volta); a abertura da chave real é da W4.4. Qualquer falha ⇒ mensagem
 * fixa: o objeto de erro nunca sai daqui (pode carregar material da chave, RS-13).
 */
export function signSealManifest(plan: SignPlan, keyId: string, privateKey: KeyObject): SignedSealResult {
  const built = buildSealManifestBody(plan, keyId);
  if (!built.ok) return built;
  try {
    const signature = cryptoSign(null, built.signingBytes, privateKey).toString('base64url');
    return { ok: true, seal: assembleEvidenceSealV2(built.body, signature, createPublicKey(privateKey)) };
  } catch {
    return SIGN_FAILED;
  }
}

/** Nome do arquivo = `seq` ASSINADO (`seal-NNNN.json`, o que `SEAL_FILE` casa e o verificador confere contra o corpo). */
export const sealFileName = (seal: { readonly seq: number }): string => `seal-${String(seal.seq).padStart(4, '0')}.json`;
