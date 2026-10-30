import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { clearStorageFatal, hashOk, seal, serialize } from '../src/lib/link-audit-storage';
import { appendRun, readRunLog, type BuildContext, type BuildOutcome } from '../src/lib/link-audit-scoring-runs/results-store';
import { MAX_RUNS, MAX_RUN_BYTES, RUN_ANCHOR_KIND, RUN_FILE_KIND, RUN_SCHEMA_VERSION, type ScoreRunDraft } from '../src/lib/link-audit-scoring-runs/results-types';
import { hashTree, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { receiptPath, resultsEnv, RES_AUDIT, runPath, tickClock, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I4 — o ARMAZENAMENTO dos resultados, isolado do motor: um registro mínimo basta porque o armazenamento só prova arquivo,
 * selo, encadeamento, recibos e ordem (a semântica do registro é do serviço; ver `link-audit-scoring-results-service.test.ts`).
 */
registerCleanup();

const SHA = sha256Hex('mínimo');
const REF_AT = '2026-10-22T10:00:00.000Z';

const tiny = (ctx: BuildContext, who = 'ana@empresa.com', over: Partial<ScoreRunDraft> = {}): ScoreRunDraft => ({
  schemaVersion: RUN_SCHEMA_VERSION,
  kind: RUN_FILE_KIND,
  auditId: RES_AUDIT,
  finalizedAt: ctx.finalizedAt,
  finalizedBy: who,
  outcome: 'INCONCLUSIVO',
  scored: null,
  inconclusive: { reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: ['COVERAGE_MIN'], coveragePercent: 11, minimumCoveragePercent: 40 },
  scoringAuditId: RES_AUDIT,
  auditIdAlias: { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId: RES_AUDIT },
  decisions: { head: null, count: 0, appliedIds: [], applied: [] },
  layout: 'VERSIONED',
  evidenceBasis: [{ ref: 'capture:c0001', kind: 'CAPTURE', observedAt: REF_AT, contentSha256: SHA, bodySha256: null, legacy: false, superseded: false }],
  profileSource: null,
  referenceDate: '2026-10-22',
  referenceDateSource: { ref: 'capture:c0001', observedAt: REF_AT, rule: 'LATEST_VERIFIED_EVIDENCE_DAY' },
  websiteDerivation: null,
  mapperVersion: 'm',
  methodologyVersion: 'x',
  scoreModelVersion: 's',
  rulerFingerprint: SHA,
  input: {},
  result: {},
  inputSha256: SHA,
  resultSha256: SHA,
  ...over,
});

const build =
  (who = 'ana@empresa.com', over: Partial<ScoreRunDraft> = {}) =>
  async (ctx: BuildContext): Promise<BuildOutcome<never>> => ({ ok: true, draft: tiny(ctx, who, over) });
/** Reenvio da pendente (o serviço o reconhece por hash+head; aqui o teste o declara). */
const resend =
  (fallback = build()) =>
  async (ctx: BuildContext): Promise<BuildOutcome<never>> =>
    ctx.pending ? { ok: true, replayOf: ctx.pending.seq } : fallback(ctx);

const ropts = (e: ResultsEnv, fsOps?: FsOps) => ({ anchorDir: e.anchors, ...(fsOps ? { fs: fsOps } : {}) });
const wopts = (e: ResultsEnv, fsOps?: FsOps, now: () => string = tickClock()) => ({ anchorDir: e.anchors, now, ...(fsOps ? { fs: fsOps } : {}) });
const append = (e: ResultsEnv, b = build(), fsOps?: FsOps, now?: () => string) => appendRun(e.base, RES_AUDIT, b, wopts(e, fsOps, now));
const read = (e: ResultsEnv, fsOps?: FsOps, auditId: string = RES_AUDIT) => readRunLog(e.base, auditId, ropts(e, fsOps));
const code = async (e: ResultsEnv): Promise<string> => {
  const r = await read(e);
  return r.ok ? 'OK' : r.code;
};
const snapshot = (e: ResultsEnv) => [hashTree(e.base), hashTree(e.anchors)];
const parse = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const clockSeed = (): (() => string) => tickClock(0);

async function filled(count = 3): Promise<ResultsEnv> {
  const e = resultsEnv();
  const now = clockSeed();
  for (let i = 0; i < count; i++) {
    const r = await append(e, build(), undefined, now);
    assert.ok(r.ok, JSON.stringify(r));
  }
  return e;
}
const rewrite = (file: string, mutate: (text: string) => string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
};

/* ------------------------------------------------------------------------------------------------ caminho feliz */
test('cada resultado é um arquivo selado e imutável (sNNNN) com recibo (aNNNN) em OUTRA pasta; encadeados; bytes canônicos', async () => {
  const e = await filled(3);
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)).sort(), ['s0001.json', 's0002.json', 's0003.json']);
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, RES_AUDIT)).sort(), ['a0001.json', 'a0002.json', 'a0003.json']);
  const r = await read(e);
  assert.ok(r.ok && r.value.runs.length === 3 && r.value.pending === null && r.value.anchors.unanchored === 0 && r.value.checkedFiles === 3);
  const runs = r.value.runs;
  assert.deepEqual(runs.map((x) => [x.seq, x.prevSha256 === null]), [[1, true], [2, false], [3, false]]);
  assert.equal(runs[1]?.prevSha256, runs[0]?.contentSha256);
  assert.equal(runs[2]?.prevSha256, runs[1]?.contentSha256);
  for (const run of runs) {
    assert.ok(hashOk(run), 'o selo confere');
    const onDisk = parse(runPath(e, run.seq));
    assert.equal(canonicalJson(onDisk), canonicalJson(run), 'o que está no disco é exatamente o registro lido');
    assert.ok(hashOk(onDisk as never));
    assert.equal(fs.readFileSync(runPath(e, run.seq), 'utf8'), serialize(onDisk as never), 'bytes = serialização do registro selado (a leitura estrita os exige)');
    assert.equal(fs.statSync(runPath(e, run.seq)).mode & 0o222, 0, 'somente leitura');
  }
  const receipt = parse(receiptPath(e, 3));
  assert.equal(receipt.kind, RUN_ANCHOR_KIND);
  assert.equal(receipt.headSha256, runs[2]?.contentSha256);
  assert.equal(receipt.prevAnchorSha256, parse(receiptPath(e, 2)).contentSha256);
});

test('a hora do resultado é do servidor e MONOTÔNICA: relógio que anda para trás nunca grava hora anterior à do resultado anterior', async () => {
  const e = resultsEnv();
  assert.ok((await append(e, build(), undefined, () => '2026-10-30T12:00:10.000Z')).ok);
  assert.ok((await append(e, build(), undefined, () => '2026-10-30T12:00:05.000Z')).ok); // relógio recuou 5 s
  const r = await read(e);
  assert.ok(r.ok);
  assert.deepEqual(r.value.runs.map((x) => x.finalizedAt), ['2026-10-30T12:00:10.000Z', '2026-10-30T12:00:10.000Z']);
});

test('o build é ASSÍNCRONO, roda DENTRO da trava e recebe só o estado CONFIRMADO; recusar o pedido não grava nada', async () => {
  const e = await filled(2);
  const before = snapshot(e);
  let seen: BuildContext | null = null;
  const refused = await appendRun<string>(e.base, RES_AUDIT, async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen = ctx;
    return { ok: false, failure: 'NAO' };
  }, wopts(e));
  assert.ok(!refused.ok && refused.code === 'REJECTED' && refused.failure === 'NAO');
  assert.deepEqual([(seen as BuildContext | null)?.seq, (seen as BuildContext | null)?.runs.length, (seen as BuildContext | null)?.pending], [3, 2, null]);
  assert.deepEqual(snapshot(e), before);
});

test('a validação semântica roda ANTES de publicar: problema ⇒ SEMANTIC, nada gravado', async () => {
  const e = resultsEnv();
  const r = await appendRun(e.base, RES_AUDIT, build(), { ...wopts(e), validate: () => ['não se explica'] });
  assert.ok(!r.ok && r.code === 'SEMANTIC');
  assert.deepEqual(fs.existsSync(path.join(e.base, RES_AUDIT)) ? fs.readdirSync(path.join(e.base, RES_AUDIT)) : [], []);
  assert.deepEqual(fs.readdirSync(e.anchors).flatMap((d) => fs.readdirSync(path.join(e.anchors, d))), []);
});

test('o tamanho máximo do registro é imposto antes de publicar (nada gravado)', async () => {
  const e = resultsEnv();
  const huge = { filler: 'x'.repeat(MAX_RUN_BYTES) };
  const r = await append(e, build('ana@empresa.com', { input: huge }));
  assert.ok(!r.ok && r.code === 'LIMIT_REACHED');
  assert.deepEqual(fs.existsSync(path.join(e.base, RES_AUDIT)) ? fs.readdirSync(path.join(e.base, RES_AUDIT)) : [], []);
});

test(`limite de ${MAX_RUNS} resultados por auditoria: o próximo é recusado sem sobrescrever`, async () => {
  const e = resultsEnv();
  const dir = path.join(e.base, RES_AUDIT);
  const adir = path.join(e.anchors, RES_AUDIT);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(adir, { recursive: true });
  let prev: string | null = null;
  let prevAnchor: string | null = null;
  for (let seq = 1; seq <= MAX_RUNS; seq++) {
    const run = seal({ ...tiny({ seq, finalizedAt: '2026-10-30T12:00:00.000Z' } as BuildContext), seq, prevSha256: prev }) as { contentSha256: string };
    const receipt = seal({ schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_ANCHOR_KIND, auditId: RES_AUDIT, seq, headSha256: run.contentSha256, anchoredAt: '2026-10-30T12:00:00.000Z', prevAnchorSha256: prevAnchor }) as { contentSha256: string };
    const name = String(seq).padStart(4, '0');
    fs.writeFileSync(path.join(dir, `s${name}.json`), serialize(run), { mode: 0o444 });
    fs.writeFileSync(path.join(adir, `a${name}.json`), serialize(receipt), { mode: 0o444 });
    prev = run.contentSha256;
    prevAnchor = receipt.contentSha256;
  }
  const full = await read(e);
  assert.ok(full.ok && full.value.runs.length === MAX_RUNS);
  const r = await append(e);
  assert.ok(!r.ok && r.code === 'LIMIT_REACHED');
  assert.equal(fs.readdirSync(dir).length, MAX_RUNS);
  const again = await append(e, async () => ({ ok: true, replayOf: MAX_RUNS }));
  assert.ok(again.ok && again.replayed && again.run.seq === MAX_RUNS, 'o reenvio idempotente no limite continua 200');
});

/* ------------------------------------------------------------------------------------------------ identidade e configuração */
test('auditId inválido e pastas ausentes são recusados (fail-closed), sem criar a pasta-base', async () => {
  const e = resultsEnv();
  for (const bad of ['', 'curto', '../etc', 'a'.repeat(65), 'AUDITORIA_MAIUSCULA', 'com espaço']) {
    const r = await appendRun(e.base, bad, build(), wopts(e));
    assert.ok(!r.ok && r.code === 'INVALID_ID', bad);
  }
  const gone = path.join(e.base, 'nao-existe');
  const missing = await appendRun(gone, RES_AUDIT, build(), wopts(e));
  assert.ok(!missing.ok && (missing.code === 'STORAGE_MISSING' || missing.code === 'UNSAFE_PATH'));
  assert.equal(fs.existsSync(gone), false, 'a pasta-base nunca é criada pelo armazenamento');
  const noAnchors = await appendRun(e.base, RES_AUDIT, build(), { ...wopts(e), anchorDir: path.join(e.anchors, 'nao-existe') });
  assert.ok(!noAnchors.ok);
  assert.deepEqual(fs.existsSync(path.join(e.base, RES_AUDIT)) ? fs.readdirSync(path.join(e.base, RES_AUDIT)) : [], [], 'sem recibos possíveis, nenhum resultado é gravado');
  const relative = await appendRun('relativo/pasta', RES_AUDIT, build(), wopts(e));
  assert.ok(!relative.ok);
});

test('sem link() atômico NÃO se grava: nenhum arquivo parcial, nenhum temporário', async () => {
  for (const unsupported of ['EPERM', 'EXDEV', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']) {
    const e = resultsEnv();
    const ops = faulty({
      async link() {
        throw errno(unsupported);
      },
    });
    const r = await append(e, build(), ops);
    assert.ok(!r.ok && r.code === 'ATOMIC_WRITE_UNAVAILABLE', unsupported);
    assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), [], `${unsupported}: nada publicado nem temporário`);
  }
});

/* ------------------------------------------------------------------------------------------------ janela de queda: resultado → recibo */
test('recibo falha DEPOIS do resultado ⇒ ANCHOR_PENDING (NUNCA sucesso); o resultado fica PENDENTE e não vale; só o reenvio o conclui, sem duplicar', async () => {
  const e = await filled(1);
  const failingAnchors = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(e.anchors)) throw errno('ENOSPC', 'sem espaço /mnt/secreto/recibo');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const second = await append(e, build(), failingAnchors);
  assert.ok(!second.ok && second.code === 'ANCHOR_PENDING' && 'pending' in second && second.pending.seq === 2 && second.runs.length === 1);
  assert.ok(!JSON.stringify(second).includes('/mnt/secreto'));
  const state = await read(e);
  assert.ok(state.ok && state.value.runs.length === 1 && state.value.pending?.seq === 2 && state.value.anchors.unanchored === 1);

  const other = await append(e, build('bia@empresa.com'), failingAnchors); // outro pedido não passa por cima da pendente
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED');
  const still = await append(e, resend(), failingAnchors); // reenvio com o recibo ainda impossível ⇒ continua pendente
  assert.ok(!still.ok && still.code === 'ANCHOR_PENDING');
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)).sort(), ['s0001.json', 's0002.json']);

  const healthy = await append(e, resend()); // disco saudável: o reenvio conclui o recibo
  assert.ok(healthy.ok && healthy.replayed && healthy.anchored && healthy.run.seq === 2);
  const final = await read(e);
  assert.ok(final.ok && final.value.runs.length === 2 && final.value.pending === null && final.value.anchors.count === 2);
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, RES_AUDIT)).sort(), ['a0001.json', 'a0002.json']);
});

test('reenvio de um resultado JÁ confirmado: replayed, nada novo gravado', async () => {
  const e = await filled(2);
  const before = snapshot(e);
  const r = await append(e, async () => ({ ok: true, replayOf: 1 }));
  assert.ok(r.ok && r.replayed && r.run.seq === 1 && r.runs.length === 2);
  assert.deepEqual(snapshot(e), before);
});

test('o recibo é tentado algumas vezes antes de desistir (erro transitório não deixa o resultado pendente)', async () => {
  const e = resultsEnv();
  let tries = 0;
  const flaky = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(e.anchors) && tries++ < 2) throw errno('EAGAIN');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const r = await append(e, build(), flaky);
  assert.ok(r.ok && !r.replayed && r.anchored, JSON.stringify(r));
  assert.equal(tries, 3);
});

test('pasta de recibos indisponível ANTES do resultado: nenhum resultado é gravado (fail-closed)', async () => {
  const e = resultsEnv();
  const broken = faulty({
    async mkdir(dir) {
      if (dir.startsWith(e.anchors)) throw errno('EACCES');
      return nodeFsOps.mkdir(dir);
    },
  });
  const r = await append(e, build(), broken);
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.deepEqual(fs.readdirSync(e.base), [], 'nem a pasta da auditoria foi criada');
});

test('falha ao gravar o RESULTADO (disco cheio): WRITE_FAILED, sem sucesso, sem recibo, sem caminhos', async () => {
  const e = resultsEnv();
  const full = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(e.base)) throw errno('ENOSPC', 'sem espaço /mnt/secreto/resultado');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const r = await append(e, build(), full);
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.ok(!JSON.stringify(r).includes('/mnt/secreto'));
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), []);
  assert.deepEqual(fs.existsSync(path.join(e.anchors, RES_AUDIT)) ? fs.readdirSync(path.join(e.anchors, RES_AUDIT)) : [], []);
  assert.ok((await append(e)).ok, 'o disco voltou: grava normalmente');
});

test('EIO/EROFS bloqueia as escritas até reiniciar; leituras continuam e mostram a pendente (fail-closed)', async () => {
  const e = await filled(1);
  const fatal = faulty({
    async link(from, to) {
      if (to.startsWith(e.anchors)) throw errno('EIO');
      return nodeFsOps.link(from, to);
    },
  });
  const r = await append(e, build(), fatal);
  assert.ok(!r.ok && r.code === 'ANCHOR_PENDING'); // o resultado já estava publicado; só o recibo falhou
  const blocked = await append(e);
  assert.ok(!blocked.ok && blocked.code === 'STORAGE_FATAL');
  const listed = await read(e);
  assert.ok(listed.ok && listed.value.pending?.seq === 2);
  clearStorageFatal(e.anchors);
  const resent = await append(e, resend());
  assert.ok(resent.ok && resent.replayed);
});

/* ------------------------------------------------------------------------------------------------ concorrência */
test('várias gravações simultâneas no mesmo processo: números únicos e sequenciais, cadeia íntegra', async () => {
  const e = resultsEnv();
  const now = clockSeed();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => append(e, build(`op${i}@empresa.com`), undefined, now)));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.deepEqual(results.map((r) => (r.ok ? r.run.seq : 0)).sort(), [1, 2, 3, 4, 5, 6]);
  const r = await read(e);
  assert.ok(r.ok && r.value.runs.length === 6 && r.value.anchors.count === 6);
});

function racing(e: ResultsEnv, times: number, anchored = true): { ops: FsOps; competitor: () => number } {
  let raced = 0;
  const dir = path.join(e.base, RES_AUDIT);
  const adir = path.join(e.anchors, RES_AUDIT);
  const ops: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (raced < times && to.startsWith(dir) && /s\d{4}\.json$/.test(to)) {
        raced++;
        const names = fs.readdirSync(dir).filter((n) => /^s\d{4}\.json$/.test(n)).sort();
        const last = names.length ? (parse(path.join(dir, names[names.length - 1] as string)) as { contentSha256: string }) : null;
        const seq = names.length + 1;
        const competitor = seal({ ...tiny({ seq, finalizedAt: '2026-10-30T13:00:00.000Z' } as BuildContext, 'bia@empresa.com'), seq, prevSha256: last?.contentSha256 ?? null });
        fs.writeFileSync(path.join(dir, `s${String(seq).padStart(4, '0')}.json`), serialize(competitor), { mode: 0o444 });
        if (anchored) {
          fs.mkdirSync(adir, { recursive: true });
          const receipts = fs.readdirSync(adir).filter((n) => /^a\d{4}\.json$/.test(n)).sort();
          const previous = receipts.length ? (parse(path.join(adir, receipts[receipts.length - 1] as string)) as { contentSha256: string }).contentSha256 : null;
          const receipt = seal({ schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_ANCHOR_KIND, auditId: RES_AUDIT, seq, headSha256: competitor.contentSha256, anchoredAt: competitor.finalizedAt, prevAnchorSha256: previous });
          fs.writeFileSync(path.join(adir, `a${String(seq).padStart(4, '0')}.json`), serialize(receipt), { mode: 0o444 });
        }
      }
      return nodeFsOps.link(from, to);
    },
  };
  return { ops, competitor: () => raced };
}

test('corrida entre processos: o link() exclusivo falha, o estado é relido (com o recibo do outro) e o build é REAVALIADO com o estado novo', async () => {
  const e = resultsEnv();
  fs.mkdirSync(path.join(e.base, RES_AUDIT));
  const { ops, competitor } = racing(e, 1);
  const contexts: number[] = [];
  const r = await append(
    e,
    async (ctx) => {
      contexts.push(ctx.seq);
      return build()(ctx);
    },
    ops,
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([competitor(), contexts, r.run.seq, r.anchored], [1, [1, 2], 2, true]);
  const state = await read(e);
  assert.ok(state.ok && state.value.runs.map((x) => [x.seq, x.finalizedBy]).join('|') === '1,bia@empresa.com|2,ana@empresa.com' && state.value.anchors.count === 2);
  assert.equal(parse(runPath(e, 2)).prevSha256, parse(runPath(e, 1)).contentSha256, 'encadeado ao resultado do outro processo');
  assert.ok(state.value.runs[1]!.finalizedAt >= state.value.runs[0]!.finalizedAt, 'hora monotônica mesmo com o relógio do outro processo à frente');
});

test('corrida com um processo que caiu ANTES do recibo: o resultado dele é PENDENTE e o nosso NÃO é gravado sobre ele', async () => {
  const e = resultsEnv();
  fs.mkdirSync(path.join(e.base, RES_AUDIT));
  const { ops } = racing(e, 1, false);
  const r = await append(e, build(), ops);
  assert.ok(!r.ok && r.code === 'PENDING_UNCONFIRMED' && 'pending' in r && r.pending.seq === 1 && r.pending.finalizedBy === 'bia@empresa.com');
  assert.deepEqual(fs.readdirSync(path.join(e.base, RES_AUDIT)), ['s0001.json']);
});

test('corrida perdida várias vezes seguidas: desiste com CONFLICT sem sobrescrever nada', async () => {
  const e = resultsEnv();
  fs.mkdirSync(path.join(e.base, RES_AUDIT));
  const { ops } = racing(e, 99);
  const r = await append(e, build(), ops);
  assert.ok(!r.ok && (r.code === 'CONFLICT' || r.code === 'LIMIT_REACHED'), JSON.stringify(r));
  const state = await read(e);
  assert.ok(state.ok && state.value.runs.every((x) => x.finalizedBy === 'bia@empresa.com'), 'só os resultados do concorrente existem; nenhum foi sobrescrito');
});

/* ------------------------------------------------------------------------------------------------ exclusão, truncamento e restauração parcial */
test('remover o ÚLTIMO resultado (recibo à frente) ⇒ TRUNCATED; remover o do meio ⇒ lacuna; nada é "consertado" em silêncio', async () => {
  const tail = await filled(3);
  fs.chmodSync(path.join(tail.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(tail, 3));
  assert.equal(await code(tail), 'TRUNCATED');
  const middle = await filled(3);
  fs.chmodSync(path.join(middle.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(middle, 2));
  assert.equal(await code(middle), 'SEQUENCE_GAP');
  const head = await filled(3);
  fs.chmodSync(path.join(head.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(head, 1));
  assert.equal(await code(head), 'SEQUENCE_GAP');
});

test('histórico inteiro apagado (pasta da auditoria sumiu) com recibos remanescentes ⇒ TRUNCATED', async () => {
  const e = await filled(2);
  fs.rmSync(path.join(e.base, RES_AUDIT), { recursive: true, force: true });
  assert.equal(await code(e), 'TRUNCATED');
});

test('restauração PARCIAL de backup: resultados antigos com recibos novos ⇒ TRUNCATED; recibos antigos com resultados novos ⇒ detectado', async () => {
  const e = resultsEnv();
  const now = clockSeed();
  assert.ok((await append(e, build(), undefined, now)).ok && (await append(e, build(), undefined, now)).ok);
  const backupRuns = tmpDir('lad-bk-r-');
  const backupAnchors = tmpDir('lad-bk-a-');
  fs.cpSync(e.base, backupRuns, { recursive: true });
  fs.cpSync(e.anchors, backupAnchors, { recursive: true });
  assert.ok((await append(e, build(), undefined, now)).ok && (await append(e, build(), undefined, now)).ok); // 4 resultados

  const oldRuns = resultsEnv();
  fs.cpSync(e.base, oldRuns.base, { recursive: true });
  fs.cpSync(e.anchors, oldRuns.anchors, { recursive: true });
  fs.rmSync(path.join(oldRuns.base, RES_AUDIT), { recursive: true, force: true });
  fs.cpSync(path.join(backupRuns, RES_AUDIT), path.join(oldRuns.base, RES_AUDIT), { recursive: true });
  assert.equal(await code(oldRuns), 'TRUNCATED', 'só a pasta de resultados voltou no tempo');

  const oldAnchors = resultsEnv();
  fs.cpSync(e.base, oldAnchors.base, { recursive: true });
  fs.cpSync(e.anchors, oldAnchors.anchors, { recursive: true });
  fs.rmSync(path.join(oldAnchors.anchors, RES_AUDIT), { recursive: true, force: true });
  fs.cpSync(path.join(backupAnchors, RES_AUDIT), path.join(oldAnchors.anchors, RES_AUDIT), { recursive: true });
  assert.equal(await code(oldAnchors), 'ANCHOR_INTEGRITY', 'só a pasta de recibos voltou no tempo: 2 resultados sem recibo (o máximo tolerado é 1)');

  // as DUAS pastas restauradas para o mesmo instante: consistente (limite documentado: indetectável sem uma terceira testemunha)
  const both = resultsEnv();
  fs.cpSync(backupRuns, both.base, { recursive: true });
  fs.cpSync(backupAnchors, both.anchors, { recursive: true });
  const restored = await read(both);
  assert.ok(restored.ok && restored.value.runs.length === 2);
});

test('um único recibo a menos é indistinguível de queda (pendente); recibo removido do MEIO ⇒ lacuna', async () => {
  const e = await filled(3);
  fs.chmodSync(path.join(e.anchors, RES_AUDIT), 0o755);
  fs.unlinkSync(receiptPath(e, 3));
  const r = await read(e);
  assert.ok(r.ok && r.value.pending?.seq === 3 && r.value.runs.length === 2 && r.value.anchors.unanchored === 1);
  const e2 = await filled(3);
  fs.chmodSync(path.join(e2.anchors, RES_AUDIT), 0o755);
  fs.unlinkSync(receiptPath(e2, 2));
  assert.equal(await code(e2), 'ANCHOR_INTEGRITY');
  const e3 = await filled(3);
  fs.rmSync(path.join(e3.anchors, RES_AUDIT), { recursive: true, force: true });
  assert.equal(await code(e3), 'ANCHOR_INTEGRITY', 'pasta de recibos apagada: 3 resultados sem recibo');
});

/* ------------------------------------------------------------------------------------------------ adulteração */
test('resultado alterado (um caractere) ⇒ selo/esquema inválido; recibo alterado ⇒ integridade; nada é devolvido', async () => {
  const e = await filled(3);
  rewrite(runPath(e, 2), (text) => text.replace('COBERTURA_INSUFICIENTE', 'CRITERIOS_INSUFICIENTES'));
  const r = await read(e);
  assert.ok(!r.ok && ['HASH_MISMATCH', 'CORRUPT'].includes(r.code), JSON.stringify(r));
  const e2 = await filled(3);
  rewrite(receiptPath(e2, 2), (text) => text.replace(/"seq": 2/, '"seq": 9'));
  const r2 = await read(e2);
  assert.ok(!r2.ok && r2.code !== 'TRUNCATED', JSON.stringify(r2));
});

test('resultado REESCRITO com selo recalculado (forja) ⇒ o recibo da outra pasta não confere (ANCHOR_MISMATCH)', async () => {
  const e = await filled(3);
  const original = parse(runPath(e, 3));
  const { contentSha256, ...rest } = original;
  void contentSha256;
  const forged = seal({ ...(rest as ScoreRunDraft & { seq: number; prevSha256: string | null }), finalizedBy: 'forjador@empresa.com' });
  fs.chmodSync(runPath(e, 3), 0o644);
  fs.writeFileSync(runPath(e, 3), serialize(forged));
  assert.equal(await code(e), 'ANCHOR_MISMATCH');
});

test('resultado forjado no MEIO, com selo recalculado e encadeamento recalculado dali em diante, continua denunciado pelos recibos', async () => {
  const e = await filled(3);
  const runs = [1, 2, 3].map((n) => parse(runPath(e, n)));
  let prev: string | null = runs[0]!.contentSha256 as string;
  const forged2 = seal({ ...stripSeal(runs[1]!), finalizedBy: 'forjador@empresa.com', prevSha256: prev } as never);
  prev = (forged2 as { contentSha256: string }).contentSha256;
  const forged3 = seal({ ...stripSeal(runs[2]!), prevSha256: prev } as never);
  for (const [n, f] of [[2, forged2], [3, forged3]] as const) {
    fs.chmodSync(runPath(e, n), 0o644);
    fs.writeFileSync(runPath(e, n), serialize(f as never));
  }
  assert.equal(await code(e), 'ANCHOR_MISMATCH');
});
function stripSeal(record: Record<string, any>): Record<string, any> {
  const { contentSha256, ...rest } = record;
  void contentSha256;
  return rest;
}

test('arquivos estranhos: nome suspeito ⇒ CORRUPT; arquivo desconhecido e temporário órfão são apenas relatados', async () => {
  const e = await filled(2);
  fs.chmodSync(path.join(e.base, RES_AUDIT), 0o755);
  fs.writeFileSync(path.join(e.base, RES_AUDIT, 'notas.txt'), 'x');
  fs.writeFileSync(path.join(e.base, RES_AUDIT, '.tmp-s0003.json-abc'), 'x');
  const ok = await read(e);
  assert.ok(ok.ok && ok.value.unexpectedFiles.includes('notas.txt') && ok.value.orphanTempFiles.length === 1 && ok.value.runs.length === 2);
  fs.writeFileSync(path.join(e.base, RES_AUDIT, 's00x3.json'), 'x');
  assert.equal(await code(e), 'CORRUPT');
});

test('resultado de OUTRA auditoria copiado para esta pasta ⇒ recusado; sequência interna que não bate com o nome ⇒ recusada', async () => {
  const other = 'auditoria-res-0002';
  const e = await filled(1);
  const e2 = resultsEnv();
  assert.ok((await appendRun(e2.base, other, async (ctx) => ({ ok: true, draft: tiny(ctx, 'ana@empresa.com', { auditId: other, scoringAuditId: other, auditIdAlias: { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId: other } }) }), wopts(e2))).ok);
  fs.chmodSync(path.join(e.base, RES_AUDIT), 0o755);
  fs.chmodSync(runPath(e, 1), 0o644);
  fs.copyFileSync(path.join(e2.base, other, 's0001.json'), runPath(e, 1));
  assert.equal(await code(e), 'CHAIN_BROKEN');
  const swapped = await filled(2);
  fs.chmodSync(path.join(swapped.base, RES_AUDIT), 0o755);
  const first = fs.readFileSync(runPath(swapped, 1));
  fs.chmodSync(runPath(swapped, 2), 0o644);
  fs.writeFileSync(runPath(swapped, 2), first);
  assert.equal(await code(swapped), 'CHAIN_BROKEN');
});

test('encadeamento quebrado com selos e recibos válidos (prevSha256 de outro registro) ⇒ CHAIN_BROKEN', async () => {
  const e = resultsEnv();
  const dir = path.join(e.base, RES_AUDIT);
  const adir = path.join(e.anchors, RES_AUDIT);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(adir, { recursive: true });
  const first = seal({ ...tiny({ seq: 1, finalizedAt: '2026-10-30T12:00:00.000Z' } as BuildContext), seq: 1, prevSha256: null }) as { contentSha256: string };
  const second = seal({ ...tiny({ seq: 2, finalizedAt: '2026-10-30T12:00:01.000Z' } as BuildContext), seq: 2, prevSha256: sha256Hex('outro') }) as { contentSha256: string };
  let prevAnchor: string | null = null;
  [first, second].forEach((run, i) => {
    const seq = i + 1;
    const receipt = seal({ schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_ANCHOR_KIND, auditId: RES_AUDIT, seq, headSha256: run.contentSha256, anchoredAt: '2026-10-30T12:00:02.000Z', prevAnchorSha256: prevAnchor }) as { contentSha256: string };
    prevAnchor = receipt.contentSha256;
    fs.writeFileSync(path.join(dir, `s000${seq}.json`), serialize(run as never), { mode: 0o444 });
    fs.writeFileSync(path.join(adir, `a000${seq}.json`), serialize(receipt as never), { mode: 0o444 });
  });
  assert.equal(await code(e), 'CHAIN_BROKEN');
});

test('hora que anda para trás entre resultados gravados é inconsistência (SEMANTIC), não ordem', async () => {
  const e = resultsEnv();
  const dir = path.join(e.base, RES_AUDIT);
  fs.mkdirSync(dir, { recursive: true });
  const first = seal({ ...tiny({ seq: 1, finalizedAt: '2026-10-30T12:00:10.000Z' } as BuildContext), seq: 1, prevSha256: null });
  const second = seal({ ...tiny({ seq: 2, finalizedAt: '2026-10-30T12:00:05.000Z' } as BuildContext), seq: 2, prevSha256: first.contentSha256 });
  fs.writeFileSync(path.join(dir, 's0001.json'), serialize(first), { mode: 0o444 });
  fs.writeFileSync(path.join(dir, 's0002.json'), serialize(second), { mode: 0o444 });
  assert.equal(await code(e), 'SEMANTIC');
});

test('leitura nunca escreve: relê tudo (resultados e recibos) sem alterar nenhum byte nem criar pastas', async () => {
  const e = await filled(3);
  const before = snapshot(e);
  for (let i = 0; i < 3; i++) assert.ok((await read(e)).ok);
  assert.deepEqual(snapshot(e), before);
  const empty = resultsEnv();
  const r = await read(empty);
  assert.ok(r.ok && r.value.runs.length === 0 && r.value.pending === null);
  assert.deepEqual([fs.readdirSync(empty.base), fs.readdirSync(empty.anchors)], [[], []]);
});
