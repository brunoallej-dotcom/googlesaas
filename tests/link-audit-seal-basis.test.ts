import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-attestation';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import type { EvidenceProvenancePolicy, EvidenceToProve } from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, world } from './helpers/link-audit-decisions-fixtures';
import { ANA, previewOver } from './helpers/link-audit-preview-fixtures';
import { captureEvidence, hash, makeBasis, reportEvidence } from './helpers/link-audit-mapper-fixtures';

/* Dados 100% FICTÍCIOS. W1 do P1: a montagem única `base → EvidenceToProve[]` e a prova de que a extração não mudou nada. */
registerCleanup();

/** A expressão EXATA que estava em `preview.ts:219` antes da extração (congelada aqui como referência). */
const oldInlineMapping = (basis: { evidences: readonly EvidenceToProve[]; artifacts?: readonly EvidenceToProve[] }): EvidenceToProve[] =>
  [...basis.evidences, ...(basis.artifacts ?? [])].map((e) => ({ ref: e.ref, contentSha256: e.contentSha256, legacy: e.legacy }));

const LEGACY_STATUS = { ref: 'legacy-status:c0001', contentSha256: hash('d'), legacy: true };

test('IA-09: equivalência com o mapeamento antigo, layout versionado (capturas e todas as revisões, sem artefatos)', () => {
  const basis = makeBasis({ evidences: [captureEvidence(1), reportEvidence(1, 1, { superseded: true }), reportEvidence(1, 2), captureEvidence(2, { contentSha256: hash('e') })] });
  const out = evidenceToProveFromBasis(basis);
  assert.deepEqual(out, oldInlineMapping(basis));
  assert.deepEqual(out.map((e) => e.ref), ['capture:c0001', 'report:c0001-r0001', 'report:c0001-r0002', 'capture:c0002']);
  assert.ok(out.every((e) => Object.keys(e).sort().join() === 'contentSha256,legacy,ref'), 'só os três campos que a verificação usa');
});

test('IA-09: equivalência com o mapeamento antigo, layout legado (evidências legadas, depois os artefatos)', () => {
  const basis = { ...makeBasis({ layout: 'LEGACY', evidences: [captureEvidence(1, { legacy: true }), reportEvidence(1, 1, { legacy: true })] }), artifacts: [LEGACY_STATUS] };
  const out = evidenceToProveFromBasis(basis);
  assert.deepEqual(out, oldInlineMapping(basis));
  assert.deepEqual(out.map((e) => [e.ref, e.legacy]), [['capture:c0001', true], ['report:c0001-r0001', true], ['legacy-status:c0001', true]]);
});

test('IA-09: artefatos ausentes ou vazios não alteram a lista; a função é pura (não muda a entrada, devolve cópia)', () => {
  const basis = makeBasis();
  const before = JSON.stringify(basis);
  const withEmpty = { ...basis, artifacts: [] };
  assert.deepEqual(evidenceToProveFromBasis(withEmpty), evidenceToProveFromBasis(basis));
  const out = evidenceToProveFromBasis(basis);
  assert.notEqual(out[0], basis.evidences[0]);
  assert.equal(JSON.stringify(basis), before);
});

test('IA-09: a lista que a prévia entrega ao verificador (classify), numa pasta real, é a da função única, ref a ref e hash a hash', async () => {
  const w = await world();
  let received: { auditId: string; evidences: readonly EvidenceToProve[] } | null = null;
  const spy: EvidenceProvenancePolicy = {
    async classify(auditId, evidences) {
      received = { auditId, evidences: [...evidences] };
      return { status: 'AUTHENTICATED' } as never;
    },
  };
  const result = await previewOver(w, { evidenceProvenance: spy }).preview(ANA, w.auditId);
  assert.ok(result.ok);
  const outcome = await createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }).readScoringBasis(ANA, w.auditId);
  assert.ok(outcome.status === 'READY');
  const got = received as { auditId: string; evidences: readonly EvidenceToProve[] } | null;
  assert.ok(got !== null && got.evidences.length > 0);
  assert.equal(got.auditId, w.auditId);
  assert.deepEqual(got.evidences, evidenceToProveFromBasis(outcome.basis));
  assert.deepEqual(got.evidences, oldInlineMapping(outcome.basis));
});
