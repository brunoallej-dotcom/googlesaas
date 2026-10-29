import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveScoringRecords, replay, slotConflicts, toScoringRecord } from '../src/lib/link-audit-decisions/project';
import { decisionIdFor, DECISION_FILE_KIND, DECISION_SCHEMA_VERSION, type DecisionEntry } from '../src/lib/link-audit-decisions/types';
import { parseScoringInput } from '../src/lib/link-audit/scoring/input';
import { rec } from './helpers/link-audit-decisions-fixtures';

const BASIS = { capture: 1, report: { capture: 1, revision: 1 }, collectedAt: '2026-10-22T12:54:48.079Z' };
const at = (seq: number): string => new Date(Date.UTC(2026, 9, 21, 12, 0, seq)).toISOString();
const hash = (seq: number): string => seq.toString(16).padStart(64, '0');

/** Entradas sintéticas (o replay não confere hashes: isso é do armazenamento). */
const record = (seq: number, body: Record<string, unknown>, supersedes: string | null = null, who = 'ana@empresa.com'): DecisionEntry =>
  ({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: 'auditoria-teste-0001',
    seq,
    action: 'RECORD',
    recordedAt: at(seq),
    recordedBy: who,
    prevSha256: seq === 1 ? null : hash(seq - 1),
    contentSha256: hash(seq),
    decisionId: decisionIdFor(seq),
    record: body,
    supersedes,
    basis: BASIS,
  }) as unknown as DecisionEntry;
const revoke = (seq: number, revokes: string): DecisionEntry =>
  ({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: 'auditoria-teste-0001',
    seq,
    action: 'REVOKE',
    recordedAt: at(seq),
    recordedBy: 'ana@empresa.com',
    prevSha256: hash(seq - 1),
    contentSha256: hash(seq),
    revokes,
    reason: 'Informação conferida e incorreta; decisão desfeita.',
  }) as unknown as DecisionEntry;

const ok = (entries: DecisionEntry[]) => {
  const result = replay(entries);
  assert.ok(result.ok, result.ok ? '' : result.issues.join(' | '));
  return result.value;
};
const issues = (entries: DecisionEntry[]): string[] => {
  const result = replay(entries);
  assert.ok(!result.ok, 'esperava inconsistência');
  return [...result.issues];
};

test('histórico vazio: nenhuma decisão, sem head', () => {
  const state = ok([]);
  assert.deepEqual([state.decisions.length, state.effective.length, state.head], [0, 0, null]);
});

test('criação: a decisão fica vigente, com autor e data do arquivo, e o head é o último arquivo', () => {
  const state = ok([record(1, rec.c2()), record(2, rec.c3())]);
  assert.deepEqual(state.effective.map((d) => [d.decisionId, d.status, d.recordedBy]), [['op-0001', 'ACTIVE', 'ana@empresa.com'], ['op-0002', 'ACTIVE', 'ana@empresa.com']]);
  assert.deepEqual(state.head, { seq: 2, sha256: hash(2) });
});

test('substituição explícita: a anterior continua no histórico (SUPERSEDED) e só a nova é vigente', () => {
  const state = ok([record(1, rec.c2('PARTIAL')), record(2, rec.c2('COMPATIBLE'), 'op-0001')]);
  assert.deepEqual(state.decisions.map((d) => [d.decisionId, d.status, d.supersededBy]), [['op-0001', 'SUPERSEDED', 'op-0002'], ['op-0002', 'ACTIVE', null]]);
  assert.deepEqual(state.effective.map((d) => d.decisionId), ['op-0002']);
  assert.equal(state.decisions[0]?.record.kind, 'JUDGEMENT'); // o conteúdo original está intacto
  assert.equal((state.decisions[0]?.record as { value: string }).value, 'PARTIAL');
  assert.equal(state.entries.length, 2);
});

test('revogação: nova entrada; a original permanece, marcada REVOKED com a sequência da revogação', () => {
  const state = ok([record(1, rec.c2()), revoke(2, 'op-0001')]);
  assert.deepEqual(state.decisions.map((d) => [d.decisionId, d.status, d.revokedAtSeq]), [['op-0001', 'REVOKED', 2]]);
  assert.equal(state.effective.length, 0);
  assert.equal(state.entries.length, 2);
});

test('depois de revogar, o subcritério pode receber uma decisão nova SEM substituição (o espaço ficou livre)', () => {
  const state = ok([record(1, rec.c2()), revoke(2, 'op-0001'), record(3, rec.c2('PARTIAL'))]);
  assert.deepEqual(state.effective.map((d) => d.decisionId), ['op-0003']);
});

test('revogação duplicada, de decisão substituída ou inexistente é inconsistência', () => {
  assert.match(issues([record(1, rec.c2()), revoke(2, 'op-0001'), revoke(3, 'op-0001')]).join(' '), /revoga op-0001, que não está vigente/);
  assert.match(issues([record(1, rec.c2()), record(2, rec.c2('PARTIAL'), 'op-0001'), revoke(3, 'op-0001')]).join(' '), /não está vigente/);
  assert.match(issues([revoke(1, 'op-0009')]).join(' '), /que não existe antes desta entrada/);
  assert.match(issues([record(1, rec.c2()), revoke(2, 'op-0002')]).join(' '), /não existe antes/); // não revoga a si mesma nem o futuro
});

test('substituição inválida: inexistente, já revogada/substituída, de outro tipo, de outro subcritério ou que RETIRA subcritério', () => {
  assert.match(issues([record(1, rec.c2(), 'op-0009')]).join(' '), /não existe antes/);
  assert.match(issues([record(1, rec.c2()), revoke(2, 'op-0001'), record(3, rec.c2('PARTIAL'), 'op-0001')]).join(' '), /não está vigente/);
  const rule = /cobrir todos os subcritérios/;
  assert.match(issues([record(1, rec.c2()), record(2, rec.naModel(), 'op-0001')]).join(' '), rule);
  // mesmo tipo, outro subcritério: C3 não pode "substituir" C2 e retirá-la do conjunto vigente em silêncio
  assert.match(issues([record(1, rec.c2()), record(2, rec.c3(), 'op-0001')]).join(' '), rule);
  assert.match(issues([record(1, rec.observation(['S5'])), record(2, rec.observation(['X4']), 'op-0001')]).join(' '), rule);
  // B3: sobreposição PARCIAL também retira subcritério em silêncio: recusada
  assert.match(issues([record(1, rec.observation(['S5', 'X4'])), record(2, rec.observation(['S5']), 'op-0001')]).join(' '), rule);
  assert.match(issues([record(1, rec.attestation(['S5', 'V5'])), record(2, rec.attestation(['V5', 'X4']), 'op-0001')]).join(' '), rule);
  assert.match(issues([record(1, rec.nameEquivalence()), record(2, rec.nameEquivalence('Outro Ltda', 'Outro'), 'op-0001')]).join(' '), rule);
  // substituição legítima: mesmo tipo e TODOS os subcritérios da anterior (pode acrescentar), ou a mesma equivalência de nomes
  ok([record(1, rec.observation(['S5'])), record(2, rec.observation(['S5', 'X4']), 'op-0001')]);
  ok([record(1, rec.attestation(['S5'])), record(2, rec.attestation(['S5', 'V5', 'X4']), 'op-0001')]);
  ok([record(1, rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo')), record(2, rec.nameEquivalence('padaria exemplo', 'PADARIA EXEMPLO LTDA'), 'op-0001')]);
});

test('B2 — juízo e N/A do mesmo subcritério são alternativas: coexistir é inconsistência; trocar de natureza exige revogar antes', () => {
  assert.match(issues([record(1, rec.c3('MISSING_NEEDED')), record(2, rec.naNoAdditional())]).join(' '), /mesmo subcritério de op-0001/);
  assert.match(issues([record(1, rec.naNoAdditional()), record(2, rec.c3('ALL_RELEVANT'))]).join(' '), /mesmo subcritério de op-0001/);
  assert.match(issues([record(1, rec.c3('MISSING_NEEDED')), record(2, rec.naNoAdditional(), 'op-0001')]).join(' '), /cobrir todos os subcritérios/); // nem por substituição
  ok([record(1, rec.c3('MISSING_NEEDED')), revoke(2, 'op-0001'), record(3, rec.naNoAdditional())]);
  ok([record(1, rec.c3()), record(2, rec.naModel()), record(3, rec.naFeature())]); // outros subcritérios convivem
});

test('B3 — equivalências de nomes: a mesma (sem ordem/caixa/espaços) é duplicata; pares diferentes convivem', () => {
  assert.match(issues([record(1, rec.nameEquivalence('A Ltda', 'A')), record(2, rec.nameEquivalence('a', '  A  LTDA '))]).join(' '), /mesmo subcritério de op-0001/);
  ok([record(1, rec.nameEquivalence('A Ltda', 'A')), record(2, rec.nameEquivalence('B Ltda', 'B'))]);
});


test('conflito de espaço: duas decisões vigentes no mesmo subcritério (sem substituir) são recusadas', () => {
  assert.match(issues([record(1, rec.c2()), record(2, rec.c2('PARTIAL'))]).join(' '), /mesmo subcritério de op-0001/);
  assert.match(issues([record(1, rec.observation(['S5'])), record(2, rec.observation(['S5', 'X4']))]).join(' '), /mesmo subcritério/);
  assert.match(issues([record(1, rec.images()), record(2, rec.images(['capture:c0001'], ['PLACE']))]).join(' '), /mesmo subcritério/);
  // sem conflito: subcritérios diferentes, confirmação de nomes repetida, N/A em subcritérios diferentes
  ok([record(1, rec.c2()), record(2, rec.c3()), record(3, rec.nameEquivalence()), record(4, rec.nameEquivalence('A Ltda', 'A')), record(5, rec.naModel()), record(6, rec.naFeature())]);
});

test('identificador da decisão precisa ser op-<sequência> e não pode repetir', () => {
  const wrong = { ...record(1, rec.c2()), decisionId: 'op-0007' } as DecisionEntry;
  assert.match(issues([wrong]).join(' '), /não corresponde à sequência/);
  const a = record(1, rec.c2());
  const b = { ...record(2, rec.c3()), decisionId: 'op-0001' } as DecisionEntry;
  assert.ok(issues([a, b]).length >= 1);
});

test('limite: mais de 200 decisões vigentes é inconsistência (mesmo teto do motor 6A)', () => {
  const entries = Array.from({ length: 201 }, (_, i) => record(i + 1, rec.nameEquivalence(`Nome ${i}`, `Apelido ${i}`)));
  assert.equal(ok(entries.slice(0, 200)).effective.length, 200);
  assert.match(issues(entries).join(' '), /mais de 200 decisões vigentes/);
});

test('slotConflicts ignora as decisões informadas (é o que a substituição usa)', () => {
  const state = ok([record(1, rec.c2()), record(2, rec.observation(['S5']))]);
  assert.deepEqual(slotConflicts(state.effective, rec.c2('PARTIAL') as never), ['op-0001']);
  assert.deepEqual(slotConflicts(state.effective, rec.c2('PARTIAL') as never, new Set(['op-0001'])), []);
  assert.deepEqual(slotConflicts(state.effective, rec.observation(['S5', 'X4']) as never), ['op-0002']);
  assert.deepEqual(slotConflicts(state.effective, rec.nameEquivalence() as never), []);
});

test('projeção para o motor: só vigentes, no formato do contrato 6A, e aceita pelo parseScoringInput', () => {
  const state = ok([
    record(1, rec.c2('PARTIAL')),
    record(2, rec.c2('COMPATIBLE'), 'op-0001'),
    record(3, rec.p3()),
    record(4, rec.nameEquivalence()),
    record(5, rec.naFeature()),
    revoke(6, 'op-0004'),
  ]);
  const records = effectiveScoringRecords(state);
  assert.deepEqual(records.map((r) => r.id), ['op-0002', 'op-0003', 'op-0005']);
  assert.deepEqual(records[0], { ...rec.c2('COMPATIBLE'), id: 'op-0002', operatorEmail: 'ana@empresa.com', recordedAt: at(2) });
  assert.deepEqual(toScoringRecord(state.decisions[0] as never), { ...rec.c2('PARTIAL'), id: 'op-0001', operatorEmail: 'ana@empresa.com', recordedAt: at(1) });
  const parsed = parseScoringInput({
    schemaVersion: 1,
    auditId: 'auditoria-teste-0001',
    referenceDate: '2026-10-22',
    evidences: [{ id: 'capture:c0001', origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-20T10:00:00Z', contentSha256: 'b'.repeat(64) }],
    operatorRecords: records,
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.issues.join(' | '));
});
