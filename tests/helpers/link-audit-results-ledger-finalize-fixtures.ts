import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DecisionService, LedgerPort } from '../../src/lib/link-audit-decisions';
import type { LedgerRecord } from '../../src/lib/link-audit-ledger';
import type { OriginAuthenticator } from '../../src/lib/link-audit-origin';
import { createResultsKnownHeads } from '../../src/lib/link-audit-scoring-runs';
import type { PreviewActor } from '../../src/lib/link-audit-scoring-runs/preview';
import type { PreviewEvaluator } from '../../src/lib/link-audit-scoring-runs/results';
import { readRunLog } from '../../src/lib/link-audit-scoring-runs/results-store';
import type { ScoreRun } from '../../src/lib/link-audit-scoring-runs/results-types';
import { seal, serialize } from '../../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../../src/lib/link-audit/snapshot-store';
import { ANA, clock, hashTree, must, rec } from './link-audit-decisions-fixtures';
import { servicesOver } from './link-audit-ledger-results-fixtures';
import { decisionsOver, ledgerFor, ledgerRecords, ledgerWorld, type LedgerServiceOver, type LedgerWorld } from './link-audit-ledger-fixtures';
import { previewOver } from './link-audit-preview-fixtures';
import { makeService, OP_A as ANA_OP, resultsEnv, type ResultsEnv } from './link-audit-results-fixtures';

/*
 * R1.3 — a FINALIZAÇÃO grava pelo livro (spec §16.17.3; porta de escrita D-R1-3). O serviço de resultados recebe a porta do serviço de decisões (que liga o contexto
 * R1 → guarda → livro → decisões → R2), e o livro real grava `RUN_INTENT` antes do resultado e `RUN_CONFIRMED` depois do recibo. Pastas reais, chaves de TESTE,
 * e-mails fictícios `@empresa.com`, nenhuma rede.
 */

/**
 * Livro em que a operação ALHEIA vence na hora (`staleOperationMs` 1, pela idade de parede ou observada) e o PRAZO DO DONO desta finalização fica parado (relógio monotônico
 * congelado): sem isso, com `staleOperationMs` 1 o próprio dono passaria do prazo (`staleOperationMs / 2`) entre o RUN_INTENT e a publicação e abortaria a si mesmo (correto).
 */
export const AGED_OTHERS = { staleOperationMs: 1, monotonicMs: () => 0 } as const;

/** Auditoria protegida com UMA decisão confirmada (livro: GENESIS, INTENT, CONFIRMED) e pastas de resultados vazias. */
export async function protectedWorld(options: Parameters<typeof ledgerWorld>[0] = {}): Promise<{ w: LedgerWorld; e: ResultsEnv }> {
  const w = await ledgerWorld(options);
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  return { w, e };
}

export interface Finalizer {
  readonly ledger: LedgerPort;
  readonly decisions: DecisionService;
  readonly preview: ReturnType<typeof previewOver>;
  readonly results: ReturnType<typeof makeService>;
}
export interface FinalizerOver {
  /** Opções do livro desta finalização (padrão: sem guarda, `pollMs` 5). */
  readonly ledger?: LedgerServiceOver;
  /** Sistema de arquivos dos RESULTADOS (falhas e quedas injetadas). */
  readonly resultsFs?: FsOps;
  readonly clock?: () => string;
  /** `false`: sem a porta de escrita (comportamento anterior à R1.3). */
  readonly port?: boolean;
  /** Embrulha a avaliação/barreira (corridas deterministas). */
  readonly evaluator?: (preview: ReturnType<typeof previewOver>) => PreviewEvaluator;
  /** Autenticador de ORIGEM do serviço de RESULTADOS (padrão: a chave de teste `TEST_ORIGIN`). R1.4: rotação/vencimento/revogação da chave que assinou a pendente. */
  readonly origin?: OriginAuthenticator;
  /** Autenticador de ORIGEM da TESTEMUNHA dos resultados que o livro lê (`originProven` da pendente; padrão `TEST_ORIGIN`). */
  readonly witnessOrigin?: OriginAuthenticator;
}

/** Serviços de UM processo sobre o mundo: decisões com o livro real, prévia real e resultados COM a porta de escrita do livro. */
export function finalizerOver(w: LedgerWorld, e: ResultsEnv, over: FinalizerOver = {}): Finalizer {
  const ledger = ledgerFor(w, { guard: null, pollMs: 5, ...over.ledger });
  const decisions = over.witnessOrigin
    ? decisionsOver(w, { ledger, knownHeads: createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir, w.ledgerDir], origin: over.witnessOrigin }) })
    : servicesOver(w, e, { ledger });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const port = over.port === false ? null : decisions.resultsLedger;
  const results = makeService(e, over.evaluator ? over.evaluator(preview) : preview, { ...(port ? { ledger: port } : {}), ...(over.resultsFs ? { fs: over.resultsFs } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.origin ? { origin: over.origin } : {}) });
  return { ledger, decisions, preview, results };
}

/** O corpo que o operador enviaria depois de ver a prévia ATUAL. */
export async function bodyNow(f: Finalizer, actor: PreviewActor, auditId: string): Promise<{ expectedHead: { seq: number; sha256: string } | null; expectedInputSha256: string }> {
  const evaluated = await f.preview.evaluate(actor, auditId);
  if (!evaluated.ok) throw new Error(`prévia: ${JSON.stringify(evaluated).slice(0, 200)}`);
  return { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string };
}
/** Vê a prévia e finaliza com o que viu. */
export async function finalizeAs(f: Finalizer, actor: PreviewActor, auditId: string) {
  return f.results.finalize(actor, auditId, await bodyNow(f, actor, auditId));
}

export async function runsOf(e: ResultsEnv, auditId: string): Promise<{ runs: readonly ScoreRun[]; pending: ScoreRun | null; all: readonly ScoreRun[] }> {
  const read = await readRunLog(e.base, auditId, { anchorDir: e.anchors });
  if (!read.ok) throw new Error(`resultados ilegíveis: ${read.code}`);
  return { runs: read.value.runs, pending: read.value.pending, all: read.value.all };
}

/** Tudo o que uma finalização poderia gravar: livro, resultados e recibos de resultados. */
export async function footprintOf(w: LedgerWorld, e: ResultsEnv): Promise<{ events: string[]; ledger: Record<string, string>; runs: Record<string, string>; anchors: Record<string, string> }> {
  return { events: (await ledgerRecords(w)).map((record) => record.event), ledger: hashTree(w.ledgerDir), runs: hashTree(e.base), anchors: hashTree(e.anchors) };
}

/** Só os arquivos de resultado e de recibo de resultado (uma pasta de auditoria criada vazia pelo passo 5 não conta como publicação). */
export function publishedRunFiles(e: ResultsEnv): string[] {
  return [...Object.keys(hashTree(e.base)), ...Object.keys(hashTree(e.anchors))].filter((name) => /(^|\/)[sa]\d{4}\.json$/.test(name)).sort();
}

/** INVARIANTE de toda a R1 (§16.17.8, R1 → L): todo `sNNNN` publicado tem um `RUN_INTENT` com o MESMO hash no livro. */
export function everyResultHasIntent(records: readonly LedgerRecord[], runs: readonly ScoreRun[]): boolean {
  const intents = new Set(records.filter((record) => record.event === 'RUN_INTENT').map((record) => `${record.run?.runSeq}:${record.run?.runSha256}`));
  return runs.every((run) => intents.has(`${run.seq}:${run.contentSha256}`));
}

/** Nunca dois `RUN_INTENT` do mesmo `runSeq` sem um `RUN_ABORTED` entre eles (I-1/I-2, RL-15). */
export function intentsWellFormed(records: readonly LedgerRecord[]): boolean {
  const open = new Map<number, boolean>();
  for (const record of records) {
    const seq = record.run?.runSeq;
    if (seq === undefined) continue;
    if (record.event === 'RUN_INTENT') {
      if (open.get(seq) === true) return false;
      open.set(seq, true);
    } else if (record.event === 'RUN_ABORTED') open.set(seq, false);
  }
  return true;
}

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'ledger-child.ts');
export interface ChildOutcome {
  readonly killed: boolean;
  readonly status: number | null;
  readonly line: Record<string, unknown> | null;
  readonly stderr: string;
}
/** UM processo Node à parte sobre as pastas do mundo (finalização pela porta, RECOVER, queda por SIGKILL). Timer de 120 s. */
export function spawnChild(w: LedgerWorld, e: ResultsEnv, config: Record<string, unknown>): Promise<ChildOutcome> {
  const payload = { decisionsDir: w.decisionsDir, anchorDir: w.anchorDir, evidenceDir: w.evidenceDir, ledgerDir: w.ledgerDir, auditId: w.auditId, actor: 'ana@empresa.com', resultsDir: e.base, resultsAnchorDir: e.anchors, ...config };
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--require', REGISTER, CHILD], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LEDGER_CHILD: JSON.stringify(payload) } as unknown as NodeJS.ProcessEnv });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      const last = [...out.trim().split('\n')].reverse().find((line) => line.startsWith('{')) ?? '';
      resolve({ killed: signal === 'SIGKILL', status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: err });
    });
  });
}

/* ------------------------------------------------------------------ R1.4: operação de resultado aberta em B ou C (conclusão só pelo autor) */

/** FsOps cujo `link()` para `target` falha SEMPRE (ENOSPC, não fatal): o recibo (fase B) ou o RUN_CONFIRMED (fase C) do dono não entra. */
export function failingLink(target: string): FsOps {
  return {
    ...nodeFsOps,
    async link(from, to) {
      if (to === target) throw Object.assign(new Error('falha simulada'), { code: 'ENOSPC' });
      return nodeFsOps.link(from, to);
    },
  };
}

/** Tudo o que qualquer gravação poderia tocar: livro, decisões, recibos das decisões, resultados e recibos de resultados (byte a byte). */
export async function everythingOf(w: LedgerWorld, e: ResultsEnv): Promise<Record<string, unknown>> {
  return { ...(await footprintOf(w, e)), decisions: hashTree(w.decisionsDir), decisionAnchors: hashTree(w.anchorDir) };
}

/**
 * Auditoria protegida com a finalização de Ana PARADA em B (o recibo falhou: `sk` publicado, `ak` ausente) ou em C (o RUN_CONFIRMED falhou: `sk` e `ak` duráveis, livro sem o
 * fecho). O livro tem GENESIS, INTENT, CONFIRMED, RUN_INTENT. Devolve o pedido IDÊNTICO (o que concluir a pendente) e o resultado selado.
 */
export async function openRunWorld(phase: 'B' | 'C', options: Parameters<typeof ledgerWorld>[0] = {}): Promise<{ w: LedgerWorld; e: ResultsEnv; body: Awaited<ReturnType<typeof bodyNow>>; run: ScoreRun }> {
  const { w, e } = await protectedWorld(options);
  const over = options.capacityPolicy ? { capacityPolicy: options.capacityPolicy, ...(options.checkpointEvery !== undefined ? { checkpointEvery: options.checkpointEvery } : {}) } : {};
  const ledgerTarget = path.join(w.ledgerDir, w.auditId, 'l000005.json');
  const receiptTarget = path.join(e.anchors, w.auditId, 'a0001.json');
  const owner = phase === 'C' ? finalizerOver(w, e, { ledger: { ...over, fs: failingLink(ledgerTarget) } }) : finalizerOver(w, e, { ledger: over, resultsFs: failingLink(receiptTarget) });
  const body = await bodyNow(owner, ANA_OP, w.auditId);
  const first = await owner.results.finalize(ANA_OP, w.auditId, body);
  if (first.ok || first.code !== 'RESULT_ANCHOR_PENDING') throw new Error(`fase ${phase}: ${JSON.stringify(first).slice(0, 240)}`);
  const view = await must(servicesOver(w, e).list(ANA, w.auditId, clock()));
  if (view.ledger.state !== 'PROTECTED' || view.ledger.runs?.open?.phase !== phase) throw new Error(`fase ${phase}: vista ${JSON.stringify(view.ledger).slice(0, 240)}`);
  const run = (await runsOf(e, w.auditId)).all[0];
  if (!run) throw new Error('sem resultado publicado');
  return { w, e, body, run };
}

/** Recibo FORJADO (só SHA-256, como quem escreve só na pasta de recibos de resultados o faria) para o `sk` pendente: o disco passa a parecer fase C. */
export function plantForgedRunReceipt(e: ResultsEnv, auditId: string, run: ScoreRun): void {
  const body = { schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId, seq: run.seq, headSha256: run.contentSha256, anchoredAt: run.finalizedAt, prevAnchorSha256: null };
  fs.mkdirSync(path.join(e.anchors, auditId), { recursive: true });
  fs.writeFileSync(path.join(e.anchors, auditId, `a${String(run.seq).padStart(4, '0')}.json`), serialize(seal(body)), { mode: 0o444, flag: 'wx' });
}
