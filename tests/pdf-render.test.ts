import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { buildReportFixture } from '../src/dev/report-fixture';
import { LocalDirectoryProvider, noBasemapProvider, resolveBasemap } from '../src/lib/pdf/map/basemap';
import type { BasemapProvider, BasemapResolution } from '../src/lib/pdf/map/basemap';
import { buildPdfFileName, defaultPdfDirectory, persistReportPdf } from '../src/lib/pdf/persist';
import { createSanitizer, registerFonts } from '../src/lib/pdf/report-layout';
import { buildReportModel } from '../src/lib/pdf/report-model';
import { renderReportPdf } from '../src/lib/pdf/report-renderer';
import { detectProviderEnvironment, reportSourceFromAuditState } from '../src/lib/pdf/report-source';
import { isPathInsideRoots, pdfReadCandidates, resolvePdfDownload, safeDownloadName } from '../src/lib/pdf/serve';
import type { BattlefieldMetrics, DiagrammerOutput } from '../src/types/gmn';

const GENERATED_AT = '2026-10-16T12:00:00.000Z';
const TILES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'tiles');

const WIN_ANSI: Record<number, string> = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };

/** Extrai o texto de um PDF sem compressão gerado com fontes padrão (strings hex dentro de TJ/Tj). */
function extractText(buffer: Buffer): string[] {
  const content = buffer.toString('latin1');
  const runs: string[] = [];
  const decode = (hex: string): string =>
    (hex.match(/../g) ?? []).map((byte) => {
      const code = parseInt(byte, 16);
      return WIN_ANSI[code] ?? String.fromCharCode(code);
    }).join('');
  for (const match of content.matchAll(/\[((?:\s*(?:<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?)\s*)+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
    const tokens = match[1] ? [...match[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1] ?? '') : [match[2] ?? ''];
    runs.push(tokens.map(decode).join(''));
  }
  return runs;
}

const pageCountOf = (buffer: Buffer): number => (buffer.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const joined = (buffer: Buffer): string => extractText(buffer).join('\n');
/** Texto com quebras de linha normalizadas, para frases que o layout quebra em duas linhas. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

async function render(
  options: Parameters<typeof buildReportFixture>[0] = {},
  basemap: BasemapResolution | undefined = undefined,
  modelOverride?: (model: ReturnType<typeof buildReportModel>) => ReturnType<typeof buildReportModel>,
  extra: Partial<Parameters<typeof buildReportModel>[0]> = {},
  /** `true` trata a fixture como o resultado persistido de uma auditoria (sem o marcador de teste). */
  treatAsAudit = false
) {
  const fixture = await buildReportFixture(options);
  const { testFixture: _fixture, ...asAudit } = fixture;
  void _fixture;
  const source = treatAsAudit ? asAudit : fixture;
  let model = buildReportModel({ source, generatedAt: GENERATED_AT, ...extra });
  if (modelOverride) model = modelOverride(model);
  const rendered = await renderReportPdf(model, { fonts: 'standard', compress: false, basemap: basemap ?? { provider: noBasemapProvider, status: 'NONE', notice: 'Mapa-base (ruas e bairros) não incluído nesta emissão.' } });
  return { model, rendered, text: joined(rendered.buffer) };
}

/* ------------------------------ geração básica ------------------------------ */

test('gera o dossiê de uma auditoria concluída: PDF válido, A4, várias páginas', async () => {
  const { rendered } = await render();
  assert.equal(rendered.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(rendered.buffer.subarray(-12).toString(), /%%EOF/);
  assert.equal(rendered.pageCount, pageCountOf(rendered.buffer));
  assert.ok(rendered.pageCount >= 8, `páginas: ${rendered.pageCount}`);
  assert.match(rendered.buffer.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
});

test('capa: selo, título exato e cobertura calculada; "Score Global" nunca aparece', async () => {
  const { text } = await render();
  assert.match(text, /AUDITORIA PARCIALMENTE VERIFICADA/);
  assert.match(text, /Desempenho nos critérios verificados/i);
  assert.match(text, /5 de 21 critérios verificados · 26% do peso total/);
  assert.match(flat(text), /2 parcialmente verificados · 12% do peso \(contados à parte\)/);
  assert.match(flat(text), /Dossiê de Auditoria e Inteligência Territorial/);
  assert.match(text, /Diagnóstico de posicionamento e oportunidades de crescimento no Google Meu Negócio\./);
  assert.doesNotMatch(text, /score global/i);
});

test('todas as páginas têm numeração "Página N de M"', async () => {
  const { rendered, text } = await render();
  for (let i = 1; i <= rendered.pageCount; i++) {
    assert.ok(text.includes(`Página ${i} de ${rendered.pageCount}`), `faltou numeração da página ${i}`);
  }
});

test('critérios sem comprovação: marca exigida, sem aprovar nem reprovar; simulado legado identificado', async () => {
  const { text } = await render({}, undefined, undefined, {}, true);
  assert.match(text, /NÃO VERIFICADO — EVIDÊNCIA INDISPONÍVEL/);
  assert.match(text, /SIMULADO \(LEGADO\) — NÃO É DADO REAL/);
  assert.match(text, /PARCIALMENTE VERIFICADO/);
  assert.match(text, /APROVADO/);
  assert.match(flat(text), /Gravado por auditoria anterior à Fase 4 e preservado como histórico/);
});

test('metodologia (auditoria anterior): só o Score Juiz histórico ARMAZENADO, com denominador 102 e sem recalculado', async () => {
  const { text, model } = await render({}, undefined, undefined, {}, true);
  const flatText = flat(text);
  assert.match(text, /SCORE JUIZ HISTÓRICO \(ARMAZENADO\)/);
  assert.match(flatText, /denominador: peso 102 \(100% do total\)/);
  assert.match(flatText, /Inclui critérios sem comprovação/);
  assert.doesNotMatch(flatText, /PONTUAÇÃO RECALCULADA/);
  assert.match(flatText, /DESEMPENHO NOS CRITÉRIOS VERIFICADOS/);
  assert.match(text, /API oficial do Google Business Profile/);
  assert.ok(model.judge.score.officialMatchesAgent);
  assert.deepEqual(model.judge.scoreLines.map((l) => l.key), ['STORED_HISTORICAL', 'VERIFIED_PERFORMANCE']);
});

test('sem histórico: a frase exata aparece no PDF', async () => {
  const { text } = await render();
  assert.ok(text.includes('Primeira auditoria registrada. Ainda não existe base histórica suficiente para comparação.'));
});

test('histórico real: comparação com a auditoria anterior, nunca um baseline inventado', async () => {
  const source = await buildReportFixture();
  const withHistory: BattlefieldMetrics = {
    ...source.battlefield,
    historicalEvolution: { ...source.battlefield.historicalEvolution, hasPreviousRound: true, previousRoundId: '11111111-1111-4111-8111-111111111111', previousExecutedAt: '2026-09-10T12:00:00.000Z', previousGreenTop3Count: 1, greenPointsDelta: 3, averagePositionDelta: -2.4 },
  };
  const model = buildReportModel({ source: { ...source, battlefield: withHistory }, generatedAt: GENERATED_AT });
  const rendered = await renderReportPdf(model, { fonts: 'standard', compress: false, basemap: { provider: noBasemapProvider, status: 'NONE', notice: null } });
  const text = joined(rendered.buffer);
  assert.match(text, /Comparação com a auditoria anterior de 10\/09\/2026/);
  assert.doesNotMatch(text, /Primeira auditoria registrada/);
});

test('datas separadas e regeneração: coleta preservada, geração registrada à parte', async () => {
  const { text } = await render({}, undefined, undefined, { regenerated: true });
  assert.match(flat(text), /regenerado a partir de resultados já coletados; nenhuma nova coleta foi feita/);
  assert.match(text, /Dados coletados em 01\/01\/2026/);
  assert.match(text, /Documento gerado em 16\/10\/2026/);
});

/* ---------------------------------- mapa-base --------------------------------- */

test('padrão: sem mapa-base o PDF sai com os pontos reais e o aviso', async () => {
  const { rendered, text } = await render();
  assert.equal(rendered.basemapStatus, 'NONE');
  assert.equal(rendered.map?.basemap, 'OMITTED');
  assert.match(text, /Mapa-base \(ruas e bairros\) não incluído nesta emissão\./);
});

test('tiles locais: mapa-base incluído, com ruas, bairros e a atribuição exigida', async () => {
  const resolution = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: TILES_DIR });
  const { rendered, text } = await render({}, resolution);
  assert.equal(rendered.basemapStatus, 'ENABLED');
  assert.equal(rendered.map?.basemap, 'INCLUDED');
  assert.ok((rendered.map?.tilesUsed ?? 0) >= 4 && (rendered.map?.tilesUsed ?? 99) <= 16);
  assert.ok((rendered.map?.placeLabels ?? 0) > 5, 'nomes de bairros desenhados');
  assert.ok((rendered.map?.roadLabels ?? 0) > 0, 'nomes de ruas desenhados');
  assert.ok(text.includes('OpenFreeMap © OpenMapTiles Data from OpenStreetMap'));
});

test('falha ao carregar o mapa: o PDF é gerado mesmo assim, com aviso claro e sem mapa falso', async () => {
  const failing: BasemapProvider = {
    id: 'openfreemap',
    kind: 'vector-tiles',
    attribution: 'x',
    maxZoom: 14,
    maxTilesPerReport: 16,
    getTile: async () => {
      throw new Error('rede indisponível');
    },
  };
  const { rendered, text } = await render({}, { provider: failing, status: 'ENABLED', notice: null });
  assert.equal(rendered.basemapStatus, 'FAILED');
  assert.equal(rendered.map?.basemap, 'OMITTED');
  assert.match(text, /Mapa-base indisponível nesta emissão/);
  assert.ok(rendered.pageCount >= 8);
});

test('nenhum tile disponível para a área também cai no modo sem mapa-base', async () => {
  const empty = new LocalDirectoryProvider(await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-empty-')), 'attr');
  const { rendered } = await render({}, { provider: empty, status: 'ENABLED', notice: null });
  assert.equal(rendered.basemapStatus, 'FAILED');
  assert.equal(rendered.map?.basemap, 'OMITTED');
});

test('sem coordenadas válidas: a página explica a ausência e o PDF continua sendo gerado', async () => {
  const source = await buildReportFixture();
  const broken: BattlefieldMetrics = {
    ...source.battlefield,
    centerOfInterest: { latitude: Number.NaN, longitude: Number.NaN },
    points: source.battlefield.points.map((pt) => ({ ...pt, latitude: Number.NaN })),
  };
  const lead = { ...source.lead, coordinates: { latitude: Number.NaN, longitude: Number.NaN } };
  const model = buildReportModel({ source: { ...source, battlefield: broken, lead }, generatedAt: GENERATED_AT });
  const rendered = await renderReportPdf(model, { fonts: 'standard', compress: false, basemap: { provider: noBasemapProvider, status: 'NONE', notice: null } });
  assert.match(joined(rendered.buffer), /Nenhuma coordenada válida foi coletada nesta auditoria/);
  assert.equal(rendered.map, null);
});

/* ----------------------------- casos-limite de texto ---------------------------- */

test('nome de estabelecimento muito longo: não quebra o layout nem a paginação', async () => {
  const long = 'Clínica Odontológica Especializada em Implantes, Ortodontia, Estética Dental, Reabilitação Oral Completa e Atendimento Domiciliar de Urgência da Região Central e Adjacências '.repeat(2).trim();
  const base = await render();
  const { rendered, text } = await render({ lead: { businessName: long } });
  assert.ok(text.includes('Clínica Odontológica Especializada'));
  assert.ok(Math.abs(rendered.pageCount - base.rendered.pageCount) <= 1);
  // o nome é cortado com reticências em vez de invadir outros elementos
  assert.ok(text.includes('…'));
});

test('emojis e símbolos fora da fonte são removidos ou trocados, nunca viram caixas', async () => {
  const { text } = await render({ lead: { businessName: 'Clínica 😀 Sorriso ≥ Top ✓' } });
  assert.ok(text.includes('Clínica'));
  assert.doesNotMatch(text, /😀/u);
  assert.ok(text.includes('>= Top'));

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const { fonts, mode } = registerFonts(doc, 'standard');
  const sanitize = createSanitizer(doc, fonts, mode);
  assert.equal(sanitize('Olá 😀 ≥ ç ão'), 'Olá >= ç ão');
  assert.equal(sanitize('a​b\u0007c'), 'abc');
});

test('lista de concorrentes vazia: mensagem explícita, sem inventar rivais', async () => {
  const { text } = await render({}, undefined, (model) => ({ ...model, competition: { ...model.competition, rivals: [] } }));
  assert.match(text, /Nenhum concorrente líder foi identificado/);
});

test('dados de reputação e vitrine reais mudam a classificação e a cobertura no PDF', async () => {
  const { text, model } = await render({ dataStyle: 'phase4-live' });
  assert.ok(model.coverage.verifiedCriteria > 5, `verificados: ${model.coverage.verifiedCriteria}`);
  assert.match(text, new RegExp(`${model.coverage.verifiedCriteria} de 21 critérios verificados`));
});

/* ------------------------- resultados persistidos e entrega ------------------------ */

test('a partir do estado persistido: monta o relatório sem recoletar nada', async () => {
  const source = await buildReportFixture();
  const state = {
    auditId: source.auditId,
    status: 'COMPLETED',
    reputation: source.reputation,
    vitrine: source.vitrine,
    battlefield: source.battlefield,
    rivals: source.rivals,
    judge: source.judge,
    strategist: source.strategist,
  };
  const result = reportSourceFromAuditState(state, source.lead);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source.battlefield, source.battlefield);
    const model = buildReportModel({ source: result.source, generatedAt: GENERATED_AT, regenerated: true });
    assert.equal(model.meta.collectedAt, source.battlefield.executedAt);
  }
});

test('estado persistido incompleto: lista o que falta em vez de inventar', async () => {
  const source = await buildReportFixture();
  const result = reportSourceFromAuditState({ auditId: 'x', reputation: source.reputation, battlefield: { ...source.battlefield, points: undefined } }, source.lead);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.missing.includes('vitrine'));
    assert.ok(result.missing.includes('judge'));
    assert.ok(result.missing.includes('battlefield.points'));
  }
});

test('provedores do ambiente: só declara o que está configurado', () => {
  assert.deepEqual(detectProviderEnvironment({ SERPER_API_KEY: 'cole-sua-api-key-aqui-1234' }), { serperConfigured: false, dataForSeoConfigured: false });
  assert.deepEqual(detectProviderEnvironment({ SERPER_API_KEY: 'abcdefghijklmnop', DATAFORSEO_LOGIN: 'a@b.c', DATAFORSEO_PASSWORD: 'x' }), { serperConfigured: true, dataForSeoConfigured: true });
});

test('armazenamento: grava o arquivo e devolve o link local de download', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const buffer = Buffer.from('%PDF-1.4 teste');
  const name = buildPdfFileName('Clínica São João & Cia', 'abcdef12-0000-4000-8000-000000000000');
  assert.equal(name, 'auditoria-gmn-cl-nica-s-o-jo-o-cia-abcdef12.pdf');
  const result = await persistReportPdf({ auditId: 'abcdef12-0000-4000-8000-000000000000', pdfFileName: name, buffer, outputDir: dir });
  assert.equal(result.uploaded, false);
  assert.equal(result.downloadUrl, '/api/audit/abcdef12-0000-4000-8000-000000000000/pdf');
  assert.deepEqual(await fs.readFile(result.localPath), buffer);
});

test('falha ao gravar o arquivo: erro claro (a auditoria falha em vez de fingir sucesso)', async () => {
  await assert.rejects(
    () =>
      persistReportPdf(
        { auditId: 'a', pdfFileName: 'x.pdf', buffer: Buffer.from('x'), outputDir: '/tmp/gmn-sem-permissao' },
        { writeFile: async () => { throw new Error('EACCES: permission denied'); }, mkdir: async () => undefined }
      ),
    /Falha ao gravar o PDF em .*x\.pdf: EACCES/
  );
});

test('falha no envio ao bucket: mantém o link local e devolve o motivo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const supabase = { storage: { from: () => ({ upload: async () => ({ error: { message: 'bucket inexistente' } }), getPublicUrl: () => ({ data: { publicUrl: 'https://x/y.pdf' } }) }) } };
  const result = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('x'), outputDir: dir }, { supabase: supabase as never, bucket: 'privado' });
  assert.equal(result.uploaded, false);
  assert.equal(result.uploadError, 'bucket inexistente');
  assert.equal(result.downloadUrl, '/api/audit/id1/pdf');
});

test('envio ao bucket privado com sucesso: o link continua sendo a rota autenticada, nunca a URL pública', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const calls: unknown[] = [];
  const supabase = { storage: { from: (bucket: string) => ({ upload: async (_p: string, _b: unknown, opts: unknown) => { calls.push([bucket, opts]); return { error: null }; }, getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.example/a.pdf' } }) }) } };
  const result = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('x'), outputDir: dir }, { supabase: supabase as never, bucket: 'privado' });
  assert.equal(result.uploaded, true);
  assert.equal(result.downloadUrl, '/api/audit/id1/pdf');
  assert.deepEqual(calls, [['privado', { contentType: 'application/pdf', upsert: false }]]);
});

test('sem bucket privado configurado nada é enviado ao Supabase', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const supabase = { storage: { from: () => { throw new Error('não deveria ser chamado'); } } };
  const result = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('x'), outputDir: dir }, { supabase: supabase as never });
  assert.equal(result.uploaded, false);
  assert.equal(result.uploadError, null);
});

test('PDF existente nunca é sobrescrito: nova gravação vira -r2, -r3', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const first = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('um'), outputDir: dir });
  const second = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('dois'), outputDir: dir });
  const third = await persistReportPdf({ auditId: 'id1', pdfFileName: 'a.pdf', buffer: Buffer.from('tres'), outputDir: dir });
  assert.deepEqual([first.fileName, second.fileName, third.fileName], ['a.pdf', 'a-r2.pdf', 'a-r3.pdf']);
  assert.equal((await fs.readFile(first.localPath)).toString(), 'um');
  assert.equal((await fs.readFile(second.localPath)).toString(), 'dois');
});

test('o local padrão dos PDFs novos é privado (.data/audits), fora de public/', () => {
  assert.match(defaultPdfDirectory('/app'), /^\/app\/\.data\/audits$/);
});

test('download: caminho do banco fora das pastas permitidas é recusado e o nome do arquivo é sanitizado', async () => {
  const roots = ['/srv/pdfs'];
  assert.equal(isPathInsideRoots('/srv/pdfs/a.pdf', roots), true);
  for (const bad of ['/etc/passwd', '/srv/pdfs/../secret.pdf', '/srv/pdfs-evil/a.pdf', '/srv/pdfs/a.txt', '/srv/pdfs/a.pdf\0.png', 'relativo/a.pdf']) {
    assert.equal(isPathInsideRoots(bad, roots), false, bad);
  }
  let read = false;
  const blocked = await resolvePdfDownload(
    { auditId: 'x', pdfFileName: 'a.pdf', pdfStoragePath: '/etc/passwd', pdfDownloadUrl: '', pageCount: 1, fileSizeBytes: 1, generatedAt: GENERATED_AT },
    async () => { read = true; return Buffer.from('x') as Buffer<ArrayBuffer>; },
    roots
  );
  assert.equal(blocked.status, 404);
  assert.equal(read, false);
  assert.equal(safeDownloadName('x"; filename="evil.exe\r\n.pdf'), 'x-filename-evil.exe-.pdf');
  assert.equal(safeDownloadName(undefined), 'auditoria-gmn.pdf');

  // Caminho gravado no Windows: resolvido só pelo nome do arquivo, dentro das pastas permitidas
  assert.deepEqual(pdfReadCandidates('D:\\proj\\public\\audits\\a-1.pdf', roots), ['/srv/pdfs/a-1.pdf']);
  assert.deepEqual(pdfReadCandidates('/etc/passwd', roots), []);
  assert.deepEqual(pdfReadCandidates('C:\\x\\..\\..\\segredo.txt', roots), []);
  assert.deepEqual(pdfReadCandidates('D:\\x\\a b.pdf', roots), [], 'nome com espaço/inesperado não é aceito'); 
});

test('download: serve o PDF gerado com os cabeçalhos corretos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-'));
  const { rendered } = await render();
  const persisted = await persistReportPdf({ auditId: 'id9', pdfFileName: 'dossie.pdf', buffer: rendered.buffer, outputDir: dir });
  const diagrammer: DiagrammerOutput = {
    auditId: 'id9', pdfFileName: 'dossie.pdf', pdfStoragePath: persisted.localPath, pdfDownloadUrl: persisted.downloadUrl,
    pageCount: rendered.pageCount, fileSizeBytes: rendered.buffer.length, generatedAt: GENERATED_AT,
  };
  const result = await resolvePdfDownload(diagrammer, undefined, [dir]);
  assert.equal(result.status, 200);
  if (result.status === 200) {
    assert.equal(result.headers['Content-Type'], 'application/pdf');
    assert.equal(result.headers['Content-Disposition'], 'attachment; filename="dossie.pdf"');
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.body, rendered.buffer);
  }
});

test('download: 404 com as mensagens originais quando o PDF não existe ou não foi finalizado', async () => {
  const none = await resolvePdfDownload(undefined);
  assert.deepEqual(none, { status: 404, error: 'O PDF desta auditoria ainda não foi finalizado pelo Diagramador.' });
  const missing = await resolvePdfDownload({ auditId: 'x', pdfFileName: 'a.pdf', pdfStoragePath: '/nao/existe/a.pdf', pdfDownloadUrl: '', pageCount: 1, fileSizeBytes: 1, generatedAt: GENERATED_AT }, undefined, ['/nao/existe']);
  assert.deepEqual(missing, { status: 404, error: 'Arquivo PDF não encontrado no armazenamento local.' });
});

/* ------------------------------- Fase 4 ------------------------------- */

test('Fase 4 sem fontes: PDF honesto, com cobertura parcial, índice de posição e plano ancorado em evidência', async () => {
  const { rendered, text, model } = await render({ dataStyle: 'phase4' }, undefined, undefined, {}, true);
  const flatText = flat(text);
  assert.ok(rendered.pageCount >= 8);
  assert.match(flatText, /AUDITORIA PARCIALMENTE VERIFICADA/);
  assert.match(flatText, /6 de 21 critérios verificados · 31% do peso total/);
  assert.match(flatText, /4 parcialmente verificados · 20% do peso \(contados à parte\)/);
  assert.match(text, /PARCIALMENTE VERIFICADO/);
  assert.match(flatText, /índice de posição/i);
  assert.match(flatText, /fora do Top 20 = 21/);
  assert.doesNotMatch(flatText, /posição média territorial/i);
  assert.doesNotMatch(flatText, /score global/i);
  // Auditoria nativa da Fase 4: não existe score histórico armazenado; só a pontuação recalculada, com o denominador.
  assert.doesNotMatch(flatText, /SCORE JUIZ HISTÓRICO/);
  assert.match(flatText, /PONTUAÇÃO RECALCULADA \(METODOLOGIA DA FASE 4\)/);
  assert.match(flatText, /denominador: peso \d+ \(\d+(,\d)?% do total\)/);
  assert.match(flatText, /Critério sem pontuação não é tratado como zero nem como 100%/);
  assert.match(flatText, /Não é comparável ao score histórico|não devem ser comparados/);
  assert.match(flatText, /AÇÃO COMPROVADA/);
  assert.match(flatText, /HIPÓTESE: VALIDAR ANTES/);
  assert.match(flatText, /CONFIANÇA/);
  assert.match(flatText, /Avaliações datadas não coletadas/);
  assert.match(flatText, /site \(resposta, indexabilidade e dados estruturados\)/i);
  assert.ok(model.quality.every((check) => check.passed), model.quality.filter((c) => !c.passed).map((c) => c.id).join(','));
});

test('Fase 4 com fontes de teste: critérios verificados mostram a fonte, e parciais mostram a limitação', async () => {
  const { text } = await render({ dataStyle: 'phase4-live' });
  const flatText = flat(text);
  // Fixture: a fonte é sintética, nunca o Serper nem uma verificação real do site
  assert.match(flatText, /Fonte: Dados sintéticos de teste \(fixture\)/);
  assert.doesNotMatch(flatText, /Fonte: Verificação técnica do site|Fonte: Serper/);
  assert.match(flatText, /Limitação: .*amostra/i);
  assert.match(flatText, /Comprovado em parte:/);
  assert.match(flatText, /indexação efetiva no Google não foi verificada/);
});

test('o índice de posição é identificado, e a média das posições conhecidas aparece separada, com o denominador', async () => {
  const { text } = await render({ dataStyle: 'phase4' });
  const flatText = flat(text);
  assert.match(flatText, /posição média no top 20/i);
  assert.match(flatText, /só os \d+ pontos com posição conhecida/);
  assert.match(flatText, /fora do top 20 conta como 21 · 49 pontos válidos/i);
  assert.match(flatText, /dos 49 válidos/);
});

test('nome longo da empresa no mapa: segunda linha curta, cortada em limite de palavra', async () => {
  const { shortBusinessName } = await import('../src/lib/pdf/map/map-render');
  assert.equal(shortBusinessName('Dra. Anna Vitória | Dentista em Anápolis'), 'Dra. Anna Vitória');
  assert.equal(shortBusinessName('Clínica de Estética Dra. Rayane Havilla - Botox e Preenchimento Facial'), 'Clínica de Estética Dra. Rayane Havilla'.slice(0, 29).replace(/\s\S*$/, '') + '…');
  const long = shortBusinessName('Clínica Odontológica Especializada em Implantes Dentários e Reabilitação');
  assert.ok(long.length <= 30 && long.endsWith('…') && !long.slice(0, -1).endsWith(' '));
  assert.equal(shortBusinessName('Barbearia Goyaz'), 'Barbearia Goyaz');
});

test('Inter: a vírgula decimal não é sobreposta ao dígito (script latino forçado na composição)', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fontkit = require('fontkit') as { openSync: (file: string) => unknown };
  const file = path.join(process.cwd(), 'assets', 'fonts', 'Inter-400.woff');
  // Sem a correção, o fontkit trata "57,1%" como script padrão e dobra o kerning de "7," e ",1".
  const raw = fontkit.openSync(file) as unknown as { layout: (text: string) => { positions: { xAdvance: number }[] } };
  assert.equal(raw.layout('57,1%').positions[1]?.xAdvance, 647, 'comportamento original do fontkit (defeito)');

  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const { fonts, mode } = registerFonts(doc, 'inter');
  assert.equal(mode, 'inter');
  for (const weight of ['regular', 'medium', 'semibold', 'bold'] as const) {
    const patched = (doc.font(fonts[weight]) as unknown as { _font: { font: { layout: (text: string) => { positions: { xAdvance: number }[] } } } })._font.font;
    const alone = patched.layout('57,1%').positions.map((p) => p.xAdvance);
    const inSentence = patched.layout('Lidera 28 pontos (57,1%').positions.map((p) => p.xAdvance).slice(-5);
    // O mesmo trecho recebe o mesmo kerning sozinho e dentro de uma frase
    assert.deepEqual(alone.slice(0, 4), inSentence.slice(0, 4), weight);
  }
  const regular = (doc.font(fonts.regular) as unknown as { _font: { font: { layout: (text: string) => { positions: { xAdvance: number }[] } } } })._font.font;
  assert.equal(regular.layout('57,1%').positions[1]?.xAdvance, 903);
  assert.equal(regular.layout('0,1').positions[1]?.xAdvance, 413);
  // A correção não altera texto sem dígitos
  assert.equal(regular.layout('AV').positions[0]?.xAdvance, raw.layout('AV').positions[0]?.xAdvance);
});

/* ------------- identificação de testes/demonstração e pontuações separadas no PDF ------------- */

import { reevaluateForReport } from '../src/lib/pdf/reevaluate';

const fmtPct = (value: number): string => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

test('PDF de fixture: faixa de teste em todas as páginas e nenhuma atribuição ao Serper', async () => {
  for (const dataStyle of ['simulated', 'phase4', 'phase4-live'] as const) {
    const { rendered, text } = await render({ dataStyle });
    const flatText = flat(text);
    assert.equal(
      (text.match(/DOCUMENTO DE TESTE · DADOS SINTÉTICOS · NÃO É O RESULTADO DE UMA AUDITORIA/g) ?? []).length,
      rendered.pageCount,
      `${dataStyle}: uma faixa por página`
    );
    assert.match(flatText, /DOCUMENTO DE TESTE \(dados sintéticos\) · Auditoria/);
    // "Serper" só pode aparecer em frases que o NEGAM
    const withoutDenials = flatText
      .replace(/NENHUMA CONSULTA REAL AO SERPER/g, '')
      .replace(/Nenhuma consulta foi feita ao Serper nem a qualquer outro provedor/g, '')
      .replace(/não vieram de nenhuma consulta real ao Serper ou a outro provedor/g, '')
      // limitação do provedor (o Serper Maps não informa fotos/vídeos/posts): não é atribuição de dado
      .replace(/o Serper Maps não expõe esses dados/g, '');
    assert.doesNotMatch(withoutDenials, /Serper/, dataStyle);
    assert.match(flatText, /Dados sintéticos de teste \(fixture\)/);
  }
});

test('PDF de auditoria (não fixture): sem faixa de teste; modo demonstração tem a sua própria faixa', async () => {
  const { text, rendered } = await render({ dataStyle: 'phase4' }, undefined, undefined, {}, true);
  assert.doesNotMatch(text, /DOCUMENTO DE TESTE|MODO DEMONSTRAÇÃO/);
  assert.ok(rendered.pageCount > 0);

  const native = await buildReportFixture({ dataStyle: 'phase4' });
  const { testFixture: _fixture, ...asAudit } = native;
  void _fixture;
  const demoSource = { ...asAudit, battlefield: { ...native.battlefield, dataOrigin: 'SIMULATED' as const } };
  const model = buildReportModel({ source: demoSource, generatedAt: GENERATED_AT });
  const demo = await renderReportPdf(model, { fonts: 'standard', compress: false, basemap: { provider: noBasemapProvider, status: 'NONE', notice: null } });
  const demoText = joined(demo.buffer);
  assert.equal((demoText.match(/MODO DEMONSTRAÇÃO · DADOS SIMULADOS · NÃO REPRESENTAM A EMPRESA REAL/g) ?? []).length, demo.pageCount);
  assert.match(flat(demoText), /MODO DEMONSTRAÇÃO \(dados simulados\) · Auditoria/);
});

test('PDF reavaliado: o score histórico armazenado e o recalculado aparecem em blocos separados, com denominadores', async () => {
  const legacy = await buildReportFixture({ dataStyle: 'simulated' });
  const reevaluated = await reevaluateForReport({ source: legacy, lead: legacy.lead });
  const model = buildReportModel({ source: reevaluated, generatedAt: GENERATED_AT, regenerated: true });
  const rendered = await renderReportPdf(model, { fonts: 'standard', compress: false, basemap: { provider: noBasemapProvider, status: 'NONE', notice: null } });
  const text = flat(joined(rendered.buffer));

  const [stored, recalculated] = model.judge.scoreLines;
  assert.match(text, /SCORE JUIZ HISTÓRICO \(ARMAZENADO\)/);
  assert.match(text, /PONTUAÇÃO RECALCULADA \(METODOLOGIA DA FASE 4\)/);
  assert.match(text, /DESEMPENHO NOS CRITÉRIOS VERIFICADOS/);
  // O valor histórico (armazenado) aparece sob o rótulo histórico; o recalculado, sob o rótulo recalculado.
  const storedBlock = text.slice(text.indexOf('SCORE JUIZ HISTÓRICO (ARMAZENADO)'), text.indexOf('PONTUAÇÃO RECALCULADA (METODOLOGIA DA FASE 4)'));
  assert.ok(storedBlock.includes(fmtPct(stored?.value ?? -1)), 'valor armazenado dentro do bloco histórico');
  assert.match(storedBlock, /denominador: peso 102 \(100% do total\)/);
  assert.ok(!storedBlock.includes(fmtPct(recalculated?.value ?? -1)) || fmtPct(recalculated?.value ?? -1) === fmtPct(stored?.value ?? -2));
  const recalculatedBlock = text.slice(text.indexOf('PONTUAÇÃO RECALCULADA (METODOLOGIA DA FASE 4)'), text.indexOf('DESEMPENHO NOS CRITÉRIOS VERIFICADOS', text.indexOf('PONTUAÇÃO RECALCULADA (METODOLOGIA DA FASE 4)')));
  assert.ok(recalculatedBlock.includes(fmtPct(recalculated?.value ?? -1)));
  assert.match(recalculatedBlock, new RegExp(`denominador: peso ${recalculated?.denominatorWeight} `));
  assert.match(text, /preservado e não recalculado neste documento/);
});

test('nenhum texto do relatório contém caractere sem glifo na Inter (viraria "?" no PDF)', async () => {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const { fonts, mode } = registerFonts(doc, 'inter');
  assert.equal(mode, 'inter');
  const sanitize = createSanitizer(doc, fonts, mode);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const dataStyle of ['simulated', 'phase4', 'phase4-live'] as const) {
    const legacy = await buildReportFixture({ dataStyle });
    const reevaluated = await reevaluateForReport({ source: legacy, lead: legacy.lead });
    for (const source of [legacy, reevaluated]) walk(buildReportModel({ source, generatedAt: GENERATED_AT }));
  }
  const bad = [...new Set(strings)].filter((text) => !text.includes('?') && sanitize(text).includes('?'));
  assert.deepEqual(bad.map((text) => text.slice(0, 120)), []);
});
