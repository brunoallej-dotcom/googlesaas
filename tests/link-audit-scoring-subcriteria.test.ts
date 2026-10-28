import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreAudit, type SubcriterionId, type SubcriterionState } from '../src/lib/link-audit/scoring';
import type { Mutable } from './helpers/link-audit-fixtures';
import { clone, evidence, obs, record, REF, richInput, run, SHA, sub, without } from './helpers/link-audit-scoring-fixtures';

/* ---------------------------------------------------------------- utilitários */
const daysAgo = (n: number): string => new Date(Date.UTC(2026, 9, 22) - n * 86_400_000).toISOString().slice(0, 10);
const setP = (key: string, list: unknown) => (d: Mutable) => {
  d.profile[key] = list;
};
const reviews = (rating: string | null, count: number, complete = true) => (d: Mutable) => {
  d.profile.reviews = [obs({ ratingShown: rating, reviewCount: count }, { complete })];
  delete d.profile.replies; // o total de avaliações mudou: as respostas lidas deixam de ser coerentes
};
const noAttestation = (d: Mutable) => {
  d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.kind !== 'SITE_SCOPE_ATTESTATION');
};
const limitedScope = (d: Mutable) => {
  noAttestation(d);
  d.site.scope = { kind: 'ROOT_ONLY', pagesRead: [{ url: 'https://exemplo.com.br/', status: 200, sha256: SHA, fetchedAt: '2026-10-21T10:00:00-03:00' }], requestCap: 8, capReached: false, blockers: [], limitations: [] };
};

interface Case {
  readonly name: string;
  readonly id: SubcriterionId;
  readonly mutate?: (d: Mutable) => void;
  readonly state: SubcriterionState;
  readonly half: number;
  readonly code?: string;
}

function check(cases: readonly Case[]): void {
  for (const c of cases) {
    const result = run(c.mutate);
    const s = sub(result, c.id);
    assert.equal(s.state, c.state, `${c.name}: estado de ${c.id} (${s.reasonCode}: ${s.reason})`);
    assert.equal(s.obtainedHalfPoints, c.half, `${c.name}: pontos de ${c.id}`);
    if (c.code) assert.equal(s.reasonCode, c.code, `${c.name}: motivo de ${c.id}`);
    if (c.state === 'SCORED' || c.state === 'ABSENCE_PROVEN') assert.equal(s.evaluatedHalfPoints, s.maxHalfPoints, `${c.name}: avaliados`);
    else assert.equal(s.evaluatedHalfPoints, 0, `${c.name}: fora do denominador`);
  }
}

function rejected(mutate: (d: Mutable) => void, pattern: RegExp): void {
  const draft = clone(richInput());
  mutate(draft);
  const outcome = scoreAudit(draft);
  assert.equal(outcome.ok, false, 'a entrada deveria ser recusada');
  if (!outcome.ok) assert.ok(outcome.issues.some((issue) => pattern.test(issue)), `esperava ${pattern}, veio: ${outcome.issues.join(' | ')}`);
}

const addr = (parsed: Mutable | undefined, complete = true) => setP('address', [obs({ raw: 'Rua X', ...(parsed ? { parsed } : {}) }, { complete })]);

/* ---------------------------------------------------------------- NAP */
test('N1/N3: presença, ausência comprovada, leitura incompleta e sem observação', () => {
  for (const [id, key] of [['N1', 'name'], ['N3', 'phone']] as const) {
    check([
      { name: `${id} presente`, id, state: 'SCORED', half: 6, code: 'PRESENT' },
      { name: `${id} vazio e lido por inteiro`, id, mutate: setP(key, [obs(null)]), state: 'ABSENCE_PROVEN', half: 0 },
      { name: `${id} vazio e incompleto`, id, mutate: setP(key, [obs(null, { complete: false })]), state: 'NOT_VERIFIED', half: 0, code: 'FIELD_NOT_EXPOSED_OR_INCOMPLETE' },
      { name: `${id} sem observação`, id, mutate: without(key), state: 'NOT_VERIFIED', half: 0, code: 'NO_OBSERVATION' },
    ]);
  }
});

test('N2: endereço completo, incompleto, área de atendimento, ausência e texto indecidível', () => {
  check([
    { name: 'completo', id: 'N2', state: 'SCORED', half: 6 },
    { name: 'sem número', id: 'N2', mutate: addr({ street: 'Rua X', city: 'Cidade' }), state: 'SCORED', half: 3 },
    { name: 'só área de atendimento', id: 'N2', mutate: addr({ serviceArea: true }), state: 'SCORED', half: 6 },
    { name: 'perfil declara que não há endereço, lido por inteiro', id: 'N2', mutate: addr({ none: true }), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'texto existe mas a decomposição não decide: Não verificado, nunca zero', id: 'N2', mutate: addr({}), state: 'NOT_VERIFIED', half: 0, code: 'ADDRESS_UNPARSED' },
    { name: 'declara ausência, mas a leitura é incompleta', id: 'N2', mutate: addr({ none: true }, false), state: 'NOT_VERIFIED', half: 0, code: 'ADDRESS_UNPARSED' },
    { name: 'texto sem decomposição', id: 'N2', mutate: addr(undefined), state: 'NOT_VERIFIED', half: 0, code: 'ADDRESS_UNPARSED' },
  ]);
});

test('N4: horários (7 dias, 24 h, parciais, ausentes, incompletos e em texto livre)', () => {
  const days = (n: number) => ({ kind: 'STRUCTURED', days: Array.from({ length: n }, (_, day) => ({ day, closed: false, intervals: [['09:00', '18:00']] })) });
  check([
    { name: '7 dias', id: 'N4', state: 'SCORED', half: 4 },
    { name: '24 horas', id: 'N4', mutate: setP('hours', [obs({ kind: 'STRUCTURED', alwaysOpen: true, days: [] })]), state: 'SCORED', half: 4 },
    { name: '3 dias lidos por inteiro', id: 'N4', mutate: setP('hours', [obs(days(3))]), state: 'SCORED', half: 2 },
    { name: '3 dias, leitura incompleta', id: 'N4', mutate: setP('hours', [obs(days(3), { complete: false })]), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: '7 dias, leitura incompleta (já é o máximo)', id: 'N4', mutate: setP('hours', [obs(days(7), { complete: false })]), state: 'SCORED', half: 4 },
    { name: 'nenhum dia, lido por inteiro', id: 'N4', mutate: setP('hours', [obs(days(0))]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'texto livre', id: 'N4', mutate: setP('hours', [obs({ kind: 'TEXT', raw: 'seg a sex' })]), state: 'NOT_VERIFIED', half: 0, code: 'HOURS_UNSTRUCTURED' },
  ]);
});

const napSource = (fields: Mutable) => (d: Mutable) => {
  d.nap = { sources: [{ sourceId: 'src-a', kind: 'SITE', evidenceIds: ['site1'], ...fields }] };
};
test('N5: consistência entre fontes (0, 1, 2 e 3 divergências; ambíguo; poucos campos; equivalência de nomes)', () => {
  const same = { name: 'Padaria Exemplo', phone: '62 3233-7847', address: 'Rua das Flores, 100 Centro Cidade Exemplo GO 75000-000' };
  check([
    { name: '0 divergências', id: 'N5', state: 'SCORED', half: 8 },
    { name: '1 divergência (telefone)', id: 'N5', mutate: napSource({ ...same, phone: '62 9999-0000' }), state: 'SCORED', half: 5 },
    { name: '2 divergências (telefone e nome)', id: 'N5', mutate: napSource({ ...same, phone: '62 9999-0000', name: 'Outro Nome Ltda' }), state: 'SCORED', half: 2 },
    { name: '3 divergências (telefone, nome e endereço)', id: 'N5', mutate: napSource({ phone: '62 9999-0000', name: 'Outro Nome Ltda', address: 'Av. Brasil, 999, Outra Cidade' }), state: 'SCORED', half: 0 },
    { name: 'só um campo comparável', id: 'N5', mutate: napSource({ name: 'Padaria Exemplo' }), state: 'NOT_VERIFIED', half: 0, code: 'NAP_NOT_COMPARABLE' },
    { name: 'sem fontes externas', id: 'N5', mutate: (d) => delete d.nap, state: 'NOT_VERIFIED', half: 0, code: 'NAP_NOT_COMPARABLE' },
    { name: 'telefone sem DDD é ambíguo, não divergente (só 1 campo comparável)', id: 'N5', mutate: napSource({ name: 'Padaria Exemplo', phone: '3233-7847' }), state: 'NOT_VERIFIED', half: 0, code: 'NAP_NOT_COMPARABLE' },
    { name: 'telefone sem DDD não conta como divergência', id: 'N5', mutate: napSource({ ...same, phone: '3233-7847' }), state: 'SCORED', half: 8 },
    { name: 'endereço parcialmente sobreposto é ambíguo', id: 'N5', mutate: napSource({ name: 'Padaria Exemplo', phone: '62 3233-7847', address: 'Rua das Flores' }), state: 'SCORED', half: 8 },
    {
      name: 'o operador registra que dois nomes são equivalentes',
      id: 'N5',
      mutate: (d) => {
        napSource({ ...same, name: 'PADARIA EXEMPLO COMÉRCIO LTDA' })(d);
        d.operatorRecords.push(record('NAME_EQUIVALENCE', 'op-name', { nameA: 'Padaria Exemplo', nameB: 'PADARIA EXEMPLO COMÉRCIO LTDA' }));
      },
      state: 'SCORED',
      half: 8,
    },
    { name: 'sem equivalência registrada, o nome diverge', id: 'N5', mutate: napSource({ ...same, name: 'PADARIA EXEMPLO COMÉRCIO LTDA' }), state: 'SCORED', half: 5 },
    { name: 'fonte externa com evidência não verificada é ignorada', id: 'N5', mutate: (d) => { d.evidences.find((e: Mutable) => e.id === 'site1').status = 'PARTIAL'; }, state: 'NOT_VERIFIED', half: 0 },
  ]);
  const cep = napSource({ name: 'Padaria Exemplo', phone: '62 3233-7847', address: 'Rua das Flores, 100 Centro 75999-999' });
  assert.equal(sub(run(cep), 'N5').obtainedHalfPoints, 5, 'CEP diferente é divergência inequívoca de endereço');
});

/* ---------------------------------------------------------------- Categorias */
test('C1/C2/C3: categoria principal, compatibilidade e adicionais (sem penalizar a quantidade)', () => {
  const judgement = (id: string, subcriterionId: string, value: string, extra: Mutable = {}) => record('JUDGEMENT', id, { subcriterionId, value, ...extra });
  const swap = (subId: string, value: string) => (d: Mutable) => {
    d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'JUDGEMENT' && r.subcriterionId === subId ? { ...r, value } : r));
  };
  check([
    { name: 'C1 presente', id: 'C1', state: 'SCORED', half: 6 },
    { name: 'C1 ausente comprovada', id: 'C1', mutate: setP('primaryCategory', [obs(null)]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'C2 compatível', id: 'C2', state: 'SCORED', half: 8 },
    { name: 'C2 parcial', id: 'C2', mutate: swap('C2', 'PARTIAL'), state: 'SCORED', half: 4 },
    { name: 'C2 incompatível (faixa zero, não ausência)', id: 'C2', mutate: swap('C2', 'INCOMPATIBLE'), state: 'SCORED', half: 0 },
    { name: 'C2 sem confirmação do operador', id: 'C2', mutate: (d) => { d.operatorRecords = d.operatorRecords.filter((r: Mutable) => !(r.kind === 'JUDGEMENT' && r.subcriterionId === 'C2')); }, state: 'NOT_VERIFIED', half: 0, code: 'OPERATOR_CONFIRMATION_REQUIRED' },
    { name: 'C2 sem categoria principal', id: 'C2', mutate: without('primaryCategory'), state: 'NOT_VERIFIED', half: 0, code: 'BASIS_MISSING' },
    { name: 'C3 todas pertinentes', id: 'C3', state: 'SCORED', half: 6 },
    { name: 'C3 seis adicionais pertinentes: sem penalidade por quantidade', id: 'C3', mutate: setP('additionalCategories', [obs(['a', 'b', 'c', 'd', 'e', 'f'])]), state: 'SCORED', half: 6 },
    { name: 'C3 maioria pertinente', id: 'C3', mutate: swap('C3', 'MOSTLY_RELEVANT'), state: 'SCORED', half: 3 },
    { name: 'C3 maioria incoerente', id: 'C3', mutate: swap('C3', 'MOSTLY_IRRELEVANT'), state: 'SCORED', half: 0 },
    { name: 'C3 lista incompleta', id: 'C3', mutate: setP('additionalCategories', [obs(['a'], { complete: false })]), state: 'NOT_VERIFIED', half: 0, code: 'FIELD_NOT_EXPOSED_OR_INCOMPLETE' },
    { name: 'C3 sem confirmação do operador', id: 'C3', mutate: (d) => { d.operatorRecords = d.operatorRecords.filter((r: Mutable) => !(r.kind === 'JUDGEMENT' && r.subcriterionId === 'C3')); }, state: 'NOT_VERIFIED', half: 0, code: 'OPERATOR_CONFIRMATION_REQUIRED' },
    {
      name: 'C3 nenhuma adicional necessária => N/A',
      id: 'C3',
      mutate: (d) => {
        d.profile.additionalCategories = [obs([])];
        d.operatorRecords = d.operatorRecords.filter((r: Mutable) => !(r.kind === 'JUDGEMENT' && r.subcriterionId === 'C3'));
        d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-c3', { subcriterionIds: ['C3'], code: 'NO_ADDITIONAL_NEEDED' }));
      },
      state: 'NOT_APPLICABLE',
      half: 0,
      code: 'NO_ADDITIONAL_NEEDED',
    },
    {
      name: 'C3 lista vazia e o operador registra que faltam => ausência comprovada',
      id: 'C3',
      mutate: (d) => {
        d.profile.additionalCategories = [obs([])];
        d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'JUDGEMENT' && r.subcriterionId === 'C3' ? { ...r, value: 'MISSING_NEEDED' } : r));
      },
      state: 'ABSENCE_PROVEN',
      half: 0,
    },
    {
      name: 'C3 lista vazia sem nenhum registro',
      id: 'C3',
      mutate: (d) => {
        d.profile.additionalCategories = [obs([])];
        d.operatorRecords = d.operatorRecords.filter((r: Mutable) => !(r.kind === 'JUDGEMENT' && r.subcriterionId === 'C3'));
      },
      state: 'NOT_VERIFIED',
      half: 0,
      code: 'OPERATOR_CONFIRMATION_REQUIRED',
    },
  ]);
  rejected((d) => { d.profile.additionalCategories = [obs([])]; }, /C3 com lista vazia/);
  rejected((d) => { d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'JUDGEMENT' && r.subcriterionId === 'C3' ? { ...r, value: 'MISSING_NEEDED' } : r)); }, /MISSING_NEEDED é inconsistente/);
  rejected((d) => { d.operatorRecords.push(judgement('op-x', 'C2', 'COMPATIBLE')); }, /mais de um juízo/);
  rejected((d) => { d.operatorRecords[0].value = 'TALVEZ'; }, /valor "TALVEZ" inválido/);
});

/* ---------------------------------------------------------------- Serviços */
test('S1–S4: faixas, ausência comprovada, leitura incompleta e N/A com causa provada', () => {
  const count = (key: string, value: number, complete = true) => setP(key, [obs(value, { complete })]);
  check([
    { name: 'S1 400 caracteres', id: 'S1', state: 'SCORED', half: 4 },
    { name: 'S1 250 caracteres', id: 'S1', mutate: setP('description', [obs({ lengthChars: 250 })]), state: 'SCORED', half: 4 },
    { name: 'S1 249 caracteres', id: 'S1', mutate: setP('description', [obs({ lengthChars: 249 })]), state: 'SCORED', half: 2 },
    { name: 'S1 sem descrição, lida por inteiro', id: 'S1', mutate: setP('description', [obs({ lengthChars: 0 })]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'S1 sem descrição, incompleta', id: 'S1', mutate: setP('description', [obs({ lengthChars: 0 }, { complete: false })]), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'S2 8 itens', id: 'S2', state: 'SCORED', half: 6 },
    { name: 'S2 4 itens', id: 'S2', mutate: count('services', 4), state: 'SCORED', half: 4 },
    { name: 'S2 2 itens', id: 'S2', mutate: count('services', 2), state: 'SCORED', half: 2 },
    { name: 'S2 nenhum', id: 'S2', mutate: count('services', 0), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'S2 3 itens com lista incompleta', id: 'S2', mutate: count('services', 3, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'S2 5 itens com lista incompleta (já é o máximo)', id: 'S2', mutate: count('services', 5, false), state: 'SCORED', half: 6 },
    { name: 'S3 3 atributos', id: 'S3', mutate: count('attributes', 3), state: 'SCORED', half: 4 },
    { name: 'S3 1 atributo', id: 'S3', mutate: count('attributes', 1), state: 'SCORED', half: 2 },
    { name: 'S4 2 produtos', id: 'S4', mutate: count('products', 2), state: 'SCORED', half: 2 },
    { name: 'S4 nenhum produto', id: 'S4', mutate: count('products', 0), state: 'ABSENCE_PROVEN', half: 0 },
    {
      name: 'S3 N/A (recurso indisponível para a categoria)',
      id: 'S3',
      mutate: (d) => {
        delete d.profile.attributes;
        d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-s3', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] }));
      },
      state: 'NOT_APPLICABLE',
      half: 0,
      code: 'FEATURE_UNAVAILABLE',
    },
    {
      name: 'S4 N/A (o negócio não vende produtos)',
      id: 'S4',
      mutate: (d) => {
        delete d.profile.products;
        d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-s4', { subcriterionIds: ['S4'], code: 'BUSINESS_MODEL' }));
      },
      state: 'NOT_APPLICABLE',
      half: 0,
      code: 'BUSINESS_MODEL',
    },
  ]);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] })); }, /causa é contrariada/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['S4'], code: 'BUSINESS_MODEL' })); }, /causa é contrariada/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE' })); delete d.profile.attributes; }, /exige evidência da causa/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', justification: 'curta' })); }, /justificativa exige pelo menos 20/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['R1'], code: 'NO_REVIEWS_PROVEN' })); }, /derivado pelos fatos/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na', { subcriterionIds: ['S4'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] })); }, /não se aplica a S4/);
});

/* ---------------------------------------------------------------- Avaliações */
test('R1: cada fronteira de nota (inclusive 4,80 / 4,79 / 2,99) e o estado Amostra insuficiente', () => {
  const boundaries: ReadonlyArray<readonly [string, number]> = [['5.00', 12], ['4.80', 12], ['4.79', 10], ['4.50', 10], ['4.49', 8], ['4.20', 8], ['4.19', 6], ['4.00', 6], ['3.99', 4], ['3.50', 4], ['3.49', 2], ['3.00', 2], ['2.99', 0], ['0', 0]];
  check(boundaries.map(([rating, half]) => ({ name: `nota ${rating}`, id: 'R1' as const, mutate: reviews(rating, 130), state: 'SCORED' as const, half })));
  check([
    { name: '5 avaliações já pontuam', id: 'R1', mutate: reviews('5.0', 5), state: 'SCORED', half: 12 },
    { name: '4 avaliações: amostra insuficiente', id: 'R1', mutate: reviews('5.0', 4), state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'REVIEWS_BELOW_MIN_SAMPLE' },
    { name: '1 avaliação: amostra insuficiente', id: 'R1', mutate: reviews('5.0', 1), state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'REVIEWS_BELOW_MIN_SAMPLE' },
    { name: '0 avaliações: não aplicável', id: 'R1', mutate: reviews(null, 0), state: 'NOT_APPLICABLE', half: 0, code: 'NO_REVIEWS_PROVEN' },
    { name: 'nota não lida com 130 avaliações', id: 'R1', mutate: reviews(null, 130), state: 'NOT_VERIFIED', half: 0, code: 'RATING_NOT_READ' },
    { name: 'contagem incompleta abaixo de 5', id: 'R1', mutate: reviews('5.0', 3, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
  ]);
  const shown = run(reviews('5.0', 3));
  const r1 = sub(shown, 'R1');
  assert.match(r1.notes.join(' '), /nota exibida: 5\.0; avaliações: 3/);
  assert.deepEqual(shown.displayData.reviews, { ratingShown: '5.0', reviewCount: 3 }, 'a nota continua exibida como dado verificado');
  assert.equal(shown.totals.sampleInsufficientHalfPoints, 12 + 6, 'R1 e L1 saem do denominador sem virar zero');
  assert.equal(sub(shown, 'R2').obtainedHalfPoints, 2, 'a quantidade (3) é fato e pontua em R2 (1–4 = 1 ponto)');
});

test('R2: fronteiras de volume e leitura incompleta', () => {
  const boundaries: ReadonlyArray<readonly [number, number]> = [[100, 12], [99, 10], [50, 10], [49, 8], [25, 8], [24, 6], [10, 6], [9, 4], [5, 4], [4, 2], [1, 2]];
  check(boundaries.map(([n, half]) => ({ name: `${n} avaliações`, id: 'R2' as const, mutate: reviews('4.9', n), state: 'SCORED' as const, half })));
  check([
    { name: '0 avaliações: ausência comprovada', id: 'R2', mutate: reviews(null, 0), state: 'ABSENCE_PROVEN', half: 0 },
    { name: '60 avaliações com leitura incompleta', id: 'R2', mutate: reviews('4.9', 60, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: '100 avaliações com leitura incompleta (já é o máximo)', id: 'R2', mutate: reviews('4.9', 100, false), state: 'SCORED', half: 12 },
  ]);
});

test('R3: fronteiras de recência, datas relativas (mesma faixa ou não) e sem avaliações', () => {
  const exact = (days: number) => setP('latestReviewDate', [obs({ kind: 'EXACT', date: daysAgo(days) })]);
  const rel = (amount: number, unit: string) => setP('latestReviewDate', [obs({ kind: 'RELATIVE', amount, unit })]);
  check([
    ...[[0, 12], [30, 12], [31, 8], [90, 8], [91, 4], [180, 4], [181, 2], [365, 2], [366, 0], [900, 0]].map(([d, half]) => ({ name: `${d} dias`, id: 'R3' as const, mutate: exact(d as number), state: 'SCORED' as const, half: half as number })),
    { name: 'há 2 dias (relativa, mesma faixa)', id: 'R3', mutate: rel(2, 'DAY'), state: 'SCORED', half: 12 },
    { name: 'há 1 semana (7–13 dias, mesma faixa)', id: 'R3', mutate: rel(1, 'WEEK'), state: 'SCORED', half: 12 },
    { name: 'há 3 meses (90–119 dias: faixas diferentes)', id: 'R3', mutate: rel(3, 'MONTH'), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'há 5 meses (150–179 dias, mesma faixa)', id: 'R3', mutate: rel(5, 'MONTH'), state: 'SCORED', half: 4 },
    { name: 'data não lida', id: 'R3', mutate: setP('latestReviewDate', [obs(null)]), state: 'NOT_VERIFIED', half: 0, code: 'DATE_NOT_AVAILABLE' },
    { name: 'sem avaliações: não aplicável', id: 'R3', mutate: reviews(null, 0), state: 'NOT_APPLICABLE', half: 0 },
  ]);
  const relative = sub(run(rel(2, 'DAY')), 'R3');
  assert.equal(relative.grade, 'SECONDARY', 'data relativa estimada rebaixa o grau da evidência');
  assert.equal(sub(run(rel(2, 'DAY')), 'R3').notes.some((note) => /relativa/.test(note)), true);
});

/* ---------------------------------------------------------------- Respostas */
const dropP3 = (d: Mutable) => {
  d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.id !== 'op-p3'); // a revisão humana de 5 respostas deixa de ser coerente
};
function replies(read: number, replied: number, extra: Mutable = {}) {
  return (d: Mutable) => {
    dropP3(d);
    d.profile.replies = [
      obs({
        ownerReplyFieldExposed: true,
        reviewsRead: read,
        allReviewsRead: false,
        repliedCount: replied,
        pairs: [
          { reviewDate: '2026-09-01', replyDate: '2026-09-02' },
          { reviewDate: '2026-09-05', replyDate: '2026-09-06' },
          { reviewDate: '2026-09-10', replyDate: '2026-09-12' },
        ].slice(0, replied),
        ...extra,
      }),
    ];
  };
}

test('P1: taxa de resposta, ausência comprovada, amostra pequena e campo não exposto', () => {
  check([
    { name: '9/10 = 90%', id: 'P1', mutate: replies(10, 9), state: 'SCORED', half: 8 },
    { name: '8/10 = 80%', id: 'P1', mutate: replies(10, 8), state: 'SCORED', half: 6 },
    { name: '7/10 = 70%', id: 'P1', mutate: replies(10, 7), state: 'SCORED', half: 6 },
    { name: '6/10 = 60%', id: 'P1', mutate: replies(10, 6), state: 'SCORED', half: 4 },
    { name: '5/10 = 50%', id: 'P1', mutate: replies(10, 5), state: 'SCORED', half: 4 },
    { name: '4/10 = 40%', id: 'P1', mutate: replies(10, 4), state: 'SCORED', half: 2 },
    { name: '1/10 = 10%', id: 'P1', mutate: replies(10, 1), state: 'SCORED', half: 2 },
    { name: '0/10: nenhuma respondida (campo exposto)', id: 'P1', mutate: replies(10, 0), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'só 9 avaliações lidas (amostra < 10)', id: 'P1', mutate: replies(9, 9), state: 'NOT_VERIFIED', half: 0, code: 'SAMPLE_TOO_SMALL' },
    { name: '5 avaliações, todas lidas', id: 'P1', mutate: (d) => { reviews('4.9', 5)(d); replies(5, 5, { allReviewsRead: true })(d); }, state: 'SCORED', half: 8 },
    { name: 'campo de resposta não exposto', id: 'P1', mutate: replies(10, 0, { ownerReplyFieldExposed: false }), state: 'NOT_VERIFIED', half: 0, code: 'REPLY_FIELD_NOT_EXPOSED' },
    { name: 'sem avaliações: não aplicável', id: 'P1', mutate: (d) => { reviews(null, 0)(d); }, state: 'NOT_APPLICABLE', half: 0, code: 'NO_REVIEWS_PROVEN' },
  ]);
  rejected(replies(10, 11), /respondidas maiores/);
  rejected((d) => { replies(10, 2, { ownerReplyFieldExposed: false })(d); }, /campo de resposta não exposto, mas há respostas/);
  rejected((d) => { d.profile.replies[0].value.allReviewsRead = true; }, /"todas as avaliações lidas" não confere/);
});

test('P2: mediana do tempo de resposta, datas insuficientes e sem respostas', () => {
  const pairs = (gaps: number[]) => (d: Mutable) => {
    dropP3(d);
    d.profile.replies = [obs({ ownerReplyFieldExposed: true, reviewsRead: 10, allReviewsRead: false, repliedCount: gaps.length, pairs: gaps.map((gap) => ({ reviewDate: '2026-08-01', replyDate: daysAfter('2026-08-01', gap) })) })];
  };
  function daysAfter(day: string, n: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  }
  check([
    { name: 'mediana 1 dia', id: 'P2', mutate: pairs([1, 1, 1]), state: 'SCORED', half: 4 },
    { name: 'mediana exatamente 7 dias', id: 'P2', mutate: pairs([1, 7, 30]), state: 'SCORED', half: 4 },
    { name: 'mediana 7,5 dias (média de 7 e 8)', id: 'P2', mutate: pairs([1, 7, 8, 30]), state: 'SCORED', half: 2 },
    { name: 'mediana 30 dias', id: 'P2', mutate: pairs([1, 30, 60]), state: 'SCORED', half: 2 },
    { name: 'mediana acima de 30 dias (faixa zero, não ausência)', id: 'P2', mutate: pairs([31, 40, 50]), state: 'SCORED', half: 0 },
    { name: 'só 2 pares com datas', id: 'P2', mutate: pairs([1, 2]), state: 'NOT_VERIFIED', half: 0, code: 'DATE_NOT_AVAILABLE' },
    { name: 'sem respostas existentes', id: 'P2', mutate: replies(10, 0), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_DERIVED' },
  ]);
});

test('P3: qualidade só com revisão humana registrada; sem respostas é N/A', () => {
  const swap = (value: string, sampleSize = 5) => (d: Mutable) => {
    d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'JUDGEMENT' && r.subcriterionId === 'P3' ? { ...r, value, sampleSize } : r));
  };
  check([
    { name: 'específicas', id: 'P3', state: 'SCORED', half: 4 },
    { name: 'genéricas ou mistas', id: 'P3', mutate: swap('GENERIC_OR_MIXED'), state: 'SCORED', half: 2 },
    { name: 'inadequadas', id: 'P3', mutate: swap('INAPPROPRIATE'), state: 'SCORED', half: 0 },
    { name: 'só 4 respostas revisadas (de 9)', id: 'P3', mutate: swap('SPECIFIC', 4), state: 'NOT_VERIFIED', half: 0, code: 'SAMPLE_TOO_SMALL' },
    { name: 'sem revisão registrada', id: 'P3', mutate: (d) => { d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.subcriterionId !== 'P3'); }, state: 'NOT_VERIFIED', half: 0, code: 'OPERATOR_CONFIRMATION_REQUIRED' },
    {
      name: 'nenhuma resposta existe => N/A derivado',
      id: 'P3',
      mutate: (d) => {
        replies(10, 0)(d);
        d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.subcriterionId !== 'P3');
      },
      state: 'NOT_APPLICABLE',
      half: 0,
      code: 'NO_REPLIES_PROVEN',
    },
  ]);
  rejected(swap('SPECIFIC', 12), /respostas revisadas \(12\) maiores/);
});

/* ---------------------------------------------------------------- Visuais */
test('V1–V3: logo e capa, fotos e vídeos (fronteiras, leitura incompleta e ausência)', () => {
  const lc = (logo: boolean, cover: boolean, complete = true) => setP('logoCover', [obs({ logo, cover }, { complete })]);
  const n = (key: string, value: number, complete = true) => setP(key, [obs(value, { complete })]);
  check([
    { name: 'V1 logo e capa', id: 'V1', state: 'SCORED', half: 4 },
    { name: 'V1 só logo', id: 'V1', mutate: lc(true, false), state: 'SCORED', half: 2 },
    { name: 'V1 nenhum, lido por inteiro', id: 'V1', mutate: lc(false, false), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'V1 só logo com leitura incompleta', id: 'V1', mutate: lc(true, false, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'V1 logo e capa com leitura incompleta (máximo)', id: 'V1', mutate: lc(true, true, false), state: 'SCORED', half: 4 },
    ...[[20, 6], [19, 4], [10, 4], [9, 2], [5, 2], [4, 1], [1, 1]].map(([v, half]) => ({ name: `V2 ${v} fotos`, id: 'V2' as const, mutate: n('photos', v as number), state: 'SCORED' as const, half: half as number })),
    { name: 'V2 nenhuma foto', id: 'V2', mutate: n('photos', 0), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'V2 12 fotos, leitura incompleta', id: 'V2', mutate: n('photos', 12, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'V2 20 fotos, leitura incompleta', id: 'V2', mutate: n('photos', 20, false), state: 'SCORED', half: 6 },
    { name: 'V3 2 vídeos', id: 'V3', state: 'SCORED', half: 2 },
    { name: 'V3 nenhum vídeo', id: 'V3', mutate: n('videos', 0), state: 'ABSENCE_PROVEN', half: 0 },
  ]);
});

test('V4: recência da mídia, mídia inexistente e leitura incompleta', () => {
  const media = (days: number, complete = true) => setP('latestMedia', [obs({ kind: 'EXACT', date: daysAgo(days) }, { complete })]);
  check([
    ...[[0, 4], [90, 4], [91, 2], [365, 2], [366, 0]].map(([d, half]) => ({ name: `${d} dias`, id: 'V4' as const, mutate: media(d as number), state: 'SCORED' as const, half: half as number })),
    { name: 'sem fotos nem vídeos, leitura completa', id: 'V4', mutate: (d) => { d.profile.photos = [obs(0)]; d.profile.videos = [obs(0)]; }, state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_DERIVED' },
    { name: 'mídia de 100 dias, leitura incompleta (pode haver mais nova)', id: 'V4', mutate: media(100, false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'mídia de 30 dias, leitura incompleta (já é o máximo)', id: 'V4', mutate: media(30, false), state: 'SCORED', half: 4 },
    { name: 'data não lida', id: 'V4', mutate: setP('latestMedia', [obs(null)]), state: 'NOT_VERIFIED', half: 0, code: 'DATE_NOT_AVAILABLE' },
  ]);
});

/* ---------------------------------------------------------------- Publicações */
function posts(items: Mutable[], over: { complete?: boolean; exposed?: boolean } = {}) {
  return setP('posts', [obs({ exposed: over.exposed ?? true, items }, { complete: over.complete ?? true })]);
}
const post = (days: number, extra: Mutable = {}): Mutable => ({ date: { kind: 'EXACT', date: daysAgo(days) }, ...extra });

test('A1: vigência, publicações antigas ou expiradas, lista vazia e N/A', () => {
  check([
    { name: 'publicação recente', id: 'A1', state: 'SCORED', half: 6 },
    { name: 'só publicações de 200 dias', id: 'A1', mutate: posts([post(200), post(300)]), state: 'SCORED', half: 2 },
    { name: 'limite de 180 dias ainda é vigente', id: 'A1', mutate: posts([post(180)]), state: 'SCORED', half: 6 },
    { name: '181 dias não é vigente', id: 'A1', mutate: posts([post(181)]), state: 'SCORED', half: 2 },
    { name: 'oferta expirada, mesmo recente, não é vigente', id: 'A1', mutate: posts([post(10, { expiresOn: daysAgo(2) })]), state: 'SCORED', half: 2 },
    { name: 'oferta com término futuro é vigente', id: 'A1', mutate: posts([post(10, { expiresOn: '2026-12-31' })]), state: 'SCORED', half: 6 },
    { name: 'lista vazia lida por inteiro', id: 'A1', mutate: posts([]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'lista vazia incompleta', id: 'A1', mutate: posts([], { complete: false }), state: 'NOT_VERIFIED', half: 0 },
    { name: 'lista não exposta', id: 'A1', mutate: posts([], { exposed: false }), state: 'NOT_VERIFIED', half: 0, code: 'FIELD_NOT_EXPOSED_OR_INCOMPLETE' },
    { name: 'antigas com lista incompleta: pode haver vigente', id: 'A1', mutate: posts([post(300)], { complete: false }), state: 'NOT_VERIFIED', half: 0 },
    { name: 'data sem informação: vigência indecidível', id: 'A1', mutate: posts([{ date: null }]), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'data relativa que cruza o limite de 180 dias', id: 'A1', mutate: posts([{ date: { kind: 'RELATIVE', amount: 6, unit: 'MONTH' } }]), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    {
      name: 'recurso indisponível => N/A',
      id: 'A1',
      mutate: (d) => {
        delete d.profile.posts;
        d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-a', { subcriterionIds: ['A1', 'A2', 'A3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] }));
      },
      state: 'NOT_APPLICABLE',
      half: 0,
      code: 'FEATURE_UNAVAILABLE',
    },
  ]);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-a', { subcriterionIds: ['A1'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] })); }, /causa é contrariada/);
});

test('A2/A3: recência da última e frequência em 90 dias', () => {
  check([
    ...[[0, 6], [30, 6], [31, 4], [60, 4], [61, 2], [90, 2], [91, 0], [400, 0]].map(([d, half]) => ({ name: `última há ${d} dias`, id: 'A2' as const, mutate: posts([post(d as number)]), state: 'SCORED' as const, half: half as number })),
    { name: 'A2 lista vazia completa', id: 'A2', mutate: posts([]), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_DERIVED' },
    { name: 'A2 lista incompleta com última de 50 dias (pode haver mais nova)', id: 'A2', mutate: posts([post(50)], { complete: false }), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'A2 lista incompleta com última de 10 dias (já é o máximo)', id: 'A2', mutate: posts([post(10)], { complete: false }), state: 'SCORED', half: 6 },
    { name: 'A3 5 publicações em 90 dias', id: 'A3', state: 'SCORED', half: 4 },
    { name: 'A3 4 publicações', id: 'A3', mutate: posts([post(1), post(2), post(3), post(4)]), state: 'SCORED', half: 4 },
    { name: 'A3 3 publicações', id: 'A3', mutate: posts([post(1), post(2), post(3)]), state: 'SCORED', half: 2 },
    { name: 'A3 2 publicações', id: 'A3', mutate: posts([post(1), post(2)]), state: 'SCORED', half: 2 },
    { name: 'A3 1 publicação', id: 'A3', mutate: posts([post(1)]), state: 'SCORED', half: 0 },
    { name: 'A3 só antigas, lista completa: ausência comprovada de recentes', id: 'A3', mutate: posts([post(200)]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'A3 3 publicações com lista incompleta', id: 'A3', mutate: posts([post(1), post(2), post(3)], { complete: false }), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'A3 4 publicações com lista incompleta (máximo)', id: 'A3', mutate: posts([post(1), post(2), post(3), post(4)], { complete: false }), state: 'SCORED', half: 4 },
    { name: 'A3 datas desconhecidas não provam nada', id: 'A3', mutate: posts([{ date: null }, { date: null }, { date: null }, { date: null }]), state: 'NOT_VERIFIED', half: 0 },
  ]);
});

/* ---------------------------------------------------------------- Conversão */
test('X1: website configurado; vazio comprovado zera X1 e torna X2/X4/X5 não aplicáveis', () => {
  const none = (d: Mutable) => { d.profile.website = [obs(null)]; };
  check([
    { name: 'X1 informado', id: 'X1', state: 'SCORED', half: 4 },
    { name: 'X1 vazio e lido por inteiro', id: 'X1', mutate: none, state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'X1 vazio mas incompleto', id: 'X1', mutate: setP('website', [obs(null, { complete: false })]), state: 'NOT_VERIFIED', half: 0 },
    { name: 'X2 N/A sem website', id: 'X2', mutate: none, state: 'NOT_APPLICABLE', half: 0, code: 'NO_WEBSITE_PROVEN' },
    { name: 'X4 N/A sem website', id: 'X4', mutate: none, state: 'NOT_APPLICABLE', half: 0, code: 'NO_WEBSITE_PROVEN' },
    { name: 'X5 N/A sem website', id: 'X5', mutate: none, state: 'NOT_APPLICABLE', half: 0, code: 'NO_WEBSITE_PROVEN' },
  ]);
});

test('X2: acesso à URL configurada (2xx/3xx, erro persistente, bloqueio, timeout)', () => {
  const access = (outcome: string, status?: number, persistent?: boolean) => (d: Mutable) => {
    d.site.accessibility = { evidenceIds: ['site1'], outcome, ...(status !== undefined ? { status } : {}), ...(persistent !== undefined ? { persistent } : {}) };
  };
  check([
    { name: '200', id: 'X2', state: 'SCORED', half: 2 },
    { name: '301 -> 200 (3xx)', id: 'X2', mutate: access('OK', 301), state: 'SCORED', half: 2 },
    { name: '404 persistente', id: 'X2', mutate: access('HTTP_ERROR', 404, true), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_PROVEN_URL' },
    { name: '410 persistente', id: 'X2', mutate: access('HTTP_ERROR', 410, true), state: 'ABSENCE_PROVEN', half: 0 },
    { name: '503 persistente', id: 'X2', mutate: access('HTTP_ERROR', 503, true), state: 'ABSENCE_PROVEN', half: 0 },
    { name: '404 não persistente', id: 'X2', mutate: access('HTTP_ERROR', 404, false), state: 'NOT_VERIFIED', half: 0, code: 'SITE_NOT_READ' },
    { name: '403 persistente = bloqueio, nunca zero', id: 'X2', mutate: access('HTTP_ERROR', 403, true), state: 'NOT_VERIFIED', half: 0, code: 'SITE_NOT_READ' },
    { name: '401', id: 'X2', mutate: access('HTTP_ERROR', 401, true), state: 'NOT_VERIFIED', half: 0 },
    { name: 'desafio/bloqueio', id: 'X2', mutate: access('BLOCKED'), state: 'NOT_VERIFIED', half: 0, code: 'SITE_NOT_READ' },
    { name: 'tempo esgotado', id: 'X2', mutate: access('TIMEOUT'), state: 'NOT_VERIFIED', half: 0 },
    { name: 'não lido', id: 'X2', mutate: access('NOT_READ'), state: 'NOT_VERIFIED', half: 0 },
    { name: 'sem registro de acesso', id: 'X2', mutate: (d) => { delete d.site.accessibility; }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_NOT_READ' },
  ]);
  rejected(access('OK', 404), /OK exige status 200–399/);
  rejected(access('HTTP_ERROR', 200), /HTTP_ERROR exige status 400–599/);
});

test('X3: canais de contato/ação (o website não conta) e leitura incompleta', () => {
  const kinds = (list: string[], complete = true) => setP('actions', [obs({ kinds: list }, { complete })]);
  check([
    { name: '3 canais', id: 'X3', state: 'SCORED', half: 4 },
    { name: '4 canais', id: 'X3', mutate: kinds(['PHONE', 'WHATSAPP', 'MESSAGES', 'BOOKING_OR_ORDER']), state: 'SCORED', half: 4 },
    { name: '2 canais', id: 'X3', mutate: kinds(['PHONE', 'WHATSAPP']), state: 'SCORED', half: 3 },
    { name: '1 canal', id: 'X3', mutate: kinds(['PHONE']), state: 'SCORED', half: 2 },
    { name: 'nenhum canal, lido por inteiro', id: 'X3', mutate: kinds([]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: '2 canais, lista incompleta (pode ser 2, 3 ou 4)', id: 'X3', mutate: kinds(['PHONE', 'WHATSAPP'], false), state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: '3 canais, lista incompleta (3 ou 4 dão o máximo)', id: 'X3', mutate: kinds(['PHONE', 'WHATSAPP', 'MESSAGES'], false), state: 'SCORED', half: 4 },
  ]);
  rejected(kinds(['PHONE', 'PHONE']), /tipos de canal repetidos/);
  rejected(setP('actions', [obs({ kinds: ['WEBSITE'] })]), /kinds.*Invalid option/i);
});

test('X5: UTM completo, parcial, ausente (somente do uso de UTM), URL não verificada e sem vazar a URL', () => {
  const url = (value: string, complete = true) => setP('website', [obs(value, { complete })]);
  check([
    { name: 'utm_source + utm_medium', id: 'X5', state: 'SCORED', half: 4 },
    { name: 'chaves em maiúsculas', id: 'X5', mutate: url('https://exemplo.com.br/?UTM_Source=g&Utm_Medium=gbp'), state: 'SCORED', half: 4 },
    { name: 'só utm_source', id: 'X5', mutate: url('https://exemplo.com.br/?utm_source=google'), state: 'SCORED', half: 2 },
    { name: 'só utm_campaign', id: 'X5', mutate: url('https://exemplo.com.br/?utm_campaign=x'), state: 'SCORED', half: 2 },
    { name: 'utm_source vazio não conta', id: 'X5', mutate: url('https://exemplo.com.br/?utm_source=&utm_medium=gbp'), state: 'SCORED', half: 2 },
    { name: 'sem UTM: ausência comprovada na URL', id: 'X5', mutate: url('https://exemplo.com.br/'), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_PROVEN_URL' },
    { name: 'outros parâmetros não são UTM', id: 'X5', mutate: url('https://exemplo.com.br/?ref=gbp&gclid=abc'), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'URL ilegível', id: 'X5', mutate: url('isso não é uma url'), state: 'NOT_VERIFIED', half: 0, code: 'WEBSITE_URL_UNPARSABLE' },
    { name: 'protocolo não http(s)', id: 'X5', mutate: url('ftp://exemplo.com.br/?utm_source=a&utm_medium=b'), state: 'NOT_VERIFIED', half: 0, code: 'WEBSITE_URL_UNPARSABLE' },
    { name: 'URL possivelmente truncada (leitura incompleta)', id: 'X5', mutate: url('https://exemplo.com.br/?utm_source=a', false), state: 'NOT_VERIFIED', half: 0, code: 'FIELD_NOT_EXPOSED_OR_INCOMPLETE' },
    { name: 'URL não verificada (evidência parcial)', id: 'X5', mutate: (d) => { d.evidences.find((e: Mutable) => e.id === 'n1').status = 'PARTIAL'; }, state: 'NOT_VERIFIED', half: 0, code: 'EVIDENCE_NOT_VERIFIED' },
  ]);
  const text = JSON.stringify(run(url('https://segredo.exemplo.com.br/p?utm_source=VALORSECRETO&utm_medium=gbp&token=ABC123')));
  assert.ok(!/VALORSECRETO|ABC123|segredo\.exemplo/.test(text), 'a URL e os valores dos parâmetros nunca entram no resultado');
  assert.match(text, /utm_medium, utm_source/, 'só os NOMES dos parâmetros UTM aparecem');
  const absent = sub(run(url('https://exemplo.com.br/')), 'X5');
  assert.match(absent.notes.join(' '), /não comprova ausência de rastreamento em geral/);
  assert.match(absent.reason, /exclusiva do uso de UTM/);
});

/* ---------------------------------------------------------------- Sites e escopo */
test('S5/X4: escopo suficiente (atestado) × escopo limitado — nunca zero por ausência global', () => {
  const offers = (n: number) => (d: Mutable) => { d.site.offers.distinctNamedOffers = n; };
  const elements = (list: string[]) => (d: Mutable) => { d.site.journey.elements = list; };
  check([
    { name: 'S5 6 ofertas (escopo atestado)', id: 'S5', state: 'SCORED', half: 6 },
    { name: 'S5 3 ofertas (escopo atestado)', id: 'S5', mutate: offers(3), state: 'SCORED', half: 3 },
    { name: 'S5 0 ofertas (escopo atestado): zero no escopo documentado', id: 'S5', mutate: offers(0), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_PROVEN_SCOPE' },
    { name: 'S5 7 ofertas (escopo limitado, máximo)', id: 'S5', mutate: (d) => { limitedScope(d); offers(7)(d); }, state: 'SCORED', half: 6 },
    { name: 'S5 3 ofertas (escopo limitado)', id: 'S5', mutate: (d) => { limitedScope(d); offers(3)(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: 'S5 0 ofertas (escopo limitado): Não verificado, nunca zero', id: 'S5', mutate: (d) => { limitedScope(d); offers(0)(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: 'S5 0 ofertas: sitemap completo SEM atestado não basta', id: 'S5', mutate: (d) => { noAttestation(d); offers(0)(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: 'S5 com escopo NONE (site bloqueado)', id: 'S5', mutate: (d) => { noAttestation(d); d.site.scope = { kind: 'NONE', pagesRead: [], requestCap: 8, capReached: false, blockers: ['403'], limitations: [] }; d.site.offers.distinctNamedOffers = 0; d.site.journey.elements = []; d.site.accessibility = { evidenceIds: ['site1'], outcome: 'BLOCKED' }; }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_NOT_READ' },
    { name: 'S5 detector não validado', id: 'S5', mutate: (d) => { d.site.offers.determination = { method: 'VALIDATED_DETECTOR', detectorId: 'det-inventado', detectorVersion: '1' }; }, state: 'NOT_VERIFIED', half: 0, code: 'DETERMINATION_NOT_VALIDATED' },
    { name: 'S5 só com fonte de terceiros não vale', id: 'S5', mutate: (d) => { d.evidences.push(evidence('tp1', { origin: 'THIRD_PARTY' })); d.site.offers.evidenceIds = ['tp1']; }, state: 'NOT_VERIFIED', half: 0, code: 'EVIDENCE_SOURCE_NOT_ALLOWED' },
    { name: 'X4 3 elementos (escopo atestado)', id: 'X4', state: 'SCORED', half: 6 },
    { name: 'X4 2 elementos (escopo atestado)', id: 'X4', mutate: elements(['CTA', 'CONTACT_OR_PURCHASE']), state: 'SCORED', half: 4 },
    { name: 'X4 0 elementos (escopo atestado)', id: 'X4', mutate: elements([]), state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'X4 3 elementos (escopo limitado, máximo)', id: 'X4', mutate: limitedScope, state: 'SCORED', half: 6 },
    { name: 'X4 2 elementos (escopo limitado)', id: 'X4', mutate: (d) => { limitedScope(d); elements(['CTA', 'CONTACT_OR_PURCHASE'])(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: 'X4 0 elementos (escopo limitado): Não verificado', id: 'X4', mutate: (d) => { limitedScope(d); elements([])(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
  ]);
  const limited = run((d) => { limitedScope(d); d.site.offers.distinctNamedOffers = 7; });
  assert.match(sub(limited, 'S5').notes.join(' '), /Observado em 1 página\(s\) lida\(s\).*não representa o domínio inteiro/);
  assert.match(limited.limitations.map((l) => l.text).join(' '), /Site: escopo ROOT_ONLY, 1 página\(s\) lida\(s\).*não para o domínio inteiro/);
  const attested = run();
  assert.match(sub(attested, 'S5').notes.join(' '), /vale no escopo documentado, não além dele/);
});

test('escopo de site: consistência do registro e do atestado do operador', () => {
  rejected((d) => { d.site.scope.kind = 'NONE'; }, /NONE não pode ter páginas lidas/);
  rejected((d) => { d.site.scope.kind = 'ROOT_ONLY'; d.site.scope.pagesRead.push({ ...d.site.scope.pagesRead[0], url: 'https://exemplo.com.br/b' }); noAttestation(d); }, /ROOT_ONLY exige exatamente 1/);
  rejected((d) => { d.site.scope.sitemap = { urlsListed: 10, urlsRead: 4 }; }, /SITEMAP_COMPLETE exige sitemap lido/);
  rejected((d) => { d.site.scope.capReached = true; }, /SITEMAP_COMPLETE exige/);
  rejected((d) => { d.site.scope.blockers = ['403']; }, /SITEMAP_COMPLETE exige/);
  rejected((d) => { limitedScope(d); d.operatorRecords.push(record('SITE_SCOPE_ATTESTATION', 'op-scope-2', { subcriterionIds: ['S5'], scopeDescription: 'Revisão completa documentada pelo operador do site inteiro.' })); }, /só vale para escopo SITEMAP_COMPLETE ou DOCUMENTED_FULL_REVIEW/);
  rejected((d) => { d.operatorRecords.push(record('SITE_SCOPE_ATTESTATION', 'op-scope-3', { subcriterionIds: ['S5'], scopeDescription: 'Revisão completa documentada pelo operador do site inteiro.' })); }, /mais de um atestado/);
  rejected((d) => { d.operatorRecords.push(record('SITE_SCOPE_ATTESTATION', 'op-scope-4', { subcriterionIds: ['R1'], scopeDescription: 'Revisão completa documentada pelo operador do site inteiro.' })); }, /não depende do escopo do site/);
  rejected((d) => { d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.id !== 'op-obs'); }, /não aponta para uma confirmação de observação/);
  rejected((d) => { d.site.scope.kind = 'DOCUMENTED_FULL_REVIEW'; d.site.scope.sitemap = undefined; d.site.scope.limitations = []; }, /exige limitações documentadas/);
  // revisão documentada pelo operador, com limitações e atestado: vale como escopo suficiente
  const documented = run((d) => {
    d.site.scope = { kind: 'DOCUMENTED_FULL_REVIEW', pagesRead: [d.site.scope.pagesRead[0]], requestCap: 8, capReached: true, blockers: [], limitations: ['Áreas logadas não foram revisadas.'] };
    d.site.offers.distinctNamedOffers = 0;
  });
  assert.equal(sub(documented, 'S5').state, 'ABSENCE_PROVEN');
});

test('V5: presença visual em fonte própria exige confirmação do operador e respeita o escopo', () => {
  const types = (list: string[], over: Mutable = {}) => (d: Mutable) => {
    d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'IMAGES_CONFIRMATION' ? { ...r, imageTypes: list, evidenceIds: ['site1'], ...over } : r));
  };
  check([
    { name: '2 tipos', id: 'V5', state: 'SCORED', half: 4 },
    { name: '3 tipos', id: 'V5', mutate: types(['PLACE', 'PRODUCT_OR_SERVICE', 'TEAM_OR_PROCESS']), state: 'SCORED', half: 4 },
    { name: '1 tipo (escopo atestado)', id: 'V5', mutate: types(['PLACE']), state: 'SCORED', half: 2 },
    { name: '0 tipos (escopo atestado)', id: 'V5', mutate: types([]), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_PROVEN_SCOPE' },
    { name: '1 tipo (escopo limitado)', id: 'V5', mutate: (d) => { limitedScope(d); types(['PLACE'])(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: '0 tipos (escopo limitado): Não verificado', id: 'V5', mutate: (d) => { limitedScope(d); types([])(d); }, state: 'NOT_VERIFIED', half: 0, code: 'SITE_SCOPE_LIMITED' },
    { name: '2 tipos (escopo limitado, máximo)', id: 'V5', mutate: limitedScope, state: 'SCORED', half: 4 },
    { name: 'sem confirmação do operador', id: 'V5', mutate: (d) => { d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.kind !== 'IMAGES_CONFIRMATION'); }, state: 'NOT_VERIFIED', half: 0, code: 'OPERATOR_CONFIRMATION_REQUIRED' },
    { name: 'imagens citadas de origem nativa não valem como fonte própria', id: 'V5', mutate: (d) => { d.operatorRecords = d.operatorRecords.map((r: Mutable) => (r.kind === 'IMAGES_CONFIRMATION' ? { ...r, evidenceIds: ['n1'] } : r)); }, state: 'NOT_VERIFIED', half: 0, code: 'EVIDENCE_SOURCE_NOT_ALLOWED' },
  ]);
  rejected(types(['PLACE', 'PLACE']), /tipos de imagem repetidos/);
  rejected((d) => { types(['PLACE'])(d); d.operatorRecords.find((r: Mutable) => r.kind === 'IMAGES_CONFIRMATION').evidenceIds = []; }, /exige a evidência/);
  rejected((d) => { types([])(d); d.operatorRecords.find((r: Mutable) => r.kind === 'IMAGES_CONFIRMATION').evidenceIds = []; }, /inclusive para zero tipos/);
});

/* ---------------------------------------------------------------- Autoridade */
const competitors = (list: Array<[string, number]>) => (d: Mutable) => {
  d.competitors = list.map(([rating, count], i) => ({ id: `comp-${i}`, name: `Concorrente ${i}`, region: 'Cidade Exemplo', equivalenceCriterion: 'mesma cidade e categoria', verifiableElements: 2, evidenceIds: ['c1'], rating, reviewCount: count }));
};
const company = (rating: string, count: number) => reviews(rating, count);

test('L1: nota frente à amostra — acima, igual ao topo, mediana, mínimo, abaixo, empates e amostras iguais', () => {
  const sample = competitors([['4.8', 120], ['4.5', 80], ['4.3', 40]]);
  const l1 = (rating: string, half: number, extra?: (d: Mutable) => void) => ({ name: `nota ${rating}`, id: 'L1' as const, mutate: (d: Mutable) => { sample(d); company(rating, 130)(d); extra?.(d); }, state: 'SCORED' as const, half });
  check([l1('5.0', 6), l1('4.8', 6), l1('4.7', 4), l1('4.5', 4), l1('4.4', 2), l1('4.3', 2), l1('4.2', 0), l1('3.0', 0)]);
  const tied = (rating: string, half: number) => ({ name: `todos 4.8, empresa ${rating}`, id: 'L1' as const, mutate: (d: Mutable) => { competitors([['4.8', 50], ['4.8', 60], ['4.8', 70]])(d); company(rating, 130)(d); }, state: 'SCORED' as const, half });
  check([tied('4.8', 6), tied('4.9', 6), tied('4.7', 0)]);
  const topTie = (rating: string, half: number) => ({ name: `topo empatado [4.9,4.9,4.5], empresa ${rating}`, id: 'L1' as const, mutate: (d: Mutable) => { competitors([['4.9', 50], ['4.9', 60], ['4.5', 70]])(d); company(rating, 130)(d); }, state: 'SCORED' as const, half });
  check([topTie('4.9', 6), topTie('4.7', 2), topTie('4.5', 2), topTie('4.4', 0)]); // mediana = topo: a faixa "2" é vazia
  const even = (rating: string, half: number) => ({ name: `4 concorrentes (mediana 4.4), empresa ${rating}`, id: 'L1' as const, mutate: (d: Mutable) => { competitors([['4.8', 50], ['4.5', 60], ['4.3', 70], ['4.0', 80]])(d); company(rating, 130)(d); }, state: 'SCORED' as const, half });
  check([even('4.4', 4), even('4.39', 2), even('4.0', 2), even('3.99', 0)]);
  check([
    { name: 'menos de 3 elegíveis', id: 'L1', mutate: competitors([['4.8', 120], ['4.5', 80]]), state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
    { name: 'concorrente com 4 avaliações é inelegível', id: 'L1', mutate: competitors([['4.8', 120], ['4.5', 80], ['4.3', 4]]), state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
    { name: 'concorrente com apenas 1 elemento verificável é inelegível', id: 'L1', mutate: (d) => { d.competitors[0].verifiableElements = 1; }, state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
    { name: 'concorrente com evidência não verificada é inelegível', id: 'L1', mutate: (d) => { d.evidences.find((e: Mutable) => e.id === 'c1').status = 'PARTIAL'; }, state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
    { name: 'empresa com 4 avaliações', id: 'L1', mutate: reviews('5.0', 4), state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'REVIEWS_BELOW_MIN_SAMPLE' },
    { name: 'empresa sem avaliações', id: 'L1', mutate: reviews(null, 0), state: 'NOT_APPLICABLE', half: 0, code: 'NO_REVIEWS_PROVEN' },
    { name: 'sem concorrentes informados', id: 'L1', mutate: (d) => { delete d.competitors; }, state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
  ]);
});

test('L2: volume frente à amostra — fronteiras, mediana nunca zero e sem pontuação máxima artificial', () => {
  const sample = competitors([['4.8', 120], ['4.5', 80], ['4.3', 40]]);
  const l2 = (count: number, half: number) => ({ name: `${count} avaliações`, id: 'L2' as const, mutate: (d: Mutable) => { sample(d); company('4.9', count)(d); }, state: 'SCORED' as const, half });
  check([l2(500, 6), l2(120, 6), l2(119, 4), l2(80, 4), l2(79, 2), l2(40, 2), l2(39, 0), l2(5, 0)]);
  check([
    { name: 'empresa com 0 avaliações perante a amostra: 0 ponto', id: 'L2', mutate: (d) => { sample(d); reviews(null, 0)(d); }, state: 'ABSENCE_PROVEN', half: 0 },
    { name: 'concorrentes todos com 0 avaliações: sem amostra elegível (não há máximo artificial)', id: 'L2', mutate: (d) => { d.competitors = [0, 1, 2].map((i) => ({ id: `z${i}`, name: 'Z', region: 'R', equivalenceCriterion: 'mesma cidade', verifiableElements: 2, evidenceIds: ['c1'], rating: null, reviewCount: 0 })); reviews(null, 0)(d); }, state: 'SAMPLE_INSUFFICIENT', half: 0, code: 'COMPETITOR_SAMPLE_BELOW_MIN' },
    { name: 'leitura incompleta do volume abaixo do topo', id: 'L2', mutate: (d) => { sample(d); reviews('4.9', 90, false)(d); }, state: 'NOT_VERIFIED', half: 0, code: 'INDECISIVE_RANGE' },
    { name: 'leitura incompleta no topo', id: 'L2', mutate: (d) => { sample(d); reviews('4.9', 130, false)(d); }, state: 'SCORED', half: 6 },
  ]);
  const evenSample = (count: number, half: number) => ({ name: `4 concorrentes (mediana 70), ${count}`, id: 'L2' as const, mutate: (d: Mutable) => { competitors([['4.8', 100], ['4.5', 80], ['4.3', 60], ['4.0', 20]])(d); company('4.9', count)(d); }, state: 'SCORED' as const, half });
  check([evenSample(100, 6), evenSample(99, 4), evenSample(70, 4), evenSample(69, 2), evenSample(35, 2), evenSample(34, 0)]);
});

test('L3: prova externa de autoridade — tipos corroborados, protocolo de busca e origens permitidas', () => {
  const finding = (cls: string, ids: string[], corroborated = true) => ({ class: cls, corroborated, evidenceIds: ids });
  const protocol = (complete = true) => ({ searched: ['OFFICIAL_SITE', 'SOCIAL', 'OFFICIAL_REGISTRY', 'INDEPENDENT_THIRD_PARTY'].slice(0, complete ? 4 : 3).map((cls) => ({ class: cls, method: 'busca manual', query: 'nome + cidade', searchedAt: '2026-10-21', evidenceIds: ['site1'] })) });
  const authority = (findings: Mutable[], withProtocol?: boolean) => (d: Mutable) => { d.authority = { findings, ...(withProtocol !== undefined ? { protocol: protocol(withProtocol) } : {}) }; };
  check([
    { name: '2 tipos corroborados', id: 'L3', state: 'SCORED', half: 6 },
    { name: '2 tipos sem protocolo (já é o máximo)', id: 'L3', mutate: authority([finding('OFFICIAL_SITE', ['site1']), finding('SOCIAL', ['soc1'])]), state: 'SCORED', half: 6 },
    { name: '1 tipo com protocolo completo', id: 'L3', mutate: authority([finding('OFFICIAL_SITE', ['site1'])], true), state: 'SCORED', half: 3 },
    { name: '0 tipos com protocolo completo: ausência no escopo buscado', id: 'L3', mutate: authority([], true), state: 'ABSENCE_PROVEN', half: 0, code: 'ABSENCE_PROVEN_PROTOCOL' },
    { name: '1 tipo sem protocolo', id: 'L3', mutate: authority([finding('OFFICIAL_SITE', ['site1'])]), state: 'NOT_VERIFIED', half: 0, code: 'PROTOCOL_INCOMPLETE' },
    { name: '1 tipo com protocolo incompleto (3 de 4 classes)', id: 'L3', mutate: authority([finding('OFFICIAL_SITE', ['site1'])], false), state: 'NOT_VERIFIED', half: 0, code: 'PROTOCOL_INCOMPLETE' },
    { name: '0 tipos sem protocolo: Não verificado, nunca zero', id: 'L3', mutate: authority([]), state: 'NOT_VERIFIED', half: 0, code: 'PROTOCOL_INCOMPLETE' },
    { name: 'classe com origem trocada é ignorada', id: 'L3', mutate: authority([finding('SOCIAL', ['site1']), finding('OFFICIAL_SITE', ['site1'])]), state: 'NOT_VERIFIED', half: 0, code: 'PROTOCOL_INCOMPLETE' },
    { name: 'achado não corroborado não conta', id: 'L3', mutate: authority([finding('OFFICIAL_SITE', ['site1']), finding('SOCIAL', ['soc1'], false)]), state: 'NOT_VERIFIED', half: 0 },
    { name: 'nenhuma busca registrada', id: 'L3', mutate: (d) => { delete d.authority; }, state: 'NOT_VERIFIED', half: 0, code: 'NO_OBSERVATION' },
  ]);
});

test('registros do operador: e-mail, justificativa, duplicidade e referências são validados', () => {
  rejected((d) => { d.operatorRecords[0].operatorEmail = 'sem-arroba'; }, /e-mail inválido/);
  rejected((d) => { d.operatorRecords[0].justification = 'curta'; }, /pelo menos 20 caracteres/);
  rejected((d) => { d.operatorRecords[1].id = d.operatorRecords[0].id; }, /registro do operador duplicado/);
  rejected((d) => { d.operatorRecords[0].recordedAt = '22/10/2026'; }, /data\/hora inválida/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-x', { subcriterionIds: ['C3'], code: 'NO_ADDITIONAL_NEEDED' })); }, /causa é contrariada ou não é provada/);
  rejected((d) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-y', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['inexistente'] })); delete d.profile.attributes; }, /evidência citada e inexistente/);
  assert.ok(REF);
});
