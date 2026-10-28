/**
 * Despejo completo das tabelas e comparação CAMPO A CAMPO antes/depois de uma escrita em produção.
 * Prova que só as linhas e colunas previstas mudaram.
 */
export interface RowsDump {
  readonly takenAt: string;
  readonly tables: Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>>;
}

export const DUMP_TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'] as const;

export async function dumpRows(readTable: (table: string) => Promise<readonly Record<string, unknown>[]>, now: Date = new Date()): Promise<RowsDump> {
  const tables: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const table of DUMP_TABLES) {
    const byId: Record<string, Record<string, unknown>> = {};
    for (const row of await readTable(table)) byId[String(row.id)] = row as Record<string, unknown>;
    tables[table] = byId;
  }
  return { takenAt: now.toISOString(), tables };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );

export interface RowChange {
  readonly table: string;
  readonly id: string;
  readonly columns: readonly string[];
  /** Chaves de primeiro nível alteradas dentro de `diagrammer_payload`. */
  readonly payloadKeys: readonly string[];
}

export interface RowsDiff {
  readonly changed: readonly RowChange[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export function diffRows(before: RowsDump, after: RowsDump): RowsDiff {
  const changed: RowChange[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const table of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const was = before.tables[table] ?? {};
    const now = after.tables[table] ?? {};
    for (const id of Object.keys(now)) if (!(id in was)) added.push(`${table}/${id}`);
    for (const id of Object.keys(was)) {
      if (!(id in now)) { removed.push(`${table}/${id}`); continue; }
      const columns = [...new Set([...Object.keys(was[id]!), ...Object.keys(now[id]!)])].filter((c) => stable(was[id]![c]) !== stable(now[id]![c])).sort();
      if (columns.length === 0) continue;
      const payloadKeys: string[] = [];
      if (columns.includes('diagrammer_payload')) {
        const a = (was[id]!.diagrammer_payload ?? {}) as Record<string, unknown>;
        const b = (now[id]!.diagrammer_payload ?? {}) as Record<string, unknown>;
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (stable(a[key]) !== stable(b[key])) payloadKeys.push(key);
      }
      changed.push({ table, id, columns, payloadKeys: payloadKeys.sort() });
    }
  }
  return { changed, added, removed };
}

/** Só estas linhas e colunas podem mudar; `updated_at` muda por causa do trigger do banco. */
export function checkAllowedChanges(diff: RowsDiff, allowedIds: readonly string[], allowedColumns: readonly string[], allowedPayloadKeys: readonly string[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const id of diff.added) violations.push(`linha nova: ${id}`);
  for (const id of diff.removed) violations.push(`linha removida: ${id}`);
  for (const change of diff.changed) {
    if (change.table !== 'gmn_audits' || !allowedIds.includes(change.id)) violations.push(`linha alterada fora do escopo: ${change.table}/${change.id} (${change.columns.join(', ')})`);
    for (const column of change.columns) if (!allowedColumns.includes(column)) violations.push(`coluna fora do escopo: ${change.table}/${change.id}.${column}`);
    for (const key of change.payloadKeys) if (!allowedPayloadKeys.includes(key)) violations.push(`chave do payload fora do escopo: ${change.id}.diagrammer_payload.${key}`);
  }
  const touched = new Set(diff.changed.filter((c) => c.table === 'gmn_audits').map((c) => c.id));
  for (const id of allowedIds) if (!touched.has(id)) violations.push(`linha prevista não foi alterada: ${id}`);
  return { ok: violations.length === 0, violations };
}
