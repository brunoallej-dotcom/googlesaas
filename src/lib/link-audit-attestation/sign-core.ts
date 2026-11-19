import { createHash } from 'node:crypto';
import { isPackageHashConsistent } from './package-hash';
import { APPROVAL_KIND, approvalSchema, auditId as auditIdSchema, candidatePackageSchema, entryRef, hex64, isoInstant, PACKAGE_KIND, shortLabel, type Approval, type CandidatePackage } from './schemas';

/*
 * P1 W4.1/W4.2 — núcleo PURO do `sign` (spec §5.5 passos 1–11; decisões §5.5.1). Recebe os BYTES já lidos (uma vez, por quem chama) do pacote,
 * da aprovação, do dossiê e do aceite formal de risco, e o que a leitura da cadeia achou (`sign-chain.ts` a lê e verifica com o verificador v2 real
 * ANTES; este arquivo só julga o resultado, na posição do passo 7); decide: plano do manifesto (com `seq` e `prevSealSha256`), ou recusa com `code`
 * estável. Sem disco, rede, ambiente nem relógio implícito: o instante vem do relógio injetado, lido no passo 10. Depois de TODAS as recusas dos
 * passos 1–10, a confirmação humana (passo 11) pela porta injetada `confirm`; só então, uma única vez, o leitor de chave injetado (passo 12;
 * IA-01). A tela da confirmação (TTY) e a chave real (12) são da W4.4, o autoteste (14) e o recibo (16) da W4.5, a gravação (15) da W4.3; o corpo
 * e a assinatura (13) estão em `sign-chain.ts`.
 */

export const SIGN_REFUSAL_CODES = [
  'USAGE',
  'SIGN_AUDIT_MISMATCH',
  'SIGN_PACKAGE_INVALID',
  'SIGN_PACKAGE_MISMATCH',
  'SIGN_APPROVAL_INVALID',
  'SIGN_INTEGRITY_NOT_OK',
  'SIGN_LEGACY_NOT_ATTESTABLE',
  'SIGN_CHECK_NOT_EXECUTED',
  'SIGN_DOSSIER_MISMATCH',
  'SIGN_SEAL_CHAIN_INVALID',
  'SIGN_SEQ_MISMATCH',
  'SIGN_EVIDENCE_CHANGED',
  'SIGN_ROLE_SEPARATION',
  'SIGN_CLOCK_REGRESSION',
  'SIGN_CONFIRMATION_FAILED',
  'UNEXPECTED',
] as const;
export type SignRefusalCode = (typeof SIGN_REFUSAL_CODES)[number];
export interface SignRefusal {
  readonly ok: false;
  readonly code: SignRefusalCode;
  /** pt-BR, sem conteúdo de arquivo, sem caminho de disco e sem dado da empresa. */
  readonly message: string;
  /** Só em `SIGN_EVIDENCE_CHANGED`: até 5 refs (rótulos fixos, já validados). */
  readonly refs?: readonly string[];
  /** Só em `SIGN_SEAL_CHAIN_INVALID`: o código FIXO do que a leitura da cadeia achou (razão do verificador v2 ou do `sign`), nunca dado de arquivo. */
  readonly chainReason?: string;
}

/** O último manifesto da cadeia. Estrutural (`EvidenceSealFile` e `EvidenceSealFileV2` o satisfazem) para este arquivo não importar o verificador. */
export interface LastSealFacts {
  readonly auditId: string;
  readonly sealedAt: string;
  readonly entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
}
/** A cabeça de uma cadeia que o verificador v2 AUTENTICOU: `seq` e `sealSha256` são os que ele devolveu (`headSeq`, `headSealSha256`). */
export interface VerifiedLastSeal extends LastSealFacts {
  readonly seq: number;
  readonly sealSha256: string;
}
/**
 * O que a leitura da cadeia de `<seals-dir>/<auditId>/` achou (`sign-chain.ts`, verificador v2 real, lista com estado e fechos, `[2]`). Estrutural,
 * para este arquivo não importar o verificador (§5.5.1 item 7). `EMPTY` = pasta da auditoria ausente ou sem nenhum `seal-NNNN.json`; `INVALID`
 * leva um código fixo. Julgado no passo 7 (`chainDecision`), DEPOIS das recusas dos passos 1–6.
 */
export type SealChainFacts =
  | { readonly status: 'EMPTY' }
  | { readonly status: 'VERIFIED'; readonly last: VerifiedLastSeal }
  | { readonly status: 'INVALID'; readonly reason: string };
/** Maior `seq` de um manifesto `v2` (contrato do verificador v2 §2, `MAX_CHAIN_SEALS`). Cópia deliberada (o núcleo não importa o verificador); paridade travada por teste. */
export const MAX_SEAL_SEQ = 256;

export interface SignCoreInput {
  /** `--audit`. A subpasta de entrega `<seals-dir>/<auditId>/` deriva SÓ dele (quarto lugar do passo 1, por construção). */
  readonly auditId: string;
  /** `--custodian`. */
  readonly custodian: string;
  /** Bytes de `--package`, `--approval` e `--dossier`, lidos UMA vez por quem chama; o núcleo nunca relê por caminho (RS-04). */
  readonly packageBytes: Uint8Array;
  readonly approvalBytes: Uint8Array;
  readonly dossierBytes: Uint8Array;
  /**
   * Bytes do arquivo do aceite formal de risco citado em `approval.riskAcceptance`, lidos UMA vez por quem chama; `null` se não foi indicado. Só
   * contam quando conferente e custodiante coincidem (passo 9: existência e hash; o conteúdo é humano); senão, são ignorados.
   */
  readonly riskAcceptanceBytes: Uint8Array | null;
  /** A cadeia de `<seals-dir>/<auditId>/`, já lida e verificada por `sign-chain.ts` (W4.2). */
  readonly chain: SealChainFacts;
  /** `--expect-seq`: o `seq` esperado, do registro EXTERNO (dossiê/cofre), nunca da pasta. Inteiro de 1 a 256. */
  readonly expectSeq: number;
  /** `--first`: obrigatório se e somente se `--expect-seq = 1` (o "só se" é USAGE; o "se", com a pasta vazia, é recusa da cadeia, §7.1). */
  readonly first: boolean;
}

/**
 * O que a tela da confirmação humana (passo 11) pode mostrar. NUNCA o hash do pacote, nem parte dele: o custodiante lê os 12 caracteres no
 * dossiê, fora desta tela, e os digita; uma tela que os mostrasse viraria um "copie o que está escrito".
 */
export interface ConfirmationFacts {
  readonly auditId: string;
  /** O `seq` do manifesto a assinar (último verificado + 1, igual a `--expect-seq`; W4.2). */
  readonly seq: number;
  /** Quantas entradas o manifesto vai atestar (o conjunto exato do pacote). */
  readonly entries: number;
}

export interface SignCoreDeps<K> {
  /** Relógio injetado; lido uma vez, no passo 10. */
  readonly now: () => Date;
  /**
   * Confirmação humana (passo 11; a tela TTY é da W4.4): devolve o texto que o custodiante DIGITOU, comparado sem nenhuma normalização com os
   * 12 primeiros caracteres de `packageSha256` (quem implementa a tela tira só o fim de linha). Chamada no máximo uma vez, depois de todas as
   * recusas dos passos 1–10 e antes de `openKey`. Lançar ou rejeitar é recusa (`SIGN_CONFIRMATION_FAILED`), nunca sucesso.
   */
  readonly confirm: (facts: ConfirmationFacts) => Promise<string>;
  /** Leitor de chave (W4.4). Chamado no máximo uma vez e SÓ depois de todas as recusas e da confirmação humana (§5.5 passo 12; IA-01). */
  readonly openKey: () => K;
}

/** O que os passos seguintes (13–16) precisam, decidido sem chave. */
export interface SignPlan {
  readonly auditId: string;
  readonly sealedAt: string;
  /** Último + 1 (verificado), igual a `--expect-seq`; 1 numa pasta sem manifesto. */
  readonly seq: number;
  /** `sealSha256` do último manifesto verificado; `null` se e somente se `seq = 1`. */
  readonly prevSealSha256: string | null;
  readonly packageSha256: string;
  /** O conjunto EXATO do pacote lido (ordem e hashes), sem a marca `legacy`. */
  readonly entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
  /** `sha256` = SHA-256 dos bytes do dossiê lidos (igual ao da aprovação). */
  readonly dossier: { readonly id: string; readonly sha256: string };
  readonly approvedBy: string;
  readonly operator: string;
  readonly custodian: string;
  readonly roleException: boolean;
  readonly requiresLaterReview: boolean;
}
export type SignCoreResult<K> = { readonly ok: true; readonly plan: SignPlan; readonly key: K } | SignRefusal;

type Parsed = { readonly ok: true; readonly pkg: CandidatePackage; readonly approval: Approval } | SignRefusal;
type Roles = { readonly ok: true; readonly roleException: boolean; readonly requiresLaterReview: boolean } | SignRefusal;
type Clock = { readonly ok: true; readonly sealedAt: string } | SignRefusal;
type ChainStep = { readonly ok: true; readonly seq: number; readonly prevSealSha256: string | null; readonly last: VerifiedLastSeal | null } | SignRefusal;
type Decision = { readonly ok: true; readonly plan: SignPlan } | SignRefusal;

const MAX_REPORTED_REFS = 5;
/** Passo 11: quantos caracteres iniciais de `packageSha256` o custodiante digita. */
const CONFIRM_PREFIX_LENGTH = 12;
const NOTHING_SIGNED = 'Nada foi assinado.';
/** UTF-8 estrito; `ignoreBOM` MANTÉM o BOM no texto, e o `JSON.parse` o recusa. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message });

/** Bytes → JSON; `undefined` (que o JSON nunca produz) marca texto fora de forma, e quem chama o converte em recusa tipada. */
function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(STRICT_UTF8.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Defesa na fronteira do núcleo (o parser do CLI é da W4.4): `--audit` no padrão (dele deriva a subpasta), `--custodian` como rótulo curto,
 * `--expect-seq` inteiro de 1 a 256 e `--first` só com `--expect-seq 1` (contradição dos próprios argumentos, sem olhar a pasta).
 */
function usageRefusal(input: SignCoreInput): SignRefusal | null {
  if (!auditIdSchema.safeParse(input.auditId).success) return refuse('USAGE', '--audit inválido (minúsculas, dígitos, "-" ou "_", 8 a 64 caracteres).');
  if (!shortLabel.safeParse(input.custodian).success) return refuse('USAGE', '--custodian deve ser um rótulo curto (iniciais ou ID), sem e-mail nem telefone.');
  if (!isSealSeq(input.expectSeq)) return refuse('USAGE', `--expect-seq deve ser um inteiro de 1 a ${MAX_SEAL_SEQ}.`);
  if (typeof input.first !== 'boolean' || (input.first && input.expectSeq !== 1)) return refuse('USAGE', '--first só vale com --expect-seq 1 (primeiro manifesto da auditoria).');
  return null;
}

const isSealSeq = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEAL_SEQ;

/** Passo 1: esquemas estritos do pacote e da aprovação (só `APPROVED`); `auditId` igual em `--audit`, no pacote e na aprovação. */
function parseInputs(input: SignCoreInput): Parsed {
  const pkg = candidatePackageSchema.safeParse(parseJsonBytes(input.packageBytes));
  if (!pkg.success) return refuse('SIGN_PACKAGE_INVALID', `O pacote não segue o esquema estrito (${PACKAGE_KIND}). ${NOTHING_SIGNED}`);
  const approval = approvalSchema.safeParse(parseJsonBytes(input.approvalBytes));
  if (!approval.success) return refuse('SIGN_APPROVAL_INVALID', `A aprovação não segue o esquema estrito (${APPROVAL_KIND}, decisão APPROVED). ${NOTHING_SIGNED}`);
  if (pkg.data.auditId !== input.auditId || approval.data.auditId !== input.auditId) return refuse('SIGN_AUDIT_MISMATCH', `O auditId difere entre --audit, o pacote e a aprovação. ${NOTHING_SIGNED}`);
  return { ok: true, pkg: pkg.data, approval: approval.data };
}

/** Passos 2 e 3 (recusa (c)): o hash declarado é o que o corpo produz, e é o aprovado. */
function approvedPackageRefusal(pkg: CandidatePackage, approval: Approval): SignRefusal | null {
  if (!isPackageHashConsistent(pkg)) return refuse('SIGN_PACKAGE_INVALID', `O hash declarado do pacote não confere com o conteúdo (pacote alterado depois da exportação). ${NOTHING_SIGNED}`);
  if (approval.packageSha256 !== pkg.packageSha256) return refuse('SIGN_PACKAGE_MISMATCH', 'O pacote a assinar não é o aprovado (hash difere). Reexporte, reconfira e reaprove.');
  return null;
}

/**
 * Passos 4 e 5 (recusas (d) e (b)), nesta ordem: FAIL (sempre recusa, IA-17) ⇒ legado ⇒ cobertura humana. `attestable = true` (passo 4) e "nenhuma
 * entrada legada" (passo 5) são o MESMO predicado pelo esquema da W1 (`attestable ⇔ sem legado`): julgados juntos e reportados como
 * `SIGN_LEGACY_NOT_ATTESTABLE` (IA-01 (b)), antes da cobertura humana, que num pacote não atestável não faria sentido. `integrity.status ≠ OK`
 * não chega aqui: o esquema da W1 fixa `"OK"` e o pacote é recusado no passo 1.
 */
function checksRefusal(pkg: CandidatePackage, approval: Approval): SignRefusal | null {
  const failed = pkg.checks.find((check) => check.status === 'FAIL');
  if (failed) return refuse('SIGN_INTEGRITY_NOT_OK', `A verificação ${failed.id} está FAIL no pacote; FAIL nunca é assinável. ${NOTHING_SIGNED}`);
  if (!pkg.attestable || pkg.entries.some((entry) => entry.legacy)) return refuse('SIGN_LEGACY_NOT_ATTESTABLE', 'Pacote com coleta legada não é atestável.');
  return humanChecksRefusal(pkg, approval);
}

/** Passo 4: cada `NOT_EXECUTED` exige resultado humano `PASS` com nota; e resultado humano só vale para verificação `NOT_EXECUTED` (herdado da W1). */
function humanChecksRefusal(pkg: CandidatePackage, approval: Approval): SignRefusal | null {
  const human = new Map<string, Approval['humanChecks'][number]>(approval.humanChecks.map((check) => [check.id, check]));
  const notExecuted: string[] = pkg.checks.filter((check) => check.status === 'NOT_EXECUTED').map((check) => check.id);
  const uncovered = notExecuted.find((id) => human.get(id)?.result !== 'PASS' || (human.get(id)?.note.trim() ?? '') === '');
  if (uncovered) return refuse('SIGN_CHECK_NOT_EXECUTED', `A verificação ${uncovered} não foi executada e a aprovação não traz resultado humano PASS com nota. ${NOTHING_SIGNED}`);
  const extra = approval.humanChecks.find((check) => !notExecuted.includes(check.id));
  if (extra) return refuse('SIGN_APPROVAL_INVALID', `A aprovação traz resultado humano para ${extra.id}, que o pacote não marca NOT_EXECUTED. ${NOTHING_SIGNED}`);
  return null;
}

/** Passo 6: SHA-256 dos BYTES lidos do dossiê (nunca de um texto decodificado). Só existência e hash; o conteúdo é humano. */
const sha256OfBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Guarda do último manifesto recebido, na posição do passo 7 (a verificação em si é do verificador v2, em `sign-chain.ts`): é desta auditoria
 * (IA-06 (3)) e tem a forma que os passos 7, 8 e 10 usam. Senão `SIGN_SEAL_CHAIN_INVALID`: nunca assina por cima nem recua.
 */
function lastSealRefusal(auditId: string, last: VerifiedLastSeal): SignRefusal | null {
  const isEntry = (entry: LastSealFacts['entries'][number]): boolean => entryRef.safeParse(entry.ref).success && hex64.safeParse(entry.contentSha256).success;
  const wellFormed = last.auditId === auditId && isSealSeq(last.seq) && hex64.safeParse(last.sealSha256).success && isoInstant.safeParse(last.sealedAt).success && last.entries.length > 0 && last.entries.every(isEntry);
  return wellFormed ? null : refuse('SIGN_SEAL_CHAIN_INVALID', `O último manifesto da cadeia não é desta auditoria ou está fora de forma. ${NOTHING_SIGNED}`);
}

/** Código fixo da leitura da cadeia (razão do verificador v2 ou do `sign`); qualquer outra coisa nunca é repassada. */
const CHAIN_REASON = /^[A-Z][A-Z0-9_]{0,47}$/;
const chainInvalid = (reason: string, message: string): SignRefusal => ({ ...refuse('SIGN_SEAL_CHAIN_INVALID', message), ...(CHAIN_REASON.test(reason) ? { chainReason: reason } : {}) });
const CHAIN_DOES_NOT_VERIFY = `A cadeia de manifestos desta auditoria não verifica (verificador v2, lista de chaves com estado e fechos). Não se assina por cima nem se recua: trate como incidente. ${NOTHING_SIGNED}`;

/**
 * Passo 7 (§7.1; decisões §5.5.1 e notas da W4.2), nesta ordem: cadeia que não verifica ⇒ `SIGN_SEAL_CHAIN_INVALID` (um `seq` calculado de cadeia
 * não verificada não vale nada); pasta sem manifesto ⇒ só `--first --expect-seq 1` (`--expect-seq > 1` indica manifesto apagado: nunca
 * recomeçar); com cadeia, `último + 1 = --expect-seq` (e `--first` recusado) ⇒ senão `SIGN_SEQ_MISMATCH`.
 */
function chainDecision(input: SignCoreInput): ChainStep {
  const { chain, expectSeq, first } = input;
  if (chain.status === 'EMPTY') {
    if (expectSeq !== 1) return chainInvalid('NO_SEAL_EXPECTED_SEQ', `Nenhum manifesto na pasta, mas --expect-seq ${expectSeq} indica ${expectSeq - 1} manifesto(s) anterior(es): algum pode ter sido apagado da cópia da estação. Nunca recomece a cadeia. ${NOTHING_SIGNED}`);
    if (!first) return chainInvalid('NO_SEAL_WITHOUT_FIRST', `Nenhum manifesto na pasta: o primeiro exige --first --expect-seq 1. ${NOTHING_SIGNED}`);
    return { ok: true, seq: 1, prevSealSha256: null, last: null };
  }
  if (chain.status !== 'VERIFIED') return chainInvalid(chain.status === 'INVALID' ? chain.reason : 'UNKNOWN', CHAIN_DOES_NOT_VERIFY);
  const malformed = lastSealRefusal(input.auditId, chain.last);
  if (malformed) return malformed;
  const next = chain.last.seq + 1;
  if (first) return refuse('SIGN_SEQ_MISMATCH', `--first, mas a pasta já tem ${chain.last.seq} manifesto(s) desta auditoria (calculado: ${next}). Confira o registro externo. ${NOTHING_SIGNED}`);
  if (expectSeq !== next) return refuse('SIGN_SEQ_MISMATCH', `--expect-seq ${expectSeq} difere do calculado pela cadeia verificada (último + 1 = ${next}). Confira o registro externo. ${NOTHING_SIGNED}`);
  return { ok: true, seq: next, prevSealSha256: chain.last.sealSha256, last: chain.last };
}

/** Passo 8 (recusa (a)): toda entrada do último manifesto está no pacote com o MESMO hash; entradas novas são permitidas. Informa até 5 refs. */
function evidenceChangedRefusal(pkg: CandidatePackage, last: LastSealFacts | null): SignRefusal | null {
  if (last === null) return null;
  const current = new Map(pkg.entries.map((entry) => [entry.ref, entry.contentSha256]));
  const refs = last.entries.filter((entry) => current.get(entry.ref) !== entry.contentSha256).map((entry) => entry.ref).slice(0, MAX_REPORTED_REFS);
  if (refs.length === 0) return null;
  return { ...refuse('SIGN_EVIDENCE_CHANGED', `Evidência já atestada mudou de hash ou sumiu (${refs.join(', ')}). ${NOTHING_SIGNED}`), refs };
}

/** Todo grupo de separadores (espaço, `.`, `_`, `-`) sai da chave do rótulo, não só o primeiro. */
const ROLE_SEPARATORS = /[\s._-]+/gu;
/** Rótulo comparável: NFKC e sem separadores (`CONF-01` ≡ `conf 01` ≡ `ＣＯＮＦ.01`); a caixa é tratada em `sameRole`. */
const roleKey = (label: string): string => label.normalize('NFKC').replace(ROLE_SEPARATORS, '');

/**
 * Mesma pessoa se as chaves coincidem em minúsculas OU em maiúsculas OU na dobra maiúsculas(minúsculas): `ΟΣ` em minúsculas vira `ος` (sigma
 * final) e não bate com `οσ`, mas em maiúsculas sim; `ß`/`SS` só batem em maiúsculas; `ẞ`/`SS` só na dobra. Cada forma a mais só AMPLIA a
 * coincidência: erra sempre para o lado de "coincide" (falha fechada).
 */
function sameRole(left: string, right: string): boolean {
  const [a, b] = [roleKey(left), roleKey(right)];
  return a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase() || a.toLowerCase().toUpperCase() === b.toLowerCase().toUpperCase();
}

/**
 * Passo 9, aceite formal com os papéis coincidindo: a referência na aprovação, o arquivo EXISTENTE (bytes não vazios: um arquivo vazio não é aceite
 * escrito) e o SHA-256 dos bytes igual ao citado. Cada falta tem a sua mensagem, sem caminho, hash nem conteúdo.
 */
function riskAcceptanceRefusal(approval: Approval, bytes: Uint8Array | null): SignRefusal | null {
  const reference = approval.riskAcceptance;
  if (reference === null) return refuse('SIGN_ROLE_SEPARATION', 'Conferente e custodiante coincidem sem aceite formal de risco.');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return refuse('SIGN_ROLE_SEPARATION', `Conferente e custodiante coincidem e a aprovação cita um aceite formal de risco, mas o arquivo do aceite formal de risco não foi fornecido (ou está vazio). ${NOTHING_SIGNED}`);
  }
  if (sha256OfBytes(bytes) !== reference.sha256) return refuse('SIGN_ROLE_SEPARATION', `Conferente e custodiante coincidem e o SHA-256 do arquivo do aceite formal de risco não confere com o da aprovação. ${NOTHING_SIGNED}`);
  return null;
}

/** Passo 9 (RS-01, D4): conferente ≠ custodiante, ou aceite formal existente e com o hash citado; operador = conferente não bloqueia, só marca revisão. */
function roleDecision(approval: Approval, input: SignCoreInput): Roles {
  const roleException = sameRole(approval.approvedBy, input.custodian);
  const refused = roleException ? riskAcceptanceRefusal(approval, input.riskAcceptanceBytes) : null;
  if (refused) return refused;
  return { ok: true, roleException, requiresLaterReview: roleException || sameRole(approval.operator, approval.approvedBy) };
}

/** Passo 10: `sealedAt` (relógio injetado) ≥ `lastCollectedAt` e ≥ `sealedAt` do último manifesto. Todas com ms em UTC: ordem lexicográfica = cronológica. */
function clockDecision(now: () => Date, pkg: CandidatePackage, last: LastSealFacts | null): Clock {
  const instant = now();
  const sealedAt = Number.isFinite(instant.getTime()) ? instant.toISOString() : '';
  if (!isoInstant.safeParse(sealedAt).success) return refuse('UNEXPECTED', 'Relógio inválido.');
  if (sealedAt < pkg.summary.lastCollectedAt || (last !== null && sealedAt < last.sealedAt)) {
    return refuse('SIGN_CLOCK_REGRESSION', `O relógio desta estação está antes da última coleta ou do último manifesto; confira o relógio. ${NOTHING_SIGNED}`);
  }
  return { ok: true, sealedAt };
}

/** Passos 1–10 na ordem do §5.5, sem chave. */
function decide(input: SignCoreInput, now: () => Date): Decision {
  const parsed = usageRefusal(input) ?? parseInputs(input);
  if (!parsed.ok) return parsed;
  const { pkg, approval } = parsed;
  const refused = approvedPackageRefusal(pkg, approval) ?? checksRefusal(pkg, approval);
  if (refused) return refused;
  const dossierSha256 = sha256OfBytes(input.dossierBytes);
  if (dossierSha256 !== approval.dossier.sha256) return refuse('SIGN_DOSSIER_MISMATCH', `O SHA-256 do dossiê não confere com o da aprovação. ${NOTHING_SIGNED}`);
  const chain = chainDecision(input);
  if (!chain.ok) return chain;
  const changed = evidenceChangedRefusal(pkg, chain.last);
  if (changed) return changed;
  const roles = roleDecision(approval, input);
  if (!roles.ok) return roles;
  const clock = clockDecision(now, pkg, chain.last);
  if (!clock.ok) return clock;
  const entries = pkg.entries.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256 }));
  const { roleException, requiresLaterReview } = roles;
  const plan: SignPlan = { auditId: input.auditId, sealedAt: clock.sealedAt, seq: chain.seq, prevSealSha256: chain.prevSealSha256, packageSha256: pkg.packageSha256, entries, dossier: { id: approval.dossier.id, sha256: dossierSha256 }, approvedBy: approval.approvedBy, operator: approval.operator, custodian: input.custodian, roleException, requiresLaterReview };
  return { ok: true, plan };
}

const CONFIRMATION_MISMATCH = `O texto digitado não confere com os ${CONFIRM_PREFIX_LENGTH} primeiros caracteres de packageSha256 do dossiê. ${NOTHING_SIGNED}`;
const CONFIRMATION_UNAVAILABLE = `A confirmação humana não foi obtida (sem terminal interativo, entrada interrompida ou falha da tela). ${NOTHING_SIGNED}`;

/**
 * Passo 11: a tela recebe só `auditId`, `seq` e o número de entradas (nunca o hash) e devolve o texto digitado, comparado EXATAMENTE com os 12 primeiros
 * caracteres de `packageSha256`. A porta que lança ou rejeita é recusa do mesmo código (a confirmação não existiu; lado fechado), e o objeto de
 * erro nunca sai daqui. Nenhuma das mensagens repete o esperado nem o digitado.
 */
async function confirmationRefusal(plan: SignPlan, confirm: SignCoreDeps<unknown>['confirm']): Promise<SignRefusal | null> {
  let typed: unknown;
  try {
    typed = await confirm({ auditId: plan.auditId, seq: plan.seq, entries: plan.entries.length });
  } catch {
    return refuse('SIGN_CONFIRMATION_FAILED', CONFIRMATION_UNAVAILABLE);
  }
  return typed === plan.packageSha256.slice(0, CONFIRM_PREFIX_LENGTH) ? null : refuse('SIGN_CONFIRMATION_FAILED', CONFIRMATION_MISMATCH);
}

/**
 * Núcleo do `sign`: todas as recusas que não precisam da chave (passos 1–10), a confirmação humana (11) e só então, uma única vez, o leitor de
 * chave injetado (12). Nunca lança pelo conteúdo lido nem pela confirmação.
 */
export async function runSignCore<K>(input: SignCoreInput, deps: SignCoreDeps<K>): Promise<SignCoreResult<K>> {
  const decision = decide(input, deps.now);
  if (!decision.ok) return decision;
  const unconfirmed = await confirmationRefusal(decision.plan, deps.confirm);
  if (unconfirmed) return unconfirmed;
  return { ok: true, plan: decision.plan, key: deps.openKey() };
}
