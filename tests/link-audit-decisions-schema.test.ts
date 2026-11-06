import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_ID_PATTERN as EVIDENCE_AUDIT_ID_PATTERN } from '../src/lib/link-audit-evidence/types';
import { availableRefs, captureRef, parseEvidenceRef, referencedEvidence, reportRef } from '../src/lib/link-audit-decisions/evidence-refs';
import { slotsOf } from '../src/lib/link-audit-decisions/project';
import { seal, hashOk } from '../src/lib/link-audit-decisions/store';
import {
  ANCHOR_FILE,
  ANCHOR_FILE_KIND,
  anchorFileName,
  anchorSchema,
  AUDIT_ID_PATTERN,
  clientRecordSchema,
  createBodySchema,
  decisionEntrySchema,
  decisionIdFor,
  DECISION_FILE_KIND,
  DECISION_ID_PATTERN,
  DECISION_SCHEMA_VERSION,
  entryFileName,
  ENTRY_FILE,
  headSchema,
  revokeBodySchema,
} from '../src/lib/link-audit-decisions/types';
import { operatorRecordSchema } from '../src/lib/link-audit/scoring/input';
import { ALL_KIND_EXAMPLES, rec } from './helpers/link-audit-decisions-fixtures';

const SHA = 'a'.repeat(64);

test('o identificador de auditoria é exatamente o do serviço de evidências', () => {
  assert.equal(AUDIT_ID_PATTERN.source, EVIDENCE_AUDIT_ID_PATTERN.source);
});

test('contrato 6A: o schema do cliente tem as MESMAS variantes do operatorRecordSchema (um tipo novo na 6A quebra este teste)', () => {
  const upstream = (operatorRecordSchema.options as unknown as Array<{ shape: { kind: { value: string } } }>).map((option) => option.shape.kind.value).sort();
  assert.deepEqual(upstream, ['IMAGES_CONFIRMATION', 'JUDGEMENT', 'NAME_EQUIVALENCE', 'NOT_APPLICABLE', 'OBSERVATION_CONFIRMATION', 'SITE_SCOPE_ATTESTATION']);
  assert.deepEqual(ALL_KIND_EXAMPLES().map((example) => example.kind).sort(), upstream);
});

test('todos os tipos de decisão são aceitos e o contrato 6A reconstruído os aceita com os campos do servidor', () => {
  for (const { kind, record } of ALL_KIND_EXAMPLES()) {
    const client = clientRecordSchema.safeParse(record);
    assert.ok(client.success, `${kind}: ${JSON.stringify(client.error?.issues)}`);
    const full = operatorRecordSchema.safeParse({ ...client.data, id: 'op-0001', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-21T12:00:00.000Z' });
    assert.ok(full.success, `${kind} no contrato completo da 6A: ${JSON.stringify(full.error?.issues)}`);
  }
});

test('o cliente NUNCA define id, autor ou data: os três campos do servidor são recusados em todos os tipos', () => {
  for (const { kind, record } of ALL_KIND_EXAMPLES()) {
    for (const extra of [{ id: 'op-0001' }, { operatorEmail: 'ana@empresa.com' }, { recordedAt: '2026-10-21T12:00:00.000Z' }, { recordedBy: 'ana@empresa.com' }, { extra: 1 }]) {
      assert.equal(clientRecordSchema.safeParse({ ...record, ...extra }).success, false, `${kind} aceitou ${Object.keys(extra)[0]}`);
    }
  }
});

test('recusas do contrato: justificativa curta, tipo desconhecido, listas vazias e valores fora do formato', () => {
  const bad = (record: unknown): boolean => clientRecordSchema.safeParse(record).success;
  assert.equal(bad({ ...rec.c2(), justification: 'curta' }), false);
  assert.equal(bad({ ...rec.c2(), kind: 'POINTS' }), false);
  assert.equal(bad({ ...rec.naModel(), subcriterionIds: [] }), false);
  assert.equal(bad({ ...rec.naModel(), code: 'OUTRO' }), false);
  assert.equal(bad({ ...rec.images(), imageTypes: ['SELFIE'] }), false);
  assert.equal(bad({ ...rec.c2(), attachmentSha256: 'xyz' }), false);
  assert.equal(bad({ ...rec.c2(), subcriterionId: 'C1' }), false);
  assert.equal(bad({ ...rec.c2(), attachmentSha256: SHA }), true);
  assert.equal(bad(null), false);
  assert.equal(bad('JUDGEMENT'), false);
});

test('corpos da API: estritos, expectedHead OBRIGATÓRIO (null = histórico vazio), substituição opcional e revogação com motivo', () => {
  const head = { seq: 3, sha256: 'a'.repeat(64) };
  assert.ok(createBodySchema.safeParse({ record: rec.c2(), expectedHead: null }).success);
  assert.ok(createBodySchema.safeParse({ record: rec.c2(), expectedHead: head }).success);
  assert.ok(createBodySchema.safeParse({ record: rec.c2(), supersedes: 'op-0001', expectedHead: head }).success);
  assert.equal(createBodySchema.safeParse({ record: rec.c2() }).success, false, 'sem expectedHead');
  assert.equal(createBodySchema.safeParse({ record: rec.c2(), expectedHead: undefined }).success, false);
  assert.equal(createBodySchema.safeParse({ record: rec.c2(), supersedes: 'op-1', expectedHead: null }).success, false);
  assert.equal(createBodySchema.safeParse({ record: rec.c2(), extra: true, expectedHead: null }).success, false);
  assert.equal(createBodySchema.safeParse({ expectedHead: null }).success, false);
  const reason = 'Informação conferida e incorreta; decisão desfeita.';
  assert.ok(revokeBodySchema.safeParse({ revokes: 'op-0002', reason, expectedHead: head }).success);
  assert.equal(revokeBodySchema.safeParse({ revokes: 'op-0002', reason }).success, false, 'sem expectedHead');
  assert.equal(revokeBodySchema.safeParse({ revokes: 'op-0002', reason: 'curto', expectedHead: null }).success, false);
  assert.equal(revokeBodySchema.safeParse({ revokes: 'op-0002', reason: 'x'.repeat(2001), expectedHead: null }).success, false);
  assert.equal(revokeBodySchema.safeParse({ revokes: '../x', reason, expectedHead: null }).success, false);
});

test('expectedHead: seq 1..9999 e SHA-256 minúsculo; nenhum campo extra', () => {
  assert.ok(headSchema.safeParse({ seq: 1, sha256: 'f'.repeat(64) }).success);
  for (const bad of [{ seq: 0, sha256: 'f'.repeat(64) }, { seq: 10000, sha256: 'f'.repeat(64) }, { seq: 1.5, sha256: 'f'.repeat(64) }, { seq: 1, sha256: 'F'.repeat(64) }, { seq: 1, sha256: 'f'.repeat(63) }, { seq: 1, sha256: 'f'.repeat(64), extra: 1 }, { seq: '1', sha256: 'f'.repeat(64) }, {}, []]) {
    assert.equal(headSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('âncora: formato fechado, selado e sem campos extras; número do arquivo = sequência', () => {
  const body = { schemaVersion: DECISION_SCHEMA_VERSION, kind: ANCHOR_FILE_KIND, auditId: 'auditoria-teste-0001', seq: 2, headSha256: 'a'.repeat(64), anchoredAt: '2026-10-21T12:00:00.000Z', prevAnchorSha256: null };
  const sealedAnchor = seal(body);
  assert.ok(hashOk(sealedAnchor) && anchorSchema.safeParse(sealedAnchor).success);
  for (const bad of [{ ...sealedAnchor, extra: 1 }, { ...sealedAnchor, seq: 0 }, { ...sealedAnchor, headSha256: 'xyz' }, { ...sealedAnchor, anchoredAt: 'ontem' }, { ...sealedAnchor, kind: 'OUTRO' }]) {
    assert.equal(anchorSchema.safeParse(bad).success, false);
  }
  const moved = { ...sealedAnchor, headSha256: 'b'.repeat(64) };
  assert.equal(hashOk(moved), false);
  assert.ok(ANCHOR_FILE.test(anchorFileName(12)) && !ANCHOR_FILE.test('a12.json') && !ANCHOR_FILE.test('d0001.json'));
});

test('identificadores e nomes de arquivo: op-NNNN, dNNNN.json, sem ambiguidade', () => {
  assert.equal(decisionIdFor(1), 'op-0001');
  assert.equal(decisionIdFor(9999), 'op-9999');
  assert.ok(DECISION_ID_PATTERN.test('op-0001') && !DECISION_ID_PATTERN.test('op-001') && !DECISION_ID_PATTERN.test('OP-0001') && !DECISION_ID_PATTERN.test('op-0001 '));
  assert.equal(entryFileName(12), 'd0012.json');
  assert.ok(ENTRY_FILE.test('d0001.json') && !ENTRY_FILE.test('d1.json') && !ENTRY_FILE.test('d0001.json.bak') && !ENTRY_FILE.test('../d0001.json'));
  // cabem no formato de id do contrato 6A
  assert.ok(/^[A-Za-z0-9_.:-]{1,64}$/.test(decisionIdFor(1)));
});

test('referências de evidência: só capture:cNNNN e report:cNNNN-rNNNN; site:cNNNN é reconhecido mas não verificável', () => {
  assert.deepEqual(parseEvidenceRef('capture:c0001'), { kind: 'capture', capture: 1 });
  assert.deepEqual(parseEvidenceRef('report:c0012-r0003'), { kind: 'report', capture: 12, revision: 3 });
  assert.deepEqual(parseEvidenceRef('site:c0001'), { kind: 'site', capture: 1 });
  for (const bad of ['', 'capture:c0000', 'capture:c1', 'capture:c00001', 'report:c0001', 'report:c0001-r0000', 'capture:c0001-r0001', 'Capture:c0001', 'capture:C0001', 'capture:c0001 ', ' capture:c0001', 'capture:c0001/../x', 'file:c0001', 'c0001', 'capture:c0001\n']) {
    assert.equal(parseEvidenceRef(bad), null, JSON.stringify(bad));
  }
  assert.equal(captureRef(7), 'capture:c0007');
  assert.equal(reportRef(7, 2), 'report:c0007-r0002');
  // todo identificador gerado cabe no formato de id do contrato da 6A
  for (const ref of [captureRef(1), captureRef(9999), reportRef(9999, 9999)]) assert.ok(/^[A-Za-z0-9_.:-]{1,64}$/.test(ref) && parseEvidenceRef(ref));
});

test('referências disponíveis vêm das versões do leitor: capturas e revisões de relatório', () => {
  const refs = availableRefs([
    { capture: 1, collectedAt: null, reportRevisions: [{ revision: 1 }, { revision: 2 }] },
    { capture: 2, collectedAt: null, reportRevisions: [] },
    { capture: null, collectedAt: null, reportRevisions: [{ revision: 9 }] },
  ]);
  assert.deepEqual([...refs].sort(), ['capture:c0001', 'capture:c0002', 'report:c0001-r0001', 'report:c0001-r0002']);
  assert.deepEqual(referencedEvidence({ ...rec.naFeature(['capture:c0001']) } as never), ['capture:c0001']);
  assert.deepEqual(referencedEvidence(rec.images(['report:c0001-r0001']) as never), ['report:c0001-r0001']);
  assert.deepEqual(referencedEvidence(rec.c2() as never), []);
});

test('espaços (slots) do contrato: um por subcritério; confirmação de nomes não ocupa nenhum', () => {
  assert.deepEqual(slotsOf(rec.c2() as never), ['J:C2', 'S:C2']);
  assert.deepEqual(slotsOf({ ...rec.naModel(), subcriterionIds: ['S4', 'S3'] } as never), ['NA:S4', 'S:S4', 'NA:S3', 'S:S3']);
  assert.deepEqual(slotsOf(rec.attestation(['S5', 'V5']) as never), ['ATT:S5', 'ATT:V5']);
  assert.deepEqual(slotsOf(rec.observation() as never), ['OBS:S5', 'OBS:X4']);
  assert.deepEqual(slotsOf(rec.images() as never), ['IMG']);
  assert.deepEqual(slotsOf(rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') as never), slotsOf(rec.nameEquivalence('  PADARIA exemplo ', 'padaria   exemplo ltda') as never)); // o par não tem ordem nem caixa
  assert.notDeepEqual(slotsOf(rec.nameEquivalence('A Ltda', 'A') as never), slotsOf(rec.nameEquivalence('B Ltda', 'B') as never));
  // juízo e N/A do MESMO subcritério compartilham um espaço (são alternativas); subcritérios diferentes não
  assert.ok(slotsOf(rec.c3() as never).some((s) => slotsOf(rec.naNoAdditional() as never).includes(s)));
  assert.ok(!slotsOf(rec.c2() as never).some((s) => slotsOf(rec.naModel() as never).includes(s)));
});

test('arquivos de decisão: o formato aceita entradas seladas e recusa qualquer campo a mais, hash ou tipo errado', () => {
  const base = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: 'auditoria-teste-0001',
    seq: 1,
    action: 'REVOKE' as const,
    recordedAt: '2026-10-21T12:00:00.000Z',
    recordedBy: 'ana@empresa.com',
    prevSha256: null,
    revokes: 'op-0001',
    reason: 'Informação conferida e incorreta; decisão desfeita.',
  };
  const sealedEntry = seal(base);
  assert.ok(hashOk(sealedEntry));
  assert.ok(decisionEntrySchema.safeParse(sealedEntry).success);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, extra: 1 }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, points: 10 }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, seq: 0 }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, seq: 10000 }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, recordedBy: 'dev@localhost' }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, recordedAt: '2026-10-21 12:00' }).success, false);
  assert.equal(decisionEntrySchema.safeParse({ ...sealedEntry, action: 'DELETE' }).success, false);
  const reworded = { ...sealedEntry, reason: 'Outro texto qualquer com mais de vinte caracteres.' };
  const rechained = { ...sealedEntry, prevSha256: SHA };
  assert.equal(hashOk(reworded), false);
  assert.equal(hashOk(rechained), false);
});

test('selo: depende só do conteúdo (ordem das chaves não importa) e muda com qualquer byte', () => {
  const a = seal({ x: 1, y: { b: 2, a: 1 } });
  const b = seal({ y: { a: 1, b: 2 }, x: 1 });
  assert.equal(a.contentSha256, b.contentSha256);
  assert.notEqual(a.contentSha256, seal({ x: 1, y: { b: 2, a: 2 } }).contentSha256);
});
