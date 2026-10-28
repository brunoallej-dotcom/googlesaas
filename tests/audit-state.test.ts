import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAuditRow } from '../src/lib/audit-state';

test('normalizes persisted audit into frontend fields', () => {
  const data = normalizeAuditRow({
    id: 'audit-123',
    status: 'RUNNING_RIVALS_AND_JUDGE',
    progress_percent: 55,
    current_agent: 'RIVALS',
    battlefield_payload: { points: [{ pointIndex: 0 }] },
    judge_payload: { overallScore: 77 },
    error_message: null,
  });
  assert.equal(data.auditId, 'audit-123');
  assert.equal(data.progressPercent, 55);
  assert.equal(data.currentAgent, 'RIVALS');
  assert.deepEqual(data.battlefield, { points: [{ pointIndex: 0 }] });
  assert.deepEqual(data.judge, { overallScore: 77 });
});

test('failed audit preserves prior stage and surfaces message', () => {
  const data = normalizeAuditRow({
    id: 'audit-456',
    status: 'FAILED',
    progress_percent: 15,
    current_agent: 'BATTLEFIELD',
    error_message: 'foreign key constraint violation',
  });
  assert.equal(data.status, 'FAILED');
  assert.equal(data.progressPercent, 15);
  assert.equal(data.currentAgent, 'BATTLEFIELD');
  assert.equal(data.errorMessage, 'foreign key constraint violation');
});
