import { GUARD_MAX_LAG, type GuardPseudonyms } from '../link-audit-ledger';
import type { LedgerBackup } from './backup';

/*
 * NÚCLEO PURO da reconciliação externa da guarda (G1.b.2b, GE-E5, PG-G09; spec `link-audit-production-gates.md` §5.1.4 regras 2, 3 e 6, §5.1.5).
 * Sem disco, rede, relógio nem ambiente: recebe a rodada de backup do livro já conferida, as cabeças lidas da guarda (a maior linha de CADA
 * pseudônimo, de todas as auditorias), o registro anterior da própria reconciliação (as linhas da guarda que ela já viu) e o que a guarda tem hoje
 * nessas posições. Devolve, por auditoria do backup, a situação equivalente à `externalGuard` da tela, os ACHADOS e as linhas do próximo registro.
 *
 * Achados (cada um ⇒ código de saída ≠ 0 no CLI):
 *  - GUARD_REGRESSED: uma linha do registro anterior sumiu ou mudou (hash ou chave). A guarda é append-only e monotônica: isso só acontece com o dono
 *    ou administrador do projeto Supabase (inclusive com `session_replication_role`, que desliga os gatilhos) ou com a conta tomada (regra 6);
 *  - GUARD_HEAD_NOT_IN_BACKUP: a cabeça da guarda está além da cauda da cópia (backup mais velho que a guarda: restaurá-lo congela a auditoria);
 *  - GUARD_HEAD_WITHOUT_LEDGER: pseudônimo de uma chave conhecida que não corresponde a nenhuma auditoria da cópia (livro ausente do backup);
 *  - GUARD_HEAD_UNKNOWN_KEY: linha sob uma chave que a reconciliação não tem (o web publica com chave fora da custódia, aposentada retirada cedo
 *    da lista da reconciliação, ou lixo gravado com a credencial de escrita);
 *  - HASH_MISMATCH: na posição da cabeça, o backup tem outro registro (a cópia não é o histórico testemunhado);
 *  - BACKUP_AHEAD_BEYOND_L_MAX: a cópia passa da cabeça por mais de `L_max` registros (`GUARD_LAGGING` na tela);
 *  - GUARD_HEAD_MISSING: livro com ≥ 2 registros e nenhuma cabeça sob nenhuma chave (regra 2);
 *  - BACKUP_LEDGER_UNREADABLE: o livro da auditoria na cópia não passou no leitor do livro.
 *
 * MÍNIMO NECESSÁRIO NA SAÍDA (decisão da G1.b.2b): o pseudônimo SEMPRE (é o que a guarda guarda); o `auditId` só quando o PRÓPRIO backup o fornece
 * (nome da pasta da auditoria na cópia), porque a ação humana (abandonar, investigar, escolher outra rodada) precisa saber qual auditoria. Linha sem
 * auditoria na cópia sai só com o pseudônimo. Auditoria sem problema não é listada: só entra nas contagens (a não ser no portão, que lista as que não
 * estão `CONSISTENT`). O registro da reconciliação nunca guarda `auditId`.
 *
 * MARCA D'ÁGUA: o próximo registro guarda as cabeças de agora MAIS as linhas do registro anterior que regrediram. Assim uma regressão nunca vira a
 * nova base em silêncio: ela é cobrada de novo em toda rodada seguinte.
 */

/** Uma linha da guarda (a cabeça de um pseudônimo). */
export interface GuardRow {
  readonly auditRef: string;
  readonly keyId: string;
  readonly ledgerSeq: number;
  readonly sha256: string;
}
export const FINDING_CODES = ['GUARD_REGRESSED', 'GUARD_HEAD_NOT_IN_BACKUP', 'GUARD_HEAD_WITHOUT_LEDGER', 'GUARD_HEAD_UNKNOWN_KEY', 'HASH_MISMATCH', 'BACKUP_AHEAD_BEYOND_L_MAX', 'GUARD_HEAD_MISSING', 'BACKUP_LEDGER_UNREADABLE'] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export interface Finding {
  readonly code: FindingCode;
  /** Pseudônimo: o da linha da guarda, ou (achado do backup) o da auditoria sob a chave ATUAL. */
  readonly auditRef: string;
  /** Só quando a cópia tem a auditoria. */
  readonly auditId: string | null;
  /** Registros do livro da auditoria na cópia. */
  readonly backupSeq: number | null;
  /** Posição da cabeça da guarda (a maior, para a auditoria; a da linha, para o pseudônimo sem livro). */
  readonly guardSeq: number | null;
  /** Posição que o registro anterior guardava (só GUARD_REGRESSED). */
  readonly recordedSeq: number | null;
}
/** Equivalente da `externalGuard` da tela para a cópia: CONSISTENT, BEHIND (até `L_max`), NO_HEAD (livro ≤ 1, regra 2) ou DIVERGENT. */
export type AuditStatus = 'CONSISTENT' | 'BEHIND' | 'NO_HEAD' | 'DIVERGENT';
export interface AuditOutcome {
  readonly auditId: string;
  /** Pseudônimo sob a chave ATUAL. */
  readonly auditRef: string;
  readonly status: AuditStatus;
  readonly backupSeq: number | null;
  readonly guardSeq: number | null;
  readonly lag: number | null;
  /** A maior cabeça só existe sob uma chave APOSENTADA (a atual não a tem): a aposentada ainda não pode sair da lista do web. */
  readonly onRetiredKey: boolean;
}
export interface AnalysisSummary {
  readonly audits: number;
  readonly consistent: number;
  readonly behind: number;
  readonly noHead: number;
  readonly divergent: number;
  /** Auditorias cuja maior cabeça só existe sob chave aposentada (spec §5.1.7: a aposentada sai do web só com 0). */
  readonly headsOnRetiredKey: number;
  readonly guardHeads: number;
  readonly findings: number;
}
export interface Analysis {
  readonly audits: readonly AuditOutcome[];
  readonly findings: readonly Finding[];
  /** Linhas do próximo registro (marca d'água), em ordem de pseudônimo e posição. */
  readonly witness: readonly GuardRow[];
  readonly summary: AnalysisSummary;
}
export interface AnalysisInput {
  readonly backup: LedgerBackup;
  readonly pseudonyms: GuardPseudonyms;
  /** A maior linha de cada pseudônimo da guarda (todas as auditorias). */
  readonly guardHeads: readonly GuardRow[];
  /** Linhas do registro anterior (`null` na primeira reconciliação). */
  readonly previous: readonly GuardRow[] | null;
  /** O que a guarda tem HOJE nas posições do registro anterior. */
  readonly previousNow: readonly GuardRow[];
}

const rowKey = (row: Pick<GuardRow, 'auditRef' | 'ledgerSeq'>): string => `${row.auditRef}:${row.ledgerSeq}`;
const byRefAndSeq = (x: GuardRow, y: GuardRow): number => (x.auditRef === y.auditRef ? x.ledgerSeq - y.ledgerSeq : x.auditRef < y.auditRef ? -1 : 1);
const finding = (code: FindingCode, auditRef: string, over: Partial<Omit<Finding, 'code' | 'auditRef'>> = {}): Finding => ({ code, auditRef, auditId: null, backupSeq: null, guardSeq: null, recordedSeq: null, ...over });

function compareFindings(x: Finding, y: Finding): number {
  const order = FINDING_CODES.indexOf(x.code) - FINDING_CODES.indexOf(y.code);
  if (order !== 0) return order;
  const ids = (x.auditId ?? '').localeCompare(y.auditId ?? '');
  if (ids !== 0) return ids;
  return x.auditRef === y.auditRef ? (x.guardSeq ?? 0) - (y.guardSeq ?? 0) : x.auditRef < y.auditRef ? -1 : 1;
}

const topOf = (rows: readonly GuardRow[]): number | null => (rows.length === 0 ? null : Math.max(...rows.map((row) => row.ledgerSeq)));
/** A maior posição não aparece sob o pseudônimo da chave atual. */
const onRetiredKey = (rows: readonly GuardRow[], currentRef: string): boolean => {
  const top = topOf(rows);
  return top !== null && !rows.some((row) => row.auditRef === currentRef && row.ledgerSeq === top);
};

/** Situação de UM livro da cópia diante das cabeças da guarda que lhe pertencem (sob qualquer chave). */
function auditOutcome(auditId: string, shas: readonly string[], rows: readonly GuardRow[], currentRef: string): { readonly outcome: AuditOutcome; readonly findings: readonly Finding[] } {
  const n = shas.length;
  const top = topOf(rows);
  const base = { auditId, auditRef: currentRef, backupSeq: n, guardSeq: top, onRetiredKey: onRetiredKey(rows, currentRef) };
  const found: Finding[] = [];
  for (const row of rows) {
    if (row.ledgerSeq > n) found.push(finding('GUARD_HEAD_NOT_IN_BACKUP', currentRef, { auditId, backupSeq: n, guardSeq: row.ledgerSeq }));
    else if (shas[row.ledgerSeq - 1] !== row.sha256) found.push(finding('HASH_MISMATCH', currentRef, { auditId, backupSeq: n, guardSeq: row.ledgerSeq }));
  }
  if (top === null) {
    if (n >= 2) return { outcome: { ...base, status: 'DIVERGENT', lag: null }, findings: [finding('GUARD_HEAD_MISSING', currentRef, { auditId, backupSeq: n })] };
    return { outcome: { ...base, status: 'NO_HEAD', lag: null }, findings: [] };
  }
  if (found.length > 0) return { outcome: { ...base, status: 'DIVERGENT', lag: null }, findings: found };
  const lag = n - top;
  if (lag > GUARD_MAX_LAG) return { outcome: { ...base, status: 'DIVERGENT', lag }, findings: [finding('BACKUP_AHEAD_BEYOND_L_MAX', currentRef, { auditId, backupSeq: n, guardSeq: top })] };
  return { outcome: { ...base, status: lag === 0 ? 'CONSISTENT' : 'BEHIND', lag }, findings: [] };
}

/** Linhas do registro anterior que a guarda não tem mais iguais (sumiram, mudaram de hash ou de chave). */
function regressedRows(previous: readonly GuardRow[], previousNow: readonly GuardRow[]): GuardRow[] {
  const now = new Map(previousNow.map((row) => [rowKey(row), row]));
  return previous.filter((row) => {
    const seen = now.get(rowKey(row));
    return seen === undefined || seen.sha256 !== row.sha256 || seen.keyId !== row.keyId;
  });
}

export function analyzeReconciliation(input: AnalysisInput): Analysis {
  // pseudônimo (sob cada chave) → auditoria da cópia
  const owner = new Map<string, string>();
  for (const ledger of input.backup.ledgers) for (const ref of input.pseudonyms.all(ledger.auditId)) owner.set(ref.auditRef, ledger.auditId);
  const known = new Set(input.pseudonyms.keyIds);
  const rowsOf = new Map<string, GuardRow[]>();
  const findings: Finding[] = [];
  for (const row of input.guardHeads) {
    const auditId = owner.get(row.auditRef);
    if (auditId === undefined) findings.push(finding(known.has(row.keyId) ? 'GUARD_HEAD_WITHOUT_LEDGER' : 'GUARD_HEAD_UNKNOWN_KEY', row.auditRef, { guardSeq: row.ledgerSeq }));
    else rowsOf.set(auditId, [...(rowsOf.get(auditId) ?? []), row]);
  }
  const outcomes = new Map<string, AuditOutcome>();
  for (const ledger of input.backup.ledgers) {
    const currentRef = input.pseudonyms.current(ledger.auditId).auditRef;
    const rows = rowsOf.get(ledger.auditId) ?? [];
    if (ledger.status === 'UNREADABLE') {
      const top = topOf(rows);
      findings.push(finding('BACKUP_LEDGER_UNREADABLE', currentRef, { auditId: ledger.auditId, guardSeq: top }));
      outcomes.set(ledger.auditId, { auditId: ledger.auditId, auditRef: currentRef, status: 'DIVERGENT', backupSeq: null, guardSeq: top, lag: null, onRetiredKey: onRetiredKey(rows, currentRef) });
      continue;
    }
    const result = auditOutcome(ledger.auditId, ledger.shas, rows, currentRef);
    outcomes.set(ledger.auditId, result.outcome);
    findings.push(...result.findings);
  }
  const regressed = input.previous === null ? [] : regressedRows(input.previous, input.previousNow);
  const headOf = new Map(input.guardHeads.map((row) => [row.auditRef, row.ledgerSeq]));
  for (const row of regressed) {
    const auditId = owner.get(row.auditRef) ?? null;
    const outcome = auditId === null ? undefined : outcomes.get(auditId);
    findings.push(finding('GUARD_REGRESSED', row.auditRef, { auditId, backupSeq: outcome?.backupSeq ?? null, guardSeq: headOf.get(row.auditRef) ?? null, recordedSeq: row.ledgerSeq }));
    if (outcome) outcomes.set(outcome.auditId, { ...outcome, status: 'DIVERGENT' });
  }
  const witness = new Map<string, GuardRow>();
  for (const row of [...input.guardHeads, ...regressed]) witness.set(rowKey(row), row);
  const audits = [...outcomes.values()].sort((x, y) => x.auditId.localeCompare(y.auditId));
  const count = (status: AuditStatus): number => audits.filter((audit) => audit.status === status).length;
  return {
    audits,
    findings: findings.sort(compareFindings),
    witness: [...witness.values()].sort(byRefAndSeq),
    summary: { audits: audits.length, consistent: count('CONSISTENT'), behind: count('BEHIND'), noHead: count('NO_HEAD'), divergent: count('DIVERGENT'), headsOnRetiredKey: audits.filter((audit) => audit.onRetiredKey).length, guardHeads: input.guardHeads.length, findings: findings.length },
  };
}

/** Portão G-1 sobre a análise: operante só com ≥ 1 auditoria na cópia, TODAS `CONSISTENT` e nenhum achado. */
export type GateAnalysisCode = 'NO_AUDITS' | 'STACK_NOT_PUBLISHING' | 'NOT_CONSISTENT';
export function gateVerdict(analysis: Analysis): { readonly operational: boolean; readonly code: GateAnalysisCode | null } {
  if (analysis.audits.length === 0) return { operational: false, code: 'NO_AUDITS' };
  if (analysis.audits.every((audit) => audit.guardSeq === null)) return { operational: false, code: 'STACK_NOT_PUBLISHING' };
  if (analysis.findings.length > 0 || analysis.audits.some((audit) => audit.status !== 'CONSISTENT')) return { operational: false, code: 'NOT_CONSISTENT' };
  return { operational: true, code: null };
}
