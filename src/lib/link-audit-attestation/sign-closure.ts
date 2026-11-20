import { createHash, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { errorCode, type BytesFsOps, type FileInfo, type FsOps } from '../link-audit/snapshot-store';
import {
  assembleKeyRetirementClosure,
  buildKeyRetirementClosureBody,
  createSealedEvidenceProvenance,
  MAX_CLOSURE_BYTES,
  MAX_CLOSURE_HEADS,
  MAX_SEAL_BYTES,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  parseTrustKeyring,
  SEAL_FILE,
  sealSha256,
  verifyEvidenceSealV2Signature,
  verifyKeyRetirementClosureSignature,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type TrustKeyring,
} from '../link-audit-evidence/provenance';
import { auditId as auditIdSchema, shortLabel } from './schemas';
import { chainSnapshot, isTrustKeyringText, keyMismatchRefusal, resolveSealsRoot, SIGN_KEY_ID_PATTERN, withVirtualFile } from './sign-chain';
import type { CloseConfirmationFacts, SignRefusal, SignRefusalCode } from './sign-core';
import { closureHeads, readReceipts, type ClosureHead, type ClosureHeadsResult, type ServerAuditFacts, type ServerPositionFacts } from './sign-receipts';
import { CLOSURES_DIR, publishClosure } from './sign-run';

/*
 * P1 W4.5 — o comando de FECHO `close-key` (spec §5.5.1 item 9; contrato do verificador v2 §6, inclusive o "Procedimento"; V2-46). Fecha a chave
 * aposentada R com um fecho assinado pela chave ATIVA S ≠ R, gravado em `<seals-dir>/_closures/<R>.json`; o runbook fixa na lista o SHA-256 desses
 * bytes (`R:<pública>:retired:<closureSha256>`), e sem essa fixação R não conta. Ordem (cada recusa: nada assinado nem gravado; a chave só depois de
 * todas as que não precisam dela, como no `sign`):
 *   argumentos → estado de R (presente, não revogada) e de S (ativa) na lista → raiz da cópia do servidor → recibos (registro externo,
 *   `sign-receipts.ts`) → varredura SOMENTE LEITURA da cópia (uma fotografia, a mesma do autoteste) → `_closures/<R>.json` ainda inexistente →
 *   cabeças (`closureHeads`) → relógio → confirmação humana (porta `confirm`: o custodiante digita o id de R, que a tela não mostra) → chave
 *   (porta `openKey`, K1 da W4.4) e `SIGN_KEY_MISMATCH` → fecho montado e assinado → AUTOTESTE (o fecho e cada cadeia coberta pelo verificador v2
 *   real com R `retired:<closureSha256>`, `acceptedVersions: [2]`) → gravação exclusiva (`publishClosure`, `sign-run.ts`).
 * Segundo e último arquivo do `sign` que importa o verificador (a W4.6 separa o núcleo dele do `FsOps` de disco). Nunca escreve por conta própria.
 */

const MAX_SERVER_AUDITS = 10_000;
/** Teto do que a varredura lê da cópia do servidor (manifestos); a fotografia os guarda em memória para o autoteste. */
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const SEAL_FILE_ANY_CASE = new RegExp(SEAL_FILE.source, 'i');
const PLACEHOLDER_EVIDENCE: readonly EvidenceToProve[] = [{ ref: 'capture:c0001', contentSha256: '0'.repeat(64), legacy: false }];
const NOTHING = 'Nada foi assinado nem gravado.';
const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message });
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CloseKeyInput {
  /** `--retired-key-id` (R). */
  readonly retiredKeyId: string;
  /** `--key-id` (S): ativa na lista e diferente de R. */
  readonly signerKeyId: string;
  /** `--seals-dir`: a cópia do servidor na estação (o fecho é gravado em `_closures/` dela). */
  readonly sealsDir: string;
  /** `--receipts-dir`: o registro externo (recibos do passo 16). */
  readonly receiptsDir: string;
  /** `--trust-keys`: a lista com estado (contrato v2 §5). */
  readonly trustKeys: string;
  /** `--custodian`: rótulo de quem assina o fecho (vai só para o resumo). */
  readonly custodian: string;
}
export interface CloseKeyDeps {
  /** Leitura dos recibos (bytes), da cópia do servidor, e a gravação de `_closures/<R>.json`. */
  readonly fs: BytesFsOps;
  /** Relógio injetado (`sealedAt` do fecho, informativo). */
  readonly now: () => Date;
  /** Confirmação humana: devolve o que o custodiante digitou, comparado EXATAMENTE com o id de R. Lançar é recusa. */
  readonly confirm: (facts: CloseConfirmationFacts) => Promise<string>;
  /** Leitor da chave S (K1, W4.4): a chave aberta ou a recusa da abertura. Chamado no máximo uma vez, depois da confirmação. */
  readonly openKey: () => KeyObject | SignRefusal | Promise<KeyObject | SignRefusal>;
  /** Só para teste: o sufixo do temporário. */
  readonly tempSuffix?: () => string;
}
export interface CloseKeyDone extends ClosureHeadsResult {
  readonly ok: true;
  readonly retiredKeyId: string;
  readonly signerKeyId: string;
  readonly custodian: string;
  readonly sealedAt: string;
  /** SHA-256 dos BYTES gravados: o hash que o runbook fixa na lista (§6). */
  readonly closureSha256: string;
  /** `_closures/<R>.json`, relativo à pasta de manifestos (a saída nunca leva o caminho de disco). */
  readonly fileName: string;
  /** Caminho real gravado; não vai para a saída. */
  readonly file: string;
  /** O item da lista a fixar: `R:<pública>:retired:<closureSha256>`. */
  readonly pinnedTrustKey: string;
}
export type CloseKeyResult = CloseKeyDone | SignRefusal;

/* ------------------------------------------------------------------------------------------------------------------- argumentos e estados */

const usage = (message: string): SignRefusal => refuse('USAGE', `${message} ${NOTHING}`);
const isPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');

/** Defesa na fronteira (o analisador do CLI faz o mesmo antes): ids no padrão, S ≠ R, lista com estado, rótulo curto e caminhos. */
function closeUsageRefusal(input: CloseKeyInput): SignRefusal | null {
  if (typeof input.retiredKeyId !== 'string' || !SIGN_KEY_ID_PATTERN.test(input.retiredKeyId)) return usage('--retired-key-id inválido (minúsculas, dígitos e "-", 4 a 32 caracteres).');
  if (typeof input.signerKeyId !== 'string' || !SIGN_KEY_ID_PATTERN.test(input.signerKeyId)) return usage('--key-id inválido (minúsculas, dígitos e "-", 4 a 32 caracteres).');
  if (input.signerKeyId === input.retiredKeyId) return usage('--key-id igual a --retired-key-id: uma chave nunca fecha a si mesma (contrato v2 §6).');
  if (!isTrustKeyringText(input.trustKeys)) return usage('--trust-keys fora do formato da lista com estado.');
  if (!shortLabel.safeParse(input.custodian).success) return usage('--custodian deve ser um rótulo curto (iniciais ou ID), sem e-mail nem telefone.');
  if (!isPath(input.sealsDir) || !isPath(input.receiptsDir)) return usage('Informe --seals-dir e --receipts-dir.');
  return null;
}

/** R presente e não revogada (dúvida ⇒ revoked, nunca retired); S ativa. Precisa só da lista: vem antes de qualquer leitura. */
function keyStateRefusal(ring: TrustKeyring, input: CloseKeyInput): SignRefusal | null {
  const retired = ring.get(input.retiredKeyId);
  if (!retired) return refuse('CLOSE_KEY_STATE_INVALID', `A chave a aposentar não está na lista --trust-keys (sem a pública dela não há o que conferir nem fixar). ${NOTHING}`);
  if (retired.status === 'revoked') return refuse('CLOSE_KEY_STATE_INVALID', `A chave a aposentar está REVOGADA na lista: uma chave revogada nunca é fechada (qualquer dúvida ⇒ revoked, nunca retired; contrato v2 §6). ${NOTHING}`);
  const signer = ring.get(input.signerKeyId)?.status ?? 'absent';
  if (signer !== 'active') return refuse('SIGN_KEY_NOT_ACTIVE', `A chave de --key-id ${signer === 'absent' ? 'não está na lista --trust-keys' : `está ${signer} na lista --trust-keys`}: só uma chave ATIVA assina o fecho. ${NOTHING}`);
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------- varredura da cópia do servidor */

const copyInvalid = (why: string, reason?: string): SignRefusal => ({ ...refuse('CLOSE_SERVER_COPY_INVALID', `Cópia do servidor (--seals-dir): ${why}. ${NOTHING}`), ...(reason ? { chainReason: reason } : {}) });
const COPY_IO = copyInvalid('erro de E/S ou permissão ao ler; a varredura não é confiável', 'VERIFICATION_ERROR');

interface ScannedPosition extends ServerPositionFacts {
  /** O manifesto v2 estrito desta auditoria e deste seq (qualquer chave), ou `null`. */
  readonly seal: EvidenceSealFileV2 | null;
}
interface ScannedAudit extends ServerAuditFacts {
  readonly positions: readonly ScannedPosition[];
}
interface ScanBudget {
  remaining: number;
}

/** `keyId` declarado por um texto qualquer (leniente, só para achar posições de R): nunca autentica nada. */
function declaredKeyIdOf(text: string): string | null {
  try {
    const json = JSON.parse(text) as unknown;
    const keyId = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as { readonly keyId?: unknown }).keyId : undefined;
    return typeof keyId === 'string' ? keyId : null;
  } catch {
    return null;
  }
}

/** Uma posição: arquivo comum até 256 KiB (sem seguir link), lido UMA vez pela fotografia; o que ele declara e, se for de R, o seu `sealSha256`. */
async function scanPosition(ops: FsOps, file: string, where: { readonly auditId: string; readonly seq: number }, retired: { readonly keyId: string; readonly key: KeyObject }, budget: ScanBudget): Promise<ScannedPosition | SignRefusal> {
  const unreadable: ScannedPosition = { seq: where.seq, declaredKeyId: null, retiredSealSha256: null, seal: null };
  const info: FileInfo = await ops.lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SEAL_BYTES) return unreadable;
  budget.remaining -= info.size;
  if (budget.remaining < 0) return copyInvalid(`acima de ${MAX_SCAN_BYTES} bytes de manifestos`, 'SCAN_BUDGET');
  const text = await ops.readFile(file, MAX_SEAL_BYTES);
  const parsed = parseEvidenceSealV2Text(Buffer.from(text, 'utf8'));
  const seal = parsed.ok && parsed.value.auditId === where.auditId && parsed.value.seq === where.seq ? parsed.value : null;
  const byRetired = seal !== null && seal.keyId === retired.keyId && verifyEvidenceSealV2Signature(seal, retired.key);
  return { seq: where.seq, declaredKeyId: declaredKeyIdOf(text), retiredSealSha256: byRetired ? sealSha256(seal) : null, seal };
}

/** Uma subpasta de auditoria: link ou não diretório ⇒ sem posições legíveis; nome de manifesto em outra caixa ⇒ recusa (como no `sign`, §7.1). */
async function scanAudit(ops: FsOps, root: string, auditId: string, retired: { readonly keyId: string; readonly key: KeyObject }, budget: ScanBudget): Promise<ScannedAudit | SignRefusal> {
  const dir = path.join(root, auditId);
  const info = await ops.lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) return { auditId, positions: [] };
  const names = await ops.readdir(dir);
  if (names.some((name) => SEAL_FILE_ANY_CASE.test(name) && !SEAL_FILE.test(name))) return copyInvalid(`nome de manifesto em outra caixa na auditoria ${auditId} (colidiria num disco que ignora a caixa)`, 'SEAL_NAME_CASE_VARIANT');
  const seqs = names.flatMap((name) => (SEAL_FILE.test(name) ? [Number(SEAL_FILE.exec(name)?.[1])] : [])).sort((a, b) => a - b);
  const positions: ScannedPosition[] = [];
  for (const seq of seqs) {
    const position = await scanPosition(ops, path.join(dir, `seal-${String(seq).padStart(4, '0')}.json`), { auditId, seq }, retired, budget);
    if ('code' in position) return position;
    positions.push(position);
  }
  return { auditId, positions };
}

/**
 * TODA a cópia do servidor, somente leitura, pela fotografia (cada arquivo lido uma vez; o autoteste reusa os mesmos bytes): cada subpasta com nome
 * de auditoria (`_closures` e outros nomes ficam de fora, como no verificador) e cada `seal-NNNN.json` dela. Erro de E/S ⇒ recusa: uma varredura
 * parcial poderia esconder uma posição de R.
 */
async function scanServerCopy(ops: FsOps, root: string, retired: { readonly keyId: string; readonly key: KeyObject }): Promise<readonly ScannedAudit[] | SignRefusal> {
  try {
    const auditIds = (await ops.readdir(root)).filter((name) => auditIdSchema.safeParse(name).success).sort();
    if (auditIds.length > MAX_SERVER_AUDITS) return copyInvalid(`mais de ${MAX_SERVER_AUDITS} auditorias`, 'TOO_MANY_AUDITS');
    const budget: ScanBudget = { remaining: MAX_SCAN_BYTES };
    const audits: ScannedAudit[] = [];
    for (const auditId of auditIds) {
      const audit = await scanAudit(ops, root, auditId, retired, budget);
      if ('code' in audit) return audit;
      audits.push(audit);
    }
    return audits;
  } catch {
    return COPY_IO;
  }
}

/** `_closures/` é diretório real (ou ausente) e ainda não tem `<R>.json` (criação exclusiva; reemissão só pelo runbook). */
async function closuresRefusal(ops: FsOps, root: string, retiredKeyId: string): Promise<SignRefusal | null> {
  const dir = path.join(root, CLOSURES_DIR);
  let info: FileInfo;
  try {
    info = await ops.lstat(dir);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? null : COPY_IO;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return copyInvalid(`${CLOSURES_DIR} não é um diretório comum (link simbólico ou arquivo)`, 'CLOSURES_DIR_INVALID');
  let names: readonly string[];
  try {
    names = await ops.readdir(dir);
  } catch {
    return COPY_IO;
  }
  if (!names.includes(`${retiredKeyId}.json`)) return null;
  return refuse('CLOSE_ALREADY_EXISTS', `${CLOSURES_DIR}/${retiredKeyId}.json já existe na cópia do servidor: o fecho é de criação exclusiva e nunca sobrescreve. Reemissão só pelo runbook (conferir, refixar o hash). ${NOTHING}`);
}

/* ------------------------------------------------------------------------------------------------------------------- relógio, confirmação e chave */

const lastSealOf = (audit: ScannedAudit | undefined): EvidenceSealFileV2 | null => audit?.positions.at(-1)?.seal ?? null;

/** `sealedAt` (relógio injetado) ≥ o `sealedAt` da cabeça e do último manifesto de cada auditoria coberta (como o passo 10 do `sign`). */
function closureInstant(now: () => Date, heads: readonly ClosureHead[], audits: ReadonlyMap<string, ScannedAudit>): { readonly ok: true; readonly sealedAt: string } | SignRefusal {
  const instant = now();
  const sealedAt = Number.isFinite(instant.getTime()) ? instant.toISOString() : '';
  if (sealedAt === '') return refuse('UNEXPECTED', 'Relógio inválido.');
  const seen = heads.flatMap((head) => {
    const audit = audits.get(head.auditId);
    return [audit?.positions.find((position) => position.seq === head.seq)?.seal, lastSealOf(audit)].flatMap((seal) => (seal ? [seal.sealedAt] : []));
  });
  if (seen.some((at) => sealedAt < at)) return refuse('SIGN_CLOCK_REGRESSION', `O relógio desta estação está antes de um manifesto coberto pelo fecho; confira o relógio. ${NOTHING}`);
  return { ok: true, sealedAt };
}

const CONFIRMATION_MISMATCH = `O texto digitado não confere com o id da chave a aposentar (conforme o registro de rotação). ${NOTHING}`;
const CONFIRMATION_UNAVAILABLE = `A confirmação humana não foi obtida (sem terminal interativo, entrada interrompida ou falha da tela). ${NOTHING}`;

/** O custodiante digita o id de R (a tela mostra S e as contagens, nunca R); comparação exata. Porta que lança ⇒ recusa, sem o objeto de erro. */
async function confirmationRefusal(confirm: CloseKeyDeps['confirm'], facts: CloseConfirmationFacts, retiredKeyId: string): Promise<SignRefusal | null> {
  let typed: unknown;
  try {
    typed = await confirm(facts);
  } catch {
    return refuse('SIGN_CONFIRMATION_FAILED', CONFIRMATION_UNAVAILABLE);
  }
  return typed === retiredKeyId ? null : refuse('SIGN_CONFIRMATION_FAILED', CONFIRMATION_MISMATCH);
}

const isRefusal = (value: unknown): value is SignRefusal => typeof value === 'object' && value !== null && (value as { readonly ok?: unknown }).ok === false;
const KEY_UNEXPECTED = refuse('UNEXPECTED', `Falha inesperada ao abrir a chave. ${NOTHING}`);

/** Passo da chave (K1): a recusa da abertura passa adiante; a pública derivada tem de ser a de S na lista (`SIGN_KEY_MISMATCH`). */
async function openedSigner(deps: CloseKeyDeps, input: CloseKeyInput): Promise<KeyObject | SignRefusal> {
  let opened: KeyObject | SignRefusal;
  try {
    opened = await deps.openKey();
  } catch {
    return KEY_UNEXPECTED; // o objeto de erro nunca sai daqui (RS-13)
  }
  if (isRefusal(opened)) return opened;
  return keyMismatchRefusal(input.trustKeys, input.signerKeyId, opened) ?? opened;
}

/* ------------------------------------------------------------------------------------------------------------------- fecho e autoteste */

const CLOSURE_FAILED = refuse('UNEXPECTED', `Não foi possível montar ou assinar o fecho. ${NOTHING}`);
const CLOSURE_TOO_LARGE = refuse('CLOSE_TOO_MANY_HEADS', `O fecho passaria de ${MAX_CLOSURE_BYTES} bytes (o verificador o recusaria). ${NOTHING}`);

/** Corpo (heads ordenadas por auditId) → assinatura Ed25519 pura de S → montagem conferida com a pública derivada → os BYTES a gravar. */
function closureText(input: CloseKeyInput, sealedAt: string, heads: readonly ClosureHead[], key: KeyObject): { readonly ok: true; readonly text: string } | SignRefusal {
  try {
    const { body, signingBytes } = buildKeyRetirementClosureBody({ retiredKeyId: input.retiredKeyId, signerKeyId: input.signerKeyId, sealedAt, heads });
    const closure = assembleKeyRetirementClosure(body, cryptoSign(null, signingBytes, key).toString('base64url'), createPublicKey(key));
    const text = `${JSON.stringify(closure)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_CLOSURE_BYTES) return CLOSURE_TOO_LARGE;
    const back = parseKeyRetirementClosureText(Buffer.from(text, 'utf8'));
    return back.ok && JSON.stringify(back.value) === JSON.stringify(closure) ? { ok: true, text } : CLOSURE_FAILED;
  } catch {
    return CLOSURE_FAILED; // nunca o objeto de erro (pode carregar material da chave, RS-13)
  }
}

/** A lista com o item de R trocado por `R:<pública>:retired:<closureSha256>` (o que o runbook fixa); `null` se R não está nela uma vez só. */
function pinnedTrustKeys(trustKeys: string, retiredKeyId: string, closureSha256: string): { readonly list: string; readonly item: string } | null {
  const items = trustKeys.split(',');
  const at = items.flatMap((entry, index) => (entry.split(':')[0] === retiredKeyId ? [index] : []));
  const publicRaw = at.length === 1 ? items[at[0] as number]?.split(':')[1] : undefined;
  if (publicRaw === undefined) return null;
  const item = `${retiredKeyId}:${publicRaw}:retired:${closureSha256}`;
  return { list: items.map((entry, index) => (index === at[0] ? item : entry)).join(','), item };
}

const selfTestFailed = (reason: string, auditId?: string): SignRefusal => ({
  ok: false,
  code: 'SIGN_SELFTEST_FAILED',
  message: `O autoteste do fecho falhou${auditId ? ` na auditoria ${auditId}` : ''}: com a chave aposentada como retired:<hash deste fecho>, o verificador v2 (lista completa com estado, só v2) não autenticou ${auditId ? 'a cadeia coberta' : 'o próprio fecho'}; o servidor também recusaria. Qualquer dúvida ⇒ revoked, nunca retired (runbook). Nada foi gravado.`,
  chainReason: reason,
});

/** O fecho por si: os bytes voltam pelo parser estrito, com R, S e as cabeças certas, a assinatura de S confere e a lista fixada é válida. */
function closureItselfRefusal(text: string, input: CloseKeyInput, heads: readonly ClosureHead[], ring: TrustKeyring | null): SignRefusal | null {
  const parsed = parseKeyRetirementClosureText(Buffer.from(text, 'utf8'));
  const signer = ring?.get(input.signerKeyId);
  const sameHeads = parsed.ok && JSON.stringify(parsed.value.heads) === JSON.stringify(heads.map(({ auditId, seq, sealSha256: sha }) => ({ auditId, seq, sealSha256: sha })));
  const pinned = ring?.get(input.retiredKeyId);
  const valid = parsed.ok && sameHeads && parsed.value.retiredKeyId === input.retiredKeyId && parsed.value.signerKeyId === input.signerKeyId && signer?.status === 'active' && verifyKeyRetirementClosureSignature(parsed.value, signer.key) && pinned?.status === 'retired' && pinned.closureSha256 === sha256Hex(text);
  return valid ? null : selfTestFailed('SELFTEST_CLOSURE_INVALID');
}

/**
 * Autoteste (§5.5.1 item 9 e item 2): o fecho em memória em `_closures/<R>.json` sobre a fotografia da varredura e, para CADA auditoria coberta, o
 * VERIFICADOR v2 REAL em modo produção com a lista em que R está `retired:<closureSha256>` e evidências = entradas do último manifesto da cadeia.
 * Tem de dar `AUTHENTICATED` com R e S em `keyIds` (o fecho foi usado). Qualquer outra coisa ⇒ `SIGN_SELFTEST_FAILED`. Nunca lança nem escreve.
 */
async function selfTestClosure(ops: FsOps, root: string, input: CloseKeyInput, closure: { readonly text: string; readonly heads: readonly ClosureHead[] }, audits: ReadonlyMap<string, ScannedAudit>): Promise<SignRefusal | null> {
  try {
    const pinned = pinnedTrustKeys(input.trustKeys, input.retiredKeyId, sha256Hex(closure.text));
    const keyring = pinned ? parseTrustKeyring(pinned.list) : null;
    const itself = closureItselfRefusal(closure.text, input, closure.heads, keyring);
    if (itself || !keyring) return itself ?? selfTestFailed('SELFTEST_CLOSURE_INVALID');
    const overlay = withVirtualFile(ops, path.join(root, CLOSURES_DIR), `${input.retiredKeyId}.json`, closure.text);
    const verifier = createSealedEvidenceProvenance({ sealsDir: root, keyring, acceptedVersions: [2], fs: overlay });
    for (const head of closure.heads) {
      const last = lastSealOf(audits.get(head.auditId));
      const evidences = last ? last.entries.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256, legacy: false })) : PLACEHOLDER_EVIDENCE;
      const verdict = await verifier.classify(head.auditId, evidences);
      if (verdict.status !== 'AUTHENTICATED') return selfTestFailed(verdict.reason, head.auditId);
      const used = 'keyIds' in verdict && verdict.keyIds.includes(input.retiredKeyId) && verdict.keyIds.includes(input.signerKeyId);
      if (!used) return selfTestFailed('SELFTEST_CLOSURE_NOT_USED', head.auditId);
    }
    return null;
  } catch {
    return selfTestFailed('VERIFICATION_ERROR');
  }
}

/* ------------------------------------------------------------------------------------------------------------------- o comando */

interface Prepared {
  readonly root: string;
  readonly snapshot: FsOps;
  readonly audits: ReadonlyMap<string, ScannedAudit>;
  readonly selection: ClosureHeadsResult;
  readonly sealedAt: string;
}

/** Tudo o que não precisa da chave nem do custodiante: argumentos, estados, recibos, varredura, `_closures`, cabeças e relógio. */
async function prepare(input: CloseKeyInput, deps: CloseKeyDeps): Promise<Prepared | SignRefusal> {
  const invalidArgs = closeUsageRefusal(input);
  if (invalidArgs) return invalidArgs;
  const ring = parseTrustKeyring(input.trustKeys) as TrustKeyring;
  const states = keyStateRefusal(ring, input);
  if (states) return states;
  const snapshot = chainSnapshot(deps.fs);
  const resolved = await resolveSealsRoot(snapshot, input.sealsDir);
  if (!resolved.ok) return resolved.reason === 'VERIFICATION_ERROR' ? COPY_IO : copyInvalid('inexistente ou não é diretório (provável erro de digitação)', resolved.reason);
  const receipts = await readReceipts(deps.fs, { receiptsDir: input.receiptsDir, sealsRoot: resolved.root });
  if (!receipts.ok) return receipts;
  const retired = { keyId: input.retiredKeyId, key: (ring.get(input.retiredKeyId) as { readonly key: KeyObject }).key };
  const scanned = await scanServerCopy(snapshot, resolved.root, retired);
  if ('code' in scanned) return scanned;
  const existing = await closuresRefusal(snapshot, resolved.root, input.retiredKeyId);
  if (existing) return existing;
  const selection = closureHeads(input.retiredKeyId, receipts.receipts, scanned);
  if (selection.heads.length > MAX_CLOSURE_HEADS) return refuse('CLOSE_TOO_MANY_HEADS', `${selection.heads.length} auditorias a cobrir: o fecho aceita no máximo ${MAX_CLOSURE_HEADS} (contrato v2 §6). ${NOTHING}`);
  const audits = new Map(scanned.map((audit) => [audit.auditId, audit]));
  const clock = closureInstant(deps.now, selection.heads, audits);
  if (!clock.ok) return clock;
  return { root: resolved.root, snapshot, audits, selection, sealedAt: clock.sealedAt };
}

/**
 * `close-key`: prepara (sem chave) → confirmação humana → chave S → fecho assinado → autoteste → gravação exclusiva de `_closures/<R>.json`. Devolve o
 * resumo (com o `closureSha256` a fixar) ou a recusa. Nunca lança.
 */
export async function runCloseKey(input: CloseKeyInput, deps: CloseKeyDeps): Promise<CloseKeyResult> {
  try {
    const ready = await prepare(input, deps);
    if ('code' in ready) return ready;
    const { selection } = ready;
    const facts: CloseConfirmationFacts = { signerKeyId: input.signerKeyId, heads: selection.heads.length, unknown: selection.unknownSealsOnServer.length, missing: selection.receiptedHeadsNotOnServer.length };
    const unconfirmed = await confirmationRefusal(deps.confirm, facts, input.retiredKeyId);
    if (unconfirmed) return unconfirmed;
    const key = await openedSigner(deps, input);
    if (isRefusal(key)) return key;
    const closure = closureText(input, ready.sealedAt, selection.heads, key);
    if (!closure.ok) return closure;
    const failed = await selfTestClosure(ready.snapshot, ready.root, input, { text: closure.text, heads: selection.heads }, ready.audits);
    if (failed) return failed;
    const written = await publishClosure(deps.fs, { sealsDir: ready.root, retiredKeyId: input.retiredKeyId, text: closure.text }, deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {});
    if (!written.ok) return written;
    const closureSha256 = sha256Hex(closure.text);
    const pinned = pinnedTrustKeys(input.trustKeys, input.retiredKeyId, closureSha256);
    return { ok: true, retiredKeyId: input.retiredKeyId, signerKeyId: input.signerKeyId, custodian: input.custodian, sealedAt: ready.sealedAt, closureSha256, fileName: written.fileName, file: written.file, pinnedTrustKey: pinned?.item ?? '', ...selection };
  } catch {
    return refuse('UNEXPECTED', `Falha inesperada no close-key. ${NOTHING}`);
  }
}
