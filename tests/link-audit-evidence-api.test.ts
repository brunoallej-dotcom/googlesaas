import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GET as listRoute } from '../src/app/api/link-audit/evidence/route';
import { GET as detailRoute } from '../src/app/api/link-audit/evidence/[auditId]/route';
import { GET as versionsRoute } from '../src/app/api/link-audit/evidence/[auditId]/versions/route';
import * as listModule from '../src/app/api/link-audit/evidence/route';
import * as detailModule from '../src/app/api/link-audit/evidence/[auditId]/route';
import * as versionsModule from '../src/app/api/link-audit/evidence/[auditId]/versions/route';
import { writeCapture } from '../src/lib/link-audit-evidence/store';
import { middleware } from '../src/middleware';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { NextRequest } from 'next/server';
import { AUDIT, captureInput, registerCleanup, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;

let operatorSeq = 0;
const operatorList = (): string => ['ana@empresa.com', 'limitado@empresa.com', ...Array.from({ length: 200 }, (_, i) => `op${i}@empresa.com`)].join(',');
const nextOperator = (): string => `op${operatorSeq++}@empresa.com`;

function setEnv(base: string | undefined, operators = operatorList()): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = operators;
  delete env.GMN_AUTH_DISABLED;
  if (base === undefined) delete env.GMN_LINK_AUDIT_EVIDENCE_DIR;
  else env.GMN_LINK_AUDIT_EVIDENCE_DIR = base;
}

const cookie = async (email: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;

function req(url: string, cookieValue?: string | null, method = 'GET'): Request {
  const headers: Record<string, string> = { host: 'app.local' };
  if (cookieValue) headers.cookie = cookieValue;
  return new Request(`http://app.local${url}`, { method, headers });
}
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });

const hashDir = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = `${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}:${fs.statSync(full).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};

async function seeded(): Promise<{ base: string; ana: string }> {
  const base = tmpDir();
  await writeFull(base);
  setEnv(base);
  return { base, ana: await cookie(nextOperator()) };
}

test('sem sessão: as três rotas respondem 401, sem dados e sem cache', async () => {
  const { base } = await seeded();
  for (const [call, label] of [
    [() => listRoute(req('/api/link-audit/evidence')), 'lista'],
    [() => detailRoute(req(`/api/link-audit/evidence/${AUDIT}`), ctx(AUDIT)), 'detalhe'],
    [() => versionsRoute(req(`/api/link-audit/evidence/${AUDIT}/versions`), ctx(AUDIT)), 'versões'],
  ] as const) {
    const r = await call();
    assert.equal(r.status, 401, label);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    const text = JSON.stringify(await r.json());
    assert.ok(!/audit|Padaria|4193|1311768467294899695|auditoria-teste/i.test(text), `${label}: nenhum dado vaza sem sessão`);
  }
  assert.ok(base);
});

test('sessão inválida, operador fora da lista e autenticação não configurada são recusados', async () => {
  const { base } = await seeded();
  const bad = await listRoute(req('/api/link-audit/evidence', `${SESSION_COOKIE}=lixo.assinatura`));
  assert.ok([401, 403].includes(bad.status));
  const outsider = await listRoute(req('/api/link-audit/evidence', await cookie('intruso@x.com')));
  assert.ok([401, 403].includes(outsider.status));
  assert.ok(!JSON.stringify(await outsider.json()).includes('Padaria'));
  env.SUPABASE_SERVICE_ROLE_KEY = '';
  const noAuth = await listRoute(req('/api/link-audit/evidence', await cookie(nextOperator())));
  assert.ok([401, 403, 503].includes(noAuth.status));
  setEnv(base);
});

test('lista: devolve a auditoria com os campos da interface e nenhum corpo bruto, caminho ou segredo', async () => {
  const { base, ana } = await seeded();
  const r = await listRoute(req('/api/link-audit/evidence', ana));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store.*private|private.*no-store/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('vary') ?? '', /Cookie/i);
  const text = JSON.stringify(await r.clone().json());
  const body = (await r.json()) as { audits: Array<Record<string, unknown>>; total: number; limit: number; offset: number };
  assert.equal(body.total, 1);
  assert.deepEqual([body.limit, body.offset], [20, 0]);
  const item = body.audits[0] as Record<string, unknown>;
  assert.deepEqual([item.companyName, item.city, item.stateCode, item.confirmedCid, item.state], ['Padaria Exemplo', 'Cidade Exemplo', 'GO', '1311768467294899695', 'COMPLETE']);
  assert.match(String(item.sourceLabel), /Serper.*não é a API oficial/);
  assert.equal((item.integrity as { status: string }).status, 'OK');
  assert.ok(!text.includes(SENTINEL) && !/bodyText|"places"|thumbnailUrl|foto-opaca|searchParameters/.test(text));
  assert.ok(!text.includes(base) && !/\.capture\.json|\/mnt\/|\/tmp\//.test(text), 'nenhum caminho do disco');
  assert.ok(!/x-api-key|authorization|cookie|token/i.test(text));
});

test('lista: paginação limitada e parâmetros estranhos recusados', async () => {
  const { ana } = await seeded();
  for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=abc', '?limit=1.5', '?offset=10001', '?offset=-3', '?limit=5&limit=6', '?foo=1', '?path=/etc/passwd', '?limit=%00', '?capture=1', `?limit=${'9'.repeat(40)}`]) {
    const r = await listRoute(req(`/api/link-audit/evidence${query}`, ana));
    assert.equal(r.status, 400, query);
    assert.deepEqual(await r.json(), { error: 'Parâmetros inválidos.', code: 'INVALID_PARAMS' });
  }
  const page2 = await listRoute(req('/api/link-audit/evidence?limit=1&offset=1', ana));
  assert.equal(page2.status, 200);
  assert.deepEqual(((await page2.json()) as { audits: unknown[] }).audits, []);
  assert.equal((await listRoute(req('/api/link-audit/evidence?limit=50&offset=0', ana))).status, 200);
});

test('detalhe: visão completa, sem corpo bruto, com integridade verificada antes da exibição', async () => {
  const { ana } = await seeded();
  const r = await detailRoute(req(`/api/link-audit/evidence/${AUDIT}`, ana), ctx(AUDIT));
  assert.equal(r.status, 200);
  const raw = await r.text();
  const audit = (JSON.parse(raw) as { audit: Record<string, any> }).audit;
  assert.equal(audit.kind, 'EVIDENCE_COLLECTION');
  assert.equal(audit.scoring, 'NOT_AVAILABLE_PENDING_D3');
  assert.equal(audit.integrity.status, 'OK');
  assert.equal(audit.establishment.name, 'Padaria Exemplo (fictícia)');
  assert.equal(audit.establishment.rating, 4.8);
  assert.ok(audit.evidences.verified.length >= 8 && audit.evidences.unverified.length > 0);
  assert.equal(audit.source.officialGoogleApi, false);
  assert.deepEqual(audit.identifiers.confirmed.map((c: { type: string }) => c.type), ['cid', 'featureId'], 'o link do fixture traz cid e fid iguais aos do retorno');
  assert.equal(audit.location, null, 'o fixture não traz coordenadas: nada é inventado');
  assert.ok(!raw.includes(SENTINEL) && !/bodyText|"places"|thumbnailUrl|foto-opaca/.test(raw));
  assert.ok(!/\/mnt\/|\/tmp\//.test(raw), 'nenhum caminho do disco');
  const rev = await detailRoute(req(`/api/link-audit/evidence/${AUDIT}?capture=1&revision=1`, ana), ctx(AUDIT));
  assert.equal(rev.status, 200);
  assert.deepEqual(((await rev.json()) as { audit: { selected: unknown } }).audit.selected, { capture: 1, revision: 1 });
});

test('detalhe: identificadores perigosos (traversal, absolutos, maiúsculas, codificados) são recusados sem tocar no disco', async () => {
  const { base, ana } = await seeded();
  const before = hashDir(base);
  for (const id of ['../../etc/passwd', '..', '.', '/etc/passwd', 'C:\\Windows\\system.ini', 'AUDITORIA-TESTE-0001', 'auditoria teste', 'a'.repeat(65), 'curto', '%2e%2e%2f%2e%2e', '..%2f..%2fx', 'auditoria-teste-0001/../x', 'auditoria-teste-0001\0', '']) {
    const r = await detailRoute(req('/api/link-audit/evidence/x', ana), ctx(id));
    assert.equal(r.status, 400, JSON.stringify(id));
    const rv = await versionsRoute(req('/api/link-audit/evidence/x/versions', ana), ctx(id));
    assert.equal(rv.status, 400, `versões ${JSON.stringify(id)}`);
  }
  const second = await cookie(nextOperator()); // cota por operador: um novo operador para o segundo grupo
  for (const query of ['?capture=0', '?revision=0', '?capture=abc', '?revision=-1', '?capture=1&capture=2', '?path=/etc', '?file=../x', '?capture=99999999']) {
    const r = await detailRoute(req(`/api/link-audit/evidence/${AUDIT}${query}`, second), ctx(AUDIT));
    assert.ok([400, 404].includes(r.status), query);
  }
  const versionsExtra = await versionsRoute(req(`/api/link-audit/evidence/${AUDIT}/versions?x=1`, second), ctx(AUDIT));
  assert.equal(versionsExtra.status, 400);
  assert.deepEqual(hashDir(base), before, 'a leitura não alterou nenhum arquivo');
});

test('detalhe: inexistente = 404; revisão inexistente = 404; arquivo adulterado = 409 sem exibir dados; coleta incompleta = 409', async () => {
  const { base, ana } = await seeded();
  assert.equal((await detailRoute(req('/api/link-audit/evidence/nao-existe-0001', ana), ctx('nao-existe-0001'))).status, 404);
  assert.equal((await detailRoute(req(`/api/link-audit/evidence/${AUDIT}?revision=9`, ana), ctx(AUDIT))).status, 404);

  assert.ok((await writeCapture(base, captureInput({ auditId: 'incompleta-0001' }))).ok);
  const incomplete = await detailRoute(req('/api/link-audit/evidence/incompleta-0001', ana), ctx('incompleta-0001'));
  assert.equal(incomplete.status, 409);
  assert.equal(((await incomplete.json()) as { code: string }).code, 'AUDIT_INCOMPLETE');

  const file = path.join(base, AUDIT, 'c0001.report-r0001.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Padaria Exemplo', 'Padaria Trocada'));
  const tampered = await detailRoute(req(`/api/link-audit/evidence/${AUDIT}`, ana), ctx(AUDIT));
  assert.equal(tampered.status, 409);
  const body = JSON.stringify(await tampered.json());
  assert.match(body, /INTEGRITY_FAILED/);
  assert.ok(!/Padaria|4193|1311768467294899695|establishment/.test(body), 'nenhum dado é exibido quando a integridade falha');
  const list = (await (await listRoute(req('/api/link-audit/evidence', ana))).json()) as { audits: Array<{ integrity: { status: string } }> };
  assert.equal(list.audits.find(() => true)?.integrity.status, 'MISMATCH', 'a lista sinaliza a integridade comprometida');
});

test('versões: histórico de capturas e revisões', async () => {
  const { ana } = await seeded();
  const r = await versionsRoute(req(`/api/link-audit/evidence/${AUDIT}/versions`, ana), ctx(AUDIT));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { auditId: string; versions: Array<{ capture: number; reportRevisions: Array<{ revision: number; superseded: boolean }> }> };
  assert.equal(body.auditId, AUDIT);
  assert.deepEqual(body.versions.map((v) => v.capture), [1]);
  assert.deepEqual(body.versions[0]?.reportRevisions.map((x) => x.revision), [1]);
  assert.equal((await versionsRoute(req('/api/link-audit/evidence/nao-existe-0001/versions', ana), ctx('nao-existe-0001'))).status, 404);
});

test('armazenamento não configurado ou inacessível: erro controlado (503), sem caminhos e sem relaxar nada', async () => {
  const ana = await cookie(nextOperator());
  const secretPath = '/mnt/d/segredo-privado-do-servidor/evidencias';
  for (const [value, code] of [[undefined, 'EVIDENCE_NOT_CONFIGURED'], ['', 'EVIDENCE_NOT_CONFIGURED'], ['relativo/pasta', 'EVIDENCE_NOT_CONFIGURED'], ['D:\\evidencias', 'EVIDENCE_NOT_CONFIGURED'], [secretPath, 'EVIDENCE_STORAGE_UNAVAILABLE'], [path.join(process.cwd(), 'public', 'evidencias'), 'EVIDENCE_STORAGE_UNAVAILABLE']] as const) {
    setEnv(value);
    for (const r of [await listRoute(req('/api/link-audit/evidence', ana)), await detailRoute(req(`/api/link-audit/evidence/${AUDIT}`, ana), ctx(AUDIT)), await versionsRoute(req(`/api/link-audit/evidence/${AUDIT}/versions`, ana), ctx(AUDIT))]) {
      assert.equal(r.status, 503, String(value));
      const text = JSON.stringify(await r.json());
      assert.match(text, new RegExp(code));
      assert.ok(!text.includes('segredo-privado') && !text.includes(process.cwd()) && !text.includes('D:\\'), 'a resposta nunca revela o caminho configurado');
    }
  }
  const file = path.join(tmpDir(), 'arquivo.txt');
  fs.writeFileSync(file, 'x');
  setEnv(file);
  assert.equal((await listRoute(req('/api/link-audit/evidence', ana))).status, 503, 'um arquivo no lugar da pasta');
});

test('somente leitura: as rotas só exportam GET e nenhum método de escrita existe', () => {
  for (const mod of [listModule, detailModule, versionsModule] as Array<Record<string, unknown>>) {
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter((m) => m in mod);
    assert.deepEqual(methods, []);
    assert.equal(typeof mod.GET, 'function');
    assert.equal(mod.dynamic, 'force-dynamic', 'respostas privadas nunca são geradas estaticamente');
  }
});

test('o middleware exige sessão nas rotas de leitura (GET) e na página', async () => {
  setEnv(undefined);
  for (const p of ['/api/link-audit/evidence', `/api/link-audit/evidence/${AUDIT}`, `/api/link-audit/evidence/${AUDIT}/versions`]) {
    const r = await middleware(new NextRequest(`http://app.local${p}`, { headers: { host: 'app.local' } }));
    assert.equal(r.status, 401, p);
  }
  const page = await middleware(new NextRequest('http://app.local/auditoria-por-link', { headers: { host: 'app.local' } }));
  assert.equal(page.status, 307);
});

test('limite de requisições por operador (429 com Retry-After); outro operador não é afetado', async () => {
  const { ana } = await seeded();
  const limitado = await cookie('limitado@empresa.com');
  let blocked = 0;
  let retry = '';
  for (let i = 0; i < 40; i++) {
    const r = await listRoute(req('/api/link-audit/evidence?limit=1', limitado));
    if (r.status === 429) {
      blocked += 1;
      retry = r.headers.get('retry-after') ?? '';
      assert.deepEqual(await r.json(), { error: 'Muitas consultas em pouco tempo. Aguarde um instante.', code: 'RATE_LIMITED' });
    }
  }
  assert.ok(blocked >= 5 && blocked <= 10, `bloqueou ${blocked} (cota de 30 por minuto)`);
  assert.match(retry, /^\d+$/);
  assert.equal((await listRoute(req('/api/link-audit/evidence?limit=1', ana))).status, 200, 'outro operador continua com acesso');
});

test('revisão 5B: sem sessão a validação nem roda (401, nunca 400); só depois de autenticado os parâmetros são validados', async () => {
  const { ana } = await seeded();
  assert.equal((await listRoute(req('/api/link-audit/evidence?limit=999'))).status, 401);
  assert.equal((await detailRoute(req('/api/link-audit/evidence/..%2fx'), ctx('../x'))).status, 401);
  assert.equal((await versionsRoute(req('/api/link-audit/evidence/x/versions?y=1'), ctx('../x'))).status, 401);
  assert.equal((await listRoute(req('/api/link-audit/evidence?limit=999', ana))).status, 400);
});

test('revisão 5B: captura adulterada com relatório íntegro NÃO exibe nada (409) e a lista não mostra o conteúdo', async () => {
  const { base, ana } = await seeded();
  const file = path.join(base, AUDIT, 'c0001.capture.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"httpStatus": 200', '"httpStatus": 500'));
  const detail = await detailRoute(req(`/api/link-audit/evidence/${AUDIT}`, ana), ctx(AUDIT));
  assert.equal(detail.status, 409);
  assert.ok(!/Padaria|1311768467294899695|establishment/.test(JSON.stringify(await detail.json())));
  const versions = await versionsRoute(req(`/api/link-audit/evidence/${AUDIT}/versions`, ana), ctx(AUDIT));
  assert.equal(versions.status, 409, 'nem o histórico é exibido');
  const list = (await (await listRoute(req('/api/link-audit/evidence', ana))).json()) as { audits: Array<Record<string, unknown>> };
  const item = list.audits[0] as Record<string, unknown>;
  assert.deepEqual([item.state, (item.integrity as { status: string }).status, item.companyName, item.confirmedCid, item.collectedAt], ['CORRUPT', 'MISMATCH', null, null, null]);
});

test('revisão 5B: coleta legada adulterada não aparece na lista nem nas versões; symlink na raiz não derruba a lista', async () => {
  const { base, ana } = await seeded();
  // uma pasta no formato legado (MANIFEST + SHA256SUMS + report.json) e depois adulterada
  const legacy = path.join(base, 'legado-teste-0001');
  fs.mkdirSync(legacy);
  const files: Record<string, string> = { 'serper-body.json': '{"places":[],"credits":3}', 'serper-status.json': '{"status":200}', 'serper-attempts.json': '{"attempts":1}', 'summary.json': '{}', 'run-stdout.txt': 'x', 'run-stderr.txt': '' };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(legacy, name), content);
  fs.writeFileSync(path.join(legacy, 'MANIFEST.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'SHA256SUMS'), Object.entries(files).map(([n, c]) => `${crypto.createHash('sha256').update(c).digest('hex')}  ${n}\n`).join(''));
  const report = JSON.stringify({ kind: 'X', identity: { operatorProvided: { name: 'Empresa Legada', city: 'Lugar', stateCode: 'GO' } }, source: { collectedAt: '2026-10-22T12:00:00.000Z' }, identifiers: { confirmed: [{ type: 'cid', value: '999' }] }, generatedAt: '2026-10-22T13:00:00.000Z' });
  fs.writeFileSync(path.join(legacy, 'report.json'), report);
  fs.writeFileSync(path.join(legacy, 'report.json.sha256'), `${crypto.createHash('sha256').update('outro conteúdo').digest('hex')}  report.json\n`); // hash que NÃO confere
  fs.symlinkSync(path.join(base, AUDIT), path.join(base, 'alias-da-auditoria-1'));
  fs.writeFileSync(path.join(base, 'arquivo-no-lugar-01'), 'x');

  const list = await listRoute(req('/api/link-audit/evidence', ana));
  assert.equal(list.status, 200, 'symlink e arquivo na raiz são ignorados');
  const items = ((await list.json()) as { audits: Array<Record<string, any>> }).audits;
  const bad = items.find((i) => i.auditId === 'legado-teste-0001') as Record<string, any>;
  assert.deepEqual([bad.integrity.status, bad.companyName, bad.confirmedCid, bad.collectedAt], ['MISMATCH', null, null, null], 'nenhum conteúdo do relatório que não confere');
  assert.ok(items.some((i) => i.auditId === AUDIT && i.integrity.status === 'OK'));
  assert.ok(!items.some((i) => i.auditId === 'alias-da-auditoria-1'));
  assert.equal((await detailRoute(req('/api/link-audit/evidence/legado-teste-0001', ana), ctx('legado-teste-0001'))).status, 409);
  const versions = await versionsRoute(req('/api/link-audit/evidence/legado-teste-0001/versions', ana), ctx('legado-teste-0001'));
  assert.equal(versions.status, 409);
  assert.ok(!JSON.stringify(await versions.json()).includes('2026-10-22'));
  assert.equal((await detailRoute(req('/api/link-audit/evidence/alias-da-auditoria-1', ana), ctx('alias-da-auditoria-1'))).status, 404, 'symlink = não encontrada, nunca 500');
  assert.equal((await versionsRoute(req('/api/link-audit/evidence/alias-da-auditoria-1/versions', ana), ctx('alias-da-auditoria-1'))).status, 404);
  assert.equal((await detailRoute(req('/api/link-audit/evidence/arquivo-no-lugar-01', ana), ctx('arquivo-no-lugar-01'))).status, 404);
});
