import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanupOrphans, checkStorage, readCapture, readReport, verifyAudit, writeCapture, writeReport, clearStorageFatal } from '../src/lib/link-audit-evidence/store';
import { sha256Hex } from '../src/lib/link-audit/canonical';
import { AUDIT, bodyText, captureInput, errno, faulty, registerCleanup, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';
import { FAKE_KEY } from './helpers/link-audit-collect-fixtures';

registerCleanup();

test('pré-voo: base privada pronta, avisa da ACL e recusa pastas públicas/de código do projeto', async () => {
  const base = path.join(tmpDir(), 'evidencias');
  const ok = await checkStorage(base);
  assert.ok(ok.ok);
  assert.equal(ok.value.linkSupported, true);
  assert.match(ok.value.notes.join(' '), /ACL do Windows/);
  assert.match(ok.value.notes.join(' '), /não é backup independente/);
  assert.deepEqual(fs.readdirSync(base).filter((n) => n.startsWith('.probe')), [], 'a sonda é removida');

  const project = tmpDir('laproj-');
  for (const sub of ['public/x', 'src/dados', '.next/cache', 'node_modules/y']) {
    const refused = await checkStorage(path.join(project, sub), { projectRoot: project });
    assert.ok(!refused.ok && refused.code === 'STORAGE_NOT_READY' && /pública|código|public|src/i.test(refused.issues.join(' ')), sub);
    assert.ok(!fs.existsSync(path.join(project, sub)), 'nada é criado em área proibida');
  }
  assert.ok((await checkStorage(path.join(project, 'privado'), { projectRoot: project })).ok);
  assert.ok(!(await checkStorage('', {})).ok);
});

test('gravação → leitura: corpo exato, hash do conteúdo, metadados e versão da metodologia', async () => {
  const base = tmpDir();
  const text = bodyText();
  const written = await writeCapture(base, captureInput({ body: text }));
  assert.ok(written.ok);
  assert.equal(written.value.captureNumber, 1);
  assert.equal(written.value.duplicate, false);
  assert.ok(fs.existsSync(path.join(base, AUDIT, 'c0001.capture.json')));
  const read = await readCapture(base, AUDIT, 1);
  assert.ok(read.ok);
  assert.equal(read.value.response.bodyText, text, 'o corpo original é preservado byte a byte');
  assert.equal(read.value.response.bodySha256, sha256Hex(text));
  assert.equal(read.value.response.bytes, Buffer.byteLength(text, 'utf8'));
  assert.deepEqual([read.value.response.httpStatus, read.value.response.attempts, read.value.response.creditsReportedByApi], [200, 1, 3]);
  assert.equal(read.value.methodologyVersion, 'lumos-reconstruida-v1');
  assert.equal(read.value.provider, 'serper-maps');
  assert.equal(read.value.contentSha256, written.value.contentSha256);
  assert.ok(!JSON.stringify(read.value).toLowerCase().includes('x-api-key'), 'nenhum cabeçalho de autenticação');
});

test('captura, site e relatório: auditoria completa, revisões nunca sobrescrevem e o vínculo é verificado', async () => {
  const base = tmpDir();
  const full = await writeFull(base);
  assert.equal((await verifyAudit(base, AUDIT)).ok && (await verifyAudit(base, AUDIT) as { value: { state: string } }).value.state, 'COMPLETE');
  const before = fs.readFileSync(path.join(base, AUDIT, 'c0001.report-r0001.json'), 'utf8');
  const second = await writeReport(base, AUDIT, 1, { ...JSON.parse(JSON.stringify(full.report)) as Record<string, unknown>, revisao: 'segunda' }, '2026-10-22T14:00:00.000Z');
  assert.ok(second.ok);
  assert.equal(second.value.revision, 2);
  assert.equal(fs.readFileSync(path.join(base, AUDIT, 'c0001.report-r0001.json'), 'utf8'), before, 'r0001 intacto');
  const r1 = await readReport(base, AUDIT, 1, 1);
  const r2 = await readReport(base, AUDIT, 1, 2);
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.value.captureSha256, r2.value.captureSha256);
  assert.notEqual(r1.value.contentSha256, r2.value.contentSha256);
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.reports.length === 2 && v.value.issues.length === 0);
});

test('captura sem relatório é INCOMPLETE (não COMPLETE)', async () => {
  const base = tmpDir();
  assert.ok((await writeCapture(base, captureInput())).ok);
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.state === 'INCOMPLETE');
});

test('duplicata: o mesmo corpo não gera outra captura; corpo diferente gera a próxima', async () => {
  const base = tmpDir();
  const a = await writeCapture(base, captureInput());
  const b = await writeCapture(base, captureInput());
  assert.ok(a.ok && b.ok);
  assert.equal(b.value.duplicate, true);
  assert.equal(b.value.captureNumber, a.value.captureNumber);
  assert.equal(fs.readdirSync(path.join(base, AUDIT)).filter((n) => n.endsWith('.capture.json')).length, 1);
  const c = await writeCapture(base, captureInput({ body: bodyText({ title: 'Outro Nome' }) }));
  assert.ok(c.ok && c.value.captureNumber === 2 && !c.value.duplicate);
});

test('corrida: gravações simultâneas recebem números distintos e nada se perde', async () => {
  const base = tmpDir();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => writeCapture(base, captureInput({ body: bodyText({ title: `Empresa ${i}` }) }))));
  assert.ok(results.every((r) => r.ok));
  const numbers = results.map((r) => (r.ok ? r.value.captureNumber : 0)).sort((x, y) => x - y);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.captures.length === 8 && v.value.issues.length === 0);
});

test('identificadores de auditoria e caminhos perigosos são recusados', async () => {
  const base = tmpDir();
  for (const bad of ['../fuga-1234', 'a/b/cdefghij', 'Maiusculas-12345', 'curto', '', '..', 'x'.repeat(65), 'com espaço aqui', '-comeca-com-hifen']) {
    const r = await writeCapture(base, captureInput({ auditId: bad }));
    assert.ok(!r.ok && (r.code === 'INVALID_ID' || r.code === 'UNSAFE_PATH'), JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(base), [], 'nada foi criado');
  assert.ok(!(await writeCapture('\0', captureInput())).ok);
});

test('segredos: na parte PRÓPRIA (pedido, entrada, falha) são recusados; no corpo do provedor a resposta paga nunca é descartada', async () => {
  const base = tmpDir();
  const own: Array<[string, Parameters<typeof captureInput>[0], { apiKey?: string }]> = [
    ['token no pedido', { request: { url: 'https://google.serper.dev/maps', body: { q: 'x', nota: 'token=abcd1234efgh' } } }, {}],
    ['cookie na falha', { response: { httpStatus: null, attempts: 1, bodyText: null, failure: 'cookie: sid=1' } }, {}],
    ['chave na entrada', { input: { snapshotId: 'snap-exemplo-0001', originalLink: `https://x.example/?k=${FAKE_KEY}`, identity: {} } }, { apiKey: FAKE_KEY }],
  ];
  for (const [label, over, options] of own) {
    const r = await writeCapture(base, captureInput(over), options);
    assert.ok(!r.ok && r.code === 'SECRET_DETECTED', label);
  }
  assert.ok(!fs.existsSync(path.join(base, AUDIT)) || fs.readdirSync(path.join(base, AUDIT)).length === 0);

  // corpo com a chave literal ecoada: a resposta É gravada, com a chave trocada e sinalizada
  const echoed = await writeCapture(base, captureInput({ body: bodyText({ obs: `eco ${FAKE_KEY} fim` }) }), { apiKey: FAKE_KEY });
  assert.ok(echoed.ok);
  const stored = await readCapture(base, AUDIT, echoed.value.captureNumber);
  assert.ok(stored.ok);
  assert.deepEqual(stored.value.response.flags, ['KEY_REDACTED']);
  assert.ok(!fs.readFileSync(path.join(base, AUDIT, 'c0001.capture.json'), 'utf8').includes(FAKE_KEY), 'a chave nunca chega ao disco');
  assert.ok(stored.value.response.bodyText?.includes('eco [REDACTED] fim'));
  // padrão de autenticação em texto legítimo ("Cookie: …"): gravado e SINALIZADO, não descartado
  const legit = await writeCapture(base, captureInput({ body: bodyText({ description: 'Cookie: bolos e doces' }) }));
  assert.ok(legit.ok);
  const flagged = await readCapture(base, AUDIT, legit.value.captureNumber);
  assert.ok(flagged.ok && flagged.value.response.flags?.includes('AUTH_PATTERN_IN_BODY'));
  // texto legítimo no corpo do provedor (a evidência original) NÃO é barrado: só chave e cabeçalhos de autenticação
  assert.ok((await writeCapture(base, captureInput({ body: bodyText({ title: 'Token: Bar e Café' }) }))).ok);
});

test('resposta sem corpo (erro HTTP ou falha de rede) também é registrada: toda tentativa paga deixa rastro', async () => {
  const base = tmpDir();
  const http = await writeCapture(base, captureInput({ response: { httpStatus: 500, attempts: 1, bodyText: null, failure: null } }));
  assert.ok(http.ok);
  const net = await writeCapture(base, captureInput({ response: { httpStatus: null, attempts: 1, bodyText: null, failure: 'ECONNRESET' } }));
  assert.ok(net.ok);
  const c1 = await readCapture(base, AUDIT, 1);
  assert.ok(c1.ok && c1.value.response.bodyText === null && c1.value.response.httpStatus === 500);
  const c2 = await readCapture(base, AUDIT, 2);
  assert.ok(c2.ok && c2.value.response.failure === 'ECONNRESET');
});

test('adulteração é detectada: corpo, hash, lacuna na numeração e vínculo relatório↔captura', async () => {
  const base = tmpDir();
  await writeFull(base);
  const file = path.join(base, AUDIT, 'c0001.capture.json');
  fs.chmodSync(file, 0o644);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(SENTINEL, 'ADULTERADO-0000'));
  const bad = await readCapture(base, AUDIT, 1);
  assert.ok(!bad.ok && (bad.code === 'HASH_MISMATCH'));
  const v = await verifyAudit(base, AUDIT);
  assert.ok(v.ok && v.value.state === 'CORRUPT' && v.value.issues.length > 0);

  fs.writeFileSync(file, original);
  assert.ok((await verifyAudit(base, AUDIT) as { value: { state: string } }).value.state === 'COMPLETE');
  // corpo trocado mantendo o hash do arquivo coerente é pego pelo hash do corpo
  const parsed = JSON.parse(original) as { response: { bodyText: string }; contentSha256: string };
  parsed.response.bodyText = '{"places":[]}';
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.ok(!(await readCapture(base, AUDIT, 1)).ok);
  fs.writeFileSync(file, original);

  const second = await writeCapture(base, captureInput({ body: bodyText({ title: 'B' }) }));
  assert.ok(second.ok);
  fs.rmSync(file);
  const gap = await verifyAudit(base, AUDIT);
  assert.ok(gap.ok && gap.value.state === 'CORRUPT' && gap.value.issues.some((i) => /Lacuna/.test(i)));
});

test('temporários órfãos: só o padrão .tmp-… e só com idade mínima são removidos; nunca capturas ou relatórios', async () => {
  const base = tmpDir();
  await writeFull(base);
  const dir = path.join(base, AUDIT);
  const old = path.join(dir, '.tmp-c0002-aaaaaaaaaaaaaaaa.json');
  const young = path.join(dir, '.tmp-c0003-bbbbbbbbbbbbbbbb.json');
  fs.writeFileSync(old, '{"parcial":');
  fs.writeFileSync(young, '{"parcial":');
  fs.utimesSync(old, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const v0 = await verifyAudit(base, AUDIT);
  assert.ok(v0.ok && v0.value.orphanTempFiles.length === 2 && v0.value.state === 'COMPLETE', 'órfão não vira captura nem corrompe');
  const removed = await cleanupOrphans(base, AUDIT, { now: new Date(), olderThanMs: 60_000 });
  assert.ok(removed.ok);
  assert.deepEqual(removed.value, ['.tmp-c0002-aaaaaaaaaaaaaaaa.json']);
  assert.ok(fs.existsSync(young) && fs.existsSync(path.join(dir, 'c0001.capture.json')) && fs.existsSync(path.join(dir, 'c0001.report-r0001.json')));
  clearStorageFatal();
});

test('revisão 5A: pastas proibidas valem sem diferenciar caixa; pasta de auditoria legada não é misturada', async () => {
  const project = tmpDir('laproj-');
  const refused = await checkStorage(path.join(project, 'Public', 'x'), { projectRoot: project });
  assert.ok(!refused.ok && refused.code === 'STORAGE_NOT_READY', 'Public ≡ public (drvfs/Windows)');
  const base = tmpDir();
  fs.mkdirSync(path.join(base, 'tuvaplast-legado-0001'));
  fs.writeFileSync(path.join(base, 'tuvaplast-legado-0001', 'MANIFEST.json'), '{}');
  const mixed = await checkStorage(base, { auditId: 'tuvaplast-legado-0001' });
  assert.ok(!mixed.ok && mixed.code === 'STORAGE_NOT_READY' && /legado/.test(mixed.issues.join(' ')));
  assert.ok((await checkStorage(base, { auditId: 'auditoria-nova-0001' })).ok);
});

test('revisão 5A: limpeza respeita idade mínima de 60 s mesmo com olderThanMs=0, e o bloqueio fatal vale por apelido (symlink) da mesma pasta', async () => {
  const base = tmpDir();
  await writeFull(base);
  const dir = path.join(base, AUDIT);
  const young = path.join(dir, '.tmp-c0009-cccccccccccccccc.json');
  fs.writeFileSync(young, '{');
  const removed = await cleanupOrphans(base, AUDIT, { now: new Date(), olderThanMs: 0 });
  assert.ok(removed.ok && removed.value.length === 0 && fs.existsSync(young), 'uma gravação em curso não perde o temporário');

  const real = tmpDir();
  const alias = path.join(tmpDir('laalias-'), 'link');
  fs.symlinkSync(real, alias);
  const eio = faulty({ writeExclusive: async () => { throw errno('EIO', 'falha'); } });
  assert.ok(!(await writeCapture(alias, captureInput(), { fs: eio })).ok);
  const viaReal = await writeCapture(real, captureInput());
  assert.ok(!viaReal.ok && viaReal.code === 'STORAGE_FATAL', 'o outro nome da mesma pasta também está bloqueado');
  clearStorageFatal(alias);
  assert.ok((await writeCapture(real, captureInput())).ok, 'desbloqueio pelo mesmo nome');
});

test('revisão 5A: mensagens de erro nunca revelam caminhos do disco', async () => {
  const base = tmpDir();
  await writeFull(base);
  const leaky = faulty({ readFile: async () => { throw errno('EACCES', "EACCES: permission denied, open '/mnt/d/privado/segredo/c0001.capture.json'"); } });
  const v = await verifyAudit(base, AUDIT, { fs: leaky });
  assert.ok(v.ok);
  const text = JSON.stringify(v.value.issues);
  assert.ok(!text.includes('/mnt/') && !text.includes('privado'), text);
  const w = await writeCapture(base, captureInput({ body: bodyText({ title: 'Outro' }) }), { fs: faulty({ link: async () => { throw errno('EACCES', "negado em '/mnt/d/x/y'"); } }) });
  assert.ok(!w.ok && !JSON.stringify(w.issues).includes('/mnt/'));
});
