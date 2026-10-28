import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CAPTURE_FILES, generateReport, persistCapture, runEvidenceCli, verifyCapture } from '../scripts/link-audit-evidence';
import { buildReportFromCapture } from '../src/lib/link-audit/collector/capture-report';
import { LEGACY_RESTRICTED_MESSAGE } from '../src/lib/link-audit/collector/site-access';
import { clock, FAKE_KEY, identityFor, inputFor } from './helpers/link-audit-collect-fixtures';

/* Captura 100% FICTÍCIA no formato do Serper /maps (par fid/cid coerente; cid > 2^53). */
const FID_FULL = '0x94aa11bb22cc33dd:0x1234567890abcdef';
const CID = '1311768467294899695';
const LINK = 'https://www.google.com/maps/place/Padaria+Exemplo/data=!4m2!3m1!1s0x0:0x1234567890abcdef?sa=X&ved=1t:2428&hl=pt-BR';
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const BODY = JSON.stringify({
  searchParameters: { q: 'Padaria Exemplo Cidade Exemplo GO', gl: 'br', hl: 'pt-br', type: 'maps', num: 10, page: 1, engine: 'google' },
  ll: '@-16.1,-49.2,17z',
  places: [{ position: 1, title: 'Padaria Exemplo', address: 'Rua Fictícia, 1 - Cidade Exemplo - GO', latitude: -16.1, longitude: -49.2, rating: 4.9, ratingCount: 12, type: 'Padaria', types: ['Padaria', 'Confeitaria'], website: 'https://www.padaria-exemplo.example/', phoneNumber: '+55 62 99999-0000', openingHours: { segunda: '08:00–18:00' }, thumbnailUrl: 'https://lh3.example/foto?token=SEGREDO', cid: CID, fid: FID_FULL, placeId: PLACE_ID }],
  credits: 3,
});
const STDOUT = [
  'PLANO (DRY_RUN) — nenhuma chamada foi feita',
  `{ "identity": { "snapshotId": "audit-20261022000000", "confirmedAt": "2026-10-22T12:54:45.249Z" },`,
  `  "found": { "googleMaps": { "queriedAt": "2026-10-22T12:54:48.079Z" }, "site": { "requestedUrl": "https://www.padaria-exemplo.example/", "checkedAt": "2026-10-22T12:54:48.084Z" } },`,
  `  "limitation": "Verificação técnica do site não concluída (BLOCKED): Consulta bloqueada por segurança: ${LEGACY_RESTRICTED_MESSAGE}." }`,
].join('\n');

function makeCapture(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacap-'));
  const files: Record<string, string> = {
    'serper-body.json': BODY, 'serper-status.json': '{"attempts":1,"status":200,"ok":true}', 'serper-attempts.json': '{"attempts":1,"at":"2026-10-22T12:54:45.404Z"}',
    'summary.json': '{"exitCode":0,"serperAttempts":1,"siteHttpRequests":1}', 'run-stdout.txt': STDOUT, 'run-stderr.txt': '', ...extra,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const cleanup = (...dirs: string[]): void => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

test('persist: copia só os 6 arquivos, confere SHA-256 por releitura, grava manifesto e NÃO toca na origem', () => {
  const from = makeCapture();
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laparent-')), 'dest', 'cap1');
  const before = Object.fromEntries(CAPTURE_FILES.map((n) => [n, sha(path.join(from, n))]));
  try {
    const result = persistCapture({ from, to, now: clock, meta: { authorizationId: 'aud-teste-0001' } });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(fs.readdirSync(to).sort(), ['MANIFEST.json', 'SHA256SUMS', ...CAPTURE_FILES].sort());
    for (const n of CAPTURE_FILES) assert.equal(sha(path.join(to, n)), before[n], n);
    for (const n of CAPTURE_FILES) assert.equal(sha(path.join(from, n)), before[n], 'origem intacta');
    const manifest = JSON.parse(fs.readFileSync(path.join(to, 'MANIFEST.json'), 'utf8')) as { storageWarning: string; authorizationId: string; files: Array<{ name: string; sha256: string }> };
    assert.match(manifest.storageWarning, /NÃO é um backup independente/);
    assert.equal(manifest.authorizationId, 'aud-teste-0001');
    assert.equal(manifest.files.find((f) => f.name === 'serper-body.json')?.sha256, before['serper-body.json']);
    assert.ok(verifyCapture(to).ok);
  } finally { cleanup(from, path.dirname(path.dirname(to))); }
});

test('persist: nunca sobrescreve (destino existente), recusa arquivo ausente e não repete a API', () => {
  const from = makeCapture();
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'laexist-'));
  fs.writeFileSync(path.join(existing, 'marca.txt'), 'não apagar');
  try {
    const exists = persistCapture({ from, to: existing, now: clock });
    assert.ok(!exists.ok && /já existe/.test(exists.reason));
    assert.equal(fs.readFileSync(path.join(existing, 'marca.txt'), 'utf8'), 'não apagar');
    fs.rmSync(path.join(from, 'summary.json'));
    const missing = persistCapture({ from, to: path.join(existing, 'novo'), now: clock });
    assert.ok(!missing.ok && /ausente/.test(missing.reason) && /NÃO deve ser repetida/.test(missing.reason));
    assert.ok(!fs.existsSync(path.join(existing, 'novo')), 'nada foi criado');
  } finally { cleanup(from, existing); }
});

test('persist: recusa copiar chave de API, cabeçalho de autenticação ou cookie (nada é criado)', () => {
  for (const [file, text] of [['run-stdout.txt', 'X-API-KEY: abc'], ['run-stdout.txt', 'Authorization: Bearer abcdefghijkl'], ['serper-status.json', '{"cookie": "a=b"}'], ['run-stderr.txt', `falhou com ${FAKE_KEY}`]] as const) {
    const from = makeCapture({ [file]: text });
    const to = path.join(os.tmpdir(), `lasec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const result = persistCapture({ from, to, env: { SERPER_API_KEY: FAKE_KEY }, now: clock });
      assert.ok(!result.ok && /chave ou cabeçalho/.test(result.reason), text);
      assert.ok(!fs.existsSync(to));
    } finally { cleanup(from, to); }
  }
});

test('persist: corpo que não é JSON é recusado; verify detecta qualquer alteração depois', () => {
  const bad = makeCapture({ 'serper-body.json': 'não é json' });
  const to0 = path.join(os.tmpdir(), `lajson-${Date.now()}`);
  try {
    assert.ok(!persistCapture({ from: bad, to: to0, now: clock }).ok);
  } finally { cleanup(bad, to0); }

  const from = makeCapture();
  const to = path.join(os.tmpdir(), `laverify-${Date.now()}`);
  try {
    assert.ok(persistCapture({ from, to, now: clock }).ok);
    fs.appendFileSync(path.join(to, 'serper-body.json'), ' ');
    const tampered = verifyCapture(to);
    assert.ok(!tampered.ok && /SHA-256 divergente/.test(tampered.reason));
    assert.ok(!verifyCapture(path.join(to, 'nao-existe')).ok);
  } finally { cleanup(from, to); }
});

test('report: relatório offline a partir da captura — identidade, identificadores, fonte, hashes, sem pontuação e sem chave', async () => {
  const from = makeCapture();
  const to = path.join(os.tmpdir(), `larep-${Date.now()}`);
  try {
    assert.ok(persistCapture({ from, to, now: clock }).ok);
    const result = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', city: 'Cidade Exemplo', uf: 'go', now: clock });
    assert.ok(result.ok, JSON.stringify(result));
    const text = fs.readFileSync(path.join(to, 'report.json'), 'utf8');
    const report = JSON.parse(text) as Record<string, any>;
    assert.equal(report.kind, 'COLLECTION_REPORT_FROM_CAPTURE');
    assert.equal(report.externalCallsMadeByThisReport, 0);
    assert.equal(report.scoring, 'NOT_AVAILABLE_PENDING_D3');
    assert.equal(report.located, 'MATCHED');
    assert.equal(report.source.officialGoogleApi, false);
    assert.match(report.source.description, /NÃO vêm da API oficial do Google Business Profile/);
    assert.deepEqual([report.source.httpStatus, report.source.httpAttempts, report.source.creditsReportedByApi, report.source.resultCount], [200, 1, 3, 1]);
    assert.equal(report.source.collectedAt, '2026-10-22T12:54:48.079Z');
    assert.equal(report.source.capture.sha256, sha(path.join(to, 'serper-body.json')), 'hash do arquivo de origem');
    assert.deepEqual(report.identifiers.fromLink, { featureId: '0x0:0x1234567890abcdef' });
    assert.equal(report.identifiers.derived.cid.value, CID);
    assert.deepEqual(report.identifiers.returnedByProvider, { cid: CID, featureId: FID_FULL, placeId: PLACE_ID });
    assert.deepEqual(report.identifiers.confirmed.map((c: { type: string }) => c.type), ['cid']);
    assert.equal(report.providerResult.thumbnailPresent, true);
    assert.ok(!text.includes('lh3.example') && !text.includes('SEGREDO'), 'o endereço da miniatura não é copiado');
    assert.equal(report.data.googleMaps.name, 'Padaria Exemplo');
    assert.equal(report.data.site.accessClass, 'RESTRICTED_RESPONSE_UNSPECIFIED');
    assert.equal(report.data.site.observedInOriginalRun, true);
    assert.equal(report.calls.siteHttpRequests, 1);
    assert.ok(report.verified.length >= 8 && report.unverified.length > 0);
    assert.match(report.limitations.join(' '), /código HTTP exato .* não foi gravado/);
    assert.ok(!/"(?:score|points|pontos|index|classification|confidence)"\s*:/i.test(text));
    assert.ok(!text.includes(FAKE_KEY));
    // hash do relatório e proibição de sobrescrever
    assert.equal(fs.readFileSync(path.join(to, 'report.json.sha256'), 'utf8').split(' ')[0], sha(path.join(to, 'report.json')));
    const again = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', now: clock }).catch((e: Error) => e);
    assert.ok(again instanceof Error || (typeof again === 'object' && 'ok' in again && !again.ok), 'segunda geração não sobrescreve');
    assert.equal(sha(path.join(to, 'report.json')), result.sha256);
  } finally { cleanup(from, to); }
});

test('buildReportFromCapture: corpo inválido, sem "places" ou HTTP não-2xx são recusados; identidade de outra empresa não é aceita', async () => {
  const input = inputFor(identityFor(LINK, { name: 'Padaria Exemplo' }));
  const params = { body: { name: 'serper-body.json', sha256: 'a'.repeat(64), bytes: 1 }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt: '2026-10-22T12:54:48.079Z', input, site: null, generatedAt: '2026-10-22T13:00:00.000Z' };
  assert.ok(!(await buildReportFromCapture({ ...params, rawBody: 'x' })).ok);
  assert.ok(!(await buildReportFromCapture({ ...params, rawBody: '{"a":1}' })).ok);
  assert.ok(!(await buildReportFromCapture({ ...params, rawBody: BODY, httpStatus: 500 })).ok);
  const other = JSON.parse(BODY) as { places: Array<Record<string, unknown>> };
  other.places[0] = { ...other.places[0], cid: '5555555555555555555', fid: '0x1:0x4d2a1b2c3d4e5f3' };
  const result = await buildReportFromCapture({ ...params, rawBody: JSON.stringify(other) });
  assert.ok(result.ok);
  assert.equal(result.report.located, 'NOT_LOCATED');
  assert.equal(result.report.providerResult, null);
  assert.deepEqual(result.report.identifiers.confirmed, []);
});

test('comando de evidências: usos incorretos e persist/verify/report ponta a ponta, sem rede', async () => {
  const lines: string[] = [];
  const errs: string[] = [];
  assert.equal(await runEvidenceCli([], (l) => lines.push(l), (l) => errs.push(l), clock), 1);
  assert.equal(await runEvidenceCli(['persist', '--from'], (l) => lines.push(l), (l) => errs.push(l), clock), 1);
  const from = makeCapture();
  const to = path.join(os.tmpdir(), `lacli-${Date.now()}`);
  try {
    assert.equal(await runEvidenceCli(['persist', '--from', from, '--to', to], (l) => lines.push(l), (l) => errs.push(l), clock), 0);
    assert.equal(await runEvidenceCli(['persist', '--from', from, '--to', to], (l) => lines.push(l), (l) => errs.push(l), clock), 3, 'segunda vez recusa');
    assert.equal(await runEvidenceCli(['verify', '--dir', to], (l) => lines.push(l), (l) => errs.push(l), clock), 0);
    assert.equal(await runEvidenceCli(['report', '--dir', to, '--link', LINK, '--operator', 'ana@empresa.com', '--name', 'Padaria Exemplo'], (l) => lines.push(l), (l) => errs.push(l), clock), 0);
    assert.match(lines.join('\n'), /Nenhuma chamada externa foi feita/);
  } finally { cleanup(from, to); }
});

test('revisão 4D: verified[] carrega a ressalva e a origem Serper; datas inválidas e site não reproduzível são tratados com honestidade', async () => {
  const from = makeCapture();
  const noSite = makeCapture({ 'run-stdout.txt': STDOUT.replace(/"site":[\s\S]*$/, '"site": null }') });
  const to = path.join(os.tmpdir(), `larev-${Date.now()}`);
  const to2 = path.join(os.tmpdir(), `larev2-${Date.now()}`);
  try {
    assert.ok(persistCapture({ from, to, now: clock }).ok);
    const ok = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock });
    assert.ok(ok.ok);
    const report = JSON.parse(fs.readFileSync(path.join(to, 'report.json'), 'utf8')) as { verified: Array<{ id: string; limitation: string | null; viaSerper: boolean; originNote: string | null }> };
    assert.ok(report.verified.length >= 8);
    assert.ok(report.verified.every((v) => v.viaSerper && /Serper \/maps/.test(v.originNote ?? '') && typeof v.limitation === 'string'));

    // sem bloco "site" na captura: a ausência é da CAPTURA, não de um provedor
    assert.ok(persistCapture({ from: noSite, to: to2, now: clock }).ok);
    const none = await generateReport({ dir: to2, link: LINK, operator: 'ana@empresa.com', now: clock });
    assert.ok(none.ok);
    const r2 = JSON.parse(fs.readFileSync(path.join(to2, 'report.json'), 'utf8')) as { limitations: string[]; data: { site: unknown } };
    assert.equal(r2.data.site, null);
    assert.ok(r2.limitations.some((l) => /coleta original não registrou o resultado da verificação do site/.test(l)));
    assert.ok(!r2.limitations.some((l) => /nenhum provedor configurado|orçamento igual a zero/.test(l)));

    const input = inputFor(identityFor(LINK, { name: 'Padaria Exemplo' }));
    const bad = await buildReportFromCapture({ rawBody: BODY, body: { name: 'serper-body.json', sha256: 'a'.repeat(64), bytes: 1 }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt: 'ontem', input, site: null, generatedAt: '2026-10-22T13:00:00.000Z' });
    assert.ok(!bad.ok && /Data inválida/.test(bad.reason));
  } finally { cleanup(from, noSite, to, to2); }
});

test('revisão 4D: persist é atômico (nome final só depois de verificado), varre tokens e o verify cobre relatório e nomes', async () => {
  const from = makeCapture();
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laat-')), 'cap');
  try {
    assert.ok(persistCapture({ from, to, now: clock }).ok);
    assert.ok(!fs.existsSync(`${to}.incomplete`));
    // token em texto livre também é recusado (padrão da base do projeto)
    const tok = makeCapture({ 'run-stderr.txt': 'falhou com token=abcd1234efgh' });
    const to2 = path.join(os.tmpdir(), `latok-${Date.now()}`);
    try {
      const r = persistCapture({ from: tok, to: to2, now: clock });
      assert.ok(!r.ok && /chave ou cabeçalho/.test(r.reason));
      assert.ok(!fs.existsSync(to2) && !fs.existsSync(`${to2}.incomplete`));
    } finally { cleanup(tok, to2); }
    // relatório + hash; adulterar o relatório é detectado; segunda geração é recusada com mensagem clara
    const rep = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock });
    assert.ok(rep.ok);
    assert.ok(verifyCapture(to).ok);
    const second = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', now: clock });
    assert.ok(!second.ok && /já existe/.test(second.reason));
    fs.appendFileSync(path.join(to, 'report.json'), ' ');
    const tampered = verifyCapture(to);
    assert.ok(!tampered.ok && /report\.json não confere/.test(tampered.reason));
    // nome fora da lista fechada em SHA256SUMS
    fs.writeFileSync(path.join(to, 'SHA256SUMS'), `${'a'.repeat(64)}  ..\n`);
    const bad = verifyCapture(to);
    assert.ok(!bad.ok);
  } finally { cleanup(from, path.dirname(to)); }
});

test('revisão 4D: arquivos auxiliares corrompidos viram recusa clara, não exceção', async () => {
  for (const [file, content] of [['serper-status.json', 'null'], ['summary.json', '{não json']] as const) {
    const from = makeCapture({ [file]: content });
    const to = path.join(os.tmpdir(), `lacorr-${Date.now()}-${file}`);
    try {
      assert.ok(persistCapture({ from, to, now: clock }).ok);
      const r = await generateReport({ dir: to, link: LINK, operator: 'ana@empresa.com', now: clock });
      assert.ok(!r.ok, file);
    } finally { cleanup(from, to); }
  }
});
