import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAuditKeyword, selectLatestCompletedAudits } from '../src/lib/audit-state';

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'a1',
  place_id: 'PLACE_A',
  target_keyword: 'Clínica Odontológica',
  status: 'COMPLETED',
  progress_percent: 100,
  current_agent: 'MAESTRO',
  created_at: '2026-10-01T10:00:00.000Z',
  battlefield_payload: { points: [] },
  ...over,
});

test('normaliza a palavra-chave sem diferenciar caixa nem espaços', () => {
  assert.equal(normalizeAuditKeyword('  Clínica   ODONTOLÓGICA '), 'clínica odontológica');
});

test('escolhe a auditoria concluída mais recente por empresa', () => {
  const result = selectLatestCompletedAudits(
    [
      row({ id: 'velha', created_at: '2026-09-01T10:00:00.000Z' }),
      row({ id: 'nova', created_at: '2026-10-10T10:00:00.000Z' }),
      row({ id: 'outra', place_id: 'PLACE_B' }),
    ],
    'clínica odontológica'
  );
  assert.equal(result['PLACE_A']?.auditId, 'nova');
  assert.equal(result['PLACE_B']?.auditId, 'outra');
});

test('ignora auditorias em andamento, com falha ou de outra palavra-chave', () => {
  const result = selectLatestCompletedAudits(
    [
      row({ id: 'andamento', status: 'RUNNING_EXTRACTION' }),
      row({ id: 'falha', status: 'FAILED' }),
      row({ id: 'outra-kw', target_keyword: 'Dentista' }),
    ],
    'Clínica Odontológica'
  );
  assert.deepEqual(result, {});
});

test('devolve o formato da API de status (campos de frontend, sem colunas brutas)', () => {
  const result = selectLatestCompletedAudits([row({})], 'Clínica Odontológica');
  const audit = result['PLACE_A'];
  assert.equal(audit?.status, 'COMPLETED');
  assert.equal(audit?.progressPercent, 100);
  assert.deepEqual(audit?.battlefield, { points: [] });
  assert.equal('battlefield_payload' in (audit ?? {}), false);
});

test('uma empresa não vaza para outra e lista vazia devolve vazio', () => {
  assert.deepEqual(selectLatestCompletedAudits([], 'x'), {});
  const result = selectLatestCompletedAudits([row({ place_id: 'PLACE_B' })], 'Clínica Odontológica');
  assert.equal(result['PLACE_A'], undefined);
});
