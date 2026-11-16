import { LEDGER_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/ledger-port';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService, type KnownHeadsProvider } from '../../src/lib/link-audit-decisions';
import { createResultsKnownHeads } from '../../src/lib/link-audit-scoring-runs';
import { ANA, entryPath, clock, must, quarantineDirOf, rec, world, type World } from './link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';
import { previewOver } from './link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv } from './link-audit-results-fixtures';

/*
 * Cenários compartilhados dos testes da TESTEMUNHA do histórico de decisões (recibo removido, rotação de chave, configuração ausente):
 * uma auditoria com op-0001 criada e revogada (confirmadas) e, opcionalmente, um resultado s1 selado sobre esse histórico (cabeça das decisões = seq 2).
 */
export const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

export async function confirmedThenRevoked(): Promise<World> {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  return w;
}

export const withWitness = (w: World, e: ReturnType<typeof resultsEnv>, provider: KnownHeadsProvider | 'real' = 'real') =>
  createDecisionService({ ledger: LEDGER_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir, knownHeads: provider === 'real' ? createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir], origin: TEST_ORIGIN }) : provider });
export const previewW = (w: World, decisions: ReturnType<typeof withWitness>, extra: object = {}) => previewOver({ evidenceDir: w.evidenceDir, raw: decisions }, extra);

/** op-0001 criada e revogada (confirmadas) e um resultado s1 selado sobre esse histórico (head das decisões = seq 2). */
export async function sealedAfterRevocation(): Promise<{ w: World; e: ReturnType<typeof resultsEnv>; decisions: ReturnType<typeof withWitness> }> {
  const w = await confirmedThenRevoked();
  const e = resultsEnv();
  const decisions = withWitness(w, e);
  const preview = previewW(w, decisions);
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.equal(evaluated.value.decisions.head?.seq, 2);
  const done = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 200));
  return { w, e, decisions };
}
export const quarantine = (w: World, seq: number): string => {
  const dir = quarantineDirOf(w, w.auditId);
  const target = path.join(dir, `d${String(seq).padStart(4, '0')}.json`);
  fs.renameSync(entryPath(w, seq), target);
  return target;
};

