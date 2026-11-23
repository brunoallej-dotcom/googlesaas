import { GUARD_LATEST_SQL, GUARD_PUBLISH_SQL, type GuardDbConnect, type GuardDbSession, type GuardDbValue } from '../../src/lib/link-audit-ledger/guard-postgres';
import { createGuardPseudonyms, type GuardPseudonyms } from '../../src/lib/link-audit-ledger/guard-pseudonym';
import { testKeyMaterial } from './link-audit-origin-fixtures';

/*
 * G1.b.2a — PROVEDOR SIMULADO da guarda no Postgres (sem rede, sem banco): implementa as DUAS consultas que o adaptador real faz, com a MESMA
 * regra 7 da função `gmn_link_audit_guard.publish_head` da migração 004 (o teste local da migração confere a função de verdade). Registra toda
 * consulta (texto e valores) para provar que o `auditId` em claro nunca sai do processo, e conta conexões abertas e encerradas (sem vazamento).
 * As chaves de teste derivam de rótulos (`gk-test-*`), nunca um material fixo no repositório.
 */
export interface SimulatedHeadRow {
  readonly audit_ref: string;
  readonly key_id: string;
  readonly ledger_seq: number;
  readonly sha256: string;
}

export const guardKey = (id: string, label = id): { readonly id: string; readonly hex: string } => ({ id, hex: testKeyMaterial(label) });
export const GUARD_KEY_A = guardKey('gk-test-a', 'guard-a');
export const GUARD_KEY_B = guardKey('gk-test-b', 'guard-b');
export const GUARD_KEY_C = guardKey('gk-test-c', 'guard-c');
/** Chave A atual, sem aposentadas. */
export const PSEUDONYMS_A: GuardPseudonyms = createGuardPseudonyms(GUARD_KEY_A);
/** Rotação: B atual, A aposentada. */
export const PSEUDONYMS_B_AFTER_A: GuardPseudonyms = createGuardPseudonyms(GUARD_KEY_B, [GUARD_KEY_A]);

type Override = (text: string, values: readonly GuardDbValue[]) => Promise<{ readonly rows: readonly unknown[] }>;

export function simulatedGuardDb() {
  const rows: SimulatedHeadRow[] = [];
  const queries: Array<{ readonly text: string; readonly values: readonly GuardDbValue[] }> = [];
  const state = { connects: 0, ends: 0, open: 0, failConnect: false, failQuery: false, override: null as Override | null };

  /** A regra 7 da função SQL (004): mesmo registro ⇒ ALREADY_RECORDED; mesma posição com outro sha256/key_id ⇒ CONFLICT; abaixo do maior ⇒ STALE. */
  function publish(auditRef: string, keyId: string, ledgerSeq: number, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(auditRef) || !/^[a-z0-9][a-z0-9-]{3,31}$/.test(keyId) || !Number.isInteger(ledgerSeq) || ledgerSeq < 1 || ledgerSeq > 4000 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error('guarda: entrada fora do formato');
    }
    const at = rows.find((row) => row.audit_ref === auditRef && row.ledger_seq === ledgerSeq);
    if (at) return at.sha256 === sha256 && at.key_id === keyId ? 'ALREADY_RECORDED' : 'CONFLICT';
    const max = Math.max(0, ...rows.filter((row) => row.audit_ref === auditRef).map((row) => row.ledger_seq));
    if (ledgerSeq < max) return 'STALE';
    rows.push({ audit_ref: auditRef, key_id: keyId, ledger_seq: ledgerSeq, sha256 });
    return 'RECORDED';
  }
  /** `… and h.ledger_seq = (select max(...) …) order by audit_ref`: TODAS as linhas na maior posição de cada pseudônimo pedido. */
  function latest(refs: readonly string[]): SimulatedHeadRow[] {
    return [...new Set(refs)].sort().flatMap((ref) => {
      const mine = rows.filter((row) => row.audit_ref === ref);
      const top = Math.max(0, ...mine.map((row) => row.ledger_seq));
      return mine.filter((row) => row.ledger_seq === top).map((row) => ({ ...row }));
    });
  }

  const connect: GuardDbConnect = async () => {
    state.connects += 1;
    if (state.failConnect) throw new Error('sentinela: conexão recusada');
    state.open += 1;
    let ended = false;
    const session: GuardDbSession = {
      async query(text, values) {
        queries.push({ text, values });
        if (state.override) return state.override(text, values);
        if (state.failQuery) throw new Error('sentinela: consulta falhou');
        if (text === GUARD_PUBLISH_SQL) return { rows: [{ outcome: publish(values[0] as string, values[1] as string, values[2] as number, values[3] as string) }] };
        if (text === GUARD_LATEST_SQL) return { rows: latest(values[0] as readonly string[]) };
        throw new Error('sentinela: SQL desconhecido');
      },
      async end() {
        if (ended) return;
        ended = true;
        state.open -= 1;
        state.ends += 1;
      },
    };
    return session;
  };
  return { connect, rows, queries, state };
}
export type SimulatedGuardDb = ReturnType<typeof simulatedGuardDb>;

/** Tudo o que saiu do processo para o provedor, serializado (para procurar o `auditId` em claro). */
export const wireOf = (db: SimulatedGuardDb): string => JSON.stringify(db.queries);
