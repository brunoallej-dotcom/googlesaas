import path from 'node:path';
import { sha256Hex } from '../link-audit/canonical';
import { HASH_DISCLAIMER } from '../link-audit/snapshot';
import type { FsOps } from '../link-audit/snapshot-store';
import type { IntegrityInfo } from './reader';

/*
 * Leitura SOMENTE LEITURA do layout LEGADO (pasta plana: MANIFEST.json + SHA256SUMS + report*.json), extraída de
 * `reader.ts` sem mudança de comportamento (Onda 6C, I1) para que o leitor de evidências e o leitor de pontuação
 * apliquem EXATAMENTE a mesma verificação de integridade. Acrescenta apenas dois retornos: os hashes que foram
 * conferidos (`verifiedHashes`) e o texto do corpo do provedor quando ele conferiu (`verifiedBodyText`).
 */
const LEGACY_FILES = ['serper-body.json', 'serper-status.json', 'serper-attempts.json', 'summary.json', 'run-stdout.txt', 'run-stderr.txt'] as const;
const MAX_LEGACY_BYTES = 6 * 1024 * 1024;
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function integrityInfo(status: IntegrityInfo['status'], checkedFiles: number, issues: readonly string[]): IntegrityInfo {
  return { status, algorithm: 'SHA-256', checkedFiles, issues, note: HASH_DISCLAIMER };
}

export interface LegacyReportFile {
  readonly file: string;
  readonly revision: number;
  readonly superseded: boolean;
  readonly report: Record<string, unknown> | null;
}

export interface LegacyRead {
  readonly integrity: IntegrityInfo;
  readonly reports: LegacyReportFile[];
  readonly body: Record<string, unknown> | null;
  readonly status: Record<string, unknown> | null;
  readonly attempts: Record<string, unknown> | null;
  /** SHA-256 (hex) dos arquivos cuja conferência com o SHA256SUMS / hash declarado passou. */
  readonly verifiedHashes: Readonly<Record<string, string>>;
  /** Texto de `serper-body.json` SOMENTE se o hash conferiu; senão `null`. */
  readonly verifiedBodyText: string | null;
  /** Texto de `serper-status.json` SOMENTE se o hash conferiu; senão `null`. */
  readonly verifiedStatusText: string | null;
}

/** Legado: pasta plana (MANIFEST.json + SHA256SUMS + report*.json). Somente leitura. */
export async function readLegacyAudit(ops: FsOps, dir: string): Promise<LegacyRead> {
  const issues: string[] = [];
  let checked = 0;
  const verifiedHashes: Record<string, string> = {};
  let verifiedBodyText: string | null = null;
  let verifiedStatusText: string | null = null;
  const text = async (name: string): Promise<string | null> => {
    try {
      return await ops.readFile(path.join(dir, name), MAX_LEGACY_BYTES);
    } catch {
      return null;
    }
  };
  const sums = await text('SHA256SUMS');
  if (!sums) issues.push('SHA256SUMS ausente.');
  else {
    const listed = new Set<string>();
    // Sem linhas repetidas e com teto: um SHA256SUMS hostil não pode forçar leituras sem fim.
    for (const line of [...new Set(sums.split('\n').filter(Boolean))].slice(0, 50)) {
      const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
      if (!m) {
        issues.push('SHA256SUMS malformado.');
        continue;
      }
      const name = m[2] as string;
      const content = (LEGACY_FILES as readonly string[]).includes(name) ? await text(name) : null;
      if (content === null) issues.push(`Arquivo listado ausente ou inesperado: ${name}.`);
      else if (sha256Hex(content) !== m[1]) issues.push(`SHA-256 divergente: ${name}.`);
      else {
        checked += 1;
        verifiedHashes[name] = m[1] as string;
        if (name === 'serper-body.json') verifiedBodyText = content;
      if (name === 'serper-status.json') verifiedStatusText = content;
      }
      listed.add(name);
    }
    for (const name of LEGACY_FILES) if (!listed.has(name)) issues.push(`Arquivo esperado fora da lista de hashes: ${name}.`);
  }
  const reports: Array<{ file: string; revision: number; superseded: boolean; report: Record<string, unknown> | null }> = [];
  for (const [file, sumFile, revision, superseded] of [
    ['report.v1-superseded.json', 'report.v1-superseded.json.sha256', 1, true],
    ['report.json', 'report.json.sha256', 2, false],
  ] as const) {
    const content = await text(file);
    if (content === null) continue;
    const declared = /^([0-9a-f]{64})/m.exec((await text(sumFile)) ?? '')?.[1];
    if (!declared) issues.push(`${file} não tem hash declarado (${sumFile} ausente ou inválido): a integridade do relatório não pode ser confirmada.`);
    else if (sha256Hex(content) !== declared) issues.push(`${file} não confere com o hash declarado.`);
    else {
      checked += 1;
      verifiedHashes[file] = declared;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = rec(JSON.parse(content));
    } catch {
      issues.push(`${file} não é JSON válido.`);
    }
    reports.push({ file, revision, superseded, report: parsed });
  }
  const json = async (name: string): Promise<Record<string, unknown> | null> => {
    const t = await text(name);
    try {
      return t ? rec(JSON.parse(t)) : null;
    } catch {
      return null;
    }
  };
  return { integrity: integrityInfo(issues.length > 0 ? 'MISMATCH' : checked > 0 ? 'OK' : 'INCOMPLETE', checked, issues), reports, body: await json('serper-body.json'), status: await json('serper-status.json'), attempts: await json('serper-attempts.json'), verifiedHashes, verifiedBodyText, verifiedStatusText };
}
