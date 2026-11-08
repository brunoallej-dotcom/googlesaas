import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computeTerritoryRankMetrics } from '../src/lib/battlefield-metrics';
import { classifyGridPoint } from '../src/lib/battlefield-map-utils';

/*
 * Spec: docs/specs/g5-homologacao-funcional.md. O SQL não é executado num PostgreSQL aqui (o ambiente não permite instalar um):
 * os testes provam a estrutura (guardas, somente INSERT, atômico), que NADA se parece com dado real e que as linhas explícitas
 * respeitam as restrições do schema. A primeira execução no laboratório é o teste de integração.
 */
const ROOT = path.join(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SQL = read('supabase/lab/seed-ficticio.sql');
const MIGRATION = `${read('supabase/migrations/001_gmn_schema.sql')}\n${read('supabase/migrations/002_audit_payloads.sql')}`;
const code = SQL.replace(/^\s*--.*$/gm, '');

const TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'] as const;
const PREFIX: Record<(typeof TABLES)[number], string> = {
  prospecting_campaigns: '1ab0c000',
  gmn_leads: '1ab01ead',
  gmn_audits: '1ab0a0d1',
  gmn_battlefield_rounds: '1ab0b0a4',
  gmn_battlefield_points: '1ab09017',
};

type Value = string | number | boolean | null;
interface Parsed {
  readonly columns: string[];
  readonly rows: Array<Record<string, Value>>;
}

/** Lê uma lista de tuplas SQL (`(a, 'b', null), (...)`) com textos entre aspas simples, números, null e booleanos. */
function parseRow(text: string, start: number): { values: Value[]; next: number } {
  const values: Value[] = [];
  let i = start;
  for (;;) {
    while (/\s/.test(text[i] ?? '')) i += 1;
    if (text[i] === "'") {
      let value = '';
      i += 1;
      for (;;) {
        if (text[i] === "'" && text[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (text[i] === "'") {
          i += 1;
          break;
        } else {
          value += text[i];
          i += 1;
        }
      }
      values.push(value);
    } else {
      let token = '';
      while (i < text.length && text[i] !== ',' && text[i] !== ')') {
        token += text[i];
        i += 1;
      }
      token = token.trim();
      values.push(token === 'null' ? null : token === 'true' ? true : token === 'false' ? false : Number(token));
      assert.ok(token === 'null' || token === 'true' || token === 'false' || Number.isFinite(Number(token)), `valor não reconhecido: ${token}`);
    }
    while (/\s/.test(text[i] ?? '')) i += 1;
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    assert.equal(text[i], ')', 'tupla mal fechada');
    return { values, next: i + 1 };
  }
}

function parseInsert(table: string): Parsed {
  const match = new RegExp(`insert into public\\.${table} \\(([^)]*)\\) values([\\s\\S]*?)\\n\\s*on conflict do nothing;`).exec(code);
  assert.ok(match, `INSERT explícito de ${table} não encontrado`);
  const columns = (match[1] ?? '').split(',').map((c) => c.trim());
  const body = match[2] ?? '';
  const rows: Array<Record<string, Value>> = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '(') {
      const { values, next } = parseRow(body, i + 1);
      assert.equal(values.length, columns.length, `${table}: ${values.length} valores para ${columns.length} colunas`);
      rows.push(Object.fromEntries(columns.map((c, index) => [c, values[index] as Value])));
      i = next;
    } else {
      i += 1;
    }
  }
  return { columns, rows };
}

const campaigns = parseInsert('prospecting_campaigns');
const leads = parseInsert('gmn_leads');
const audits = parseInsert('gmn_audits');
const rounds = parseInsert('gmn_battlefield_rounds');

test('estrutura: um único bloco atômico, guardas ANTES de qualquer insert, somente INSERT ... ON CONFLICT DO NOTHING nas 5 tabelas', () => {
  const trimmed = code.trim();
  assert.ok(trimmed.startsWith('do $seed$'), 'nada antes do bloco');
  assert.ok(trimmed.endsWith('$seed$;'), 'nada depois do bloco');
  assert.equal(trimmed.match(/\bdo \$seed\$/g)?.length, 1, 'um único bloco');
  const production = code.indexOf("raise exception 'SEED ABORTADO: este é o projeto de PRODUCAO");
  const foreign = code.indexOf("raise exception 'SEED ABORTADO: ha linhas que nao sao deste seed");
  const firstInsert = code.indexOf('insert into');
  assert.ok(production > 0 && foreign > production && firstInsert > foreign, 'guarda da produção, guarda de dados reais, só então os inserts');
  assert.doesNotMatch(code, /\b(update|delete|truncate|drop|alter|grant|revoke|create|copy|vacuum)\b/i, 'sem escrita além de INSERT, sem DDL nem permissões');
  const inserts = [...code.matchAll(/insert into public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(inserts, [...TABLES], 'cada tabela uma vez, na ordem das chaves estrangeiras');
  assert.equal(code.match(/on conflict do nothing;/g)?.length, TABLES.length, 'todo INSERT é idempotente');
});

test('guarda 1: a impressão digital da produção bate com a auditoria de 17/10 (e a guarda 2 usa os mesmos prefixos dos ids)', () => {
  const evidence = JSON.parse(read('docs/phase5/evidence/rls-audit-2026-10-17.json')) as { '10_storage': { buckets: Array<{ id: string; criado_em: string }> } };
  const fingerprint = (id: string): string => (evidence['10_storage'].buckets.find((b) => b.id === id)?.criado_em ?? '').replace('T', ' ').replace(/\+00:00$/, '+00');
  for (const id of ['gmn-audit-pdfs', 'gmn-audit-pdfs-private']) {
    assert.ok(fingerprint(id).length > 0, id);
    assert.ok(code.includes(`id = '${id}' and created_at = '${fingerprint(id)}'`), `a guarda precisa conter a impressão digital de ${id}`);
  }
  for (const table of TABLES) assert.ok(code.includes(`'${PREFIX[table]}-%'`), `guarda 2 cobre ${table}`);
});

test('tudo é fictício: ids do laboratório, marcador (LAB), URLs .invalid, telefone só zeros, nada que lembre dado real', () => {
  for (const match of code.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) assert.ok(match[0].startsWith('1ab'), `uuid fora do laboratório: ${match[0]}`);
  const prefixOf = (rows: Parsed): string[] => rows.rows.map((r) => String(r.id).slice(0, 8));
  assert.deepEqual([...new Set(prefixOf(campaigns))], [PREFIX.prospecting_campaigns]);
  assert.deepEqual([...new Set(prefixOf(leads))], [PREFIX.gmn_leads]);
  assert.deepEqual([...new Set(prefixOf(audits))], [PREFIX.gmn_audits]);
  assert.deepEqual([...new Set(prefixOf(rounds))], [PREFIX.gmn_battlefield_rounds]);
  assert.ok(code.includes("'1ab09017-0000-4000-8000-'"), 'ids dos pontos');
  for (const row of campaigns.rows) assert.match(String(row.city), /\(LAB\)$/);
  for (const row of leads.rows) assert.match(String(row.business_name), /\(LAB\)$/);
  assert.doesNotMatch(code, /@/, 'nenhum e-mail');
  for (const url of code.match(/https?:\/\/[^'\s)]+/g) ?? []) assert.match(url, /^https:\/\/[a-z0-9.-]+\.invalid(\/|$)/, `URL fora de .invalid: ${url}`);
  for (const phone of code.match(/\(\d\d\) [\d-]+/g) ?? []) assert.equal(phone, '(00) 0000-0000');
  assert.doesNotMatch(code, /\+55|\+\d{6,}/, 'sem telefone internacional');
  for (const real of ['tuvaplast', 'belo riso', 'anápolis', 'anapolis', 'goiânia', 'goiania', 'odontol', 'dentista', 'clínica', 'google']) assert.ok(!code.toLowerCase().includes(real), `palavra de dado real: ${real}`);
  for (const row of [...campaigns.rows, ...rounds.rows]) for (const key of ['center_lat', 'center_lng']) assert.ok(Math.abs(Number(row[key])) <= 0.1, `coordenada no oceano: ${key}`);
  for (const row of leads.rows) for (const key of ['latitude', 'longitude']) assert.ok(Math.abs(Number(row[key])) <= 0.1);
});

test('drift: as restrições usadas pelo teste continuam no schema (001/002)', () => {
  for (const fragment of [
    "CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'))",
    'CHECK (frontier_rank BETWEEN 11 AND 40)',
    'CHECK (frontier_page IN (1, 2))',
    "CHECK (whatsapp_status IN ('VERIFIED_WHATSAPP', 'LIKELY_MOBILE_WHATSAPP', 'LANDLINE_ONLY', 'MISSING'))",
    "CHECK (website_status IN ('OWN_DOMAIN', 'SOCIAL_LINK_ONLY', 'MISSING'))",
    'UNIQUE(campaign_id, place_id)',
    'CHECK (progress_percent BETWEEN 0 AND 100)',
    'CHECK (total_points = 49)',
    'audit_id UUID NOT NULL UNIQUE',
    'CHECK (point_index BETWEEN 0 AND 48)',
    'CHECK (row_index BETWEEN 0 AND 6)',
    'CHECK (col_index BETWEEN 0 AND 6)',
    "CHECK (read_status IN ('VALID', 'UNREADABLE'))",
    'CHECK (attempts_made BETWEEN 1 AND 3)',
    "'GREEN_TOP3', 'YELLOW_TOP7', 'RED_8_TO_20', 'INVISIBLE', 'GRAY_UNREADABLE'",
    "'QUEUED',\n            'RUNNING_EXTRACTION'",
    'UNIQUE(round_id, point_index)',
    'battlefield_payload JSONB',
  ]) assert.ok(MIGRATION.includes(fragment), `o schema mudou: ${fragment}`);
});

const required = (rows: Parsed, columns: string[], table: string): void => {
  for (const row of rows.rows) for (const column of columns) assert.ok(row[column] !== null && row[column] !== undefined, `${table}: ${column} é NOT NULL sem default`);
};
const oneOf = (value: Value | undefined, allowed: readonly string[], label: string): void => assert.ok(allowed.includes(String(value)), `${label}: ${String(value)}`);
const within = (value: Value | undefined, min: number, max: number, label: string): void => assert.ok(typeof value === 'number' && value >= min && value <= max, `${label}: ${String(value)}`);
const maxLength = (value: Value | undefined, limit: number, label: string): void => assert.ok(value === null || value === undefined || String(value).length <= limit, `${label} excede ${limit}`);

test('linhas explícitas: contagens, colunas obrigatórias, enumerações, faixas, tamanhos, chaves estrangeiras e unicidade do schema', () => {
  assert.deepEqual([campaigns.rows.length, leads.rows.length, audits.rows.length, rounds.rows.length], [2, 4, 2, 2]);

  required(campaigns, ['city', 'niche_keyword', 'center_lat', 'center_lng'], 'campanhas');
  for (const r of campaigns.rows) {
    oneOf(r.status, ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'], 'campanha.status');
    maxLength(r.city, 120, 'city');
    maxLength(r.state_code, 10, 'state_code');
    maxLength(r.niche_keyword, 180, 'niche_keyword');
  }
  const campaignIds = new Set(campaigns.rows.map((r) => r.id));
  assert.equal(campaignIds.size, campaigns.rows.length, 'ids de campanha únicos');

  required(leads, ['campaign_id', 'place_id', 'business_name', 'primary_category', 'frontier_rank', 'frontier_page', 'whatsapp_status', 'website_status', 'latitude', 'longitude'], 'leads');
  const unique = new Set<string>();
  for (const r of leads.rows) {
    assert.ok(campaignIds.has(r.campaign_id), 'lead.campaign_id aponta para uma campanha do seed');
    within(r.frontier_rank, 11, 40, 'frontier_rank');
    oneOf(String(r.frontier_page), ['1', '2'], 'frontier_page');
    oneOf(r.whatsapp_status, ['VERIFIED_WHATSAPP', 'LIKELY_MOBILE_WHATSAPP', 'LANDLINE_ONLY', 'MISSING'], 'whatsapp_status');
    oneOf(r.website_status, ['OWN_DOMAIN', 'SOCIAL_LINK_ONLY', 'MISSING'], 'website_status');
    within(r.rating, 0, 9.99, 'rating (numeric(3,2))');
    for (const [column, limit] of [['place_id', 128], ['cid', 64], ['feature_id', 128], ['business_name', 255], ['primary_category', 160], ['phone_raw', 64]] as const) maxLength(r[column], limit, column);
    const key = `${String(r.campaign_id)}|${String(r.place_id)}`;
    assert.ok(!unique.has(key), `UNIQUE(campaign_id, place_id) violada: ${key}`);
    unique.add(key);
    assert.equal(r.website_status === 'MISSING', r.website_url === null, 'website_url coerente com website_status');
  }
  const leadById = new Map(leads.rows.map((r) => [String(r.id), r]));
  assert.equal(leadById.size, leads.rows.length, 'ids de lead únicos');

  required(audits, ['lead_id', 'place_id', 'target_keyword', 'interest_center_lat', 'interest_center_lng'], 'auditorias');
  for (const r of audits.rows) {
    const lead = leadById.get(String(r.lead_id));
    assert.ok(lead, 'audit.lead_id aponta para um lead do seed');
    assert.equal(r.place_id, lead.place_id, 'place_id da auditoria igual ao do lead (regra do db:check)');
    oneOf(r.status, ['QUEUED', 'RUNNING_EXTRACTION', 'RUNNING_RIVALS_AND_JUDGE', 'RUNNING_STRATEGIST', 'RUNNING_REVIEWER', 'RUNNING_DIAGRAMMER', 'COMPLETED', 'FAILED'], 'audit.status');
    assert.equal(r.status, 'FAILED', 'FAILED, sem payload: não gera ruído em db:check nem em validate:recovery');
    within(r.progress_percent, 0, 100, 'progress_percent');
    maxLength(r.target_keyword, 180, 'target_keyword');
    maxLength(r.current_agent, 64, 'current_agent');
  }
  const auditById = new Map(audits.rows.map((r) => [String(r.id), r]));
  assert.equal(auditById.size, audits.rows.length, 'ids de auditoria únicos');

  required(rounds, ['audit_id', 'lead_id', 'place_id', 'keyword_pure', 'center_lat', 'center_lng'], 'rodadas');
  const roundAudits = new Set<string>();
  for (const r of rounds.rows) {
    const audit = auditById.get(String(r.audit_id));
    assert.ok(audit, 'round.audit_id aponta para uma auditoria do seed');
    assert.ok(!roundAudits.has(String(r.audit_id)), 'audit_id é UNIQUE em rodadas');
    roundAudits.add(String(r.audit_id));
    assert.equal(r.lead_id, audit.lead_id);
    assert.equal(r.place_id, audit.place_id);
    assert.equal(r.total_points, 49, 'CHECK (total_points = 49)');
    within(r.average_position, 0, 999.99, 'average_position (numeric(5,2))');
    for (const key of ['top3_percentage', 'top7_percentage', 'invisibility_percentage']) within(r[key], 0, 100, key);
  }
});

/** A fórmula do cabeçalho do seed, reescrita aqui para provar as restrições e os agregados das rodadas. */
function point(i: number): { row: number; col: number; status: 'VALID' | 'UNREADABLE'; attempts: number; rank: number | null; tier: string } {
  if (i === 48) return { row: Math.floor(i / 7), col: i % 7, status: 'UNREADABLE', attempts: 3, rank: null, tier: 'GRAY_UNREADABLE' };
  const rank = i % 10 === 9 ? null : (i % 9) + 1;
  const tier = rank === null ? 'INVISIBLE' : rank <= 3 ? 'GREEN_TOP3' : rank <= 7 ? 'YELLOW_TOP7' : 'RED_8_TO_20';
  return { row: Math.floor(i / 7), col: i % 7, status: 'VALID', attempts: 1, rank, tier };
}

test('pontos: a fórmula respeita as restrições e os agregados das rodadas batem com ela; o SQL usa exatamente essa fórmula', () => {
  const points = Array.from({ length: 49 }, (_, i) => point(i));
  const tiers = ['GREEN_TOP3', 'YELLOW_TOP7', 'RED_8_TO_20', 'INVISIBLE', 'GRAY_UNREADABLE'];
  assert.ok(new Set(points.map((p) => `${p.row},${p.col}`)).size === 49, '49 posições distintas de grade');
  points.forEach((p, i) => {
    within(i, 0, 48, 'point_index');
    within(p.row, 0, 6, 'row_index');
    within(p.col, 0, 6, 'col_index');
    within(p.attempts, 1, 3, 'attempts_made');
    oneOf(p.tier, tiers, 'visual_tier');
    assert.equal(p.rank === null, p.tier === 'INVISIBLE' || p.tier === 'GRAY_UNREADABLE', 'target_rank nulo só para invisível e ilegível');
  });
  // O que o app grava (src/lib/supabase.ts) vem de computeTerritoryRankMetrics: índice de posição (fora do Top 20 = 21) e
  // percentuais sobre os pontos VÁLIDOS, em 1 casa decimal. A classificação visual vem de classifyGridPoint.
  const metrics = computeTerritoryRankMetrics(points.map((p) => ({ readStatus: p.status, targetRank: p.rank })));
  for (const p of points) assert.equal(p.tier, classifyGridPoint(p.status, p.rank), `tier do ponto (${p.row},${p.col}) diferente da classificação do app`);
  const count = (tier: string): number => points.filter((p) => p.tier === tier).length;
  const expected = {
    valid_points_count: metrics.validPoints,
    unreadable_points_count: metrics.unreadablePoints,
    green_top3_count: count('GREEN_TOP3'),
    yellow_top4_to_7_count: count('YELLOW_TOP7'),
    red_rank8_to_20_count: count('RED_8_TO_20'),
    invisible_count: count('INVISIBLE'),
    average_position: metrics.rankIndexAverage,
    top3_percentage: metrics.top3Percent,
    top7_percentage: metrics.top7Percent,
    invisibility_percentage: metrics.outsideTop20Percent,
  };
  assert.deepEqual(expected, { valid_points_count: 48, unreadable_points_count: 1, green_top3_count: 15, yellow_top4_to_7_count: 19, red_rank8_to_20_count: 10, invisible_count: 4, average_position: 6.35, top3_percentage: 31.3, top7_percentage: 70.8, invisibility_percentage: 8.3 });
  for (const round of rounds.rows) for (const [key, value] of Object.entries(expected)) assert.equal(round[key], value, `rodada.${key}`);
  assert.equal(expected.green_top3_count + expected.yellow_top4_to_7_count + expected.red_rank8_to_20_count + expected.invisible_count + expected.unreadable_points_count, 49);

  for (const snippet of [
    'cross join generate_series(0, 48) as g(i)',
    'g.i,\n    g.i / 7,\n    g.i % 7,',
    "case when g.i = 48 then 'UNREADABLE' else 'VALID' end",
    'case when g.i = 48 then 3 else 1 end',
    'case when g.i = 48 or g.i % 10 = 9 then null else (g.i % 9) + 1 end',
    "when g.i = 48 then 'GRAY_UNREADABLE'",
    "when g.i % 10 = 9 then 'INVISIBLE'",
    "when (g.i % 9) + 1 <= 3 then 'GREEN_TOP3'",
    "when (g.i % 9) + 1 <= 7 then 'YELLOW_TOP7'",
    "else 'RED_8_TO_20'",
  ]) assert.ok(code.includes(snippet), `o SQL dos pontos mudou: ${snippet}`);
  assert.equal(rounds.rows.length * 49, 98, 'pontos esperados: 98');
});

/** Divide uma lista SQL nas vírgulas de nível zero (fora de parênteses e de textos entre aspas simples). */
function splitTopLevel(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current.trim());
  return items;
}

test('pontos: as 17 colunas do INSERT batem, uma a uma e na ordem, com as 17 expressões do SELECT', () => {
  const match = /insert into public\.gmn_battlefield_points \(([^)]*)\)\s+select([\s\S]*?)\n\s+from \(values/.exec(code);
  assert.ok(match, 'INSERT ... SELECT dos pontos não encontrado');
  const columns = (match[1] ?? '').split(',').map((c) => c.trim());
  const expressions = splitTopLevel(match[2] ?? '');
  assert.equal(columns.length, 17);
  assert.equal(expressions.length, columns.length, 'uma expressão por coluna');
  const shape: Record<string, RegExp> = {
    id: /^\('1ab09017-0000-4000-8000-' \|\| lpad\(/,
    round_id: /^r\.id$/,
    point_index: /^g\.i$/,
    row_index: /^g\.i \/ 7$/,
    col_index: /^g\.i % 7$/,
    latitude: /^\(r\.lat \+ /,
    longitude: /^\(r\.lng \+ /,
    distance_from_center_meters: /^round\(sqrt\(/,
    read_status: /^case when g\.i = 48 then 'UNREADABLE' else 'VALID' end$/,
    attempts_made: /^case when g\.i = 48 then 3 else 1 end$/,
    target_rank: /^case when g\.i = 48 or g\.i % 10 = 9 then null else \(g\.i % 9\) \+ 1 end$/,
    visual_tier: /^case\s+when g\.i = 48 then 'GRAY_UNREADABLE'/,
    leader_place_id: /LAB-FICT-LEADER-/,
    leader_business_name: /Concorrente Fictício/,
    leader_primary_category: /Categoria Fictícia \(LAB\)/,
    leader_rating: /else 4\.00 end$/,
    leader_total_reviews: /else 10 end$/,
  };
  assert.deepEqual(columns, Object.keys(shape), 'colunas na ordem esperada');
  columns.forEach((column, index) => assert.match(expressions[index] ?? '', shape[column] as RegExp, `coluna ${column} (posição ${index + 1})`));
});
