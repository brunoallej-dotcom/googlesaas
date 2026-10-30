import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, tickClock, type Spec } from './link-audit-results-fixtures';

/*
 * Processo FILHO dos testes de concorrência da Onda 6C (I4): finaliza UMA vez e imprime uma linha JSON com o desfecho. Roda com
 * `node --require tests/register-typescript.cjs` e recebe tudo por argumento (pastas temporárias, operador e a "visão" do mundo).
 * Dados fictícios; nenhuma rede.
 */
interface Config {
  readonly base: string;
  readonly anchors: string;
  readonly other: string;
  readonly auditId: string;
  readonly actor: { email: string };
  /** Estado REAL do mundo (o que o avaliador enxerga). */
  readonly world: Spec;
  /** O que o operador VIU (corpo enviado); por padrão, o próprio mundo. */
  readonly seen?: Spec;
  /** Largada sincronizada (ms desde a época) para sobrepor os processos. */
  readonly startAt: number;
  readonly crashBeforeReceipt?: boolean;
  readonly clockStart: number;
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] as string) as Config;
  const world = buildEvaluation(config.world);
  const seen = config.seen ? buildEvaluation(config.seen) : world;
  const ops = config.crashBeforeReceipt
    ? {
        ...nodeFsOps,
        async writeExclusive(target: string, data: string, mode?: number) {
          if (target.startsWith(config.anchors)) process.kill(process.pid, 'SIGKILL'); // cai depois do resultado, antes do recibo
          return nodeFsOps.writeExclusive(target, data, mode);
        },
      }
    : nodeFsOps;
  const service = makeService({ base: config.base, anchors: config.anchors, other: config.other }, new FakeEvaluator(world), { fs: ops, clock: tickClock(config.clockStart) });
  while (Date.now() < config.startAt) await new Promise((resolve) => setTimeout(resolve, 1));
  const result = await service.finalize(config.actor, config.auditId, bodyOf(seen));
  process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, replayed: result.value.replayed, seq: result.value.head.seq } : { ok: false, code: result.code })}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'CHILD_CRASH' })}\n`);
  process.exitCode = 1;
});
