import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isDecisionsPayload, isFinalizePayload, isPreviewPayload, isResultsPayload, isRunDetailPayload } from '../src/components/link-audit/audit-page/validators';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { clock, rec, registerCleanup, world } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_B, resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I6 — CONTRATO: os payloads REAIS dos serviços (prévia, decisões, resultados) em cada estado alcançável passam pelos
 * validadores estritos da tela. Existe porque uma revisão achou que `status: null` (SEM_EVIDENCIA, ENTRADA_RECUSADA) era recusado.
 */
registerCleanup();
const ACTOR = { email: 'bia@empresa.com' };
const wire = <T,>(value: T): unknown => JSON.parse(JSON.stringify(value));

async function previewOf(w: Awaited<ReturnType<typeof world>>, over: Parameters<typeof previewOver>[1] = {}) {
  const r = await previewOver(w, over).preview(ACTOR, w.auditId);
  assert.ok(r.ok, JSON.stringify(r));
  return wire(r.value) as Record<string, any>;
}

test('prévia REAL em CALCULADO_FINALIZAVEL (inconclusivo): aceita e permite finalizar', async () => {
  const w = await world();
  const p = await previewOf(w);
  assert.equal(p.state, 'CALCULADO_FINALIZAVEL');
  assert.ok(isPreviewPayload(p, w.auditId));
  assert.equal(p.finalization.allowed, true);
});

test('prévia REAL em SEM_EVIDENCIA: aceita (critérios com status null), nunca permite finalizar', async () => {
  const w = await world({ seed: false });
  fs.mkdirSync(path.join(w.evidenceDir, w.auditId), { recursive: true });
  const p = await previewOf(w);
  assert.equal(p.state, 'SEM_EVIDENCIA');
  assert.ok(p.criteria.every((c: { status: unknown }) => c.status === null), 'sem resultado do motor o status do critério é null');
  assert.ok(isPreviewPayload(p, w.auditId), JSON.stringify(p).slice(0, 300));
  assert.equal(p.finalization.allowed, false);
});

test('prévia REAL em ENTRADA_RECUSADA (o motor recusou): aceita, com bloqueios visíveis, nunca finalizável', async () => {
  const w = await world();
  const p = await previewOf(w, { score: () => ({ ok: false, issues: ['entrada recusada de teste'] }) as never });
  assert.equal(p.state, 'ENTRADA_RECUSADA');
  assert.ok(isPreviewPayload(p, w.auditId), JSON.stringify(p).slice(0, 300));
  assert.ok(p.blockers.some((b: { severity: string }) => b.severity === 'BLOCKING'));
  assert.equal(p.finalization.allowed, false);
});

test('prévia REAL em DECISAO_PENDENTE (recibo da decisão não gravado): aceita e não finalizável', async () => {
  let failReceipts = false;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-anc-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await world({ fs: ops });
  failReceipts = true;
  const created = await w.service.create(ACTOR, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock);
  assert.ok(!created.ok && created.code === 'ANCHOR_PENDING');
  const p = await previewOf(w);
  assert.equal(p.state, 'DECISAO_PENDENTE');
  assert.ok(isPreviewPayload(p, w.auditId), JSON.stringify(p).slice(0, 300));
  assert.equal(p.finalization.allowed, false);
  const list = wire((await w.service.list(ACTOR, w.auditId)) as never) as { value: unknown };
  assert.ok(isDecisionsPayload(list.value, w.auditId), 'lista de decisões com pendente');
});

test('prévia REAL em CALCULADO_NAO_FINALIZAVEL (decisão retida): aceita, com "held" e bloqueio, nunca finalizável', async () => {
  const w = await world();
  const created = await w.service.create(ACTOR, w.auditId, { record: rec.attestation(['S5']) }, clock);
  assert.ok(created.ok, JSON.stringify(created));
  const p = await previewOf(w);
  assert.equal(p.state, 'CALCULADO_NAO_FINALIZAVEL', p.state);
  assert.ok(p.decisions.held.length > 0);
  assert.ok(isPreviewPayload(p, w.auditId), JSON.stringify(p).slice(0, 300));
  assert.equal(p.finalization.allowed, false);
  const list = wire((await w.service.list(ACTOR, w.auditId)) as never) as { value: unknown };
  assert.ok(isDecisionsPayload(list.value, w.auditId));
});

test('decisões REAIS: vigente, substituída e revogada passam; o histórico completo também', async () => {
  const w = await world();
  const first = await w.service.create(ACTOR, w.auditId, { record: rec.c2('COMPATIBLE') }, clock);
  assert.ok(first.ok);
  const second = await w.service.create(ACTOR, w.auditId, { record: rec.c2('PARTIAL'), supersedes: 'op-0001' }, clock);
  assert.ok(second.ok);
  const revoked = await w.service.revoke(ACTOR, w.auditId, { revokes: 'op-0002', reason: 'Informação conferida e incorreta; decisão desfeita.' }, clock);
  assert.ok(revoked.ok, JSON.stringify(revoked));
  const list = wire((await w.service.list(ACTOR, w.auditId)) as never) as { value: { allDecisions: Array<{ status: string }> } };
  assert.deepEqual(list.value.allDecisions.map((d) => d.status).sort(), ['REVOKED', 'SUPERSEDED']);
  assert.ok(isDecisionsPayload(list.value, w.auditId));
});

test('resultados REAIS: lista (confirmado + pendente), detalhe, finalização e reenvio passam; head e numeração coerentes', async () => {
  let failReceipts = false;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-ra-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview, { fs: ops });
  const seen = await preview.preview(OP_B, w.auditId);
  assert.ok(seen.ok);
  const body = { expectedHead: seen.value.finalization.expectedHead, expectedInputSha256: seen.value.finalization.expectedInputSha256 };
  const done = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(done.ok);
  assert.ok(isFinalizePayload(wire(done.value), w.auditId), 'finalização nova');
  const again = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(again.ok && again.value.replayed);
  assert.ok(isFinalizePayload(wire(again.value), w.auditId), 'reenvio');
  const list = await svc.list(OP_B, w.auditId);
  assert.ok(list.ok);
  assert.ok(isResultsPayload(wire(list.value), w.auditId), 'lista com um confirmado');
  const detail = await svc.get(OP_B, w.auditId, 1);
  assert.ok(detail.ok);
  assert.ok(isRunDetailPayload(wire(detail.value), w.auditId, 1), 'detalhe');
  // novo estado + recibo falhando ⇒ pendente (n+1)
  assert.ok((await w.service.create(ACTOR, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock)).ok);
  const next = await preview.preview(OP_B, w.auditId);
  assert.ok(next.ok);
  failReceipts = true;
  const pending = await svc.finalize(OP_B, w.auditId, { expectedHead: next.value.finalization.expectedHead, expectedInputSha256: next.value.finalization.expectedInputSha256 });
  assert.ok(!pending.ok && pending.code === 'RESULT_ANCHOR_PENDING');
  const withPending = await svc.list(OP_B, w.auditId);
  assert.ok(withPending.ok && withPending.value.pending?.seq === 2);
  assert.ok(isResultsPayload(wire(withPending.value), w.auditId), 'lista com pendente');
});
