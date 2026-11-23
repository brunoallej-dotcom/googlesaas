import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { POST as finalizeRoute } from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import { GET as listRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import { GET as detailRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/[seq]/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { sealSha256 } from '../src/lib/link-audit-evidence/provenance';
import { hashTree, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { proveEvidenceForRoutes, sealAuditV2ForTests } from './helpers/link-audit-evidence-provenance-fixtures';
import { applyLedgerEnv, routeWorld } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';

/*
 * R2.2 pelas ROTAS (composição de `scoring/shared.ts`, como em produção): a porta de reconferência é montada A CADA requisição a partir do ambiente (a mesma política `[2]` e a
 * mesma lista de chaves da prévia). Revogar a chave entre duas leituras muda o estado na leitura seguinte; a pasta de manifestos apagada continua marcada; lista inválida ⇒ "a
 * reconferir" (nunca 409/503 por isso). As respostas nunca trazem ids de chave nem hashes da proveniência. Auditoria protegida pelo livro (formato v2), sessão assinada por
 * valor fictício, pastas temporárias, nenhuma rede.
 */
registerCleanup();

const SESSAO_SENTINELA = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
let operatorSeq = 0;
const nextOperator = (): string => `rr${operatorSeq++}@empresa.com`;
const cookie = async (): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(nextOperator(), SESSAO_SENTINELA)}`;
const PROVENANCE_FIELDS = /headSeq|headSealSha256|keyIds|evidenceProvenance|revokedKeyIds/;

function req(url: string, init: { method?: string; cookie: string; body?: unknown }): Request {
  const headers: Record<string, string> = { host: 'app.local', cookie: init.cookie };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://app.local${url}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
}
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const ctxSeq = (auditId: string, seq: string) => ({ params: Promise.resolve({ auditId, seq }) });
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;

async function setup() {
  const w = await routeWorld();
  const proof = await proveEvidenceForRoutes(env, w);
  const dirs = { results: tmpDir('lrr-api-rs-'), resultAnchors: tmpDir('lrr-api-ra-') };
  env.SUPABASE_SERVICE_ROLE_KEY = SESSAO_SENTINELA;
  env.GMN_OPERATOR_EMAILS = Array.from({ length: 200 }, (_, i) => `rr${i}@empresa.com`).join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = dirs.results;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = dirs.resultAnchors;
  applyLedgerEnv(env, { ledgerDir: w.ledgerDir });
  return { w, dirs, ...proof };
}

test('R2.2 rotas: a porta é montada a cada requisição (shared.ts) — revogar entre duas leituras muda o estado; pasta apagada continua marcada; lista inválida ⇒ "A reconferir"', async () => {
  const { w, dirs, sealsDir, keys } = await setup();
  const base = `/api/link-audit/scoring/${w.auditId}`;
  const seen = await json(await previewRoute(req(base, { cookie: await cookie() }), ctx(w.auditId)));
  const created = await finalizeRoute(req(`${base}/finalize`, { method: 'POST', cookie: await cookie(), body: { expectedHead: seen.finalization.expectedHead, expectedInputSha256: seen.finalization.expectedInputSha256 } }), ctx(w.auditId));
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()).slice(0, 300));
  const stored = JSON.parse(fs.readFileSync(path.join(dirs.results, w.auditId, 's0001.json'), 'utf8')) as { schemaVersion: number; evidenceProvenance: { headSealSha256: string; keyIds: string[] } };
  assert.equal(stored.schemaVersion, 2, 'auditoria protegida pelo livro');
  assert.deepEqual(stored.evidenceProvenance.keyIds, [keys.keyId]);
  const before = [hashTree(dirs.results), hashTree(dirs.resultAnchors)];

  const read = async (): Promise<string[]> => {
    const listed = await listRoute(req(`${base}/results`, { cookie: await cookie() }), ctx(w.auditId));
    const detail = await detailRoute(req(`${base}/results/1`, { cookie: await cookie() }), ctxSeq(w.auditId, '1'));
    assert.equal(listed.status, 200);
    assert.equal(detail.status, 200);
    const [l, d] = [await json(listed), await json(detail)];
    for (const body of [l, d]) {
      const text = JSON.stringify(body);
      assert.ok(!PROVENANCE_FIELDS.test(text) && !text.includes(keys.keyId) && !text.includes(stored.evidenceProvenance.headSealSha256), 'nem ids de chave nem hashes da proveniência');
    }
    assert.equal(l.results.length, 1, 'o resultado nunca some da lista');
    return [l.results[0].provenanceState, d.provenanceState];
  };

  assert.deepEqual(await read(), ['VERIFIED', 'VERIFIED']);
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = `${keys.keyId}:${keys.publicRaw}:revoked`;
  assert.deepEqual(await read(), ['RECHECK', 'RECHECK'], 'a revogação feita entre as requisições aparece na seguinte');
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = keys.trustKeys;
  assert.deepEqual(await read(), ['VERIFIED', 'VERIFIED'], 'nada foi lembrado da requisição anterior');
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = 'lixo';
  assert.deepEqual(await read(), ['RECHECK', 'RECHECK'], 'lista inválida: revisão, nunca autenticado');
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = `${keys.keyId}:${keys.publicRaw}:revoked`;
  fs.rmSync(path.join(sealsDir, w.auditId), { recursive: true, force: true });
  assert.deepEqual(await read(), ['RECHECK', 'RECHECK'], 'revogada e pasta apagada: continua marcada');
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = keys.trustKeys;
  assert.deepEqual(await read(), ['RECHECK', 'RECHECK'], 'pasta apagada sem revogação: NO_SEAL ⇒ a reconferir');
  // re-atestada com a MESMA chave e o MESMO conteúdo (Ed25519 e `sealedAt` fixos ⇒ selo idêntico): a cabeça gravada volta e confere
  const again = await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  assert.equal(sealSha256(again), stored.evidenceProvenance.headSealSha256, 'o selo de teste é determinístico: a mesma cabeça volta');
  assert.deepEqual(await read(), ['VERIFIED', 'VERIFIED'], 'a mesma cadeia de volta confere');
  assert.deepEqual([hashTree(dirs.results), hashTree(dirs.resultAnchors)], before, 'nenhuma leitura reescreveu resultado ou recibo');
});
