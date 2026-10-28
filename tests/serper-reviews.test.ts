import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeReviewSample,
  deriveServiceTerms,
  fetchSerperReviews,
  parseRelativeAge,
  parseSerperReviewsResponse,
  readSerperReviewsConfig,
  type ParsedReview,
  type ReviewsFetcher,
} from '../src/lib/serper-reviews';

/*
 * ATENÇÃO: o formato da resposta do Serper Reviews NÃO foi confirmado em documentação oficial.
 * As respostas abaixo são HIPOTÉTICAS (fixtures de teste). Nenhuma chamada real é feita.
 */
const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const ON = { enabled: true, apiKey: 'fixture-key-nao-real', url: 'https://example.invalid/reviews', maxPages: 2 };

function pages(...responses: unknown[]): { fetcher: ReviewsFetcher; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      const payload = responses[Math.min(index++, responses.length - 1)];
      return { ok: true, status: 200, json: async () => payload };
    },
  };
}

test('desligado por padrão: sem GMN_REVIEWS_PROVIDER nenhuma chamada é feita', async () => {
  const config = readSerperReviewsConfig({ SERPER_API_KEY: 'uma-chave-qualquer-1234567' });
  assert.equal(config.enabled, false);
  const { fetcher, calls } = pages({});
  const outcome = await fetchSerperReviews({ featureId: '0x1:0x2', placeId: 'p', cid: null }, config, fetcher);
  assert.equal(outcome.state, 'DISABLED');
  assert.equal(calls.length, 0);
});

test('ligado exige chave válida e o identificador fid; senão não consulta', async () => {
  const noKey = readSerperReviewsConfig({ GMN_REVIEWS_PROVIDER: 'serper', SERPER_API_KEY: 'cole-sua-api-key-aqui' });
  assert.equal(noKey.apiKey, null);
  const { fetcher, calls } = pages({});
  assert.equal((await fetchSerperReviews({ featureId: 'x', placeId: 'p', cid: null }, noKey, fetcher)).state, 'DISABLED');
  assert.equal((await fetchSerperReviews({ featureId: null, placeId: 'p', cid: null }, ON, fetcher)).state, 'MISSING_IDENTIFIER');
  assert.equal(calls.length, 0);
});

test('limite de páginas protege o custo: padrão 1, máximo 5', () => {
  assert.equal(readSerperReviewsConfig({ GMN_REVIEWS_PROVIDER: 'serper', SERPER_API_KEY: 'k'.repeat(20) }).maxPages, 1);
  assert.equal(readSerperReviewsConfig({ GMN_REVIEWS_PROVIDER: 'serper', SERPER_API_KEY: 'k'.repeat(20), GMN_REVIEWS_MAX_PAGES: '3' }).maxPages, 3);
  assert.equal(readSerperReviewsConfig({ GMN_REVIEWS_PROVIDER: 'serper', SERPER_API_KEY: 'k'.repeat(20), GMN_REVIEWS_MAX_PAGES: '50' }).maxPages, 1);
});

test('requisição: envia fid, ordenação por mais recentes e o token da próxima página, sem exceder o limite', async () => {
  const { fetcher, calls } = pages(
    { reviews: [{ rating: 5, isoDate: daysAgo(2) }], nextPageToken: 'tok1' },
    { reviews: [{ rating: 4, isoDate: daysAgo(40) }], nextPageToken: 'tok2' }
  );
  const outcome = await fetchSerperReviews({ featureId: '0xabc:0xdef', placeId: 'ChIJ1', cid: '99' }, ON, fetcher, () => NOW);
  assert.equal(outcome.state, 'FETCHED');
  assert.equal(calls.length, 2, 'respeita maxPages');
  assert.equal(calls[0]?.body.fid, '0xabc:0xdef');
  assert.equal(calls[0]?.body.sortBy, 'newest');
  assert.equal(calls[0]?.body.nextPageToken, undefined);
  assert.equal(calls[1]?.body.nextPageToken, 'tok1');
  if (outcome.state === 'FETCHED') {
    assert.equal(outcome.exhausted, false, 'ainda havia próxima página');
    assert.equal(outcome.reviews.length, 2);
  }
});

test('falha de rede ou HTTP: resultado FAILED com o motivo, sem inventar avaliações', async () => {
  const http: ReviewsFetcher = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const failed = await fetchSerperReviews({ featureId: 'x', placeId: 'p', cid: null }, ON, http);
  assert.equal(failed.state, 'FAILED');
  if (failed.state === 'FAILED') {
    assert.equal(failed.httpStatus, 429);
    assert.equal(failed.reviews.length, 0);
  }
  const net: ReviewsFetcher = async () => { throw new Error('ETIMEDOUT'); };
  const down = await fetchSerperReviews({ featureId: 'x', placeId: 'p', cid: null }, ON, net);
  assert.equal(down.state === 'FAILED' && /ETIMEDOUT/.test(down.reason), true);
  const notJson: ReviewsFetcher = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  assert.equal((await fetchSerperReviews({ featureId: 'x', placeId: 'p', cid: null }, ON, notJson)).state, 'FAILED');
});

test('falha na segunda página preserva as avaliações já obtidas', async () => {
  let call = 0;
  const flaky: ReviewsFetcher = async () => {
    if (call++ === 0) return { ok: true, status: 200, json: async () => ({ reviews: [{ isoDate: daysAgo(1) }], nextPageToken: 't' }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const outcome = await fetchSerperReviews({ featureId: 'x', placeId: 'p', cid: null }, ON, flaky);
  assert.equal(outcome.state, 'FAILED');
  if (outcome.state === 'FAILED') {
    assert.equal(outcome.reviews.length, 1);
    assert.equal(outcome.pagesFetched, 1);
  }
});

test('interpretador defensivo: campos ausentes ou inesperados não geram datas nem respostas', () => {
  const none = parseSerperReviewsResponse({ qualquer: 'coisa' }, NOW);
  assert.equal(none.reviews.length, 0);
  assert.match(none.warnings[0] ?? '', /lista "reviews"/);

  const page = parseSerperReviewsResponse({ reviews: [{ rating: 5 }, 'lixo', null, { isoDate: 'não é data', date: 'quando?' }] }, NOW);
  assert.equal(page.reviews.length, 2);
  assert.ok(page.reviews.every((r) => r.dateBasis === 'NONE' && r.ageDaysMin === null));
  assert.ok(page.warnings.some((w) => /ignoradas/.test(w)));
  assert.ok(page.warnings.some((w) => /data utilizável/.test(w)));
});

test('datas relativas viram intervalos, sem falsa precisão', () => {
  assert.deepEqual(parseRelativeAge('há 3 dias'), { min: 3, max: 3 });
  assert.deepEqual(parseRelativeAge('3 days ago'), { min: 3, max: 3 });
  assert.deepEqual(parseRelativeAge('há 2 semanas'), { min: 14, max: 20 });
  assert.deepEqual(parseRelativeAge('um mês atrás'), { min: 30, max: 59 });
  assert.deepEqual(parseRelativeAge('a month ago'), { min: 30, max: 59 });
  assert.deepEqual(parseRelativeAge('há 2 anos'), { min: 730, max: 1094 });
  assert.deepEqual(parseRelativeAge('há 5 horas'), { min: 0, max: 1 });
  assert.equal(parseRelativeAge('editado ontem'), null);
  assert.equal(parseRelativeAge(''), null);
});

const review = (ageMin: number, ageMax: number, reply = true, text: string | null = 'Ótimo serviço de implante'): ParsedReview => ({
  rating: 5, text, ageDaysMin: ageMin, ageDaysMax: ageMax, dateBasis: 'ISO', hasOwnerReply: reply, ownerReplyFieldPresent: true,
});

test('recência: só é calculada quando a janela de 30 dias está coberta com datas confiáveis', () => {
  // Amostra que chega a datas anteriores à janela: cobertura completa da janela.
  const covered = analyzeReviewSample({
    reviews: [review(1, 2), review(10, 11), review(25, 26), review(45, 46), review(80, 81)],
    profileTotalReviews: 200,
    exhausted: false,
  });
  assert.equal(covered.windowCovered, true);
  assert.equal(covered.countLast30Days, 3);
  assert.equal(covered.countLast30DaysIsLowerBound, false);
  assert.equal(covered.sampleIsComplete, false);

  // Amostra que NÃO alcança os 30 dias: o número seria apenas um mínimo e a janela não está coberta.
  const short = analyzeReviewSample({ reviews: [review(1, 2), review(3, 4), review(5, 6)], profileTotalReviews: 200, exhausted: false });
  assert.equal(short.windowCovered, false);
  assert.equal(short.countLast30DaysIsLowerBound, true);
  assert.ok(short.limitations.some((l) => /apenas um mínimo/.test(l)));
});

test('amostra parcial nunca é apresentada como total do perfil', () => {
  const analysis = analyzeReviewSample({ reviews: [review(1, 2), review(50, 51)], profileTotalReviews: 100, exhausted: true });
  assert.equal(analysis.sampleIsComplete, false, '"sem próxima página" não basta: a API devolveu 2 de 100');
  assert.ok(analysis.limitations.some((l) => /Amostra de 2 de 100/.test(l)));
  const complete = analyzeReviewSample({ reviews: Array.from({ length: 95 }, (_, i) => review(i, i + 1)), profileTotalReviews: 100, exhausted: true });
  assert.equal(complete.sampleIsComplete, true);
});

test('datas ausentes ou imprecisas impedem a janela coberta', () => {
  const undated: ParsedReview = { rating: 5, text: 'x', ageDaysMin: null, ageDaysMax: null, dateBasis: 'NONE', hasOwnerReply: false, ownerReplyFieldPresent: true };
  const a = analyzeReviewSample({ reviews: [review(1, 2), undated, review(60, 61)], profileTotalReviews: 3, exhausted: true });
  assert.equal(a.windowCovered, false);
  assert.ok(a.limitations.some((l) => /sem data utilizável/.test(l)));
  // "um mês atrás" (30 a 59 dias) cruza o limite da janela: ambíguo
  const b = analyzeReviewSample({ reviews: [review(1, 2), review(30, 59), review(90, 91)], profileTotalReviews: 3, exhausted: true });
  assert.equal(b.ambiguousDates, 1);
  assert.equal(b.windowCovered, false);
});

test('taxa de resposta: sem o campo de resposta na API ela fica indisponível (ausência do campo não é "sem resposta")', () => {
  const noField = (age: number): ParsedReview => ({ ...review(age, age + 1, false), ownerReplyFieldPresent: false });
  const unknown = analyzeReviewSample({ reviews: [noField(1), noField(2), noField(60)], profileTotalReviews: 3, exhausted: true });
  assert.equal(unknown.ownerResponseRatePercent, null);
  assert.ok(unknown.limitations.some((l) => /não enviou o campo de resposta/.test(l)));

  const known = analyzeReviewSample({ reviews: [review(1, 2, true), review(2, 3, false), review(60, 61, false), review(70, 71, true)], profileTotalReviews: 4, exhausted: true });
  assert.equal(known.ownerResponseRatePercent, 50);
  assert.equal(known.ownerReplies, 2);
});

test('termos de serviço: contados apenas nos textos reais da amostra', () => {
  const terms = deriveServiceTerms('Clínica Odontológica', 'implante dentário');
  assert.ok(terms.includes('odontologica') && terms.includes('implante') && terms.includes('dentario'));
  assert.ok(!terms.includes('clinica'), 'palavra genérica ignorada');
  const analysis = analyzeReviewSample({
    reviews: [review(1, 2, false, 'Fiz um implante e adorei'), review(2, 3, false, 'Atendimento educado'), review(3, 4, false, null)],
    profileTotalReviews: 3,
    exhausted: true,
    serviceTerms: terms,
  });
  assert.equal(analysis.textsAvailable, 2);
  assert.equal(analysis.reviewsMentioningTerms, 1);
  const noTerms = analyzeReviewSample({ reviews: [review(1, 2)], profileTotalReviews: 1, exhausted: true });
  assert.equal(noTerms.reviewsMentioningTerms, null);
});
