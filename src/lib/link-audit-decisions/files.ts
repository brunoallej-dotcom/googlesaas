import { locateIn as locateInStorage, type IdRule, type Location, type StoreResult } from '../link-audit-storage';
import { AUDIT_ID_PATTERN } from './types';

/*
 * Primitivas compartilhadas pelo armazenamento das decisões e pelo das âncoras: selo SHA-256, leitura ESTRITA dos bytes,
 * caminhos seguros, bloqueio após erro fatal de disco e a garantia de que só se grava de forma atômica.
 *
 * Desde a Onda 6C (I0) elas vivem no módulo NEUTRO `../link-audit-storage`; este arquivo só as REEXPORTA, com os mesmos nomes,
 * assinaturas, códigos de erro e mensagens da Onda 6B (provado por `tests/link-audit-storage-conformance.test.ts`). A única
 * diferença de forma: o padrão do identificador da auditoria deixou de estar embutido nas primitivas e a 6B o informa aqui.
 */
export {
  assertBase,
  atomicOnly,
  ATOMIC_UNAVAILABLE_ERRNO,
  clearStorageFatal,
  dirStatus,
  DURABILITY_UNPROVEN_MESSAGE,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  hashOk,
  isBaseTripped,
  isStorageFatal,
  mapOrdered,
  READ_CONCURRENCY,
  readSealedFile,
  scrubPaths,
  seal,
  serialize,
  splitNames,
  tripBase,
  watchDurability,
} from '../link-audit-storage';
export type { DirStatus, Location, StoreErrorCode, StoreFailure, StoreOptions, StoreResult } from '../link-audit-storage';

const AUDIT_ID_RULE: IdRule = { pattern: AUDIT_ID_PATTERN, message: 'auditId inválido (8 a 64 caracteres: letras minúsculas, números, _ e -).' };

export function locateIn(baseDir: unknown, auditId: unknown, projectRoot: string, label: string): StoreResult<Location> {
  return locateInStorage(baseDir, auditId, projectRoot, label, AUDIT_ID_RULE);
}
