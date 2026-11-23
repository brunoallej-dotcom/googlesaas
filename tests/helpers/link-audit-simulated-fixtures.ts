import { runCli, type CliDeps } from '../../scripts/link-audit-collect';
import type { EnvLike } from '../../src/lib/link-audit-runtime/config';

/* W5.2b (spec do P1 §5.7): coleta SIMULADA pelo CLI, com dependências injetadas. Dados 100% SINTÉTICOS; nenhuma rede nem arquivo de ambiente. */
export const SIM_AUDIT_ID = 'ensaio-w5-cli-0001';
export const SIM_OPERATOR = 'operador-ensaio@exemplo.invalid';
export const SIM_NOW = '2026-11-22T10:00:00.000Z';
export const HOMOLOGATION_ENV: EnvLike = { GMN_LINK_AUDIT_HOMOLOGATION: '1' };

export interface SimHarness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
  /** Chamadas que o modo SIMULATED NUNCA pode fazer. */
  readonly forbidden: { loadEnv: number; usedStore: number; createLiveProviders: number };
}

export function simHarness(env: EnvLike, now: string = SIM_NOW): SimHarness {
  const out: string[] = [];
  const err: string[] = [];
  const forbidden = { loadEnv: 0, usedStore: 0, createLiveProviders: 0 };
  const deps: CliDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date(now),
    loadEnv: () => {
      forbidden.loadEnv += 1;
    },
    getEnv: () => env,
    usedStore: () => {
      forbidden.usedStore += 1;
      throw new Error('o modo SIMULATED não usa o registro de autorizações');
    },
    createLiveProviders: () => {
      forbidden.createLiveProviders += 1;
      throw new Error('o modo SIMULATED nunca cria provedor real');
    },
  };
  return { deps, out, err, forbidden };
}

export const simArgs = (evidenceDir: string, extra: readonly string[] = [], auditId = SIM_AUDIT_ID): string[] => ['--simulated', '--audit', auditId, '--operator', SIM_OPERATOR, '--evidence-dir', evidenceDir, ...extra];

/** S-02 do ensaio: coleta simulada com a trava, em `--json`. Devolve o código, o relatório impresso e o hash que o operador registra. */
export async function collectSimulated(evidenceDir: string, auditId = SIM_AUDIT_ID): Promise<{ code: number; report: { source: { capture: { sha256: string }; simulated?: boolean; provider: string } }; collectorHash: string; harness: SimHarness }> {
  const harness = simHarness(HOMOLOGATION_ENV);
  const code = await runCli(simArgs(evidenceDir, ['--json'], auditId), harness.deps);
  if (code !== 0 || harness.out.length !== 1) throw new Error(`fixture: coleta simulada falhou (${code}): ${harness.err.join(' | ')}`);
  const report = JSON.parse(harness.out[0] as string) as { source: { capture: { sha256: string }; simulated?: boolean; provider: string } };
  return { code, report, collectorHash: report.source.capture.sha256, harness };
}
