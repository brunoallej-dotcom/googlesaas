import path from 'node:path';
import type { LedgerPort } from '@/lib/link-audit-decisions';
import { createLedgerService, createUnconfiguredLedger, ledgerConfigFromProcess } from '@/lib/link-audit-ledger';

/**
 * LIVRO DE CABEÇAS das rotas (Q2/Q3): pasta própria (`GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR`) e chave EXCLUSIVA do livro. Pasta ou chave ausente, fraca,
 * contraditória ou igual à de origem ⇒ o livro é `NOT_CONFIGURED` e NENHUMA decisão é gravada (falha fechada). A guarda externa NÃO está ligada
 * (não existe provedor): o estado diz `NOT_CONFIGURED` e nada afirma proteção contra rollback coordenado.
 * As rotas nunca recebem o ambiente inteiro: elas só leem as duas pastas abaixo; as CHAVES são lidas pelo módulo do livro (um teste confere).
 */
const pick = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  return value && !value.includes('\0') && path.isAbsolute(value) ? path.resolve(value) : null;
};
export const ledgerDirOf = (): string | null => pick(process.env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR);
export const sealsDirOf = (): string | null => pick(process.env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR);

export function ledgerForRoutes(otherDirs: ReadonlyArray<string | null | undefined>): LedgerPort {
  const config = ledgerConfigFromProcess(() => new Date());
  return config.ok ? createLedgerService({ dir: config.dir, authenticator: config.authenticator, otherDirs: [...otherDirs, sealsDirOf()] }) : createUnconfiguredLedger();
}
