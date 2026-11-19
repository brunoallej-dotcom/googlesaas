import { createDecisionService } from '../../src/lib/link-audit-decisions';
import { createEvidenceReader } from '../../src/lib/link-audit-evidence';
import { createResultsKnownHeads } from '../../src/lib/link-audit-scoring-runs';
import { createLedgerService, deriveCapacityPolicy } from '../../src/lib/link-audit-ledger';
import { nodeFsOps, type FsOps } from '../../src/lib/link-audit/snapshot-store';
import fs from 'node:fs';
import { ledgerAuth, LEDGER_AUTH_A, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS } from './link-audit-ledger-fixtures';
import { rec } from './link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';

/*
 * FILHO dos testes do livro (processo À PARTE, para provar concorrência e queda DE VERDADE, não só com mutex em memória ou exceção simulada).
 * Configuração por variável de ambiente `LEDGER_CHILD` (JSON): pastas temporárias recebidas do pai; nada fora delas é tocado. Chaves fictícias.
 *  - `task: 'create'` com `crash`: faz UMA criação e se mata com SIGKILL antes/depois de publicar (`link`) um arquivo cujo nome termina em `match`.
 *  - `task: 'recover'`: roda `RECOVER` (com o mesmo mecanismo de queda opcional).
 *  - `task: 'recover-retry'`: `RECOVER` com novas tentativas SÓ no 409 transitório da §16.16 (`PENDING_UNCONFIRMED`); qualquer outra recusa volta como veio.
 *  - `task: 'workload'`: várias rodadas de criar+revogar a MESMA decisão própria, com tentativas; imprime um resumo JSON.
 *  - `task: 'finalize'` (com `withPort`, R1.3): avalia e finaliza PELA PORTA de escrita do livro; `startAt` sobrepõe processos; `crash` derruba em torno de um `link()` ou fsync.
 */
interface Config {
  readonly task: 'create' | 'recover' | 'recover-retry' | 'workload' | 'enroll' | 'revoke' | 'create-retry' | 'revoke-retry' | 'list' | 'finalize';
  /** `revoke`: decisão a revogar. */
  readonly decisionId?: string;
  /** Política de capacidade PEQUENA (só testes): total, revogações reservadas e intervalo dos pontos de verificação. */
  readonly capacity?: { readonly max: number; readonly revocations: number; readonly every: number };
  /** Rotação planejada: chave B atual e A aposentada (validade 30 dias a partir de hoje). */
  readonly rotated?: boolean;
  /** O fsync do diretório dessa pasta falha (EIO) neste processo. */
  readonly failSync?: 'decisions' | 'anchors' | 'ledger';
  /** `true`: a falha vale também para a PRÓPRIA pasta-base (o pai da pasta da auditoria); `false` (padrão): só a pasta da auditoria e o que há dentro dela. */
  readonly failSyncParents?: boolean;
  /** `true`: a falha do fsync vale SÓ para a pasta-base (a RAIZ do livro/decisões/recibos, onde vive o nome da pasta da auditoria), não para a pasta da auditoria. */
  readonly failSyncBaseOnly?: boolean;
  /** A falha do fsync só vale quando o arquivo com este nome JÁ existe na pasta sincronizada (ex.: `l000003.json`): falha exatamente na sincronização que torna ESSE registro durável. */
  readonly failSyncWhenExists?: string;
  /** `create`: reenvia o MESMO pedido original (`expectedHead: null`), em vez de recalcular a cabeça a partir da leitura. */
  readonly resend?: boolean;
  /** Arquivo onde este processo registra cada diretório que sincronizou com SUCESSO (uma linha por chamada). */
  readonly syncLog?: string;
  readonly decisionsDir: string;
  readonly anchorDir: string;
  readonly evidenceDir: string;
  readonly ledgerDir: string;
  readonly auditId: string;
  readonly actor: string;
  /** `before`/`after`: em torno do `link()` de um arquivo cujo caminho termina em `match`; `after-temp`: depois do temporário; `sync-before`/`sync-after`: em torno do fsync do diretório `match` (caminho exato). */
  readonly crash?: { readonly at: 'before' | 'after' | 'after-temp' | 'sync-before' | 'sync-after'; readonly match: string };
  /** `finalize`: grava PELA PORTA de escrita do livro (R1.3: `RUN_INTENT` antes do resultado, `RUN_CONFIRMED` depois do recibo). */
  readonly withPort?: boolean;
  /** Largada sincronizada (ms desde a época) para sobrepor processos concorrentes. */
  readonly startAt?: number;
  readonly worker?: number;
  readonly rounds?: number;
  /** `recover-retry`: limite de novas tentativas (padrão `RECOVER_RETRIES`); os testes do próprio filho o reduzem para provar que ele é respeitado. */
  readonly recoverRetries?: number;
  readonly staleOperationMs?: number;
  /** Testemunha dos RESULTADOS (pastas dos resultados e dos recibos deles): sem isso o filho não enxerga resultado algum (`NO_RESULTS`). */
  readonly resultsDir?: string;
  readonly resultsAnchorDir?: string;
  readonly nowIso?: string;
}
const config = JSON.parse(process.env.LEDGER_CHILD ?? '{}') as Config;
const die = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('inalcançável');
};

const failingPrefix = (): string | null => (config.failSync === 'decisions' ? config.decisionsDir : config.failSync === 'anchors' ? config.anchorDir : config.failSync === 'ledger' ? config.ledgerDir : null);
const ops: FsOps = {
  ...nodeFsOps,
  async syncDirectory(dir) {
    if (config.crash?.at === 'sync-before' && dir === config.crash.match) die();
    const bad = failingPrefix();
    const armed = config.failSyncWhenExists === undefined || fs.existsSync(`${dir}/${config.failSyncWhenExists}`);
    const hit = config.failSyncBaseOnly === true ? dir === bad : dir.startsWith(`${bad}/`) || (config.failSyncParents === true && dir === bad);
    if (armed && bad !== null && hit) throw Object.assign(new Error('EIO simulado'), { code: 'EIO' });
    await nodeFsOps.syncDirectory(dir);
    if (config.syncLog) fs.appendFileSync(config.syncLog, `${dir}\n`);
    if (config.crash?.at === 'sync-after' && dir === config.crash.match) die();
  },
  async link(from, to) {
    const hit = config.crash && to.endsWith(config.crash.match);
    if (hit && config.crash?.at === 'before') die();
    await nodeFsOps.link(from, to);
    if (hit && config.crash?.at === 'after') die();
  },
  async writeExclusive(target, data, mode) {
    await nodeFsOps.writeExclusive(target, data, mode);
    if (config.crash?.at === 'after-temp' && target.includes(config.crash.match)) die();
  },
};

const slots = [rec.c2, rec.c3, () => rec.p3(5), rec.naModel, rec.naFeature] as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT = new Set(['HEAD_MISMATCH', 'LEDGER_OPERATION_IN_PROGRESS', 'WRITE_CONFLICT', 'PENDING_UNCONFIRMED', 'LEDGER_UNAVAILABLE']);
/** `recover-retry`: tentativas além da primeira (cada uma depois de 3–14 ms); a janela da §16.16 dura um fsync. */
const RECOVER_RETRIES = 200;

(async () => {
  const reader = createEvidenceReader({ baseDir: config.evidenceDir, authorize: () => true });
  const retiredUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const authenticator = config.rotated ? ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:${retiredUntil}`], now: () => new Date() }) : LEDGER_AUTH_A;
  const ledger = createLedgerService({
    dir: config.ledgerDir,
    authenticator,
    ...(config.capacity ? { checkpointEvery: config.capacity.every, capacityPolicy: deriveCapacityPolicy(config.capacity.max, config.capacity.revocations, config.capacity.every) } : {}),
    otherDirs: [config.decisionsDir, config.anchorDir, config.evidenceDir],
    fs: ops,
    pollMs: 5,
    ...(config.staleOperationMs !== undefined ? { staleOperationMs: config.staleOperationMs } : {}),
  });
  const service = createDecisionService({ baseDir: config.decisionsDir, anchorDir: config.anchorDir, evidence: reader, evidenceBaseDir: config.evidenceDir, origin: TEST_ORIGIN, knownHeads: config.resultsDir && config.resultsAnchorDir ? createResultsKnownHeads({ baseDir: config.resultsDir, anchorDir: config.resultsAnchorDir, origin: TEST_ORIGIN, otherDirs: [config.decisionsDir, config.anchorDir, config.evidenceDir, config.ledgerDir] }) : NO_RESULTS, ledger, fs: ops });
  const actor = { email: config.actor };
  const clock = (): string => config.nowIso ?? new Date().toISOString();
  const headOf = async (): Promise<unknown> => {
    const listed = await service.list(actor, config.auditId);
    return listed.ok ? listed.value.head : null;
  };

  // `list`: só LEITURA (a vista que a tela e a prévia veem); imprime o estado do livro. Serve para provar o que uma leitura faz depois de um reinício.
  if (config.task === 'list') {
    const listed = await service.list(actor, config.auditId, clock);
    console.log(JSON.stringify(listed.ok ? { ok: true, state: listed.value.ledger.state, reason: listed.value.ledger.reason, finalizable: listed.value.finalizable, decisions: listed.value.decisions.length } : { ok: false, code: listed.code }));
    return;
  }
  // `finalize`: avalia e SELA um resultado (serviço real de resultados sobre as pastas recebidas); imprime o veredito.
  if (config.task === 'finalize') {
    // import TARDIO: as fixtures de resultados registram hooks do `node:test`, cujo resumo TAP seria impresso depois da resposta do filho nas OUTRAS tarefas
    const { previewOver } = await import('./link-audit-preview-fixtures');
    const { makeService } = await import('./link-audit-results-fixtures');
    const preview = previewOver({ evidenceDir: config.evidenceDir, raw: service } as never);
    while (config.startAt !== undefined && Date.now() < config.startAt) await sleep(1);
    const evaluated = await preview.evaluate(actor, config.auditId);
    if (!evaluated.ok) {
      console.log(JSON.stringify({ ok: false, stage: 'evaluate', code: evaluated.code }));
      return;
    }
    const port = config.withPort ? service.resultsLedger : null;
    const results = makeService({ base: config.resultsDir as string, anchors: config.resultsAnchorDir as string, other: config.decisionsDir }, preview, { fs: ops, ...(port ? { ledger: port } : {}) });
    const done = await results.finalize(actor, config.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
    console.log(JSON.stringify({ ok: done.ok, code: done.ok ? null : done.code, ...(done.ok ? { replayed: done.value.replayed, seq: done.value.head.seq } : { blockers: (evaluated.value.payload.blockers ?? []).map((b: { code: string }) => b.code), hasInput: evaluated.value.inputSha256 !== null }) }));
    return;
  }
  if (config.task === 'enroll') {
    const result = await service.ledgerAction(actor, config.auditId, { action: 'ENROLL' }, clock);
    console.log(JSON.stringify({ ok: result.ok }));
    return;
  }
  if (config.task === 'recover') {
    const result = await service.ledgerAction(actor, config.auditId, { action: 'RECOVER' }, clock);
    console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code }));
    return;
  }
  // §16.16: quem NÃO é o autor e lê a fase C de um dono VIVO (recibo gravado, CONFIRMED ainda não) recebe o 409 transitório `PENDING_UNCONFIRMED`; o cliente real tenta de novo
  // pelo `Retry-After`. Só esse código é repetido (limitado): qualquer outra recusa — inclusive `LEDGER_UNAVAILABLE` — volta como veio, para não esconder defeito do livro.
  if (config.task === 'recover-retry') {
    const bound = config.recoverRetries ?? RECOVER_RETRIES;
    let result = await service.ledgerAction(actor, config.auditId, { action: 'RECOVER' }, clock);
    let retries = 0;
    while (!result.ok && result.code === 'PENDING_UNCONFIRMED' && retries < bound) {
      retries += 1;
      await sleep(3 + Math.floor(Math.random() * 12));
      result = await service.ledgerAction(actor, config.auditId, { action: 'RECOVER' }, clock);
    }
    console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code, retries }));
    return;
  }
  // com tentativas (só para conflitos transitórios): devolve o veredito FINAL, para provar a fronteira de capacidade sob concorrência sem depender de sorte
  if (config.task === 'create-retry' || config.task === 'revoke-retry') {
    let last: { ok: boolean; code?: string } = { ok: false, code: 'SEM_TENTATIVA' };
    for (let tries = 0; tries < 300; tries += 1) {
      const head = await headOf();
      const result =
        config.task === 'create-retry'
          ? await service.create(actor, config.auditId, { record: (slots[(config.worker ?? 0) % slots.length] as () => Record<string, unknown>)(), expectedHead: head }, clock)
          : await service.revoke(actor, config.auditId, { revokes: config.decisionId as string, reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: head }, clock);
      last = result.ok ? { ok: true } : { ok: false, code: result.code };
      if (result.ok || !TRANSIENT.has(result.ok ? '' : result.code)) break;
      await sleep(3 + Math.floor(Math.random() * 12));
    }
    console.log(JSON.stringify(last));
    return;
  }
  if (config.task === 'revoke') {
    const result = await service.revoke(actor, config.auditId, { revokes: config.decisionId as string, reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: await headOf() }, clock);
    console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code }));
    return;
  }
  if (config.task === 'create') {
    const result = await service.create(actor, config.auditId, { record: rec.c2(), expectedHead: config.resend ? null : await headOf() }, clock);
    console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code }));
    return;
  }
  // workload: cada trabalhador usa SEU subcritério; cria e revoga a própria decisão várias vezes, com tentativas
  const make = slots[(config.worker ?? 0) % slots.length] as () => Record<string, unknown>;
  const summary = { writes: 0, retries: 0, races: 0, fatal: [] as string[] };
  const attempt = async (run: (head: unknown) => Promise<{ ok: boolean; code?: string; value?: unknown }>): Promise<{ ok: boolean; value?: unknown }> => {
    for (let tries = 0; tries < 400; tries += 1) {
      const result = await run(await headOf());
      if (result.ok) return result;
      // corrida de LEITURA sob carga: o livro lido antes das decisões pode ainda não ter a INTENT de OUTRO processo; some quando ele termina (o teste confere o estado FINAL)
      const raced = result.code === 'DECISIONS_HISTORY_UNRESOLVED' && /UNLEDGERED_(ENTRY|PENDING)|LEDGER_BEHIND/.test(((result as { issues?: string[] }).issues ?? []).join(' '));
      if (raced) summary.races += 1;
      if (!raced && !TRANSIENT.has(result.code ?? '')) {
        summary.fatal.push(`${result.code ?? '?'} ${((result as { issues?: string[] }).issues ?? []).join(' | ').slice(0, 240)}`);
        return result;
      }
      summary.retries += 1;
      await sleep(3 + Math.floor(Math.random() * 12));
    }
    summary.fatal.push('TENTATIVAS_ESGOTADAS');
    return { ok: false };
  };
  for (let round = 0; round < (config.rounds ?? 3); round += 1) {
    const created = await attempt(async (head) => (await service.create(actor, config.auditId, { record: make(), expectedHead: head }, clock)) as never);
    if (!created.ok) break;
    summary.writes += 1;
    const decisionId = (created.value as { decision: { decisionId: string } }).decision.decisionId;
    const revoked = await attempt(async (head) => (await service.revoke(actor, config.auditId, { revokes: decisionId, reason: 'Rodada de carga: decisão própria desfeita pelo mesmo operador.', expectedHead: head }, clock)) as never);
    if (!revoked.ok) break;
    summary.writes += 1;
  }
  console.log(JSON.stringify(summary));
})().catch((error: unknown) => {
  console.log(JSON.stringify({ crashed: String(error instanceof Error ? error.message : error) }));
  process.exit(3);
});
