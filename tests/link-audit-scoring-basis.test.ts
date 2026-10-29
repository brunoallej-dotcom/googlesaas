import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateReport, persistCapture } from '../scripts/link-audit-evidence';
import { EvidenceAccessError, type EvidenceActor } from '../src/lib/link-audit-evidence/reader';
import { createScoringBasisReader, INFORMATIONAL_REVIEWS_REASON, SCORING_BASIS_VERSION, type ScoringBasis, type ScoringBasisOutcome } from '../src/lib/link-audit-evidence/scoring-basis';
import { writeCapture, writeReport } from '../src/lib/link-audit-evidence/store';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { CID_OTHER, clock, FID_OTHER, LINK, PLACE, PLACE_ID, T_NOW } from './helpers/link-audit-collect-fixtures';
import { AUDIT, bodyText, captureInput, CID, COLLECTED_AT, errno, faulty, FID, registerCleanup, REQUEST_URL, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';

/* Dados 100% FICTÍCIOS. A pasta real da TUVAPLAST nunca é lida: o layout legado é uma RÉPLICA gerada aqui. */
registerCleanup();

const OPERATOR: EvidenceActor = { email: 'ana@empresa.com' };
const allow = (actor: EvidenceActor): boolean => actor.email === 'ana@empresa.com';
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const readerFor = (baseDir: string, fs?: FsOps) => createScoringBasisReader({ baseDir, authorize: allow, ...(fs ? { fs } : {}) });

const ready = (outcome: ScoringBasisOutcome): ScoringBasis => {
  assert.equal(outcome.status, 'READY', JSON.stringify(outcome).slice(0, 300));
  return (outcome as { basis: ScoringBasis }).basis;
};
const available = (basis: ScoringBasis) => {
  assert.equal(basis.profile.state, 'AVAILABLE', JSON.stringify(basis.profile));
  return basis.profile as Extract<ScoringBasis['profile'], { state: 'AVAILABLE' }>;
};

/** Grava uma captura (+ relatório mínimo) com controle total sobre corpo, identidade, status e relatório. */
async function seed(base: string, opts: { body?: string | null; auditId?: string; status?: number; collectedAt?: string; mutateIdentity?: (identity: Record<string, unknown>) => void; report?: Record<string, unknown> | null } = {}) {
  const auditId = opts.auditId ?? AUDIT;
  const input = captureInput({ auditId, ...(opts.body !== undefined ? { body: opts.body } : {}), ...(opts.collectedAt ? { collectedAt: opts.collectedAt } : {}) });
  if (opts.mutateIdentity) opts.mutateIdentity((input.input as { identity: Record<string, unknown> }).identity);
  if (opts.status !== undefined) (input as { response: unknown }).response = { httpStatus: opts.status, attempts: 1, bodyText: opts.body === undefined ? bodyText() : opts.body, failure: opts.status >= 400 ? 'falha de teste' : null };
  const cap = await writeCapture(base, input);
  assert.ok(cap.ok, JSON.stringify(cap));
  if (opts.report !== null) {
    const rep = await writeReport(base, auditId, cap.value.captureNumber, opts.report ?? { kind: 'TESTE', evidences: [] }, T_NOW);
    assert.ok(rep.ok, JSON.stringify(rep));
  }
  return cap.value;
}

const tamper = (file: string, change: (text: string) => string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
};
const treeState = (dir: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, `${sha(fs.readFileSync(path.join(dir, name), 'utf8'))}:${fs.statSync(path.join(dir, name)).mtimeMs}:${(fs.statSync(path.join(dir, name)).mode & 0o777).toString(8)}`]));

/** Todas as chaves (profundidade total) de um valor JSON. */
const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (found.add(k), keysOf(v, found));
  return found;
};

// ------------------------------------------------------------------------------------------------ autorização e ids
test('sem autorização nada é lido: ator inválido, e-mail vazio, autorizador que falha ou que nega ⇒ EvidenceAccessError (falha fechada)', async () => {
  const base = tmpDir();
  await writeFull(base);
  const reader = readerFor(base);
  for (const actor of [{ email: 'intruso@x.com' }, { email: '' }, undefined as unknown as EvidenceActor, { email: 123 } as unknown as EvidenceActor]) {
    await assert.rejects(() => reader.readScoringBasis(actor, AUDIT), EvidenceAccessError);
  }
  await assert.rejects(() => createScoringBasisReader({ baseDir: base, authorize: () => { throw new Error('banco fora do ar'); } }).readScoringBasis(OPERATOR, AUDIT), EvidenceAccessError);
  await assert.rejects(() => createScoringBasisReader({ baseDir: base, authorize: async () => false }).readScoringBasis(OPERATOR, AUDIT), EvidenceAccessError);
});

test('identificador inválido ou com travessia de caminho lança erro (como o leitor 5B) e nunca lê fora da base', async () => {
  const base = tmpDir();
  await writeFull(base);
  for (const bad of ['../fora', 'a/b', 'curto', 'A'.repeat(10), '', 'x'.repeat(65)]) await assert.rejects(() => readerFor(base).readScoringBasis(OPERATOR, bad), /inválido/i, bad);
});

test('auditoria inexistente, symlink ou arquivo no lugar da pasta: NOT_FOUND (nunca exceção que derrube a rota)', async () => {
  const base = tmpDir();
  await writeFull(base);
  assert.deepEqual(await readerFor(base).readScoringBasis(OPERATOR, 'auditoria-inexistente-01'), { status: 'NOT_FOUND' });
  fs.symlinkSync(path.join(base, AUDIT), path.join(base, 'alias-da-auditoria-1'));
  assert.deepEqual(await readerFor(base).readScoringBasis(OPERATOR, 'alias-da-auditoria-1'), { status: 'NOT_FOUND' });
  fs.writeFileSync(path.join(base, 'arquivo-no-lugar-1'), 'x');
  assert.deepEqual(await readerFor(base).readScoringBasis(OPERATOR, 'arquivo-no-lugar-1'), { status: 'NOT_FOUND' });
  assert.deepEqual(await readerFor(path.join(base, 'nao-existe')).readScoringBasis(OPERATOR, AUDIT), { status: 'NOT_FOUND' });
});

// ------------------------------------------------------------------------------------------------ proveniência e hashes
test('PROVENIÊNCIA: capturas e relatórios saem com referência da 6B, data da coleta, hash selado e hash do corpo', async () => {
  const base = tmpDir();
  const written = await writeFull(base);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  assert.equal(basis.version, SCORING_BASIS_VERSION);
  assert.deepEqual([basis.auditId, basis.layout], [AUDIT, 'VERSIONED']);
  assert.equal(basis.evidences.length, 2);
  const [capture, report] = basis.evidences;
  assert.deepEqual(capture, {
    ref: 'capture:c0001', kind: 'CAPTURE', capture: 1, revision: null, observedAt: COLLECTED_AT, generatedAt: null,
    contentSha256: written.cap.contentSha256, bodySha256: sha(bodyText()), superseded: false, legacy: false, origin: 'GOOGLE_NATIVE', provider: 'serper-maps', intermediary: true,
  });
  assert.deepEqual(report, {
    ref: 'report:c0001-r0001', kind: 'REPORT', capture: 1, revision: 1, observedAt: COLLECTED_AT, generatedAt: T_NOW,
    contentSha256: written.rep.contentSha256, bodySha256: null, superseded: false, legacy: false, origin: 'GOOGLE_NATIVE', provider: 'serper-maps', intermediary: true,
  });
  // o hash exposto é o do ARQUIVO em disco (selo): recalculado independentemente
  const onDisk = JSON.parse(fs.readFileSync(path.join(base, AUDIT, 'c0001.capture.json'), 'utf8')) as { contentSha256: string; response: { bodySha256: string } };
  assert.deepEqual([onDisk.contentSha256, onDisk.response.bodySha256], [capture?.contentSha256, capture?.bodySha256]);
  for (const e of basis.evidences) assert.match(e.contentSha256, /^[0-9a-f]{64}$/);
});

test('o `observedAt` do relatório é a data da COLETA da captura, nunca a de geração; revisões antigas são marcadas como superadas', async () => {
  const base = tmpDir();
  await writeFull(base);
  const second = await writeReport(base, AUDIT, 1, { kind: 'TESTE', evidences: [{ id: 'maps-website', status: 'NOT_VERIFIED' }] }, '2026-11-02T10:00:00.000Z');
  assert.ok(second.ok);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  const reports = basis.evidences.filter((e) => e.kind === 'REPORT');
  assert.deepEqual(reports.map((r) => [r.ref, r.superseded, r.observedAt, r.generatedAt]), [
    ['report:c0001-r0001', true, COLLECTED_AT, T_NOW],
    ['report:c0001-r0002', false, COLLECTED_AT, '2026-11-02T10:00:00.000Z'],
  ]);
  // o status das evidências vem do relatório MAIS RECENTE da captura do perfil
  assert.deepEqual(available(basis).reportEvidence, { 'maps-website': 'NOT_VERIFIED' });
});

// ------------------------------------------------------------------------------------------------ perfil
test('PERFIL: campos lidos do perfil casado por identificador; ausente = null; nenhuma completude inferida', async () => {
  const base = tmpDir();
  await writeFull(base);
  const profile = available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  assert.equal(profile.name, PLACE.title);
  assert.equal(profile.phone, PLACE.phoneNumber);
  assert.equal(profile.primaryCategory, 'Padaria');
  assert.deepEqual(profile.additionalCategories, ['Confeitaria']);
  assert.deepEqual(profile.address, { raw: PLACE.address });
  assert.equal(profile.hoursRaw, 'segunda: 08:00–18:00');
  assert.deepEqual(profile.source, { ref: 'capture:c0001', observedAt: COLLECTED_AT, contentSha256: profile.source.contentSha256, bodySha256: sha(bodyText()) });
  assert.deepEqual(profile.identity, { state: 'PROVEN', matchedBy: { cid: true, placeId: false }, expectedCidOrigin: 'LINK' }, 'o link confirmado tem CID/FID, não placeId');
  // as evidências maps-* do relatório do pipeline real (status por campo)
  assert.ok(Object.values(profile.reportEvidence).length >= 5);
  for (const status of Object.values(profile.reportEvidence)) assert.ok(['VERIFIED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_FOUND'].includes(status));
  assert.ok(!('maps-rating' in profile.reportEvidence) && !('maps-review-count' in profile.reportEvidence), 'status de nota/contagem não vai para o perfil elegível');
});

test('AUSENTES e INCOMPLETOS: sem telefone, site, horários, categorias ou endereço ⇒ null/lista vazia; nada é fabricado (sem `complete`, sem zero, sem ausência comprovada)', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ phoneNumber: undefined, website: undefined, openingHours: undefined, types: undefined, type: undefined, address: undefined, rating: undefined, ratingCount: undefined }) });
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  const profile = available(basis);
  assert.deepEqual([profile.phone, profile.website, profile.hoursRaw, profile.primaryCategory, profile.address, profile.additionalCategories], [null, null, null, null, null, null], 'nenhuma lista vazia fabricada');
  assert.deepEqual(basis.informational.reviews && [basis.informational.reviews.rating, basis.informational.reviews.ratingCount], [null, null]);
  const text = JSON.stringify(basis);
  assert.ok(!/complete|ABSENCE|NO_REVIEWS|NOT_APPLICABLE|"zero"/i.test(text), 'o leitor não decide completude nem ausência');
  assert.equal(profile.reportEvidence['maps-website'], undefined, 'relatório mínimo não traz evidências: nada é presumido');
});

test('CAMPOS de texto de fonte externa chegam limpos (sem controle/bidi) e limitados', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ title: `Padaria‮\u0000 Exemplo\n\t  Ltda ${'x'.repeat(400)}` }) });
  const profile = available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  assert.ok(profile.name && !/[\u0000-\u001F‮]/.test(profile.name) && profile.name.length <= 200);
  assert.ok(profile.name.startsWith('Padaria Exemplo Ltda'));
});

// ------------------------------------------------------------------------------------------------ website
test('WEBSITE: o bruto nunca sai; saem a URL derivada, o hash do bruto e a referência íntegra à evidência de origem', async () => {
  const base = tmpDir();
  await writeFull(base);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  const website = available(basis).website;
  assert.ok(website);
  assert.deepEqual([website.state, website.derived, website.utm, website.unparsableReason], ['DERIVED', 'https://www.padaria-exemplo.example/', { level: 'NOT_OBSERVED', names: [] }, null]);
  assert.equal(website.derivation.rule, 'lumos-url-derive-v1');
  assert.equal(website.derivation.rawSha256, sha(PLACE.website), 'hash do website bruto (conferível contra a captura)');
  assert.deepEqual(website.derivation.sourceEvidence, available(basis).source);
  assert.ok(!JSON.stringify(basis).includes('SEGREDO-IG') && !JSON.stringify(basis).includes('igsh'));
});

test('WEBSITE com UTM: completo, parcial, ausente, sem esquema e não-http — valores sensíveis jamais aparecem', async () => {
  const cases: Array<[string, string, string | null, string]> = [
    ['https://loja.example/promo?utm_source=VALOR-SECRETO-A&utm_medium=VALOR-SECRETO-B&token=TOKEN-X', 'DERIVED', 'https://loja.example/?utm_medium=x&utm_source=x', 'COMPLETE'],
    ['https://loja.example/?utm_source=VALOR-SECRETO-A', 'DERIVED', 'https://loja.example/?utm_source=x', 'PARTIAL'],
    ['https://loja.example/?utm_source=&sessao=SESSAO-X', 'DERIVED', 'https://loja.example/', 'NOT_OBSERVED'],
    ['loja.example/?utm_source=VALOR-SECRETO-A&utm_medium=VALOR-SECRETO-B', 'UNPARSABLE', null, 'NULL'],
    ['ftp://loja.example/?utm_source=VALOR-SECRETO-A', 'UNPARSABLE', null, 'NULL'],
  ];
  for (const [raw, state, derived, level] of cases) {
    const base = tmpDir();
    await seed(base, { body: bodyText({ website: raw }) });
    const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
    const website = available(basis).website;
    assert.ok(website, raw);
    assert.deepEqual([website.state, website.derived, website.utm === null ? 'NULL' : website.utm.level], [state, derived, level], raw);
    for (const secret of ['VALOR-SECRETO', 'TOKEN-X', 'SESSAO-X']) assert.ok(!JSON.stringify(basis).includes(secret), `${raw}: vazou ${secret}`);
  }
});

// ------------------------------------------------------------------------------------------------ M-4a
test('M-4a ESTRITA: nota e contagem existem SOMENTE em `informational.reviews`, rotuladas como excluídas do cálculo', async () => {
  const base = tmpDir();
  const written = await writeFull(base);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  assert.deepEqual(basis.informational.reviews, {
    rating: 4.8, ratingCount: 86, scoringUse: 'EXCLUDED_M4A', reason: INFORMATIONAL_REVIEWS_REASON,
    source: { ref: 'capture:c0001', observedAt: COLLECTED_AT, contentSha256: written.cap.contentSha256 },
  });
  const outside = { evidences: basis.evidences, profile: basis.profile };
  const keys = keysOf(outside);
  for (const forbidden of ['rating', 'ratingCount', 'reviewCount', 'reviews', 'ratingShown', 'reviewsRead']) assert.ok(!keys.has(forbidden), `"${forbidden}" fora de informational`);
});

test('M-4a: contagens 0, 999, 1000, 1001, abreviadas, texto, fracionária, negativa, nula e ausente — nunca no perfil elegível; 1000 sem tratamento especial', async () => {
  const table: Array<[unknown, number | null]> = [
    [0, 0], [999, 999], [1000, 1000], [1001, 1001], ['1,2 mil', null], ['1.2K', null], ['1k+', null], ['120', null], [1.5, null], [-3, null], [null, null], [undefined, null],
  ];
  const seen: unknown[] = [];
  for (const [count, informational] of table) {
    const base = tmpDir();
    await seed(base, { body: bodyText({ ratingCount: count }) });
    const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
    assert.equal(basis.informational.reviews?.ratingCount, informational, String(count));
    assert.equal(basis.informational.reviews?.scoringUse, 'EXCLUDED_M4A');
    const keys = keysOf({ evidences: basis.evidences, profile: basis.profile });
    assert.ok(!keys.has('ratingCount') && !keys.has('complete'), String(count));
    // os hashes dependem do corpo (que muda com a contagem); tudo o mais tem de ser idêntico
    seen.push(JSON.stringify({ ...basis, informational: null }).replace(/[0-9a-f]{64}/g, 'H'));
  }
  assert.equal(new Set(seen).size, 1, 'a contagem não altera NADA fora de `informational` (999/1000/1001 são tratados igual a todas as outras)');
});

// ------------------------------------------------------------------------------------------------ identidade
test('IDENTIDADE: sem confirmação do operador, não localizado, ambíguo ou corpo ilegível ⇒ perfil UNAVAILABLE e nenhum valor (nem informativo)', async () => {
  const cases: Array<[string, Parameters<typeof seed>[1], string]> = [
    ['sem confirmação', { mutateIdentity: (id) => { delete id.confirmation; } }, 'IDENTITY_NOT_CONFIRMED'],
    ['identidade fora do esquema', { mutateIdentity: (id) => { id.identifiers = {}; } }, 'IDENTITY_NOT_CONFIRMED'],
    ['outro CID', { body: bodyText({ cid: '5555555555555555555', fid: '0x935ef1a2b3c4d5e6:0x00000000000000ff', placeId: 'ChIJoutroLugarQualquerXYZ12' }) }, 'NOT_LOCATED'],
    ['mesmo NOME, outro CID (nome nunca confirma)', { body: bodyText({ cid: '5555555555555555555', fid: undefined, placeId: undefined, title: 'Padaria Exemplo' }) }, 'NOT_LOCATED'],
    ['ambíguo (o próprio resultado tem CID que contradiz o FID)', { body: bodyText({ fid: '0x935ef1a2b3c4d5e6:0x00000000000000ff' }) }, 'AMBIGUOUS_IDENTITY'],
    ['corpo que não é JSON', { body: 'isto não é json' }, 'BODY_UNREADABLE'],
    ['JSON sem places', { body: JSON.stringify({ credits: 3 }) }, 'BODY_UNREADABLE'],
  ];
  for (const [name, opts, reason] of cases) {
    const base = tmpDir();
    await seed(base, opts);
    const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
    assert.deepEqual(basis.profile, { state: 'UNAVAILABLE', reason }, name);
    assert.equal(basis.informational.reviews, null, `${name}: sem identidade provada não sai nem o dado informativo`);
    assert.equal(basis.evidences.length, 2, `${name}: a proveniência das evidências continua`);
    assert.ok(!JSON.stringify(basis).includes(SENTINEL));
  }
});

test('CAPTURA UTILIZÁVEL: o perfil vem da captura mais recente com HTTP 2xx e corpo; capturas sem resposta são puladas; nunca se mistura capturas', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-1111' }) });
  // 2ª captura: falha do provedor (sem corpo)
  const failedCapture = captureInput({ body: null });
  (failedCapture as { response: unknown }).response = { httpStatus: 503, attempts: 3, bodyText: null, failure: 'indisponível' };
  assert.ok((await writeCapture(base, failedCapture)).ok);
  let profile = available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  assert.deepEqual([profile.source.ref, profile.phone], ['capture:c0001', '(62) 3000-1111'], 'a captura 2 não tem resposta utilizável');
  // 3ª captura boa, SEM telefone: o telefone NÃO volta da captura 1
  assert.ok((await writeCapture(base, captureInput({ body: bodyText({ phoneNumber: undefined, website: 'https://novo.example/' }) }))).ok);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  profile = available(basis);
  assert.deepEqual([profile.source.ref, profile.phone, profile.website?.derived], ['capture:c0003', null, 'https://novo.example/'], 'sem mistura entre capturas');
  assert.deepEqual(basis.evidences.filter((e) => e.kind === 'CAPTURE').map((e) => e.ref), ['capture:c0001', 'capture:c0002', 'capture:c0003']);
  // todas as capturas sem resposta utilizável
  const only = tmpDir();
  assert.ok((await writeCapture(only, failedCapture)).ok);
  assert.ok((await writeReport(only, AUDIT, 1, { kind: 'TESTE', evidences: [] }, T_NOW)).ok);
  assert.deepEqual(ready(await readerFor(only).readScoringBasis(OPERATOR, AUDIT)).profile, { state: 'UNAVAILABLE', reason: 'NO_USABLE_CAPTURE' });
});

// ------------------------------------------------------------------------------------------------ integridade
test('INTEGRIDADE: qualquer arquivo adulterado, truncado, ausente ou fora de lugar ⇒ INTEGRITY_FAILED/NO_EVIDENCE e NENHUM dado sai', async () => {
  const cases: Array<[string, (dir: string) => void, 'INTEGRITY_FAILED' | 'NO_EVIDENCE']> = [
    ['captura adulterada (hash não confere)', (d) => tamper(path.join(d, 'c0001.capture.json'), (t) => t.replace('"attempts": 1', '"attempts": 2')), 'INTEGRITY_FAILED'],
    ['corpo da captura trocado mantendo o selo', (d) => tamper(path.join(d, 'c0001.capture.json'), (t) => t.replace('Padaria Exemplo (fict', 'Outra Empresa (fict')), 'INTEGRITY_FAILED'],
    ['relatório adulterado', (d) => tamper(path.join(d, 'c0001.report-r0001.json'), (t) => t.replace('"revision": 1', '"revision": 1,\n  "x": 1')), 'INTEGRITY_FAILED'],
    ['observação do site adulterada', (d) => tamper(path.join(d, 'c0001.site.json'), (t) => t.replace('HTTP_ERROR', 'OK')), 'INTEGRITY_FAILED'],
    ['captura truncada (JSON inválido)', (d) => tamper(path.join(d, 'c0001.capture.json'), (t) => t.slice(0, 200)), 'INTEGRITY_FAILED'],
    ['captura vazia', (d) => tamper(path.join(d, 'c0001.capture.json'), () => ''), 'INTEGRITY_FAILED'],
    ['captura apagada (relatório órfão)', (d) => { fs.chmodSync(path.join(d, 'c0001.capture.json'), 0o644); fs.rmSync(path.join(d, 'c0001.capture.json')); }, 'INTEGRITY_FAILED'],
    ['relatório apagado (sem relatório)', (d) => { fs.chmodSync(path.join(d, 'c0001.report-r0001.json'), 0o644); fs.rmSync(path.join(d, 'c0001.report-r0001.json')); }, 'NO_EVIDENCE'],
    ['arquivo de outra auditoria copiado para cá', (d) => fs.copyFileSync(path.join(d, 'c0001.capture.json'), path.join(d, 'c0002.capture.json')), 'INTEGRITY_FAILED'],
  ];
  for (const [name, damage, expected] of cases) {
    const base = tmpDir();
    await writeFull(base);
    damage(path.join(base, AUDIT));
    const outcome = await readerFor(base).readScoringBasis(OPERATOR, AUDIT);
    assert.equal(outcome.status, expected, name);
    assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status'], `${name}: só o estado e a integridade`);
    const text = JSON.stringify(outcome);
    for (const leak of ['Padaria', 'Outra Empresa', '99999-0000', 'padaria-exemplo', SENTINEL, 'contentSha256', 'profile', 'evidences', 'informational', base]) assert.ok(!text.includes(leak), `${name}: vazou ${leak}`);
    assert.ok('integrity' in outcome && outcome.integrity.status !== 'OK', name);
  }
});

test('INTEGRIDADE: com duas capturas, adulterar só uma já invalida a base inteira (nada é aproveitado da outra)', async () => {
  const base = tmpDir();
  await writeFull(base);
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-2222' }), report: null });
  assert.equal((await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).status, 'READY');
  tamper(path.join(base, AUDIT, 'c0002.capture.json'), (t) => t.replace('"attempts": 1', '"attempts": 9'));
  const outcome = await readerFor(base).readScoringBasis(OPERATOR, AUDIT);
  assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status']);
  assert.equal(outcome.status, 'INTEGRITY_FAILED');
});

test('FALHAS DE LEITURA: EIO/EACCES na listagem ou na leitura ⇒ falha controlada, sem caminho do disco e sem dados', async () => {
  const base = tmpDir();
  await writeFull(base);
  const secretPath = '/mnt/segredo/pasta-privada';
  const reads: Array<[string, FsOps]> = [
    ['readdir EACCES', faulty({ async readdir(dir: string) { if (dir.endsWith(AUDIT)) throw errno('EACCES', `EACCES: negado ${secretPath}`); return nodeFsOps.readdir(dir); } })],
    ['readFile EIO', faulty({ async readFile(file: string, max: number) { if (file.endsWith('.capture.json')) throw errno('EIO', `EIO: erro ${secretPath}`); return nodeFsOps.readFile(file, max); } })],
    ['readFile EACCES no relatório', faulty({ async readFile(file: string, max: number) { if (file.includes('report-r')) throw errno('EACCES', `EACCES ${secretPath}`); return nodeFsOps.readFile(file, max); } })],
  ];
  for (const [name, ops] of reads) {
    const outcome = await readerFor(base, ops).readScoringBasis(OPERATOR, AUDIT);
    assert.ok(['INTEGRITY_FAILED', 'NO_EVIDENCE'].includes(outcome.status), `${name}: ${outcome.status}`);
    const text = JSON.stringify(outcome);
    assert.ok(!text.includes(secretPath) && !text.includes('/mnt/') && !text.includes(base) && !text.includes('Padaria'), `${name}: vazamento ${text.slice(0, 200)}`);
    assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status']);
  }
});

// ------------------------------------------------------------------------------------------------ segurança de saída e somente leitura
test('SEM VAZAMENTO: corpo bruto, pedido, link original, miniatura, nota interna, identificadores, e-mail e caminhos nunca aparecem na saída', async () => {
  const base = tmpDir();
  await writeFull(base);
  const text = JSON.stringify(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  const leaks = [SENTINEL, 'internalNote', 'SEGREDO-IG', 'igsh', 'google.serper.dev', REQUEST_URL, 'foto-opaca', 'thumbnail', 'bodyText', 'www.google.com/maps', LINK, 'ana@empresa.com', 'snap-exemplo', CID, FID, PLACE_ID, base, os_tmp()];
  for (const leak of leaks) assert.ok(!text.includes(leak), `vazou: ${leak}`);
  assert.ok(!/"places"|"request"|"searchParameters"|"credits"/.test(text));
});
function os_tmp(): string {
  return path.dirname(tmpDir());
}

test('SOMENTE LEITURA: a leitura não altera nada na pasta (nomes, conteúdo, modos e datas) e não chama nenhuma operação de escrita', async () => {
  const base = tmpDir();
  await writeFull(base);
  const dir = path.join(base, AUDIT);
  const before = treeState(dir);
  const writes: string[] = [];
  const guarded = faulty({
    async writeExclusive(...args: Parameters<FsOps['writeExclusive']>) { writes.push('writeExclusive'); return nodeFsOps.writeExclusive(...args); },
    async link(...args: Parameters<FsOps['link']>) { writes.push('link'); return nodeFsOps.link(...args); },
    async mkdir(...args: Parameters<FsOps['mkdir']>) { writes.push('mkdir'); return nodeFsOps.mkdir(...args); },
    async unlink(...args: Parameters<FsOps['unlink']>) { writes.push('unlink'); return nodeFsOps.unlink(...args); },
    async chmod(...args: Parameters<FsOps['chmod']>) { writes.push('chmod'); return nodeFsOps.chmod(...args); },
  });
  ready(await readerFor(base, guarded).readScoringBasis(OPERATOR, AUDIT));
  assert.deepEqual(writes, []);
  assert.deepEqual(treeState(dir), before);
});

test('estabilidade: duas leituras seguidas devolvem exatamente o mesmo resultado (determinístico, sem relógio)', async () => {
  const base = tmpDir();
  await writeFull(base);
  const a = JSON.stringify(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  const b = JSON.stringify(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  assert.equal(a, b);
});

// ------------------------------------------------------------------------------------------------ layout LEGADO (réplica fictícia)
async function legacyReplica(extraPlace: Record<string, unknown> = {}): Promise<{ base: string; dir: string; bodyText: string }> {
  const base = tmpDir();
  const from = tmpDir('lafrom-');
  const body = JSON.stringify({
    searchParameters: { q: 'x' },
    places: [{ title: 'Padaria Exemplo', cid: CID, fid: FID, placeId: PLACE_ID, rating: 4.9, ratingCount: 12, phoneNumber: '(62) 3000-9999', website: 'https://legado.example/p?utm_source=ORIGEM-LEGADO&utm_medium=MEIO-LEGADO&token=TOKEN-LEGADO', type: 'Padaria', ...extraPlace }],
    credits: 3,
  });
  const stdout = ['{ "identity": { "snapshotId": "audit-20261022000000", "confirmedAt": "2026-10-22T12:54:45.249Z" },', '  "found": { "googleMaps": { "queriedAt": "2026-10-22T12:54:48.079Z" } } }'].join('\n');
  for (const [name, content] of Object.entries({
    'serper-body.json': body, 'serper-status.json': '{"attempts":1,"status":200,"ok":true}', 'serper-attempts.json': '{"attempts":1,"at":"2026-10-22T12:54:45.404Z"}',
    'summary.json': '{"exitCode":0,"serperAttempts":1,"siteHttpRequests":0}', 'run-stdout.txt': stdout, 'run-stderr.txt': '',
  })) fs.writeFileSync(path.join(from, name), content);
  const dir = path.join(base, AUDIT);
  assert.ok(persistCapture({ from, to: dir, now: clock }).ok);
  assert.ok((await generateReport({ dir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);
  fs.renameSync(path.join(dir, 'report.json'), path.join(dir, 'report.v1-superseded.json'));
  fs.renameSync(path.join(dir, 'report.json.sha256'), path.join(dir, 'report.v1-superseded.json.sha256'));
  assert.ok((await generateReport({ dir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);
  return { base, dir, bodyText: body };
}

test('LEGADO: capturas legadas válidas são lidas (hash do corpo conferido, relatório 1 superado, relatório 2 vigente) e nada é modificado', async () => {
  const { base, dir, bodyText: body } = await legacyReplica();
  const before = treeState(dir);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  assert.equal(basis.layout, 'LEGACY');
  const bodyHash = sha(body);
  assert.deepEqual(basis.evidences.map((e) => [e.ref, e.kind, e.legacy, e.superseded]), [
    ['capture:c0001', 'CAPTURE', true, false],
    ['report:c0001-r0001', 'REPORT', true, true],
    ['report:c0001-r0002', 'REPORT', true, false],
  ]);
  const [capture, r1, r2] = basis.evidences;
  assert.deepEqual([capture?.contentSha256, capture?.bodySha256, capture?.observedAt], [bodyHash, bodyHash, '2026-10-22T12:54:48.079Z'], 'legado: o hash da captura é o do corpo bruto do provedor');
  assert.equal(r1?.contentSha256, sha(fs.readFileSync(path.join(dir, 'report.v1-superseded.json'), 'utf8')));
  assert.equal(r2?.contentSha256, sha(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')));
  assert.ok(r1?.observedAt === capture?.observedAt && r2?.observedAt === capture?.observedAt);
  const profile = available(basis);
  assert.deepEqual([profile.name, profile.phone, profile.primaryCategory], ['Padaria Exemplo', '(62) 3000-9999', 'Padaria']);
  assert.deepEqual(profile.identity, { state: 'PROVEN', matchedBy: { cid: true, placeId: false }, expectedCidOrigin: 'LINK' });
  assert.deepEqual([profile.website?.derived, profile.website?.utm?.level, profile.website?.derivation.rawSha256], ['https://legado.example/?utm_medium=x&utm_source=x', 'COMPLETE', sha(JSON.parse(body).places[0].website)]);
  assert.deepEqual(basis.informational.reviews && [basis.informational.reviews.rating, basis.informational.reviews.ratingCount, basis.informational.reviews.scoringUse], [4.9, 12, 'EXCLUDED_M4A']);
  const text = JSON.stringify(basis);
  for (const leak of ['TOKEN-LEGADO', 'ORIGEM-LEGADO', 'MEIO-LEGADO', 'serper-body', 'run-stdout', base, '"places"', LINK]) assert.ok(!text.includes(leak), `legado vazou ${leak}`);
  assert.deepEqual(treeState(dir), before, 'o legado é só leitura');
});

test('LEGADO: corpo adulterado, hash de relatório ausente ou arquivo listado ausente ⇒ INTEGRITY_FAILED e nenhum dado; pasta sem relatório ⇒ NO_EVIDENCE', async () => {
  const damages: Array<[string, (dir: string) => void, string]> = [
    ['corpo do provedor adulterado', (d) => fs.writeFileSync(path.join(d, 'serper-body.json'), fs.readFileSync(path.join(d, 'serper-body.json'), 'utf8').replace('Padaria Exemplo', 'Outra Empresa')), 'INTEGRITY_FAILED'],
    ['hash do relatório vigente ausente', (d) => fs.rmSync(path.join(d, 'report.json.sha256')), 'INTEGRITY_FAILED'],
    ['relatório vigente adulterado', (d) => fs.writeFileSync(path.join(d, 'report.json'), fs.readFileSync(path.join(d, 'report.json'), 'utf8').replace('Padaria', 'Outra')), 'INTEGRITY_FAILED'],
    ['arquivo listado apagado', (d) => fs.rmSync(path.join(d, 'serper-status.json')), 'INTEGRITY_FAILED'],
    ['SHA256SUMS apagado', (d) => fs.rmSync(path.join(d, 'SHA256SUMS')), 'INTEGRITY_FAILED'],
  ];
  for (const [name, damage, expected] of damages) {
    const { base, dir } = await legacyReplica();
    damage(dir);
    const outcome = await readerFor(base).readScoringBasis(OPERATOR, AUDIT);
    assert.equal(outcome.status, expected, name);
    assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status'], name);
    for (const leak of ['Padaria', 'Outra Empresa', 'legado.example', 'contentSha256', base]) assert.ok(!JSON.stringify(outcome).includes(leak), `${name}: vazou ${leak}`);
  }
  const { base, dir } = await legacyReplica();
  for (const f of ['report.json', 'report.json.sha256', 'report.v1-superseded.json', 'report.v1-superseded.json.sha256']) fs.rmSync(path.join(dir, f));
  assert.equal((await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).status, 'NO_EVIDENCE');
});

test('LEGADO: sem status HTTP 2xx registrado a captura não é utilizável; sem confirmação do operador no relatório o perfil não é provado', async () => {
  const noStatus = await legacyReplica();
  // reescreve status e SHA256SUMS de forma consistente (ainda íntegro), mas com HTTP 500
  const statusFile = path.join(noStatus.dir, 'serper-status.json');
  fs.writeFileSync(statusFile, '{"attempts":1,"status":500,"ok":false}');
  const sums = fs.readFileSync(path.join(noStatus.dir, 'SHA256SUMS'), 'utf8').split('\n').map((line) => (line.endsWith('  serper-status.json') ? `${sha(fs.readFileSync(statusFile, 'utf8'))}  serper-status.json` : line)).join('\n');
  fs.writeFileSync(path.join(noStatus.dir, 'SHA256SUMS'), sums);
  const basis = ready(await readerFor(noStatus.base).readScoringBasis(OPERATOR, AUDIT));
  assert.deepEqual(basis.profile, { state: 'UNAVAILABLE', reason: 'NO_USABLE_CAPTURE' });
  assert.equal(basis.informational.reviews, null);
  assert.equal(basis.evidences.length, 3, 'a proveniência continua íntegra');

  const other = await legacyReplica({ cid: '5555555555555555555', fid: '0x935ef1a2b3c4d5e6:0x00000000000000ff', placeId: 'ChIJoutroLugarQualquerXYZ12' });
  assert.deepEqual(ready(await readerFor(other.base).readScoringBasis(OPERATOR, AUDIT)).profile, { state: 'UNAVAILABLE', reason: 'NOT_LOCATED' });
});

// ------------------------------------------------------------------------------------------------ compatibilidade
test('COMPATIBILIDADE com o leitor 5B: o mesmo diretório continua sendo exibido pelo leitor de evidências, com os mesmos números de versões', async () => {
  const { createEvidenceReader } = await import('../src/lib/link-audit-evidence/reader');
  const base = tmpDir();
  await writeFull(base);
  const evidenceReader = createEvidenceReader({ baseDir: base, authorize: allow });
  const view = await evidenceReader.getAudit(OPERATOR, AUDIT);
  assert.ok(view && view.integrity.status === 'OK');
  const versions = await evidenceReader.listVersions(OPERATOR, AUDIT);
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  // as referências do leitor de pontuação são exatamente as que a 6B constrói a partir das versões do leitor 5B
  const fromVersions = versions.flatMap((v) => (v.capture === null ? [] : [`capture:c${String(v.capture).padStart(4, '0')}`, ...v.reportRevisions.map((r) => `report:c${String(v.capture).padStart(4, '0')}-r${String(r.revision).padStart(4, '0')}`)]));
  assert.deepEqual(basis.evidences.map((e) => e.ref).sort(), fromVersions.sort());
  assert.deepEqual(basis.evidences.find((e) => e.kind === 'CAPTURE')?.observedAt, versions[0]?.collectedAt);
});


// ------------------------------------------------------------------------------------------------ revisão independente do I1
const rewriteLegacyReport = (dir: string, change: (report: Record<string, any>) => void): void => {
  const file = path.join(dir, 'report.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(json);
  const text = `${JSON.stringify(json, null, 2)}\n`;
  fs.writeFileSync(file, text);
  fs.writeFileSync(`${file}.sha256`, `${sha(text)}  report.json\n`); // quem edita o relatório recalcula o sidecar (limitação herdada do 5B)
};

test('STATUS HTTP: só 2xx é resposta utilizável — 1xx, 3xx, 4xx e 5xx COM corpo íntegro não geram perfil', async () => {
  for (const status of [100, 199, 301, 404, 500]) {
    const base = tmpDir();
    await seed(base, { status });
    const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
    assert.deepEqual(basis.profile, { state: 'UNAVAILABLE', reason: 'NO_USABLE_CAPTURE' }, `HTTP ${status}`);
    assert.equal(basis.informational.reviews, null);
  }
  for (const status of [200, 204, 299]) {
    const base = tmpDir();
    await seed(base, { status });
    assert.equal(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).profile.state, 'AVAILABLE', `HTTP ${status}`);
  }
});

test('HORÁRIOS: vários dias viram texto "dia: horário; …" na ordem do provedor (texto composto, não estruturado)', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ openingHours: { segunda: '08:00–18:00', 'terça': '09:00–17:00', domingo: 'Fechado' } }) });
  assert.equal(available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT))).hoursRaw, 'segunda: 08:00–18:00; terça: 09:00–17:00; domingo: Fechado');
});

test('WEBSITE: segredos no CAMINHO (token, chave sk-, Bearer, ;jsessionid) nunca saem — o caminho é descartado', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ website: 'https://usuario:SENHA7@loja.example:8443/p/SEGREDO8/sk-abcdefghijklmnopqrstuvwxyz0123/Bearer%20abcdefgh12345678;jsessionid=SEGREDO9?utm_source=S10&token=S12#frag' }) });
  const basis = ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT));
  assert.equal(available(basis).website?.derived, 'https://loja.example:8443/?utm_source=x');
  for (const secret of ['SENHA7', 'SEGREDO', 'sk-abc', 'Bearer', 'jsessionid', 'S10', 'S12', 'frag', 'usuario']) assert.ok(!JSON.stringify(basis).includes(secret), secret);
});

test('CAPTURA MAIS RECENTE é a de maior data de coleta (não o maior número); capturas sem relatório não herdam o de outra', async () => {
  const base = tmpDir();
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-1111' }), collectedAt: '2026-10-22T12:00:00.000Z', report: { kind: 'TESTE', evidences: [{ id: 'maps-name', status: 'VERIFIED' }] } });
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-2222' }), collectedAt: '2026-09-01T12:00:00.000Z', report: null });
  let profile = available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  assert.deepEqual([profile.source.ref, profile.phone], ['capture:c0001', '(62) 3000-1111'], 'c0002 é MAIS ANTIGA apesar do número maior');
  assert.deepEqual(profile.reportEvidence, { 'maps-name': 'VERIFIED' });
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-3333' }), collectedAt: '2026-11-05T12:00:00.000Z', report: null });
  profile = available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT)));
  assert.deepEqual([profile.source.ref, profile.phone, profile.reportEvidence], ['capture:c0003', '(62) 3000-3333', {}], 'sem relatório próprio: nada herdado de outra captura');
});

test('EVIDÊNCIAS do relatório: o primeiro id repetido vence e status fora do enum é ignorado', async () => {
  const base = tmpDir();
  await seed(base, { report: { kind: 'TESTE', evidences: [{ id: 'maps-website', status: 'VERIFIED' }, { id: 'maps-website', status: 'NOT_VERIFIED' }, { id: 'maps-name', status: 'HACKED' }, { id: 'maps-rating', status: 'VERIFIED' }, 'lixo', null] } });
  assert.deepEqual(available(ready(await readerFor(base).readScoringBasis(OPERATOR, AUDIT))).reportEvidence, { 'maps-website': 'VERIFIED' });
});

test('IDENTIDADE ÚNICA: capturas de empresas diferentes na mesma auditoria ⇒ INTEGRITY_FAILED (nenhum dado)', async () => {
  const base = tmpDir();
  await seed(base);
  await seed(base, { body: bodyText({ cid: CID_OTHER, fid: FID_OTHER, placeId: undefined, title: 'OUTRA EMPRESA' }), mutateIdentity: (id) => { id.identifiers = { cid: CID_OTHER, featureId: FID_OTHER }; }, report: null });
  const outcome = await readerFor(base).readScoringBasis(OPERATOR, AUDIT);
  assert.equal(outcome.status, 'INTEGRITY_FAILED');
  assert.ok(!JSON.stringify(outcome).includes('OUTRA EMPRESA'));
  assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status']);
});

test('RELATÓRIOS: lacuna na numeração das revisões (r1, r3 sem r2) ⇒ INTEGRITY_FAILED', async () => {
  const base = tmpDir();
  await writeFull(base);
  for (const at of ['2026-11-02T10:00:00.000Z', '2026-11-03T10:00:00.000Z']) assert.ok((await writeReport(base, AUDIT, 1, { kind: 'TESTE', evidences: [] }, at)).ok);
  assert.equal((await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).status, 'READY');
  const gap = path.join(base, AUDIT, 'c0001.report-r0002.json');
  fs.chmodSync(gap, 0o644);
  fs.rmSync(gap);
  assert.equal((await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).status, 'INTEGRITY_FAILED');
});

test('CORRIDA (arquivo muda ENTRE a verificação e a leitura): nunca devolve base parcial ou misturada', async () => {
  const base = tmpDir();
  await writeFull(base);
  const other = tmpDir();
  await writeFull(other, { body: bodyText({ phoneNumber: '(11) 90000-0000' }) }); // captura válida e autosselada, mas de OUTRO conteúdo
  const forged = fs.readFileSync(path.join(other, AUDIT, 'c0001.capture.json'), 'utf8');
  const nthRead = (match: (file: string) => boolean, nth: number, act: (file: string, max: number) => Promise<string>): FsOps => {
    let count = 0;
    return faulty({ async readFile(file: string, max: number) { if (match(file) && ++count === nth) return act(file, max); return nodeFsOps.readFile(file, max); } });
  };
  const isCapture = (f: string) => f.endsWith('c0001.capture.json');
  const isReport = (f: string) => f.endsWith('c0001.report-r0001.json');
  const cases: Array<[string, FsOps]> = [
    ['captura trocada por outra válida na 2ª leitura', nthRead(isCapture, 2, async () => forged)],
    ['captura ilegível na 2ª leitura', nthRead(isCapture, 2, async () => { throw errno('EIO', 'EIO /mnt/x'); })],
    ['relatório ilegível na 2ª leitura', nthRead(isReport, 2, async () => { throw errno('EIO', 'EIO /mnt/x'); })],
  ];
  for (const [name, ops] of cases) {
    const outcome = await readerFor(base, ops).readScoringBasis(OPERATOR, AUDIT);
    assert.equal(outcome.status, 'INTEGRITY_FAILED', name);
    assert.ok(!JSON.stringify(outcome).includes('90000-0000') && !JSON.stringify(outcome).includes('/mnt/'), name);
  }
});

test('CORRIDA: captura SEM relatório que falha na 2ª leitura também invalida a base (nada de base parcial)', async () => {
  const base = tmpDir();
  await writeFull(base);
  await seed(base, { body: bodyText({ phoneNumber: '(62) 3000-2222' }), report: null });
  assert.equal((await readerFor(base).readScoringBasis(OPERATOR, AUDIT)).status, 'READY');
  let count = 0;
  const ops = faulty({ async readFile(file: string, max: number) { if (file.endsWith('c0002.capture.json') && ++count === 2) throw errno('EIO', 'EIO /mnt/x'); return nodeFsOps.readFile(file, max); } });
  const outcome = await readerFor(base, ops).readScoringBasis(OPERATOR, AUDIT);
  assert.equal(outcome.status, 'INTEGRITY_FAILED');
  assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status']);
});

test('LEGADO: relatório vigente de OUTRA coleta (hash do corpo declarado diferente) ⇒ INTEGRITY_FAILED; sem report.json vigente ⇒ NO_EVIDENCE (o superado não é promovido)', async () => {
  const foreign = await legacyReplica();
  rewriteLegacyReport(foreign.dir, (r) => { r.source.capture.sha256 = 'c'.repeat(64); r.source.collectedAt = '2026-03-01T10:00:00.000Z'; });
  const outcome = await readerFor(foreign.base).readScoringBasis(OPERATOR, AUDIT);
  assert.equal(outcome.status, 'INTEGRITY_FAILED');
  assert.ok(!JSON.stringify(outcome).includes('2026-03-01') && !JSON.stringify(outcome).includes('Padaria'));

  const onlySuperseded = await legacyReplica();
  for (const f of ['report.json', 'report.json.sha256']) fs.rmSync(path.join(onlySuperseded.dir, f));
  assert.equal((await readerFor(onlySuperseded.base).readScoringBasis(OPERATOR, AUDIT)).status, 'NO_EVIDENCE');
});

test('LEGADO: relatório vigente SEM vínculo criptográfico verificável com a captura nunca vira base (hash ausente, nulo, não textual, curto, vazio, caixa alta, com espaço/prefixo, bloco ausente ou errado)', async () => {
  const control = await legacyReplica();
  const bodyHash = sha(control.bodyText);
  assert.equal(ready(await readerFor(control.base).readScoringBasis(OPERATOR, AUDIT)).layout, 'LEGACY'); // controle: o hash correto é aceito
  const broken: Array<[string, 'INTEGRITY_FAILED' | 'NO_EVIDENCE', (r: Record<string, any>) => void]> = [
    ['hash ausente', 'INTEGRITY_FAILED', (r) => { delete r.source.capture.sha256; }],
    ['hash nulo', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = null; }],
    ['hash numérico', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = 12345; }],
    ['hash em lista', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = [bodyHash]; }],
    ['hash curto', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = bodyHash.slice(0, 63); }],
    ['hash vazio', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = ''; }],
    ['hash em maiúsculas', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = bodyHash.toUpperCase(); }],
    ['hash com espaço', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = `${bodyHash} `; }],
    ['hash com prefixo', 'INTEGRITY_FAILED', (r) => { r.source.capture.sha256 = `sha256:${bodyHash}`; }],
    ['bloco capture ausente', 'INTEGRITY_FAILED', (r) => { delete r.source.capture; }],
    ['bloco capture textual', 'INTEGRITY_FAILED', (r) => { r.source.capture = bodyHash; }],
    ['bloco source ausente (sem data de coleta)', 'NO_EVIDENCE', (r) => { delete r.source; }],
  ];
  for (const [name, expected, change] of broken) {
    const replica = await legacyReplica();
    rewriteLegacyReport(replica.dir, change);
    const outcome = await readerFor(replica.base).readScoringBasis(OPERATOR, AUDIT);
    assert.equal(outcome.status, expected, name);
    assert.deepEqual(Object.keys(outcome).sort(), ['integrity', 'status'], `${name}: só estado e integridade`);
    assert.ok(!JSON.stringify(outcome).includes('Padaria') && !JSON.stringify(outcome).includes('3000-9999'), name);
  }
});

test('LEGADO: data de coleta inválida ⇒ NO_EVIDENCE; `generatedAt` hostil do relatório nunca é repassado', async () => {
  const badDate = await legacyReplica();
  rewriteLegacyReport(badDate.dir, (r) => { r.source.collectedAt = '2026-13-45T99:99:99Z'; });
  assert.equal((await readerFor(badDate.base).readScoringBasis(OPERATOR, AUDIT)).status, 'NO_EVIDENCE');

  const hostile = await legacyReplica();
  rewriteLegacyReport(hostile.dir, (r) => { r.generatedAt = 'http://evil.example/?token=SEGREDOX api_key=SEGREDOY'; });
  const basis = ready(await readerFor(hostile.base).readScoringBasis(OPERATOR, AUDIT));
  assert.equal(basis.evidences.find((e) => e.ref === 'report:c0001-r0002')?.generatedAt, null);
  assert.ok(!JSON.stringify(basis).includes('SEGREDOX') && !JSON.stringify(basis).includes('evil.example'));
});

test('LEGADO: o status HTTP usado é o do texto VERIFICADO (trocar o arquivo depois da verificação não muda o perfil)', async () => {
  const { base, dir } = await legacyReplica();
  const statusFile = path.join(dir, 'serper-status.json');
  let reads = 0;
  const ops = faulty({ async readFile(file: string, max: number) { const text = await nodeFsOps.readFile(file, max); return file === statusFile && ++reads > 1 ? '{"status":500}' : text; } });
  assert.equal(ready(await readerFor(base, ops).readScoringBasis(OPERATOR, AUDIT)).profile.state, 'AVAILABLE');
});
