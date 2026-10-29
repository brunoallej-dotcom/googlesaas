import { parseScoringInput, type OperatorRecord } from '../link-audit/scoring/input';
import { SCORING_INPUT_SCHEMA_VERSION } from '../link-audit/scoring/versions';

/*
 * Compatibilidade com a Onda 6A. Em vez de copiar as regras, o conjunto de registros vigentes passa pelo MESMO
 * `parseScoringInput` do motor (schema estrito + validação cruzada), dentro de uma entrada mínima. As evidências
 * citadas entram como evidências armazenadas (já confirmadas pelo leitor) e o motor continua sendo o único juiz.
 *
 * Única regra que depende de dados que a 6B não tem (o escopo de leitura do site, que vem da coleta/6C):
 * "atestado só vale para escopo SITEMAP_COMPLETE ou DOCUMENTED_FULL_REVIEW". Ela é descartada AQUI e verificada
 * quando a 6C montar a entrada completa. Um teste garante que é a única regra descartada.
 */
export const SITE_SCOPE_ISSUE = /só vale para escopo SITEMAP_COMPLETE ou DOCUMENTED_FULL_REVIEW/;

const PLACEHOLDER_AUDIT_ID = 'auditoria-decisoes';

export function checkOperatorRecordsContract(records: readonly OperatorRecord[], evidenceRefs: Iterable<string>, nowIso: string): string[] {
  const evidences = [...new Set(evidenceRefs)].sort().map((id) => ({
    id,
    origin: 'GOOGLE_NATIVE',
    capture: 'STORED_CAPTURE',
    status: 'VERIFIED',
    observedAt: nowIso,
    contentSha256: '0'.repeat(64),
  }));
  const parsed = parseScoringInput({
    schemaVersion: SCORING_INPUT_SCHEMA_VERSION,
    auditId: PLACEHOLDER_AUDIT_ID,
    referenceDate: nowIso.slice(0, 10),
    evidences,
    operatorRecords: records,
  });
  if (parsed.ok) return [];
  return parsed.issues.filter((issue) => !SITE_SCOPE_ISSUE.test(issue));
}
