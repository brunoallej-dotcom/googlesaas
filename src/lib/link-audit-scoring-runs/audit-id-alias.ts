import { sha256Hex } from '../link-audit/canonical';

/*
 * Identificador da auditoria para o motor (Onda 6C, I2, M-10). PURO: sem rede, disco, ambiente nem relógio.
 *
 * O armazenamento (evidências, decisões, resultados) aceita `_` no `auditId`; o motor só aceita `[a-z0-9-]`. O `auditId` REAL
 * nunca é trocado em silêncio: o motor recebe um alias determinístico, e o alias carrega a regra, o motivo e o id de origem
 * (auditável e verificável por `verifyAuditIdAlias`). O armazenamento continua usando sempre o id real.
 *
 * Sem colisão POR CONSTRUÇÃO (endurece a M-10 da v2.2, que previa 8 hex de sufixo e não impedia que um id comum fosse igual
 * ao alias de outro): todo alias termina na FORMA RESERVADA `-ux<32 hex>` (precedida de um trecho legível não vazio); um id que já nasce
 * nessa forma NÃO passa inalterado, também recebe alias. Assim o conjunto dos ids inalterados e o dos aliases são disjuntos, e
 * dois ids distintos só coincidiriam por colisão de 128 bits do SHA-256 (inviável). Ids comuns (sem `_`, válidos no motor e
 * fora da forma reservada) passam inalterados.
 */
export const AUDIT_ID_ALIAS_RULE = 'lumos-audit-id-alias-v1' as const;

/** Igual ao `AUDIT_ID_PATTERN` do armazenamento (um teste confere a igualdade). */
export const STORE_AUDIT_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
/** Igual ao `auditId` do contrato de entrada do motor (um teste confere contra o schema real). */
export const ENGINE_AUDIT_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
/** Forma reservada: só os aliases terminam assim. */
export const RESERVED_ALIAS_SHAPE = /-ux[0-9a-f]{32}$/;

const MAX_LENGTH = 64;
const DIGEST_HEX = 32;
const MAX_READABLE = MAX_LENGTH - '-ux'.length - DIGEST_HEX;

export type AuditIdAliasReason = 'CONTAINS_UNDERSCORE' | 'RESERVED_SHAPE' | 'NOT_ENGINE_VALID';

export interface AuditIdAlias {
  readonly applied: boolean;
  readonly rule: 'IDENTITY' | typeof AUDIT_ID_ALIAS_RULE;
  readonly reason: AuditIdAliasReason | null;
  /** O `auditId` real (o armazenamento usa sempre este). */
  readonly sourceAuditId: string;
  /** O `auditId` que entra no `ScoringInput`. */
  readonly scoringAuditId: string;
}

function aliasOf(sourceAuditId: string): string {
  const digest = sha256Hex(`${AUDIT_ID_ALIAS_RULE}\n${sourceAuditId}`).slice(0, DIGEST_HEX);
  // o 1º caractere do id é alfanumérico (padrão do armazenamento): o trecho legível nunca fica vazio
  const readable = sourceAuditId.replace(/_/g, '-').slice(0, MAX_READABLE).replace(/-+$/, '');
  return `${readable}-ux${digest}`;
}

/** `null` se o id não é um `auditId` válido do armazenamento (nada é adaptado a partir de lixo). */
export function deriveAuditIdAlias(sourceAuditId: unknown): AuditIdAlias | null {
  if (typeof sourceAuditId !== 'string' || !STORE_AUDIT_ID.test(sourceAuditId)) return null;
  const reserved = RESERVED_ALIAS_SHAPE.test(sourceAuditId);
  const underscore = sourceAuditId.includes('_');
  if (!underscore && !reserved && ENGINE_AUDIT_ID.test(sourceAuditId)) {
    return { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId, scoringAuditId: sourceAuditId };
  }
  const reason: AuditIdAliasReason = underscore ? 'CONTAINS_UNDERSCORE' : reserved ? 'RESERVED_SHAPE' : 'NOT_ENGINE_VALID';
  return { applied: true, rule: AUDIT_ID_ALIAS_RULE, reason, sourceAuditId, scoringAuditId: aliasOf(sourceAuditId) };
}

/** Recalcula o alias a partir do id de origem e confere TODOS os campos (o que está gravado precisa ser reproduzível). */
export function verifyAuditIdAlias(alias: unknown): boolean {
  if (typeof alias !== 'object' || alias === null) return false;
  const given = alias as Partial<AuditIdAlias>;
  const expected = deriveAuditIdAlias(given.sourceAuditId);
  return (
    expected !== null &&
    given.applied === expected.applied &&
    given.rule === expected.rule &&
    given.reason === expected.reason &&
    given.scoringAuditId === expected.scoringAuditId &&
    ENGINE_AUDIT_ID.test(expected.scoringAuditId)
  );
}
