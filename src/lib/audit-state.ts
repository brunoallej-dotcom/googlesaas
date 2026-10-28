import type { AgentName, AuditPipelineStage } from '@/types/gmn';

/** Translate Supabase columns to the stable API response consumed by the UI. */
export function normalizeAuditRow(row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {
    auditId: String(row.id),
    status: row.status as AuditPipelineStage,
    progressPercent: Number(row.progress_percent ?? 0),
    currentAgent: (row.current_agent ?? 'MAESTRO') as AgentName,
  };

  const mappings: readonly [string, string][] = [
    ['reputation_payload', 'reputation'],
    ['vitrine_payload', 'vitrine'],
    ['battlefield_payload', 'battlefield'],
    ['rivals_payload', 'rivals'],
    ['judge_payload', 'judge'],
    ['strategist_payload', 'strategist'],
    ['reviewer_audit_log', 'reviewerLogs'],
    ['diagrammer_payload', 'diagrammer'],
  ];

  for (const [from, to] of mappings) {
    if (row[from] !== null && row[from] !== undefined) {
      record[to] = row[from];
    }
  }

  if (typeof row.updated_at === 'string') record.updatedAt = row.updated_at;
  if (typeof row.created_at === 'string') record.createdAt = row.created_at;

  if (typeof row.error_message === 'string' && row.error_message) {
    record.errorMessage = row.error_message;
  }

  return record;
}

/** Normaliza a palavra-chave para comparar auditorias (sem diferenciar caixa nem espaços extras). */
export function normalizeAuditKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Escolhe, por empresa (`place_id`), a auditoria CONCLUÍDA mais recente da palavra-chave informada.
 * Ignora auditorias em andamento, com falha ou de outra palavra-chave.
 */
export function selectLatestCompletedAudits(
  rows: readonly Record<string, unknown>[],
  keyword: string
): Record<string, Record<string, unknown>> {
  const wanted = normalizeAuditKeyword(keyword);
  const latest = new Map<string, { row: Record<string, unknown>; createdAt: string }>();

  for (const row of rows) {
    if (row.status !== 'COMPLETED' || typeof row.place_id !== 'string') continue;
    if (normalizeAuditKeyword(String(row.target_keyword ?? '')) !== wanted) continue;

    const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
    const current = latest.get(row.place_id);
    if (!current || createdAt > current.createdAt) {
      latest.set(row.place_id, { row, createdAt });
    }
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [placeId, { row }] of latest) {
    result[placeId] = normalizeAuditRow(row);
  }
  return result;
}
