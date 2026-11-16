import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256Hex } from '../src/lib/link-audit/canonical';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { clearStorageFatal, seal, serialize } from '../src/lib/link-audit-storage';
import { createScoringResultsService, type ResultsFailure } from '../src/lib/link-audit-scoring-runs';
import { RESULTS_HTTP_STATUS, RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { clock, hashTree, must, rec, registerCleanup, world } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { BLOCKING, bodyOf, buildEvaluation, FakeEvaluator, fakeBasis, makeService, OP_A, OP_B, receiptPath, resultsEnv, RES_AUDIT, runPath, tickClock, type ResultsEnv, type Spec } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I4 — a FINALIZAÇÃO e a consulta. Avaliador injetado (entrada e resultado REAIS do motor; só o caminho do disco de
 * evidências/decisões é falso) para os casos que o mapeador real não alcança (PONTUADO) e para mudar o estado ENTRE as etapas;
 * e um bloco com a prévia REAL sobre pastas reais (INCONCLUSIVO verdadeiro, decisão pendente, revogação pendente).
 */
registerCleanup();

const trees = (e: ResultsEnv) => [hashTree(e.base), hashTree(e.anchors)];
const refused = (r: { ok: boolean }): ResultsFailure => {
  assert.equal(r.ok, false, 'devia ter sido recusado');
  return r as ResultsFailure;
};
function setup(spec: Spec = {}, over: Parameters<typeof makeService>[2] = {}) {
  const e = resultsEnv();
  const ev = buildEvaluation(spec);
  const evaluator = new FakeEvaluator(ev);
  return { e, ev, evaluator, svc: makeService(e, evaluator, over) };
}
const finalize = (s: ReturnType<typeof setup>, actor = OP_B, body: unknown = bodyOf(s.ev)) => s.svc.finalize(actor, RES_AUDIT, body);

/* ------------------------------------------------------------------------------------------------ sucesso */
test('PONTUADO: grava resultado e recibo, devolve a projeção pública definitiva, e a consulta confere tudo', async () => {
  const s = setup({ kind: 'PONTUADO' });
  const r = await finalize(s);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.value.definitive, r.value.replayed, r.value.anchored, r.value.head.seq, r.value.stateChangedAfterFinalization], [true, false, true, 1, false]);
  assert.deepEqual(fs.readdirSync(path.join(s.e.base, RES_AUDIT)), ['s0001.json']);
  assert.deepEqual(fs.readdirSync(path.join(s.e.anchors, RES_AUDIT)), ['a0001.json']);
  const run = r.value.run as Record<string, any>;
  assert.equal(run.outcome, 'PONTUADO');
  assert.ok(['PROVISORIO', 'PUBLICAVEL'].includes(run.level));
  assert.ok(run.result.index !== null && run.result.confidence !== null);
  assert.equal(run.hashes.inputSha256, s.ev.inputSha256);
  assert.equal(run.decisions.head.sha256, s.ev.decisions.head?.sha256);
  assert.equal(r.value.head.sha256, run.hashes.contentSha256);
  assert.match(run.versions.rulerFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(run.finalizedBy, 'bia@empresa.com');
  assert.match(run.finalizedAt, /^2026-10-30T12:00:\d\d\.\d{3}Z$/);

  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok && listed.value.results.length === 1 && listed.value.pending === null && listed.value.definitive === true);
  assert.deepEqual([listed.value.results[0]?.stale, listed.value.results[0]?.superseded, listed.value.head?.seq, listed.value.anchors.unanchored], [false, false, 1, 0]);
  assert.equal(listed.value.integrity.status, 'OK');
  const got = await s.svc.get(OP_B, RES_AUDIT, 1);
  assert.ok(got.ok && got.value.stale === false && got.value.superseded === false);
  assert.deepEqual(got.value.run, run, 'consulta e finalização devolvem a MESMA projeção');
});

test('PONTUADO: pontos obtidos são número no avaliado e null em NOT_VERIFIED, na finalização e na consulta de detalhe; o registro selado não muda ("ausência nunca vira zero")', async () => {
  const s = setup({ kind: 'PONTUADO' });
  const r = await finalize(s);
  assert.ok(r.ok, JSON.stringify(r));
  const sealed = fs.readFileSync(path.join(s.e.base, RES_AUDIT, 's0001.json'), 'utf8');
  const check = (run: Record<string, any>): void => {
    const subs = run.result.subcriteria as Array<Record<string, any>>;
    assert.ok(subs.some((item) => item.state === 'NOT_VERIFIED') && subs.some((item) => item.state === 'SCORED'), 'a fixture mistura avaliado e não verificado');
    for (const item of subs) {
      if (item.state === 'SCORED' || item.state === 'ABSENCE_PROVEN') assert.equal(typeof item.obtainedHalfPoints, 'number', item.id);
      else assert.equal(item.obtainedHalfPoints, null, `${item.id} ${item.state}`);
    }
    for (const item of run.result.criteria as Array<Record<string, any>>) {
      if (item.status === 'EVALUATED' || item.status === 'PARTIAL') assert.equal(typeof item.obtainedHalfPoints, 'number', item.id);
      else assert.equal(item.obtainedHalfPoints, null, `${item.id} ${item.status}`);
    }
  };
  check(r.value.run as Record<string, any>);
  const got = await s.svc.get(OP_B, RES_AUDIT, 1);
  assert.ok(got.ok);
  check(got.value.run as Record<string, any>);
  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok && !/obtainedHalfPoints/.test(JSON.stringify(listed.value.results)), 'a lista é resumo: não carrega pontos por subcritério');
  assert.equal(fs.readFileSync(path.join(s.e.base, RES_AUDIT, 's0001.json'), 'utf8'), sealed, 'a projeção não toca o registro selado');
});

test('INCONCLUSIVO é um resultado válido e selável, sem índice nem pontos (index:null)', async () => {
  const s = setup({ kind: 'INCONCLUSIVO' });
  const r = await finalize(s);
  assert.ok(r.ok, JSON.stringify(r));
  const run = r.value.run as Record<string, any>;
  assert.equal(run.outcome, 'INCONCLUSIVO');
  assert.equal(run.level, null);
  assert.equal(run.result.index, null);
  assert.equal(run.result.confidence, null);
  assert.ok(run.inconclusive.minimumCoveragePercent === 40 && run.inconclusive.coveragePercent < 40);
  assert.ok(!('obtainedHalfPoints' in run.result.totals));
  assert.ok(!/\(\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?\)/.test(JSON.stringify(run)));
  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok && listed.value.results[0]?.outcome === 'INCONCLUSIVO' && listed.value.results[0]?.level === null && listed.value.results[0]?.reasonCode !== null);
});

test('a resposta não vaza entrada do motor, justificativas, URLs, hashes brutos nem caminhos (autor/hora são do servidor)', async () => {
  const s = setup({ kind: 'PONTUADO', website: true });
  const r = await finalize(s, OP_B);
  assert.ok(r.ok);
  const text = JSON.stringify(r.value);
  assert.ok(!/Conferido no painel e no site oficial|exemplo\.com\.br|utm_source=|utm_medium=|"input"|rawSha256|\/tmp|\/mnt|lad-rs/.test(text), text.slice(0, 400));
  const bytes = fs.readFileSync(runPath(s.e, 1), 'utf8');
  assert.ok(bytes.includes('exemplo.com.br'), 'o registro interno guarda a entrada exata do motor (por isso nunca sai por uma rota)');
});

test('o autor e a hora vêm da sessão e do servidor: relógio crescente e autor = operador autenticado', async () => {
  const s = setup();
  const first = await finalize(s, OP_A);
  assert.ok(first.ok);
  const second = setup({ kind: 'INCONCLUSIVO' }, { clock: tickClock(100) });
  const r2 = await finalize(second, OP_B);
  assert.ok(r2.ok);
  assert.equal((first.value.run as any).finalizedBy, 'ana@empresa.com');
  assert.equal((r2.value.run as any).finalizedBy, 'bia@empresa.com');
  assert.ok((r2.value.run as any).finalizedAt > (first.value.run as any).finalizedAt);
});

/* ------------------------------------------------------------------------------------------------ idempotência */
test('reenvio idêntico de um resultado CONFIRMADO ⇒ replayed (qualquer operador), nada novo gravado; o reconhecimento vem ANTES da avaliação e a avaliação só serve para sinalizar mudança', async () => {
  const s = setup();
  assert.ok((await finalize(s, OP_B)).ok);
  const before = trees(s.e);
  const evaluations = s.evaluator.evaluateCalls;
  for (const actor of [OP_B, OP_A]) {
    const again = await finalize(s, actor);
    assert.ok(again.ok && again.value.replayed && again.value.anchored && again.value.head.seq === 1 && again.value.stateChangedAfterFinalization === false, JSON.stringify(again));
    assert.equal((again.value.run as any).seq, 1);
  }
  assert.deepEqual(trees(s.e), before);
  assert.equal(s.evaluator.evaluateCalls, evaluations + 2, 'uma leitura por reenvio, só para comparar com o estado de hoje (nunca para decidir gravar)');
});

test('novo estado ⇒ novo resultado encadeado; o anterior fica SUBSTITUÍDO e o mais recente informa se está DESATUALIZADO', async () => {
  const s = setup({ variant: 'v1' });
  assert.ok((await finalize(s)).ok);
  const second = buildEvaluation({ variant: 'v2', headSeed: 'h2' });
  s.evaluator.current = second;
  const r2 = await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(second));
  assert.ok(r2.ok && !r2.value.replayed && r2.value.head.seq === 2, JSON.stringify(r2));
  const read = await readRunLog(s.e.base, RES_AUDIT, { anchorDir: s.e.anchors });
  assert.ok(read.ok && read.value.runs[1]?.prevSha256 === read.value.runs[0]?.contentSha256);
  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.results.map((x) => [x.seq, x.superseded, x.stale]), [[1, true, null], [2, false, false]]);
  s.evaluator.current = buildEvaluation({ variant: 'v3', headSeed: 'h3' }); // o mundo andou: o resultado 2 passa a estar desatualizado
  const stale = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(stale.ok && stale.value.results[1]?.stale === true && stale.value.currentInputSha256 !== null);
  const got = await s.svc.get(OP_B, RES_AUDIT, 2);
  assert.ok(got.ok && got.value.stale === true);
  const old = await s.svc.get(OP_B, RES_AUDIT, 1);
  assert.ok(old.ok && old.value.superseded === true && old.value.stale === null);
});

test('mesmo conteúdo de entrada mas OUTRO head das decisões não é reenvio: vira novo resultado (o head faz parte da identidade do pedido)', async () => {
  const s = setup({ kind: 'PONTUADO', headSeed: 'h1' });
  assert.ok((await finalize(s)).ok);
  const moved = buildEvaluation({ kind: 'PONTUADO', headSeed: 'h2' }); // mesma entrada do motor, head diferente
  assert.equal(moved.inputSha256, s.ev.inputSha256);
  s.evaluator.current = moved;
  const r = await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(moved));
  assert.ok(r.ok && !r.value.replayed && r.value.head.seq === 2, JSON.stringify(r));
});

test('reenvio de um registro que NÃO se explica (selo e recibo refeitos) ⇒ RESULT_INTEGRITY, nunca replayed', async () => {
  const s = setup({ kind: 'PONTUADO' });
  assert.ok((await finalize(s)).ok);
  const { contentSha256, ...rest } = JSON.parse(fs.readFileSync(runPath(s.e, 1), 'utf8')) as Record<string, any>;
  void contentSha256;
  const forged = seal({ ...rest, outcome: 'INCONCLUSIVO' }) as { contentSha256: string };
  fs.chmodSync(runPath(s.e, 1), 0o644);
  fs.writeFileSync(runPath(s.e, 1), serialize(forged as never));
  const { contentSha256: old, ...receipt } = JSON.parse(fs.readFileSync(receiptPath(s.e, 1), 'utf8')) as Record<string, any>;
  void old;
  fs.chmodSync(receiptPath(s.e, 1), 0o644);
  fs.writeFileSync(receiptPath(s.e, 1), serialize(seal({ ...receipt, headSha256: forged.contentSha256 }) as never));
  assert.equal(refused(await finalize(s)).code, 'RESULT_INTEGRITY');
});

/* ------------------------------------------------------------------------------------------------ recusas (nada é gravado) */
test('recusas por bloqueio: decisão pendente, revogação pendente, decisão fora do contrato, atribuição incompleta ⇒ NOT_FINALIZABLE com os bloqueios; nada gravado', async () => {
  const cases: Array<[string, string, string[]]> = [
    ['decisão pendente', 'DECISION_PENDING', ['op-c2']],
    ['revogação pendente', 'DECISION_PENDING', ['op-c3', 'op-p3']],
    ['decisão fora do contrato', 'DECISION_NOT_SUPPORTED', ['op-x']],
    ['sem captura íntegra', 'NO_STORED_CAPTURE', []],
    ['atribuição de culpados incompleta (entrada recusada)', 'INPUT_REFUSED_UNATTRIBUTED', []],
  ];
  for (const [name, code, ids] of cases) {
    const s = setup({ allowed: false, blockers: [BLOCKING(code, ids)] });
    const r = refused(await finalize(s));
    assert.equal(r.code, 'NOT_FINALIZABLE', name);
    assert.deepEqual(r.blockers?.map((b) => [b.code, b.decisionIds]), [[code, ids]], name);
    assert.deepEqual(trees(s.e), [{}, {}], `${name}: nada gravado`);
    assert.equal(RESULTS_HTTP_STATUS[r.code], 409);
  }
  // bloqueio BLOQUEANTE mesmo que o sinal `allowed` venha verdadeiro (defesa em profundidade)
  const s = setup({ allowed: true, blockers: [BLOCKING('DECISION_PENDING', ['op-c2'])] });
  assert.equal(refused(await finalize(s)).code, 'NOT_FINALIZABLE');
  assert.deepEqual(trees(s.e), [{}, {}]);
});

test('expectedHead desatualizado ⇒ HEAD_MISMATCH com o head ATUAL; retrocesso ⇒ HISTORY_REGRESSED; ausente quando já há decisões ⇒ HEAD_MISMATCH', async () => {
  const seen = buildEvaluation({ kind: 'PONTUADO', headSeed: 'h1' });
  const s = setup({ kind: 'PONTUADO', headSeed: 'h2' });
  const stale = refused(await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(seen)));
  assert.equal(stale.code, 'HEAD_MISMATCH');
  assert.deepEqual(stale.head, s.ev.decisions.head);
  const none = refused(await s.svc.finalize(OP_B, RES_AUDIT, { ...bodyOf(s.ev), expectedHead: null }));
  assert.equal(none.code, 'HEAD_MISMATCH');
  const regressed = setup({ kind: 'INCONCLUSIVO', headSeed: 'h9' }); // head atual seq 1; o operador viu seq 6
  const back = refused(await regressed.svc.finalize(OP_B, RES_AUDIT, bodyOf(seen)));
  assert.equal(back.code, 'HISTORY_REGRESSED');
  assert.equal(back.head?.seq, 1);
  for (const x of [s, regressed]) assert.deepEqual(trees(x.e), [{}, {}]);
});

test('expectedInputSha256 divergente ⇒ INPUT_CHANGED (inclusive captura TROCADA com o mesmo número e a mesma data); nada gravado', async () => {
  const s = setup({ kind: 'PONTUADO' });
  const wrong = refused(await s.svc.finalize(OP_B, RES_AUDIT, { ...bodyOf(s.ev), expectedInputSha256: sha256Hex('outra') }));
  assert.equal(wrong.code, 'INPUT_CHANGED');
  const seen = bodyOf(s.ev);
  s.evaluator.current = buildEvaluation({ kind: 'PONTUADO', evidenceSalt: 'captura-trocada' }); // mesmos números e datas, outro conteúdo
  const swapped = refused(await s.svc.finalize(OP_B, RES_AUDIT, seen));
  assert.equal(swapped.code, 'INPUT_CHANGED');
  s.evaluator.current = buildEvaluation({ kind: 'PONTUADO', variant: 'v2' }); // o conteúdo do perfil mudou depois da prévia
  assert.equal(refused(await s.svc.finalize(OP_B, RES_AUDIT, seen)).code, 'INPUT_CHANGED');
  assert.deepEqual(trees(s.e), [{}, {}]);
});

test('corpo estrito: só expectedHead e expectedInputSha256; pontuação, entrada, data, autor, hashes ou qualquer outro campo ⇒ FORBIDDEN_FIELDS; malformado ⇒ INVALID_BODY', async () => {
  const s = setup();
  const good = bodyOf(s.ev);
  for (const extra of ['score', 'index', 'result', 'input', 'referenceDate', 'finalizedBy', 'finalizedAt', 'outcome', 'level', 'inputSha256', 'resultSha256', 'obtainedHalfPoints', 'seq', 'path', '__proto__x']) {
    const r = refused(await s.svc.finalize(OP_B, RES_AUDIT, { ...good, [extra]: 1 }));
    assert.equal(r.code, 'FORBIDDEN_FIELDS', extra);
    assert.ok(r.issues.every((issue) => issue.length < 80));
  }
  for (const bad of [null, [], 'texto', 42, {}, { expectedHead: null }, { expectedInputSha256: good.expectedInputSha256 }, { ...good, expectedInputSha256: 'xyz' }, { ...good, expectedInputSha256: good.expectedInputSha256.toUpperCase() }, { ...good, expectedHead: { seq: 0, sha256: 'a'.repeat(64) } }, { ...good, expectedHead: { seq: 1, sha256: 'curto' } }, { ...good, expectedHead: { seq: 1, sha256: 'a'.repeat(64), x: 1 } }, { ...good, expectedHead: 7 }]) {
    assert.ok(['INVALID_BODY', 'FORBIDDEN_FIELDS'].includes(refused(await s.svc.finalize(OP_B, RES_AUDIT, bad)).code), JSON.stringify(bad));
  }
  assert.equal(s.evaluator.evaluateCalls, 0, 'um corpo inválido nunca chega à avaliação');
  assert.deepEqual(trees(s.e), [{}, {}]);
});

test('auditId e operador inválidos são recusados antes de qualquer leitura', async () => {
  const s = setup();
  for (const bad of ['', 'curto', '../etc', 'a'.repeat(65), 'MAIUSCULA_AUDIT', 'com espaço']) assert.equal(refused(await s.svc.finalize(OP_B, bad, bodyOf(s.ev))).code, 'INVALID_PARAMS', bad);
  for (const email of ['', 'sem-arroba', 'a b@c.com', '@x.com', `${'a'.repeat(250)}@x.com`]) assert.equal(refused(await s.svc.finalize({ email }, RES_AUDIT, bodyOf(s.ev))).code, 'OPERATOR_IDENTITY_INVALID', email);
  assert.equal(refused(await s.svc.finalize(null as never, RES_AUDIT, bodyOf(s.ev))).code, 'OPERATOR_IDENTITY_INVALID');
  assert.equal(s.evaluator.evaluateCalls, 0);
  const bad = createScoringResultsService({ preview: s.evaluator, basisReader: fakeBasis().reader, baseDir: s.e.base, anchorDir: s.e.anchors, clock: () => 'agora' });
  assert.equal(refused(await bad.finalize(OP_B, RES_AUDIT, bodyOf(s.ev))).code, 'INTERNAL_ERROR', 'relógio fora do formato: nada é gravado');
  assert.deepEqual(trees(s.e), [{}, {}]);
});

test('falhas da avaliação (integridade das evidências, auditoria inexistente, leitura inconsistente) passam adiante sem gravar nada', async () => {
  for (const code of ['EVIDENCE_INTEGRITY', 'AUDIT_NOT_FOUND', 'READ_INCONSISTENT', 'DECISIONS_UNAVAILABLE', 'INTERNAL_ERROR'] as const) {
    const s = setup();
    s.evaluator.current = { ok: false, code, issues: [] } as never;
    const r = refused(await finalize(s));
    assert.equal(r.code, code);
    assert.deepEqual(trees(s.e), [{}, {}]);
  }
});

/* ------------------------------------------------------------------------------------------------ website: releitura do bruto íntegro */
test('website emitido: o servidor RELÊ o bruto íntegro (rawSha256) e só grava se a derivação conferir', async () => {
  const basis = fakeBasis({ verdict: 'MATCH' });
  const s = setup({ kind: 'PONTUADO', website: true }, { basisReader: basis.reader });
  const r = await finalize(s);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(basis.state.calls.length, 1);
  assert.deepEqual(Object.keys(basis.state.calls[0]!).sort(), ['derived', 'rawSha256', 'sourceRef', 'utmLevel']);
  assert.equal(basis.state.calls[0]?.utmLevel, 'COMPLETE');
  const run = r.value.run as Record<string, any>;
  assert.deepEqual(Object.keys(run.website).sort(), ['rule', 'utmLevel', 'x5Proof']);
  const stored = await readRunLog(s.e.base, RES_AUDIT, { anchorDir: s.e.anchors });
  assert.ok(stored.ok && stored.value.runs[0]?.websiteDerivation?.rawSha256 === basis.state.calls[0]?.rawSha256, 'o hash do bruto fica no registro interno, nunca na resposta');
});

test('website: bruto adulterado ou ilegível agora ⇒ WEBSITE_DERIVATION_MISMATCH; sem website na entrada a releitura nem acontece', async () => {
  for (const verdict of ['MISMATCH', 'NOT_AVAILABLE'] as const) {
    const basis = fakeBasis({ verdict });
    const s = setup({ kind: 'PONTUADO', website: true }, { basisReader: basis.reader });
    assert.equal(refused(await finalize(s)).code, 'WEBSITE_DERIVATION_MISMATCH', verdict);
    assert.deepEqual(trees(s.e), [{}, {}]);
  }
  const none = fakeBasis({ verdict: 'MISMATCH' });
  const s = setup({ kind: 'PONTUADO' }, { basisReader: none.reader });
  assert.ok((await finalize(s)).ok);
  assert.equal(none.state.calls.length, 0);
  const noProof = setup({ kind: 'PONTUADO', website: true, websiteWithoutProof: true });
  assert.equal(refused(await finalize(noProof)).code, 'WEBSITE_DERIVATION_MISMATCH', 'website emitido sem derivação comprovada na base');
});

/* ------------------------------------------------------------------------------------------------ política de revalidação (TOCTOU) */
test('mudança DEPOIS da avaliação e ANTES de publicar (releitura final) ⇒ INPUT_CHANGED, nada gravado', async () => {
  const s = setup({ kind: 'PONTUADO' });
  s.evaluator.onFingerprint = (n) => {
    if (n === 1) s.evaluator.current = buildEvaluation({ kind: 'PONTUADO', headSeed: 'h-novo' }); // uma decisão foi confirmada no intervalo
  };
  assert.equal(refused(await finalize(s)).code, 'INPUT_CHANGED');
  assert.deepEqual(trees(s.e), [{}, {}]);
  assert.equal(s.evaluator.evaluateCalls, 1);
});

test('mudança DEPOIS da gravação: o resultado vale para o estado que ele grava, é informado (stateChangedAfterFinalization) e fica DESATUALIZADO', async () => {
  const s = setup({ kind: 'PONTUADO' });
  s.evaluator.onFingerprint = (n) => {
    if (n === 2) s.evaluator.current = buildEvaluation({ kind: 'PONTUADO', variant: 'v-depois', headSeed: 'h-depois' });
  };
  const r = await finalize(s);
  assert.ok(r.ok && r.value.stateChangedAfterFinalization === true && !r.value.replayed, JSON.stringify(r));
  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok && listed.value.results[0]?.stale === true);
});

test('captura TROCADA com o mesmo número e a mesma data depois de um resultado ⇒ EVIDENCE_HASH_CHANGED (hashes fixados), nada novo gravado', async () => {
  const s = setup({ kind: 'PONTUADO', variant: 'v1' });
  assert.ok((await finalize(s)).ok);
  const swapped = buildEvaluation({ kind: 'PONTUADO', variant: 'v2', headSeed: 'h2', evidenceSalt: 'captura-trocada' }); // operador viu ESTA prévia
  s.evaluator.current = swapped;
  const before = trees(s.e);
  const r = refused(await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(swapped)));
  assert.equal(r.code, 'EVIDENCE_HASH_CHANGED');
  assert.ok(r.issues.length > 0 && r.issues.every((issue) => /^mudou: (capture|report):c\d{4}/.test(issue)));
  assert.deepEqual(trees(s.e), before);
  const fine = buildEvaluation({ kind: 'PONTUADO', variant: 'v2', headSeed: 'h2', extraRefs: ['capture:c0007'] }); // captura NOVA (número novo) é permitida
  s.evaluator.current = fine;
  assert.ok((await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(fine))).ok);
});

test('o registro grava o head das decisões e os hashes das evidências REALMENTE usados', async () => {
  const s = setup({ kind: 'PONTUADO', headSeed: 'h-registrado', evidenceSalt: 'sal' });
  assert.ok((await finalize(s)).ok);
  const read = await readRunLog(s.e.base, RES_AUDIT, { anchorDir: s.e.anchors });
  assert.ok(read.ok);
  const run = read.value.runs[0]!;
  assert.deepEqual(run.decisions.head, s.ev.decisions.head);
  assert.deepEqual(run.evidenceBasis.map((b) => [b.ref, b.contentSha256]), s.ev.input!.evidences.map((x) => [x.id, x.contentSha256]));
  assert.equal(run.inputSha256, s.ev.inputSha256);
  assert.equal(run.resultSha256, s.ev.result!.resultSha256);
  assert.equal(run.rulerFingerprint, s.ev.result!.rulerFingerprint);
  assert.equal(run.referenceDate, s.ev.input!.referenceDate);
  assert.equal(run.decisions.count, s.ev.decisions.decisions.length);
});

/* ------------------------------------------------------------------------------------------------ registros que violam a política não são gravados */
test('registro coerente com o motor mas que viola a política do mapeador (avaliações, campo completo sem prova) é recusado na gravação', async () => {
  for (const spec of [{ reviews: true }, { completeField: true }] as const) {
    const s = setup({ kind: 'PONTUADO', ...spec });
    const r = refused(await finalize(s));
    assert.equal(r.code, 'RESULT_INTEGRITY', JSON.stringify(spec));
    assert.deepEqual(trees(s.e), [{}, {}]);
  }
});

/* ------------------------------------------------------------------------------------------------ disco e recibo */
test('falha ao criar o RECIBO ⇒ RESULT_ANCHOR_PENDING (nunca sucesso); o resultado não vale; só o MESMO autor, reenviando, conclui', async () => {
  let failReceipts = true;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-ra-')) throw errno('ENOSPC', 'sem espaço /mnt/secreto/recibo');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const s = setup({ kind: 'PONTUADO' }, { fs: ops });
  const first = refused(await finalize(s, OP_B));
  assert.equal(first.code, 'RESULT_ANCHOR_PENDING');
  assert.equal(RESULTS_HTTP_STATUS[first.code], 503);
  assert.deepEqual([first.pending?.seq, first.pending?.isMine], [1, true]);
  assert.ok(!JSON.stringify(first).includes('bia@empresa.com'), 'a pendente não revela o e-mail de ninguém');
  assert.deepEqual(first.pending?.decisionsHead, s.ev.decisions.head, 'o autor recupera o pedido original (head + inputSha256)');
  assert.equal(first.pending?.inputSha256, s.ev.inputSha256);
  assert.ok(!JSON.stringify(first).includes('/mnt/secreto'));
  assert.ok(fs.existsSync(runPath(s.e, 1)) && !fs.existsSync(receiptPath(s.e, 1)), 'resultado publicado, recibo ausente');

  const listed = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(listed.ok && listed.value.results.length === 0 && listed.value.pending?.seq === 1 && listed.value.anchors.unanchored === 1, 'a pendente NÃO é resultado');
  const got = refused(await s.svc.get(OP_B, RES_AUDIT, 1));
  assert.equal(got.code, 'RESULT_PENDING_UNCONFIRMED');

  const other = buildEvaluation({ variant: 'v2', headSeed: 'h2' });
  s.evaluator.current = other;
  assert.equal(refused(await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(other))).code, 'RESULT_PENDING_UNCONFIRMED', 'outro pedido não passa por cima da pendente');
  s.evaluator.current = s.ev;
  const stranger = refused(await finalize(s, OP_A));
  assert.equal(stranger.code, 'RESULT_PENDING_UNCONFIRMED', 'outro operador não conclui a pendente alheia');
  const still = refused(await finalize(s, OP_B));
  assert.equal(still.code, 'RESULT_ANCHOR_PENDING', 'recibo ainda impossível: continua pendente');

  failReceipts = false;
  const done = await finalize(s, OP_B);
  assert.ok(done.ok && done.value.replayed && done.value.anchored && done.value.head.seq === 1, JSON.stringify(done));
  const after = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(after.ok && after.value.results.length === 1 && after.value.pending === null);
  assert.deepEqual(fs.readdirSync(path.join(s.e.base, RES_AUDIT)), ['s0001.json'], 'sem duplicar');
});

test('falha de disco ao gravar o resultado ⇒ RESULTS_STORAGE_UNAVAILABLE sem caminhos, nada gravado, e o reenvio funciona quando o disco volta', async () => {
  let broken = true;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (broken && target.includes('lad-rs-')) throw errno('ENOSPC', 'sem espaço /mnt/secreto/resultado');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const s = setup({ kind: 'PONTUADO' }, { fs: ops });
  const r = refused(await finalize(s));
  assert.equal(r.code, 'RESULTS_STORAGE_UNAVAILABLE');
  assert.deepEqual(r.issues, []);
  assert.ok(!JSON.stringify(r).includes('/mnt/secreto'));
  assert.deepEqual(fs.readdirSync(path.join(s.e.base, RES_AUDIT)), []);
  broken = false;
  assert.ok((await finalize(s)).ok);
});

test('erro fatal de disco (EIO) bloqueia as escritas até reiniciar; leituras continuam', async () => {
  let fatal = true;
  const ops = faulty({
    async link(from, to) {
      if (fatal && to.includes('lad-ra-')) throw errno('EIO');
      return nodeFsOps.link(from, to);
    },
  });
  const s = setup({ kind: 'PONTUADO' }, { fs: ops });
  assert.equal(refused(await finalize(s)).code, 'RESULT_ANCHOR_PENDING');
  fatal = false;
  const blocked = refused(await finalize(s)); // mesmo reenvio: a base está bloqueada
  assert.equal(blocked.code, 'RESULTS_STORAGE_UNAVAILABLE');
  assert.ok((await s.svc.list(OP_B, RES_AUDIT)).ok, 'leitura continua');
  clearStorageFatal(s.e.anchors);
  assert.ok((await finalize(s)).ok);
});

test('pasta de recibos ausente/indisponível ⇒ nenhum resultado é gravado (fail-closed)', async () => {
  const s = setup({ kind: 'PONTUADO' });
  fs.rmSync(s.e.anchors, { recursive: true, force: true });
  const r = refused(await finalize(s));
  assert.ok(['RESULT_ANCHOR_STORAGE_UNAVAILABLE', 'RESULTS_MISCONFIGURED'].includes(r.code), r.code);
  assert.deepEqual(fs.existsSync(path.join(s.e.base, RES_AUDIT)) ? fs.readdirSync(path.join(s.e.base, RES_AUDIT)) : [], []);
});

test('configuração insegura: pastas iguais, aninhadas, iguais às de evidências/decisões ou relativas ⇒ RESULTS_MISCONFIGURED, nada gravado', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation();
  const evaluator = new FakeEvaluator(ev);
  const cases: Array<Partial<Parameters<typeof makeService>[2]>> = [
    { anchorDir: e.base },
    { anchorDir: path.join(e.base, 'recibos') },
    { baseDir: path.join(e.anchors, 'resultados') },
    { otherDirs: [e.base] },
    { otherDirs: [e.anchors] },
    { otherDirs: [path.dirname(e.base)] },
    { baseDir: 'relativo/resultados' },
    { anchorDir: 'relativo/recibos' },
    { baseDir: '' },
  ];
  for (const over of cases) {
    fs.mkdirSync(path.join(e.base, 'recibos'), { recursive: true });
    const svc = makeService(e, evaluator, over);
    assert.equal(refused(await svc.finalize(OP_B, RES_AUDIT, bodyOf(ev))).code, 'RESULTS_MISCONFIGURED', JSON.stringify(over));
    assert.equal(refused(await svc.list(OP_B, RES_AUDIT)).code, 'RESULTS_MISCONFIGURED');
  }
  assert.equal(evaluator.evaluateCalls, 0);
});

/* ------------------------------------------------------------------------------------------------ leitura: integridade total */
async function finalized(count = 3) {
  const s = setup({ kind: 'PONTUADO', variant: 'v0', headSeed: 'h0' });
  for (let i = 1; i <= count; i++) {
    const ev = buildEvaluation({ kind: i === 2 ? 'INCONCLUSIVO' : 'PONTUADO', variant: `v${i}`, headSeed: `h${i}` });
    s.evaluator.current = ev;
    const r = await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(ev));
    assert.ok(r.ok, JSON.stringify(r));
  }
  return s;
}
const rewrite = (file: string, mutate: (text: string) => string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
};
const noData = (r: ResultsFailure): void => {
  const text = JSON.stringify(r);
  assert.ok(!/definitive|"result"|"input"|outcome|inputSha256|\/tmp|lad-rs/.test(text), `falha de integridade não pode trazer dados: ${text.slice(0, 200)}`);
};

test('resultado adulterado (um caractere) ⇒ list e get recusam com RESULT_INTEGRITY e NENHUM dado', async () => {
  const s = await finalized(3);
  rewrite(runPath(s.e, 2), (text) => text.replace('"outcome": "INCONCLUSIVO"', '"outcome": "PONTUADO"'));
  for (const r of [refused(await s.svc.list(OP_B, RES_AUDIT)), refused(await s.svc.get(OP_B, RES_AUDIT, 1)), refused(await s.svc.get(OP_B, RES_AUDIT, 3))]) {
    assert.equal(r.code, 'RESULT_INTEGRITY');
    assert.equal(RESULTS_HTTP_STATUS[r.code], 409);
    noData(r);
  }
});

test('resultado REESCRITO com selo recalculado ⇒ o recibo da pasta separada denuncia (RESULT_ANCHOR_MISMATCH)', async () => {
  const s = await finalized(2);
  const { contentSha256, ...rest } = JSON.parse(fs.readFileSync(runPath(s.e, 2), 'utf8')) as Record<string, any>;
  void contentSha256;
  rewrite(runPath(s.e, 2), () => serialize(seal({ ...rest, finalizedBy: 'forjador@empresa.com' }) as never));
  const r = refused(await s.svc.list(OP_B, RES_AUDIT));
  assert.equal(r.code, 'RESULT_ANCHOR_MISMATCH');
  noData(r);
  assert.equal(refused(await s.svc.get(OP_B, RES_AUDIT, 2)).code, 'RESULT_ANCHOR_MISMATCH');
});

test('registro coerente com o selo E com o recibo (quem controla as duas pastas) mas que não se explica pelo motor ⇒ RESULT_INTEGRITY', async () => {
  const s = await finalized(2);
  const { contentSha256, ...rest } = JSON.parse(fs.readFileSync(runPath(s.e, 2), 'utf8')) as Record<string, any>;
  void contentSha256;
  const forged = seal({ ...rest, outcome: rest.outcome === 'PONTUADO' ? 'INCONCLUSIVO' : 'PONTUADO' }) as { contentSha256: string };
  rewrite(runPath(s.e, 2), () => serialize(forged as never));
  const receipt = JSON.parse(fs.readFileSync(receiptPath(s.e, 2), 'utf8')) as Record<string, any>;
  const { contentSha256: oldReceiptSeal, ...receiptRest } = receipt;
  void oldReceiptSeal;
  rewrite(receiptPath(s.e, 2), () => serialize(seal({ ...receiptRest, headSha256: forged.contentSha256 }) as never));
  const r = refused(await s.svc.list(OP_B, RES_AUDIT));
  assert.equal(r.code, 'RESULT_INTEGRITY');
  noData(r);
  assert.equal(refused(await s.svc.get(OP_B, RES_AUDIT, 1)).code, 'RESULT_INTEGRITY', 'um único registro inconsistente invalida a consulta inteira');
});

test('recibo adulterado ou incompatível ⇒ integridade dos recibos; recibo removido/trocado ⇒ detectado', async () => {
  const altered = await finalized(3);
  rewrite(receiptPath(altered.e, 2), (text) => text.replace(/"seq": 2/, '"seq": 9'));
  const r = refused(await altered.svc.list(OP_B, RES_AUDIT));
  assert.ok(['RESULT_ANCHOR_INTEGRITY', 'RESULT_ANCHOR_MISMATCH', 'RESULT_INTEGRITY'].includes(r.code), r.code);
  noData(r);

  const swapped = await finalized(3);
  const a1 = fs.readFileSync(receiptPath(swapped.e, 1));
  rewrite(receiptPath(swapped.e, 3), () => a1.toString('utf8'));
  assert.ok(['RESULT_ANCHOR_INTEGRITY', 'RESULT_ANCHOR_MISMATCH', 'RESULT_INTEGRITY'].includes(refused(await swapped.svc.list(OP_B, RES_AUDIT)).code));

  const missing = await finalized(3);
  fs.chmodSync(path.join(missing.e.anchors, RES_AUDIT), 0o755);
  fs.unlinkSync(receiptPath(missing.e, 2));
  assert.equal(refused(await missing.svc.list(OP_B, RES_AUDIT)).code, 'RESULT_ANCHOR_INTEGRITY');
});

test('exclusão e truncamento: resultado removido do fim ⇒ RESULT_TRUNCATED; do meio ⇒ integridade; histórico apagado ⇒ RESULT_TRUNCATED', async () => {
  const tail = await finalized(3);
  fs.chmodSync(path.join(tail.e.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(tail.e, 3));
  const r = refused(await tail.svc.list(OP_B, RES_AUDIT));
  assert.equal(r.code, 'RESULT_TRUNCATED');
  noData(r);
  assert.equal(refused(await tail.svc.get(OP_B, RES_AUDIT, 1)).code, 'RESULT_TRUNCATED');

  const middle = await finalized(3);
  fs.chmodSync(path.join(middle.e.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(middle.e, 2));
  assert.equal(refused(await middle.svc.list(OP_B, RES_AUDIT)).code, 'RESULT_INTEGRITY');

  const wiped = await finalized(2);
  fs.rmSync(path.join(wiped.e.base, RES_AUDIT), { recursive: true, force: true });
  assert.equal(refused(await wiped.svc.list(OP_B, RES_AUDIT)).code, 'RESULT_TRUNCATED');
});

test('restauração parcial de backup (só resultados voltaram no tempo) ⇒ RESULT_TRUNCATED', async () => {
  const s = await finalized(2);
  const backup = path.join(s.e.other, 'bk');
  fs.cpSync(path.join(s.e.base, RES_AUDIT), backup, { recursive: true });
  const third = buildEvaluation({ variant: 'v9', headSeed: 'h9' });
  s.evaluator.current = third;
  assert.ok((await s.svc.finalize(OP_B, RES_AUDIT, bodyOf(third))).ok);
  fs.chmodSync(path.join(s.e.base, RES_AUDIT), 0o755);
  fs.rmSync(path.join(s.e.base, RES_AUDIT), { recursive: true, force: true });
  fs.cpSync(backup, path.join(s.e.base, RES_AUDIT), { recursive: true });
  assert.equal(refused(await s.svc.list(OP_B, RES_AUDIT)).code, 'RESULT_TRUNCATED');
});

test('consultas: auditoria sem resultados ⇒ lista vazia (ou 404 se a auditoria nem existe); seq inexistente ⇒ 404; sem base atual os resultados selados continuam visíveis', async () => {
  const s = setup();
  const empty = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(empty.ok && empty.value.results.length === 0 && empty.value.head === null && empty.value.pending === null);
  assert.equal(refused(await s.svc.get(OP_B, RES_AUDIT, 1)).code, 'RESULT_NOT_FOUND');
  assert.equal(RESULTS_HTTP_STATUS.RESULT_NOT_FOUND, 404);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(refused(await s.svc.get(OP_B, RES_AUDIT, bad)).code, 'INVALID_PARAMS');
  assert.equal(refused(await s.svc.list(OP_B, '../x')).code, 'INVALID_PARAMS');

  const gone = setup();
  gone.evaluator.current = { ok: false, code: 'AUDIT_NOT_FOUND', issues: [] } as never;
  assert.equal(refused(await gone.svc.list(OP_B, RES_AUDIT)).code, 'AUDIT_NOT_FOUND');

  assert.ok((await finalize(s)).ok);
  s.evaluator.current = { ok: false, code: 'AUDIT_NOT_FOUND', issues: [] } as never; // as evidências sumiram depois: os resultados selados continuam consultáveis
  const kept = await s.svc.list(OP_B, RES_AUDIT);
  assert.ok(kept.ok && kept.value.results.length === 1 && kept.value.results[0]?.stale === null && kept.value.currentInputSha256 === null);
  s.evaluator.current = { ok: false, code: 'EVIDENCE_INTEGRITY', issues: [] } as never;
  const integrity = await s.svc.get(OP_B, RES_AUDIT, 1);
  assert.ok(integrity.ok && integrity.value.stale === null);
});

test('leituras nunca escrevem: nenhuma pasta é criada nem alterada', async () => {
  const s = await finalized(2);
  const before = trees(s.e);
  for (let i = 0; i < 3; i++) {
    assert.ok((await s.svc.list(OP_B, RES_AUDIT)).ok);
    assert.ok((await s.svc.get(OP_B, RES_AUDIT, 1)).ok);
  }
  assert.deepEqual(trees(s.e), before);
  const fresh = setup();
  await fresh.svc.list(OP_B, RES_AUDIT);
  assert.deepEqual(fs.readdirSync(fresh.e.base), []);
});

test('mensagens e códigos: toda falha tem texto fixo em português e status HTTP; nenhuma mensagem carrega caminho ou segredo', () => {
  for (const code of Object.keys(RESULTS_HTTP_STATUS) as Array<keyof typeof RESULTS_HTTP_STATUS>) {
    assert.ok(RESULTS_MESSAGE[code].length > 10, code);
    assert.ok(!/\/|\\|token|secret|senha/i.test(RESULTS_MESSAGE[code].replace(/n\/v/gi, '')), `${code}: ${RESULTS_MESSAGE[code]}`);
    assert.ok(RESULTS_HTTP_STATUS[code] >= 400 && RESULTS_HTTP_STATUS[code] < 600);
  }
  assert.equal(RESULTS_HTTP_STATUS.RESULT_ANCHOR_PENDING, 503);
});

/* ------------------------------------------------------------------------------------------------ prévia REAL: pastas reais de evidências e decisões */
test('REAL: INCONCLUSIVO verdadeiro sobre evidências e decisões reais (cobertura 22 hp); a prévia serve de avaliador e o reenvio é idempotente', async () => {
  const w = await world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview);
  const seen = await preview.preview(OP_B, w.auditId);
  assert.ok(seen.ok);
  const body = { expectedHead: seen.value.finalization.expectedHead, expectedInputSha256: seen.value.finalization.expectedInputSha256 };
  assert.ok(seen.value.finalization.allowed && body.expectedInputSha256);
  const r = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(r.ok, JSON.stringify(r));
  const run = r.value.run as Record<string, any>;
  assert.equal(run.outcome, 'INCONCLUSIVO');
  assert.equal(run.result.index, null);
  assert.equal(run.hashes.inputSha256, body.expectedInputSha256);
  assert.equal(run.evidence.layout, 'VERSIONED');
  const again = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(again.ok && again.value.replayed);
  assert.equal(fs.readdirSync(path.join(e.base, w.auditId)).length, 1);
  const listed = await svc.list(OP_B, w.auditId);
  assert.ok(listed.ok && listed.value.results[0]?.stale === false);
});

test('REAL: decisão confirmada muda o estado ⇒ o corpo antigo é recusado (HEAD_MISMATCH) e o novo é aceito; o resultado grava o head novo', async () => {
  const w = await world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview);
  const before = await preview.preview(OP_B, w.auditId);
  assert.ok(before.ok);
  const oldBody = { expectedHead: before.value.finalization.expectedHead, expectedInputSha256: before.value.finalization.expectedInputSha256 as string };
  await must(w.service.create(OP_B, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock));
  const stale = await svc.finalize(OP_B, w.auditId, oldBody);
  assert.ok(!stale.ok && ['HEAD_MISMATCH', 'INPUT_CHANGED'].includes(stale.code), JSON.stringify(stale));
  assert.deepEqual(fs.existsSync(path.join(e.base, w.auditId)) ? fs.readdirSync(path.join(e.base, w.auditId)) : [], []);
  const after = await preview.preview(OP_B, w.auditId);
  assert.ok(after.ok && after.value.decisions.head !== null);
  const r = await svc.finalize(OP_B, w.auditId, { expectedHead: after.value.finalization.expectedHead, expectedInputSha256: after.value.finalization.expectedInputSha256 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((r.value.run as any).decisions.head.seq, after.value.decisions.head?.seq);
  assert.equal((r.value.run as any).decisions.count, 1);
});

test('REAL: decisão PENDENTE (recibo da 6B não gravado) e revogação PENDENTE ⇒ NOT_FINALIZABLE; nada gravado', async () => {
  let failDecisionReceipts = false;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failDecisionReceipts && target.includes('lad-anc-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await world({ fs: ops });
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview);
  const created = await must(w.service.create(OP_B, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock));
  void created;
  failDecisionReceipts = true;
  const pendingDecision = await w.service.create(OP_B, w.auditId, { record: rec.nameEquivalence('Outra Padaria Ltda', 'Outra Padaria') }, clock);
  assert.ok(!pendingDecision.ok && pendingDecision.code === 'ANCHOR_PENDING', JSON.stringify(pendingDecision));
  const view = await preview.preview(OP_B, w.auditId);
  assert.ok(view.ok && view.value.finalization.allowed === false);
  const body = { expectedHead: view.value.finalization.expectedHead, expectedInputSha256: (view.value.finalization.expectedInputSha256 ?? sha256Hex('x')) as string };
  const r = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(!r.ok && r.code === 'NOT_FINALIZABLE' && r.blockers?.some((b) => b.code === 'DECISION_PENDING'), JSON.stringify(r));
  assert.deepEqual(fs.existsSync(path.join(e.base, w.auditId)) ? fs.readdirSync(path.join(e.base, w.auditId)) : [], []);
});
