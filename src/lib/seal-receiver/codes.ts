import { EVIDENCE_TRUST_REASONS, type ClosureMotive } from '../link-audit-seals-channel/codes';

/*
 * P9.3b — códigos de saída e saída PÚBLICA do receptor de manifestos (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.8). A saída vai ao log do
 * Actions, que é público: no sucesso, uma linha `OK WRITTEN|ALREADY_PRESENT <relpath> <sha256>` no stdout; na falha, uma linha
 * `ERRO <CÓDIGO>[ <DETALHE>]` no stderr. O detalhe só existe em dois códigos e só vem de conjuntos FECHADOS: `E_V2_REFUSED <RAZÃO>` (as razões
 * fixas do verificador v2, `EvidenceTrustReason`, mais `HEAD_MISMATCH`) e `E_CLOSURE_REFUSED <MOTIVO>` (os motivos fixos do S-11). Nunca conteúdo
 * de arquivo, caminho real, host ou valor de variável. O job de entrega (P9.5, `receiver-call.sh`) remonta a linha e só aceita este conjunto.
 */

/** Saída numérica de cada código (§5.8): os comuns aos dois receptores (os mesmos números do receptor de deploy) e os do receptor de manifestos. */
export const SEAL_RECEIVER_EXIT_CODES = {
  E_COMMAND: 10,
  E_INPUT_TOO_LARGE: 11,
  E_INPUT_TRUNCATED: 12,
  E_HASH_MISMATCH: 13,
  E_TRUST_LIST_MISMATCH: 14,
  E_TRUST_LIST_INVALID: 15,
  E_LOCKED: 16,
  E_ARTIFACT: 17,
  E_INTERNAL: 29,
  E_FORMAT: 30,
  E_EXISTS_DIFFERENT: 31,
  E_V2_REFUSED: 32,
  E_CLOSURE_REFUSED: 33,
  E_UNSAFE_PATH: 34,
  E_WRITE_FAILED: 35,
  E_WRITE_UNCONFIRMED: 36,
  E_POSTWRITE_VERIFY: 37,
} as const;

export type SealReceiverCode = keyof typeof SEAL_RECEIVER_EXIT_CODES;
export const EXIT_OK = 0;

/**
 * Detalhes do `E_V2_REFUSED`: as razões fixas do verificador v2 e `HEAD_MISMATCH` (a cadeia do host com o candidato autentica, mas a cabeça não é o
 * candidato: o análogo do `SEAL_HEAD_MISMATCH` do S-10 no CI). Qualquer outro código da leitura da cadeia cai em `VERIFICATION_ERROR`.
 */
export const V2_REFUSAL_DETAILS = [...EVIDENCE_TRUST_REASONS, 'HEAD_MISMATCH'] as const;
export type V2RefusalDetail = (typeof V2_REFUSAL_DETAILS)[number];

/** Detalhes do `E_CLOSURE_REFUSED`: os motivos do S-11 contra as cadeias do HOST (o `FORMAT` do fecho é `E_FORMAT`, passo 3). */
export const CLOSURE_REFUSAL_DETAILS = ['SIGNER_NOT_LISTED', 'SIGNATURE_INVALID', 'RETIRED_NOT_LISTED', 'HEAD_NOT_IN_REPO'] as const satisfies readonly ClosureMotive[];
export type ClosureRefusalDetail = (typeof CLOSURE_REFUSAL_DETAILS)[number];
type UnlistedMotive = Exclude<ClosureMotive, ClosureRefusalDetail | 'FORMAT'>;
/** Falha de compilação se o S-11 ganhar um motivo que este conjunto não tem. */
const MOTIVES_ARE_EXHAUSTIVE: [UnlistedMotive] extends [never] ? true : never = true;
void MOTIVES_ARE_EXHAUSTIVE;

export type SealReceiverDetail = V2RefusalDetail | ClosureRefusalDetail;

const isV2Detail = (detail: string): detail is V2RefusalDetail => (V2_REFUSAL_DETAILS as readonly string[]).includes(detail);
const isClosureDetail = (detail: string): detail is ClosureRefusalDetail => (CLOSURE_REFUSAL_DETAILS as readonly string[]).includes(detail);

/** `E_V2_REFUSED <RAZÃO>` de um código da leitura da cadeia: só os do conjunto fechado; o resto vira `VERIFICATION_ERROR` (falha fechada). */
export const v2Detail = (reason: string | undefined): V2RefusalDetail => (reason !== undefined && isV2Detail(reason) ? reason : 'VERIFICATION_ERROR');

/**
 * Recusa com código fixo. `detail` é tipado: só uma razão do verificador (com `E_V2_REFUSED`) ou um motivo do S-11 (com `E_CLOSURE_REFUSED`).
 * `logNote` vai SÓ ao log local (nunca à saída pública) e nunca leva conteúdo de arquivo.
 */
export class SealReceiverError extends Error {
  readonly code: SealReceiverCode;
  readonly detail: SealReceiverDetail | null;
  readonly logNote: string | null;
  constructor(code: SealReceiverCode, detail: SealReceiverDetail | null = null, logNote: string | null = null) {
    super(detail === null ? code : `${code} ${detail}`);
    this.name = 'SealReceiverError';
    this.code = code;
    this.detail = detail;
    this.logNote = logNote;
  }
}

/** O único formato de recusa pública: `ERRO <CÓDIGO>[ <DETALHE>]`, com detalhe só onde o conjunto fechado permite. */
export function publicErrorLine(code: SealReceiverCode, detail: SealReceiverDetail | null): string {
  const allowed = detail !== null && ((code === 'E_V2_REFUSED' && isV2Detail(detail)) || (code === 'E_CLOSURE_REFUSED' && isClosureDetail(detail)));
  return allowed ? `ERRO ${code} ${detail}` : `ERRO ${code}`;
}

/** Resultado de uma execução: exatamente UMA linha pública (stdout no sucesso, stderr na falha) e a saída numérica. */
export interface SealReceiverOutcome {
  readonly exitCode: number;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export const okOutcome = (line: string): SealReceiverOutcome => ({ exitCode: EXIT_OK, stdout: line, stderr: null });
export const errorOutcome = (code: SealReceiverCode, detail: SealReceiverDetail | null = null): SealReceiverOutcome => ({ exitCode: SEAL_RECEIVER_EXIT_CODES[code], stdout: null, stderr: publicErrorLine(code, detail) });
