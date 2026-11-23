import type { EvidenceTrustReason } from '../link-audit-evidence/provenance-core';

/*
 * P9.2 — códigos FIXOS das regras S-01 a S-13 do job `seals` (spec `ci-deploy-and-seal-delivery.md` §5.4). A saída pública (log e resumo do
 * Actions) só leva estes códigos, as razões fixas do verificador v2 e campos públicos (caminho na gramática, hashes, `seq`, ids de chave):
 * nunca conteúdo de arquivo.
 */

export const SEALS_RULES = ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08', 'S-09', 'S-10', 'S-11', 'S-12', 'S-13'] as const;
export type SealsRuleId = (typeof SEALS_RULES)[number];

/** As razões fixas de `EvidenceTrustReason`, em tempo de execução (o tipo do verificador não existe em JS). Exaustividade travada abaixo. */
export const EVIDENCE_TRUST_REASONS = [
  'PROOF_NOT_CONFIGURED',
  'NO_SEAL',
  'LEGACY_NO_SEAL',
  'SEAL_INVALID',
  'EVIDENCE_NOT_SEALED',
  'EVIDENCE_MISSING',
  'EVIDENCE_HASH_MISMATCH',
  'VERIFICATION_ERROR',
  'SEAL_CHAIN_BROKEN',
  'SEAL_NOT_CUMULATIVE',
  'SEAL_DOWNGRADE',
  'SEAL_VERSION_NOT_ALLOWED',
  'SEAL_KEY_RETIRED_UNCOVERED',
  'SEAL_KEY_REVOKED',
] as const satisfies readonly EvidenceTrustReason[];
type MissingReason = Exclude<EvidenceTrustReason, (typeof EVIDENCE_TRUST_REASONS)[number]>;
/** Falha de compilação se o verificador ganhar uma razão que esta lista não tem. */
const REASONS_ARE_EXHAUSTIVE: [MissingReason] extends [never] ? true : never = true;
void REASONS_ARE_EXHAUSTIVE;

/**
 * Motivos fixos do S-11 (fecho novo, e o fecho de uma fixação pelo S-12). `SIGNER_NOT_ACTIVE` (revisão do PR #72, item 4): o signatário de um fecho
 * NOVO tem de estar `active`; o fecho histórico de uma fixação segue só a regra de antes (signatário na lista, qualquer estado).
 */
export const CLOSURE_MOTIVES = ['FORMAT', 'SIGNER_NOT_LISTED', 'SIGNER_NOT_ACTIVE', 'SIGNATURE_INVALID', 'RETIRED_NOT_LISTED', 'HEAD_NOT_IN_REPO'] as const;
export type ClosureMotive = (typeof CLOSURE_MOTIVES)[number];

export type SealsRefusalCode =
  | 'SEALS_NOT_APPEND_ONLY'
  | 'TRUST_LIST_DELETED'
  | 'SEALS_UNEXPECTED_PATH'
  | 'SEALS_BAD_MODE'
  | 'SEALS_TOO_LARGE'
  | 'SEALS_TOO_MANY'
  | 'SEAL_FORMAT'
  | 'SEAL_NOT_CANONICAL'
  | 'SEAL_NAME_MISMATCH'
  | 'SEALS_NOT_AT_END'
  | `SEAL_V2_${EvidenceTrustReason}`
  | 'SEAL_HEAD_MISMATCH'
  | `CLOSURE_${ClosureMotive}`
  | 'TRUST_LIST_FORMAT'
  | 'TRUST_LIST_ENV_PREFIX'
  | 'TRUST_LIST_TRANSITION'
  | 'SEALS_AND_TRUST_LIST_TOGETHER';

export interface SealsRefusal {
  readonly rule: SealsRuleId;
  readonly code: SealsRefusalCode;
  /** Relativo a `link-audit-seals/`, só quando o caminho casa a gramática do §5.2; `null` para recusa global ou caminho fora da tabela. */
  readonly path: string | null;
  /** Detalhe fixo e público (motivo de transição com o id da chave, ids fora da regra de ambiente); nunca conteúdo de arquivo. */
  readonly detail: string | null;
}

export const refusal = (rule: SealsRuleId, code: SealsRefusalCode, path: string | null = null, detail: string | null = null): SealsRefusal => ({ rule, code, path, detail });

const isTrustReason = (reason: string): reason is EvidenceTrustReason => (EVIDENCE_TRUST_REASONS as readonly string[]).includes(reason);

/**
 * `SEAL_V2_<RAZÃO>` de uma cadeia recusada. Só as razões fixas do verificador viram código; os códigos próprios da leitura da cadeia do `sign`
 * (pasta ilegível, nome em outra caixa, cabeça fora do caminho v2) caem em `SEAL_V2_VERIFICATION_ERROR` (falha fechada, conjunto fechado).
 */
export const sealV2Code = (reason: string): SealsRefusalCode => `SEAL_V2_${isTrustReason(reason) ? reason : 'VERIFICATION_ERROR'}`;

/** Ordem de recusa: a regra (S-01 primeiro) e, dentro da regra, o caminho; recusas globais (sem caminho) antes das de arquivo. */
export function sortRefusals(refusals: readonly SealsRefusal[]): SealsRefusal[] {
  const rank = (item: SealsRefusal): number => SEALS_RULES.indexOf(item.rule);
  const key = (item: SealsRefusal): string => `${item.path ?? ''}\u0000${item.code}\u0000${item.detail ?? ''}`;
  return [...refusals].sort((a, b) => rank(a) - rank(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
