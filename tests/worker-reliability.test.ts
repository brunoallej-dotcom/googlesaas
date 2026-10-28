import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideEnqueue,
  deriveAuditPhase,
  staleMinutesFromEnv,
  type ExistingAuditSummary,
} from '../src/lib/audit-liveness';
import {
  enqueueLockKey,
  HEARTBEAT_TTL_SECONDS,
  memoryCoordinationStore,
  readWorkerHeartbeat,
  writeWorkerHeartbeat,
  type CoordinationStore,
} from '../src/lib/audit-coordinator';
import { processAuditJob, workerConcurrency } from '../src/workers/audit-worker';
import type { BullMQAuditJobPayload } from '../src/types/gmn';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

test('fase derivada: concluída/falha são finais; parada vira INTERRUPTED; Worker fora do ar também', () => {
  const base = { now: NOW, staleMinutes: 15 };
  assert.equal(deriveAuditPhase({ ...base, status: 'COMPLETED', updatedAt: ago(999), workerAlive: false }).phase, 'COMPLETED');
  const failed = deriveAuditPhase({ ...base, status: 'FAILED', updatedAt: ago(1), workerAlive: true });
  assert.deepEqual([failed.phase, failed.resumable], ['FAILED', true]);

  assert.equal(deriveAuditPhase({ ...base, status: 'QUEUED', updatedAt: ago(0.5), workerAlive: true }).phase, 'WAITING');
  assert.equal(deriveAuditPhase({ ...base, status: 'RUNNING_EXTRACTION', updatedAt: ago(3), workerAlive: true }).phase, 'RUNNING');

  const stale = deriveAuditPhase({ ...base, status: 'RUNNING_EXTRACTION', updatedAt: ago(16), workerAlive: true });
  assert.deepEqual([stale.phase, stale.resumable], ['INTERRUPTED', true]);
  assert.match(stale.reason ?? '', /Sem atualização há 16 min/);

  const noWorker = deriveAuditPhase({ ...base, status: 'QUEUED', updatedAt: ago(5), workerAlive: false });
  assert.equal(noWorker.phase, 'INTERRUPTED');
  assert.match(noWorker.reason ?? '', /Worker/);
  // recém-enfileirada com Worker ausente ainda dá um período de tolerância
  assert.equal(deriveAuditPhase({ ...base, status: 'QUEUED', updatedAt: ago(0.5), workerAlive: false }).phase, 'WAITING');
  // sem data confiável não se declara interrupção por tempo
  assert.equal(deriveAuditPhase({ ...base, status: 'RUNNING_REVIEWER', updatedAt: null, workerAlive: true }).phase, 'RUNNING');
  assert.equal(staleMinutesFromEnv({ GMN_AUDIT_STALE_MINUTES: '30' }), 30);
  assert.equal(staleMinutesFromEnv({ GMN_AUDIT_STALE_MINUTES: '0' }), 15);
});

const audit = (id: string, status: string, minutes: number, hasBattlefield = false): ExistingAuditSummary => ({ id, status, updatedAt: ago(minutes), hasBattlefield });

test('idempotência: auditoria ativa, concluída ou retomável bloqueia uma nova (409); só force libera', () => {
  const opts = { now: NOW, staleMinutes: 15 };
  assert.deepEqual(decideEnqueue([], true, opts), { action: 'CREATE' });

  const running = decideEnqueue([audit('a1', 'RUNNING_EXTRACTION', 2)], true, opts);
  assert.equal(running.action === 'REUSE' && running.code, 'ALREADY_RUNNING');

  const done = decideEnqueue([audit('a2', 'COMPLETED', 600)], true, opts);
  assert.equal(done.action === 'REUSE' && done.auditId, 'a2');
  assert.equal(done.action === 'REUSE' && done.code, 'ALREADY_COMPLETED');

  // parou depois de coletar o Battlefield: oferece retomar em vez de pagar de novo
  const resumable = decideEnqueue([audit('a3', 'RUNNING_STRATEGIST', 40, true)], true, opts);
  assert.equal(resumable.action === 'REUSE' && resumable.code, 'RESUMABLE_EXISTS');
  const failedWithData = decideEnqueue([audit('a4', 'FAILED', 5, true)], true, opts);
  assert.equal(failedWithData.action === 'REUSE' && failedWithData.code, 'RESUMABLE_EXISTS');

  // falhou sem nada coletado: nova tentativa liberada
  assert.deepEqual(decideEnqueue([audit('a5', 'FAILED', 5, false)], true, opts), { action: 'CREATE' });
  // confirmação explícita
  assert.deepEqual(decideEnqueue([audit('a2', 'COMPLETED', 600)], true, { ...opts, force: true }), { action: 'CREATE' });
});

test('trava de enfileiramento: o segundo clique falha, expira e é por empresa+palavra-chave normalizada', async () => {
  let clock = 0;
  const store = memoryCoordinationStore(() => clock);
  const key = enqueueLockKey('place-1', '  Dentista  Centro ');
  assert.equal(key, enqueueLockKey('place-1', 'dentista centro'));
  assert.notEqual(key, enqueueLockKey('place-2', 'dentista centro'));
  assert.equal(await store.setIfAbsent(key, 'ana', 120), true);
  assert.equal(await store.setIfAbsent(key, 'ana', 120), false);
  clock += 121_000;
  assert.equal(await store.setIfAbsent(key, 'ana', 120), true);
  await store.del(key);
  assert.equal(await store.setIfAbsent(key, 'ana', 120), true);
});

test('batimento do Worker: presente, expirado e Redis inacessível', async () => {
  let clock = 0;
  const store = memoryCoordinationStore(() => clock);
  assert.deepEqual(await readWorkerHeartbeat(store), { redisReachable: true, heartbeat: null });
  await writeWorkerHeartbeat(store, { pid: 42, concurrency: 3 }, new Date(NOW));
  const alive = await readWorkerHeartbeat(store);
  assert.equal(alive.heartbeat?.pid, 42);
  clock += (HEARTBEAT_TTL_SECONDS + 1) * 1000;
  assert.equal((await readWorkerHeartbeat(store)).heartbeat, null);

  const broken: CoordinationStore = {
    setIfAbsent: async () => { throw new Error('Redis fora do ar'); },
    set: async () => { throw new Error('Redis fora do ar'); },
    get: async () => { throw new Error('Redis fora do ar'); },
    del: async () => { throw new Error('Redis fora do ar'); },
  };
  assert.deepEqual(await readWorkerHeartbeat(broken), { redisReachable: false, heartbeat: null });
});

const jobPayload = { auditId: 'a-1', lead: { placeId: 'p1' }, targetKeyword: 'x' } as unknown as BullMQAuditJobPayload;

test('Worker: job duplicado ou reentregue NÃO executa o pipeline (nenhuma consulta paga)', async () => {
  let ran = 0;
  const progress: unknown[] = [];
  const job = { id: 'j1', data: jobPayload, updateProgress: async (value: unknown) => { progress.push(value); } };
  const deps = (claimed: boolean) => ({
    claim: async () => claimed,
    run: (async () => { ran++; return { status: 'COMPLETED' }; }) as never,
  });

  const skipped = await processAuditJob(job as never, deps(false));
  assert.deepEqual(skipped, { skipped: true, reason: 'AUDIT_NOT_QUEUED' });
  assert.equal(ran, 0);

  const executed = await processAuditJob(job as never, deps(true));
  assert.equal(ran, 1);
  assert.equal((executed as { status?: string }).status, 'COMPLETED');
});

test('Worker: concorrência configurável com limites seguros', () => {
  assert.equal(workerConcurrency({}), 3);
  assert.equal(workerConcurrency({ GMN_WORKER_CONCURRENCY: '1' }), 1);
  assert.equal(workerConcurrency({ GMN_WORKER_CONCURRENCY: '50' }), 3);
  assert.equal(workerConcurrency({ GMN_WORKER_CONCURRENCY: 'abc' }), 3);
});

test('Worker: job travado/falho persiste o estado FAILED (a auditoria não fica "em andamento" para sempre)', async () => {
  const { handleJobFailure } = await import('../src/workers/audit-worker');
  const saved: [string, string][] = [];
  await handleJobFailure({ id: 'j9', data: { auditId: 'aud-9' } }, new Error('job stalled more than allowable limit'), async (id, message) => { saved.push([id, message]); });
  assert.deepEqual(saved, [['aud-9', 'job stalled more than allowable limit']]);

  // sem auditId nada é gravado; e falha ao gravar não derruba o Worker
  await handleJobFailure(undefined, new Error('x'), async () => { throw new Error('não deveria gravar'); });
  await handleJobFailure({ id: 'j', data: { auditId: 'aud-10' } }, new Error('x'), async () => { throw new Error('Supabase fora do ar'); });
});

test('retomada só existe com o Campo de Batalha completo gravado (senão seria uma coleta nova e paga)', async () => {
  const { hasReusableBattlefield } = await import('../src/lib/audit-liveness');
  assert.equal(hasReusableBattlefield({ battlefield: { points: new Array(49).fill({}) } }), true);
  assert.equal(hasReusableBattlefield({ battlefield: { points: new Array(48).fill({}) } }), false);
  assert.equal(hasReusableBattlefield({ status: 'FAILED' }), false);
  assert.equal(hasReusableBattlefield(null), false);
});

test('rota resume: auditoria FALHA sem dados gravados responde 409 NOTHING_TO_RESUME e não enfileira nada', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-de-teste-0123456789';
  process.env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  const { createSessionToken, SESSION_COOKIE } = await import('../src/lib/auth/session');
  const { gmnRepository } = await import('../src/lib/supabase');
  const { POST } = await import('../src/app/api/audit/[id]/resume/route');
  const id = '00000000-0000-4000-8000-0000000000f1';
  const original = gmnRepository.getAuditState;
  gmnRepository.getAuditState = async () => ({ auditId: id, status: 'FAILED', progressPercent: 5, currentAgent: 'MAESTRO', errorMessage: 'Invalid URL' });
  // Redis não pode ser tocado: a recusa acontece antes
  const token = await createSessionToken('ana@empresa.com', process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    // ensureRedisReady é chamado antes na rota; sem Redis a resposta seria 503. Garantimos a ordem:
    const response = await POST(
      new Request(`http://app.local/api/audit/${id}/resume`, { method: 'POST', headers: { host: 'app.local', cookie: `${SESSION_COOKIE}=${token}` } }),
      { params: Promise.resolve({ id }) }
    );
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, 'NOTHING_TO_RESUME');
  } finally {
    gmnRepository.getAuditState = original;
  }
});
