import { createHmac, hkdfSync } from 'node:crypto';

/*
 * PSEUDÔNIMO da auditoria na guarda externa (D-G0-5; spec `link-audit-production-gates.md` §5.1.4 regra 8 e §5.1.7). O provedor NUNCA recebe o
 * `auditId` (ele pode nascer do nome da empresa): recebe `audit_ref` = HMAC-SHA-256 do `auditId` com uma chave DERIVADA (HKDF-SHA-256, rótulo e sal
 * próprios da guarda) de `GMN_LINK_AUDIT_GUARD_KEY`, mais o id PÚBLICO dessa chave. A chave atual é a única que publica; as aposentadas (rotação por
 * comprometimento) só entram na LEITURA: o `latest` consulta o pseudônimo de cada chave e fica com o maior `ledgerSeq`.
 *
 * Puro: recebe o material já validado pela configuração (`config.ts`, mesma política de formato e de sanidade das outras chaves da Fase 6) e nunca o
 * expõe — o material derivado fica só no fecho. Ponto de extensão da reconciliação externa (G1.b.2b, GE-E5): ela recalcula os mesmos pseudônimos
 * fora da VPS com a chave sob custódia do responsável. Mudar a derivação equivale a trocar a chave (as cabeças gravadas deixam de ser achadas).
 */
export const GUARD_PSEUDONYM_SALT = 'gmn.link-audit.guard.salt';
export const GUARD_PSEUDONYM_INFO = 'gmn.link-audit.guard.audit-ref.v1';
const DERIVED_BYTES = 32;
const KEY_ID = /^[a-z0-9][a-z0-9-]{3,31}$/;
const MATERIAL = /^[0-9a-f]{64}$/;

/** Par id/material de uma chave da guarda (só entre a configuração e este módulo). */
export interface GuardKeyMaterial {
  readonly id: string;
  readonly hex: string;
}
/** Pseudônimo de uma auditoria sob UMA chave: o que vai para o provedor (nunca o `auditId`). */
export interface GuardRef {
  readonly keyId: string;
  readonly auditRef: string;
}
export interface GuardPseudonyms {
  /** Id público da chave atual (a única que publica). */
  readonly currentKeyId: string;
  /** Ids públicos de todas as chaves, a atual primeiro (nunca material). */
  readonly keyIds: readonly string[];
  /** Pseudônimo sob a chave ATUAL (publicação). */
  current(auditId: string): GuardRef;
  /** Pseudônimos sob TODAS as chaves, a atual primeiro (leitura do `latest`). */
  all(auditId: string): readonly GuardRef[];
}

/** Lança (sem citar material) se a lista for malformada: id ou material fora do formato, id repetido ou o mesmo material sob dois ids. */
export function createGuardPseudonyms(current: GuardKeyMaterial, retired: readonly GuardKeyMaterial[] = []): GuardPseudonyms {
  const keys = [current, ...retired];
  for (const key of keys) if (!KEY_ID.test(key.id) || !MATERIAL.test(key.hex)) throw new Error('chave da guarda fora do formato');
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error('identificador de chave da guarda repetido');
  if (new Set(keys.map((key) => key.hex)).size !== keys.length) throw new Error('a mesma chave aparece sob dois identificadores da guarda');
  const derived = keys.map((key) => ({ keyId: key.id, secretKey: Buffer.from(hkdfSync('sha256', Buffer.from(key.hex, 'hex'), GUARD_PSEUDONYM_SALT, GUARD_PSEUDONYM_INFO, DERIVED_BYTES)) }));
  const refOf = (entry: (typeof derived)[number], auditId: string): GuardRef => ({ keyId: entry.keyId, auditRef: createHmac('sha256', entry.secretKey).update(auditId, 'utf8').digest('hex') });
  const first = derived[0] as (typeof derived)[number];
  return Object.freeze({
    currentKeyId: first.keyId,
    keyIds: Object.freeze(derived.map((entry) => entry.keyId)),
    current: (auditId: string) => refOf(first, auditId),
    all: (auditId: string) => derived.map((entry) => refOf(entry, auditId)),
  });
}
