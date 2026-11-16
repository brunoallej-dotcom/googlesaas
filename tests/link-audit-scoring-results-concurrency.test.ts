import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { appendRun, readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { hashTree, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, receiptPath, resultsEnv, RES_AUDIT, runPath, tickClock, type ResultsEnv, type Spec } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I4 — CONCORRÊNCIA REAL: processos Node de verdade disputando a mesma auditoria (o `link()` exclusivo do sistema de arquivos
 * é a única garantia entre processos), mais a corrida em um único processo com um concorrente simulado no instante do `link()`.
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'link-audit-results-child.ts');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');

interface Outcome {
  readonly ok: boolean;
  readonly replayed?: boolean;
  readonly seq?: number;
  readonly code?: string;
  readonly signal: string | null;
}
interface ChildSpec {
  readonly actor: { email: string };
  readonly world: Spec;
  readonly seen?: Spec;
  readonly crashBeforeReceipt?: boolean;
}

/** O executor de testes do Node injeta NODE_TEST_CONTEXT nos filhos (eventos serializados no stdout): o filho é um programa comum, sem isso. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runChild(e: ResultsEnv, child: ChildSpec, startAt: number, clockStart: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--require', REGISTER, CHILD, JSON.stringify({ ...child, base: e.base, anchors: e.anchors, other: e.other, auditId: RES_AUDIT, startAt, clockStart })], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    proc.on('error', reject);
    proc.on('close', (_code, signal) => {
      // as fixtures importam node:test (limpeza de pastas), então o filho também imprime TAP ao sair: a linha do desfecho é a única que é JSON
      const line = out.split('\n').find((candidate) => /^\{"ok":/.test(candidate));
      if (!line) return resolve({ ok: false, code: signal ? `KILLED_${signal}` : `NO_OUTPUT:${err.slice(0, 200)}`, signal });
      resolve({ ...(JSON.parse(line) as Omit<Outcome, 'signal'>), signal });
    });
  });
}
/** Dispara todos juntos (largada sincronizada para sobrepor a execução, mesmo com a partida lenta de cada processo). */
async function race(e: ResultsEnv, children: readonly ChildSpec[]): Promise<Outcome[]> {
  const startAt = Date.now() + 3000;
  return Promise.all(children.map((child, index) => runChild(e, child, startAt, index * 10)));
}
const state = async (e: ResultsEnv) => {
  const r = await readRunLog(e.base, RES_AUDIT, { anchorDir: e.anchors });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const S1: Spec = { kind: 'PONTUADO', variant: 'v1', headSeed: 'h1' };
const S2: Spec = { kind: 'PONTUADO', variant: 'v2', headSeed: 'h2' };

test('CINCO PROCESSOS do mesmo operador finalizam o MESMO estado ao mesmo tempo: exatamente um resultado novo, os outros são reenvios; um arquivo, um recibo, cadeia íntegra', async () => {
  const e = resultsEnv();
  const outcomes = await race(e, [OP_B, OP_B, OP_B, OP_B, OP_B].map((actor) => ({ actor, world: S1 })));
  assert.ok(outcomes.every((o) => o.ok), JSON.stringify(outcomes));
  assert.equal(outcomes.filter((o) => o.replayed === false).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((o) => o.replayed === true).length, 4);
  assert.ok(outcomes.every((o) => o.seq === 1));
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, RES_AUDIT)), ['a0001.json']);
  const s = await state(e);
  assert.ok(s.runs.length === 1 && s.pending === null && s.anchors.unanchored === 0 && s.orphanTempFiles.length === 0);
});

test('operadores DIFERENTES no mesmo estado: um só resultado; quem chegou na janela resultado→recibo de outro operador recebe 409 transitório e, ao reenviar, 200 (reenvio)', async () => {
  const e = resultsEnv();
  const outcomes = await race(e, [OP_A, OP_B, OP_A, OP_B, OP_A].map((actor) => ({ actor, world: S1 })));
  for (const o of outcomes) assert.ok(o.ok || o.code === 'RESULT_PENDING_UNCONFIRMED', JSON.stringify(o));
  assert.equal(outcomes.filter((o) => o.ok && o.replayed === false).length, 1, JSON.stringify(outcomes));
  const s = await state(e);
  assert.ok(s.runs.length === 1 && s.pending === null, 'o dono do resultado concluiu o próprio recibo');
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
  const retry = await race(e, [OP_A, OP_B].map((actor) => ({ actor, world: S1 })));
  assert.ok(retry.every((o) => o.ok && o.replayed === true && o.seq === 1), JSON.stringify(retry));
});

/*
 * VISÃO ANTIGA DO MUNDO: quem enviou o pedido com uma prévia desatualizada NUNCA finaliza. Os três testes seguintes usam o mesmo mundo (S2).
 * Os DOIS primeiros fixam a ORDEM por sincronização explícita (cada fase só começa quando a anterior terminou), então os códigos são EXATOS e
 * não dependem de temporização. O terceiro é a corrida real e confere só o que o protocolo garante em qualquer intercalação: um processo
 * de outro operador que chega entre a gravação do resultado e o recibo do dono recebe o 409 TRANSITÓRIO `RESULT_PENDING_UNCONFIRMED`
 * (a pendente vem antes da conferência da visão; comportamento documentado no teste dos operadores diferentes e no da queda real).
 */
const STALE_BY_HEAD: ChildSpec = { actor: OP_A, world: S2, seen: S1 }; // viu a prévia antiga (outra cabeça de decisões)
const STALE_BY_INPUT: ChildSpec = { actor: OP_A, world: S2, seen: { ...S2, evidenceSalt: 'captura-trocada' } }; // viu outra captura (mesmo número e data)
const STALE_OWNER: ChildSpec = { actor: OP_B, world: S2, seen: S1 }; // até o autor do resultado vigente, com a visão velha, não regrava
const CURRENT_OWNER: ChildSpec = { actor: OP_B, world: S2, seen: S2 };
const codesOf = (outcomes: readonly Outcome[]): Array<string | undefined> => outcomes.map((o) => (o.ok ? 'OK' : o.code));

test('visão ANTIGA ANTES de qualquer resultado (ordem fixada): cada processo recebe o código exato da sua defasagem e nada é gravado', async () => {
  const e = resultsEnv();
  const before = [hashTree(e.base), hashTree(e.anchors)];
  const outcomes = await race(e, [STALE_BY_HEAD, STALE_BY_INPUT, STALE_BY_HEAD, STALE_OWNER]);
  assert.ok(outcomes.every((o) => o.signal === null), JSON.stringify(outcomes));
  assert.deepEqual(codesOf(outcomes), ['HEAD_MISMATCH', 'INPUT_CHANGED', 'HEAD_MISMATCH', 'HEAD_MISMATCH'], JSON.stringify(outcomes));
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before, 'nenhum byte foi gravado');
  const s = await state(e);
  assert.ok(s.runs.length === 0 && s.pending === null, 'nenhum resultado, nenhuma pendente');
});

test('visão ANTIGA DEPOIS do resultado confirmado (ordem fixada): ninguém regrava, nem o autor com a visão velha; o resultado vigente fica intacto', async () => {
  const e = resultsEnv();
  const [first] = await race(e, [CURRENT_OWNER]); // fase 1: o estado atual finaliza e o recibo é dado ANTES de a fase 2 começar
  assert.deepEqual([first?.ok, first?.replayed, first?.seq], [true, false, 1], JSON.stringify(first));
  const sealed = [hashTree(e.base), hashTree(e.anchors)];
  const outcomes = await race(e, [STALE_BY_HEAD, STALE_BY_INPUT, STALE_BY_HEAD, STALE_OWNER]); // fase 2: sem pendente, logo sem janela transitória
  assert.ok(outcomes.every((o) => o.signal === null), JSON.stringify(outcomes));
  assert.deepEqual(codesOf(outcomes), ['HEAD_MISMATCH', 'INPUT_CHANGED', 'HEAD_MISMATCH', 'HEAD_MISMATCH'], JSON.stringify(outcomes));
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], sealed, 'o resultado e o recibo vigentes não mudaram um byte');
  const s = await state(e);
  assert.ok(s.runs.length === 1 && s.pending === null && s.anchors.unanchored === 0 && s.orphanTempFiles.length === 0);
  assert.equal(s.runs[0]?.finalizedBy, OP_B.email);
});

test('visão ANTIGA em CORRIDA real com os atuais: só o dono com o estado atual grava, um único resultado e cadeia íntegra; o 409 transitório vale só para quem não é dono', async () => {
  const e = resultsEnv();
  const children = [STALE_BY_HEAD, CURRENT_OWNER, STALE_BY_HEAD, CURRENT_OWNER, STALE_BY_INPUT];
  const exact = ['HEAD_MISMATCH', undefined, 'HEAD_MISMATCH', undefined, 'INPUT_CHANGED'];
  const outcomes = await race(e, children);
  outcomes.forEach((o, index) => {
    const label = `processo ${index}: ${JSON.stringify(o)}`;
    assert.equal(o.signal, null, `${label}: nenhum processo pode ter sido morto nem ter travado`);
    if (children[index]?.actor.email === OP_B.email) {
      assert.ok(o.ok && o.seq === 1, `${label}: o dono com a visão ATUAL conclui (novo ou reenvio), nunca recebe 409`);
      return;
    }
    assert.equal(o.ok, false, `${label}: visão antiga NUNCA finaliza`);
    // Só duas respostas são legítimas: o código exato da defasagem OU o 409 transitório (resultado do dono gravado, recibo ainda não).
    // Qualquer outro código (CHILD_CRASH, INTERNAL_ERROR, NO_OUTPUT, KILLED_*, RESULT_INTEGRITY…) é falha inesperada e reprova o teste.
    assert.ok(o.code === exact[index] || o.code === 'RESULT_PENDING_UNCONFIRMED', `${label}: código inesperado`);
  });
  assert.equal(outcomes.filter((o) => o.ok && o.replayed === false).length, 1, 'exatamente UM resultado novo');
  assert.equal(outcomes.filter((o) => o.ok).length, 2, 'só os dois processos do dono concluíram');

  // Invariantes finais, valem em qualquer intercalação: um arquivo, um recibo, cadeia íntegra, dono autorizado, estado atual.
  const expected = buildEvaluation(S2);
  const s = await state(e);
  assert.ok(s.runs.length === 1 && s.pending === null && s.anchors.unanchored === 0 && s.orphanTempFiles.length === 0, JSON.stringify(outcomes));
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, RES_AUDIT)), ['a0001.json']);
  const run = s.runs[0];
  assert.equal(run?.finalizedBy, OP_B.email, 'o resultado pertence ao operador autorizado que tinha o estado atual');
  assert.equal(run?.decisions.head?.sha256, expected.decisions.head?.sha256, 'cita as decisões ATUAIS');
  assert.equal(run?.inputSha256, expected.inputSha256, 'pontua a entrada ATUAL');

  // Com o dono já com recibo não há mais janela transitória: as visões antigas reenviadas agora recebem o código EXATO (sem 409) e nada muda.
  const sealed = [hashTree(e.base), hashTree(e.anchors)];
  const after = await race(e, [STALE_BY_HEAD, STALE_BY_INPUT]);
  assert.deepEqual(codesOf(after), ['HEAD_MISMATCH', 'INPUT_CHANGED'], JSON.stringify(after));
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], sealed);
});

test('estados DIFERENTES em sequência, vindos de processos distintos: cada um vira um resultado encadeado, sem sobrescrever', async () => {
  const e = resultsEnv();
  const first = await race(e, [{ actor: OP_A, world: S1 }]);
  const second = await race(e, [{ actor: OP_B, world: S2 }, { actor: OP_B, world: S2 }]);
  assert.ok(first[0]?.ok && second.every((o) => o.ok), JSON.stringify([first, second]));
  assert.equal(second.filter((o) => o.replayed === false).length, 1);
  const s = await state(e);
  assert.deepEqual(s.runs.map((r) => r.seq), [1, 2]);
  assert.equal(s.runs[1]?.prevSha256, s.runs[0]?.contentSha256);
  assert.ok(s.runs[1]!.finalizedAt >= s.runs[0]!.finalizedAt);
});

test('QUEDA REAL (SIGKILL entre o resultado e o recibo): o resultado fica PENDENTE e não vale; outro operador é barrado; o MESMO autor, reenviando, conclui', async () => {
  const e = resultsEnv();
  const [crashed] = await race(e, [{ actor: OP_B, world: S1, crashBeforeReceipt: true }]);
  assert.equal(crashed?.signal, 'SIGKILL', JSON.stringify(crashed));
  assert.ok(fs.existsSync(runPath(e, 1)) && !fs.existsSync(receiptPath(e, 1)), 'resultado publicado, recibo ausente');
  const pending = await state(e);
  assert.ok(pending.runs.length === 0 && pending.pending?.seq === 1 && pending.anchors.unanchored === 1);

  const [stranger] = await race(e, [{ actor: OP_A, world: S1 }]);
  assert.deepEqual([stranger?.ok, stranger?.code], [false, 'RESULT_PENDING_UNCONFIRMED']);
  const [other] = await race(e, [{ actor: OP_B, world: S2 }]);
  assert.deepEqual([other?.ok, other?.code], [false, 'RESULT_PENDING_UNCONFIRMED']);
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json'], 'nada novo foi gravado sobre a pendente');

  const [concluded] = await race(e, [{ actor: OP_B, world: S1 }]);
  assert.deepEqual([concluded?.ok, concluded?.replayed, concluded?.seq], [true, true, 1]);
  const done = await state(e);
  assert.ok(done.runs.length === 1 && done.pending === null && done.anchors.unanchored === 0);
});

test('queda de um processo durante a corrida: os demais não ficam presos nem duplicam; o autor da pendente conclui', async () => {
  const e = resultsEnv();
  const outcomes = await race(e, [
    { actor: OP_B, world: S1, crashBeforeReceipt: true },
    { actor: OP_B, world: S1 },
    { actor: OP_B, world: S1 },
    { actor: OP_A, world: S1 },
  ]);
  const crashed = outcomes.filter((o) => o.signal === 'SIGKILL').length;
  const s = await state(e);
  assert.ok(s.runs.length + (s.pending ? 1 : 0) === 1, `exatamente um arquivo de resultado: ${JSON.stringify(outcomes)}`);
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
  for (const o of outcomes) if (o.signal !== 'SIGKILL') assert.ok(o.ok || ['RESULT_PENDING_UNCONFIRMED', 'RESULT_ANCHOR_PENDING'].includes(o.code ?? ''), JSON.stringify(o));
  if (crashed === 1 && s.pending) {
    const [resend] = await race(e, [{ actor: OP_B, world: S1 }]);
    assert.ok(resend?.ok && resend.replayed);
  }
  const final = await state(e);
  assert.ok(final.runs.length === 1 && final.pending === null);
});

/* ------------------------------------------------------------------------------------------------ no mesmo processo */
test('duas finalizações simultâneas do mesmo estado em um processo: um resultado, um reenvio', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation(S1);
  const a = makeService(e, new FakeEvaluator(ev));
  const b = makeService(e, new FakeEvaluator(ev), { clock: tickClock(50) });
  const [ra, rb] = await Promise.all([a.finalize(OP_A, RES_AUDIT, bodyOf(ev)), b.finalize(OP_B, RES_AUDIT, bodyOf(ev))]);
  assert.ok(ra.ok && rb.ok);
  assert.deepEqual([ra.value.replayed, rb.value.replayed].sort(), [false, true]);
  assert.equal((await state(e)).runs.length, 1);
});

test('concorrente simulado no instante do link(): o serviço relê, reconhece o MESMO estado já finalizado pelo outro e responde reenvio (sem duplicar)', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation(S1);
  // um segundo processo (simulado) finaliza o mesmo estado em pastas à parte; seus arquivos são "plantados" no instante do nosso link()
  const rival = resultsEnv();
  const planted = await makeService(rival, new FakeEvaluator(ev), { clock: tickClock(200) }).finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(planted.ok);
  let raced = 0;
  const ops = {
    ...nodeFsOps,
    async link(from: string, to: string) {
      if (raced++ === 0 && to.startsWith(e.base) && /s\d{4}\.json$/.test(to)) {
        fs.mkdirSync(path.join(e.base, RES_AUDIT), { recursive: true });
        fs.mkdirSync(path.join(e.anchors, RES_AUDIT), { recursive: true });
        fs.copyFileSync(runPath(rival, 1), runPath(e, 1));
        fs.copyFileSync(receiptPath(rival, 1), receiptPath(e, 1));
      }
      return nodeFsOps.link(from, to);
    },
  };
  const evaluator = new FakeEvaluator(ev);
  const r = await makeService(e, evaluator, { fs: ops }).finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(r.ok && r.value.replayed && r.value.head.seq === 1, JSON.stringify(r));
  assert.equal(evaluator.evaluateCalls, 2, 'avaliou antes da disputa; depois da perda do link() reconheceu o reenvio SEM reavaliar para decidir (a 2ª leitura só sinaliza obsolescência)');
  assert.equal(r.value.stateChangedAfterFinalization, false);
  const s = await state(e);
  assert.ok(s.runs.length === 1 && s.runs[0]?.finalizedBy === 'ana@empresa.com', 'vale o resultado do outro processo, não o nosso');
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
});

test('concorrente simulado grava um estado DIFERENTE no instante do link(): o serviço relê, reavalia contra o mundo atual e recusa o pedido desatualizado', async () => {
  const e = resultsEnv();
  const seen = buildEvaluation(S1);
  const rivalEval = buildEvaluation(S2);
  const rival = resultsEnv();
  assert.ok((await makeService(rival, new FakeEvaluator(rivalEval), { clock: tickClock(200) }).finalize(OP_A, RES_AUDIT, bodyOf(rivalEval))).ok);
  const world = new FakeEvaluator(seen);
  let raced = 0;
  const ops = {
    ...nodeFsOps,
    async link(from: string, to: string) {
      if (raced++ === 0 && to.startsWith(e.base) && /s\d{4}\.json$/.test(to)) {
        fs.mkdirSync(path.join(e.base, RES_AUDIT), { recursive: true });
        fs.mkdirSync(path.join(e.anchors, RES_AUDIT), { recursive: true });
        fs.copyFileSync(runPath(rival, 1), runPath(e, 1));
        fs.copyFileSync(receiptPath(rival, 1), receiptPath(e, 1));
        world.current = rivalEval; // o mundo andou junto com o outro processo
      }
      return nodeFsOps.link(from, to);
    },
  };
  const r = await makeService(e, world, { fs: ops }).finalize(OP_B, RES_AUDIT, bodyOf(seen));
  assert.ok(!r.ok && ['HEAD_MISMATCH', 'INPUT_CHANGED'].includes(r.code), JSON.stringify(r));
  const s = await state(e);
  assert.deepEqual(s.runs.map((x) => x.finalizedBy), ['ana@empresa.com'], 'nosso resultado antigo NÃO foi gravado depois do novo');
});

test('muitas finalizações de estados sucessivos em um processo: cadeia e recibos íntegros, hora monotônica', async () => {
  const e = resultsEnv();
  const evaluator = new FakeEvaluator(buildEvaluation({ ...S1, variant: 'a0' }));
  const svc = makeService(e, evaluator);
  for (let i = 0; i < 8; i++) {
    const ev = buildEvaluation({ ...S1, variant: `a${i}`, headSeed: `h${i}` });
    evaluator.current = ev;
    const r = await svc.finalize(i % 2 ? OP_A : OP_B, RES_AUDIT, bodyOf(ev));
    assert.ok(r.ok && r.value.head.seq === i + 1, JSON.stringify(r));
  }
  const s = await state(e);
  assert.equal(s.runs.length, 8);
  for (let i = 1; i < s.runs.length; i++) {
    assert.equal(s.runs[i]!.prevSha256, s.runs[i - 1]!.contentSha256);
    assert.ok(s.runs[i]!.finalizedAt >= s.runs[i - 1]!.finalizedAt);
  }
  const before = [hashTree(e.base), hashTree(e.anchors)];
  assert.ok((await svc.list(OP_A, RES_AUDIT)).ok);
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before);
  void appendRun;
});
