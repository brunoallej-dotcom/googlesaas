import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { GET as listRoute } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { POST as ledgerRoute } from '../src/app/api/link-audit/decisions/[auditId]/ledger/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { LEDGER_KIND, LEDGER_SCHEMA_VERSION, ledgerRecordSchema, type LedgerDraft } from '../src/lib/link-audit-ledger';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, entryPath, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { applyLedgerEnv, decisionsOver, isoAt, ledgerAuth, ledgerEvents, ledgerFor, ledgerPath, ledgerRecords, ledgerWorld, LEDGER_KEY_A, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { sealedWorld, servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * Q5 (confirmado pelo responsável em 03/11/2026): ADOÇÃO DE HISTÓRICO NÃO VAZIO, QUARANTINE_ACK e RESTORE_ACK exigem autorização ADMINISTRATIVA explícita, auditável e com
 * dupla aprovação. Esse mecanismo NÃO existe e NÃO foi simulado ⇒ as três operações ficam indisponíveis, em qualquer estado, por qualquer canal. A única "adoção" que
 * continua é a INSCRIÇÃO de auditoria comprovadamente VAZIA — e só quando a ausência de histórico é realmente verificável.
 */
registerCleanup();
const ADMIN = ['ADOPT', 'RESTORE_ACK', 'QUARANTINE_ACK'] as const;
const trees = (w: LedgerWorld) => ({ ledger: hashTree2(w.ledgerDir), decisions: hashTree2(w.decisionsDir), anchors: hashTree2(w.anchorDir) });
function hashTree2(dir: string): Record<string, string> {
  return fs.existsSync(dir) ? hashTree(dir) : {};
}

test('Q5: ADOPT, RESTORE_ACK e QUARANTINE_ACK respondem ADMIN_APPROVAL_UNAVAILABLE em TODOS os estados do livro (a inscrever, protegida vazia/com decisão, operação aberta, não resolvida por chave revogada, por desacordo com resultado, legada) e nunca mudam nada', async () => {
  const states: Array<[string, () => Promise<{ w: LedgerWorld; service: ReturnType<typeof servicesOver> }>]> = [
    ['a inscrever', async () => { const w = await ledgerWorld({ enroll: false }); return { w, service: servicesOver(w, resultsEnv()) }; }],
    ['protegida vazia', async () => { const w = await ledgerWorld(); return { w, service: servicesOver(w, resultsEnv()) }; }],
    ['protegida com decisão', async () => { const w = await ledgerWorld(); await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())); return { w, service: servicesOver(w, resultsEnv()) }; }],
    ['operação aberta (INTENT sem entrada)', async () => {
      const w = await ledgerWorld({ decisionsFs: faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } }) });
      await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
      return { w, service: servicesOver(w, resultsEnv()) };
    }],
    ['legada (histórico sem livro)', async () => { const w = await ledgerWorld({ enroll: false }); await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock())); return { w, service: servicesOver(w, resultsEnv()) }; }],
    ['chave do livro revogada', async () => {
      const w = await ledgerWorld(); await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
      return { w, service: decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: ledgerAuth({ current: 'lk-novo-test:' + LEDGER_KEY_A.split(':')[1]!.split('').reverse().join(''), revokedIds: ['lk-test-a'] }) }), knownHeads: NO_RESULTS }) };
    }],
    ['desacordo com resultado', async () => {
      const { w, e, run } = await sealedWorld();
      fs.rmSync(ledgerPath(w, run.ledgerHead?.ledgerSeq as number));
      return { w, service: servicesOver(w, e) };
    }],
  ];
  for (const [label, build] of states) {
    const { w, service } = await build();
    for (const action of ADMIN) {
      const before = trees(w);
      const bodies: unknown[] = [{ action }, { action, approvers: ['adm1@empresa.com', 'adm2@empresa.com'], reason: 'aprovado' }, { action: action.toLowerCase() }, [{ action }], { action: [action] }];
      for (const [index, body] of bodies.entries()) {
        const result = await service.ledgerAction(ANA, w.auditId, body, clock());
        assert.ok(!result.ok, `${label}/${action}/corpo ${index}: nunca concede`);
        if (index === 0) assert.equal(result.code, 'ADMIN_APPROVAL_UNAVAILABLE', `${label}/${action}`);
      }
      assert.deepEqual(trees(w), before, `${label}/${action}: nenhum arquivo mudou`);
    }
  }
});

test('Q5 (rota): nenhum cabeçalho, parâmetro ou segundo operador "aprova" — a rota continua 403 ADMIN_APPROVAL_UNAVAILABLE, e a identidade do operador comum não vira administrador', async () => {
  const env = process.env as Record<string, string | undefined>;
  const SECRET = 'service-role-key-de-teste-0123456789';
  const w = await ledgerWorld({ enroll: false });
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com,bia@empresa.com,admin@empresa.com,root@empresa.com';
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  const e = resultsEnv();
  env.GMN_LINK_AUDIT_RESULTS_DIR = e.base;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = e.anchors;
  applyLedgerEnv(env, w);
  const cookie = async (who: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(who, SECRET)}`;
  const before = trees(w);
  const ctx = { params: Promise.resolve({ auditId: w.auditId }) };
  for (const who of ['ana@empresa.com', 'bia@empresa.com', 'admin@empresa.com', 'root@empresa.com']) {
    for (const action of ADMIN) {
      for (const extra of [{}, { 'x-gmn-admin': 'true' }, { 'x-forwarded-user': 'root' }, { authorization: 'Bearer admin' }, { 'x-approved-by': 'bia@empresa.com' }] as Array<Record<string, string>>) {
        const response = await ledgerRoute(
          new Request(`http://app.local/api/link-audit/decisions/${w.auditId}/ledger?admin=1&approved=1`, { method: 'POST', headers: { host: 'app.local', cookie: await cookie(who), 'content-type': 'application/json', origin: 'http://app.local', ...extra }, body: JSON.stringify({ action }) }),
          ctx,
        );
        assert.ok([400, 403].includes(response.status), `${who}/${action}/${JSON.stringify(extra)} ⇒ ${response.status}`);
        if (response.status === 403) assert.equal(((await response.json()) as { code: string }).code, 'ADMIN_APPROVAL_UNAVAILABLE');
      }
    }
  }
  const sameBody = await ledgerRoute(new Request(`http://app.local/api/link-audit/decisions/${w.auditId}/ledger`, { method: 'POST', headers: { host: 'app.local', cookie: await cookie('ana@empresa.com'), 'content-type': 'application/json', origin: 'http://app.local' }, body: JSON.stringify({ action: 'ADOPT' }) }), ctx);
  assert.equal(sameBody.status, 403);
  assert.deepEqual(trees(w), before, 'nenhum arquivo mudou');
  const view = (await (await listRoute(new Request(`http://app.local/api/link-audit/decisions/${w.auditId}`, { headers: { host: 'app.local', cookie: await cookie('bia@empresa.com') } }), ctx)).json()) as { ledger: { state: string }; decisions: unknown[] };
  assert.deepEqual([view.ledger.state, view.decisions.length], ['LEGACY_READ_ONLY', 0], 'continua em modo restrito');
});

/* ------------------------------------------------------------------ a inscrição só vale para auditoria VERIFICAVELMENTE vazia */
test('Q5: a inscrição (única "adoção" que continua) exige ausência de histórico VERIFICÁVEL — decisão, pendência, recibo órfão, resultado, resultado pendente, registro da guarda ou fonte ilegível a impedem, sem gravar GENESIS', async () => {
  const noGenesis = async (w: LedgerWorld, label: string): Promise<void> => assert.ok(!fs.existsSync(ledgerPath(w, 1)), `${label}: nenhum GENESIS foi gravado`);

  // controle: auditoria realmente vazia ⇒ inscreve
  const empty = await ledgerWorld({ enroll: false });
  const ok = await empty.rawProtected.ledgerAction(ANA, empty.auditId, { action: 'ENROLL' }, clock());
  assert.ok(ok.ok, 'controle: vazia ⇒ inscrita');
  assert.deepEqual(await ledgerEvents(empty), ['GENESIS']);
  assert.equal((await ledgerRecords(empty))[0]?.genesis?.mode, 'EMPTY', 'a inscrição é GENESIS de auditoria VAZIA, nunca de histórico adotado');

  // 1) já há decisão confirmada
  const withDecision = await ledgerWorld({ enroll: false });
  await must(withDecision.service.create(ANA, withDecision.auditId, { record: rec.c2() }, clock()));
  const r1 = await withDecision.rawProtected.ledgerAction(ANA, withDecision.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!r1.ok && r1.code === 'ADMIN_APPROVAL_UNAVAILABLE');
  await noGenesis(withDecision, 'decisão confirmada');

  // 2) há decisão PENDENTE (sem recibo)
  const pendingWorld = await ledgerWorld({ enroll: false });
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(pendingWorld.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const pendingCreate = await decisionsOver(pendingWorld, { ledger: LEDGER_NOT_REQUIRED, fs: noReceipts }).create(ANA, pendingWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pendingCreate.ok && pendingCreate.code === 'ANCHOR_PENDING', 'precondição: decisão pendente (sem recibo)');
  const r2 = await pendingWorld.rawProtected.ledgerAction(ANA, pendingWorld.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!r2.ok, 'pendência impede a inscrição');
  await noGenesis(pendingWorld, 'decisão pendente');

  // 3) RECIBO ÓRFÃO (a entrada foi removida e o recibo ficou): a pasta de decisões "parece" vazia, mas a de recibos prova que houve histórico
  const orphan = await ledgerWorld({ enroll: false });
  await must(orphan.service.create(ANA, orphan.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(entryPath(orphan, 1));
  assert.ok(fs.existsSync(anchorPath(orphan, 1)));
  const r3 = await orphan.rawProtected.ledgerAction(ANA, orphan.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!r3.ok, 'recibo órfão: o histórico NÃO é verificavelmente vazio');
  await noGenesis(orphan, 'recibo órfão');

  // 4) já existe RESULTADO selado (mesmo sem nenhuma decisão)
  const resulted = await ledgerWorld({ enroll: false });
  const e = resultsEnv();
  const isolated = servicesOver(resulted, e, { ledger: LEDGER_NOT_REQUIRED });
  const preview = previewOver({ evidenceDir: resulted.evidenceDir, raw: isolated });
  const evaluated = await preview.evaluate(OP_A, resulted.auditId);
  assert.ok(evaluated.ok);
  assert.ok((await makeService(e, preview).finalize(OP_A, resulted.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string })).ok, 'resultado v1 selado sem livro');
  const r4 = await servicesOver(resulted, e).ledgerAction(ANA, resulted.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!r4.ok && r4.code === 'ADMIN_APPROVAL_UNAVAILABLE', 'resultado existente ⇒ há histórico ⇒ adoção administrativa (indisponível)');
  await noGenesis(resulted, 'resultado selado');

  // 5) a FONTE de resultados (testemunha) está ilegível/indisponível ⇒ não dá para provar que está vazia ⇒ recusa
  for (const provider of [
    async () => ({ ok: false as const, reason: 'STORAGE_UNAVAILABLE' as const }),
    async () => ({ ok: false as const, reason: 'NOT_CONFIGURED' as const }),
    async () => ({ ok: false as const, reason: 'UNTRUSTED' as const }),
    async () => { throw new Error('boom'); },
  ]) {
    const blind = await ledgerWorld({ enroll: false });
    const service = decisionsOver(blind, { ledger: ledgerFor(blind, { guard: null }), knownHeads: provider as never });
    const refused = await service.ledgerAction(ANA, blind.auditId, { action: 'ENROLL' }, clock());
    assert.ok(!refused.ok, 'sem poder ler os resultados a vacuidade não é verificável');
    await noGenesis(blind, 'testemunha ilegível');
  }

  // 6) pastas que EXISTEM mas não podem ser lidas (ou cuja existência não pode ser estabelecida) ⇒ ausência de histórico NÃO é verificável ⇒ recusa
  const unreadable: Array<[string, (w: LedgerWorld) => ReturnType<typeof faulty>, boolean]> = [
    ['decisões com histórico e listagem com EIO', (w) => faulty({ async readdir(dir) { if (dir.startsWith(w.decisionsDir)) throw errno('EIO'); return nodeFsOps.readdir(dir); } }), true],
    ['existência da pasta de decisões da auditoria indeterminável (EACCES)', (w) => faulty({ async lstat(target) { if (target === `${w.decisionsDir}/${w.auditId}`) throw errno('EACCES'); return nodeFsOps.lstat(target); } }), false],
    ['existência da pasta de recibos da auditoria indeterminável (EACCES)', (w) => faulty({ async lstat(target) { if (target === `${w.anchorDir}/${w.auditId}`) throw errno('EACCES'); return nodeFsOps.lstat(target); } }), false],
    ['existência da pasta do livro da auditoria indeterminável (EIO)', (w) => faulty({ async lstat(target) { if (target === `${w.ledgerDir}/${w.auditId}`) throw errno('EIO'); return nodeFsOps.lstat(target); } }), false],
  ];
  for (const [label, inject, withHistory] of unreadable) {
    const blind = await ledgerWorld({ enroll: false });
    if (withHistory) await must(blind.service.create(ANA, blind.auditId, { record: rec.c2() }, clock()));
    const fsOps = inject(blind);
    const service = decisionsOver(blind, { ledger: ledgerFor(blind, { guard: null, fs: fsOps }), knownHeads: NO_RESULTS, fs: fsOps });
    const refused = await service.ledgerAction(ANA, blind.auditId, { action: 'ENROLL' }, clock());
    assert.ok(!refused.ok, `${label}: ausência de histórico não verificável ⇒ nenhuma inscrição`);
    await noGenesis(blind, label);
  }

  // 7) a GUARDA externa já tem registro desta auditoria (o livro existiu e sumiu) ⇒ nunca "vazia"
  const guarded = await ledgerWorld({ enroll: false, withGuard: true });
  await guarded.guard.publish({ auditId: guarded.auditId, ledgerSeq: 1, sha256: 'a'.repeat(64) });
  const r7 = await guarded.rawProtected.ledgerAction(ANA, guarded.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!r7.ok, 'a guarda prova que houve livro');
  await noGenesis(guarded, 'guarda com registro');
  void BIA;
});

test('Q5: o modo de GENESIS "ADOPTED" (adoção de histórico) é reservado e inexistente — um registro assim, mesmo assinado com a chave do livro, é recusado pelo contrato e a auditoria não fica protegida', async () => {
  const w = await ledgerWorld({ enroll: false });
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const auth = ledgerAuth(LEDGER_KEY_A);
  const unsigned = { schemaVersion: LEDGER_SCHEMA_VERSION, kind: LEDGER_KIND, auditId: w.auditId, ledgerSeq: 1, prevSha256: null, event: 'GENESIS', recordedAt: isoAt(0), actor: 'ana@empresa.com', genesis: { mode: 'ADOPTED' } } as unknown as LedgerDraft;
  const forged = seal({ ...unsigned, origin: auth.sign('LEDGER', unsigned) });
  assert.equal(ledgerRecordSchema.safeParse(forged).success, false, 'o esquema recusa o modo ADOPTED');
  fs.mkdirSync(`${w.ledgerDir}/${w.auditId}`, { recursive: true });
  fs.writeFileSync(`${w.ledgerDir}/${w.auditId}/l000001.json`, serialize(forged), { mode: 0o444 });
  const view = await must(servicesOver(w, resultsEnv()).list(BIA, w.auditId, clock()));
  assert.notEqual(view.ledger.state, 'PROTECTED');
  assert.deepEqual([view.decisions.length, view.finalizable], [0, false]);
});
