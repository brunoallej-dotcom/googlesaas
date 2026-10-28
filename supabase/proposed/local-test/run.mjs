import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const P = process.argv[2];
const read = (f) => fs.readFileSync(path.join(P, f), 'utf8');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'pw', port: 54329, persistent: false, onLog: () => {}, onError: () => {} });
await pg.initialise(); await pg.start();
const results = [];
const ok = (name) => { results.push(name); console.log('OK   ', name); };

async function client(db) { const c = pg.getPgClient(db); await c.connect(); return c; }
const as = async (c, role, sql, params) => {
  await c.query(`set role ${role}`);
  try { return { rows: (await c.query(sql, params)).rows }; }
  catch (e) { return { error: e.code, message: e.message }; }
  finally { await c.query('reset role'); }
};

// papéis (cluster inteiro), como no Supabase
const root = await client('postgres');
await root.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator login password 'x'`);
await root.query(`grant anon, authenticated, service_role to authenticator`);

const MIG001 = read('supabase/migrations/001_gmn_schema.sql').replace(/create extension if not exists "uuid-ossp";/i, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const MIG002 = read('supabase/migrations/002_audit_payloads.sql');
const AUDIT = read('supabase/audit/rls-audit-json.sql');
const HARDEN = read('supabase/proposed/003_rls_hardening.sql');
const ROLLBACK = read('supabase/proposed/003_rls_hardening.rollback.sql');
const TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'];

let n = 0;
async function freshDb({ oldPermissive = false } = {}) {
  const name = `t${++n}`;
  await root.query(`create database ${name}`);
  const c = await client(name);
  await c.query(`
    create schema auth; create table auth.users (id uuid primary key default gen_random_uuid());
    create schema storage; create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
    create table storage.objects (bucket_id text, name text);
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  await c.query(MIG001); await c.query(MIG002);
  for (const t of TABLES) await c.query(`alter table public.${t} enable row level security`); // estado de produção observado
  await c.query(`
    insert into prospecting_campaigns (id, city, niche_keyword, center_lat, center_lng) values ('11111111-1111-4111-8111-111111111111','Anápolis','Dentista',-16.3,-48.9);
    insert into gmn_leads (id, campaign_id, place_id, business_name, primary_category, frontier_rank, frontier_page, whatsapp_status, website_status, latitude, longitude)
      values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','P1','Empresa','Dentista',12,1,'MISSING','MISSING',-16.3,-48.9);
    insert into gmn_audits (id, lead_id, place_id, target_keyword, interest_center_lat, interest_center_lng)
      values ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','P1','dentista',-16.3,-48.9);
    insert into storage.buckets (id, name, public) values ('gmn-audit-pdfs', 'gmn-audit-pdfs', false), ('gmn-audit-pdfs-private', 'gmn-audit-pdfs-private', false);`);
  if (oldPermissive) {
    await c.query(`create policy antiga_leitura on public.gmn_leads for select to anon, authenticated using (true);
                   create policy antiga_escrita on public.gmn_audits for all to authenticated using (true) with check (true);`);
  }
  return c;
}

try {
  // ---------- CENÁRIO 1: antes e depois, com política permissiva ANTIGA ----------
  const c = await freshDb({ oldPermissive: true });
  const aclOf = async () => (await c.query(`select relname, (select string_agg(e::text, ',' order by e::text) from unnest(relacl) e) acl from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname in ('prospecting_campaigns','gmn_leads','gmn_audits','gmn_battlefield_rounds','gmn_battlefield_points') order by relname`)).rows;
  const defaclOf = async () => (await c.query(`select pg_get_userbyid(defaclrole) r, defaclobjtype t, (select string_agg(e::text, ',' order by e::text) from unnest(defaclacl) e) a from pg_default_acl where defaclnamespace='public'::regnamespace order by 1,2`)).rows;
  const aclBefore = await aclOf(); const defBefore = await defaclOf();
  const before = JSON.parse((await c.query(AUDIT)).rows[0].audit);
  assert.equal(Object.keys(before).length >= 18, true);
  assert.ok(before['1_rls_por_tabela'].find((r) => r.objeto === 'gmn_audits').rls_ativo);
  assert.ok(before['2_politicas'].some((p) => p.politica === 'antiga_leitura' && p.permissiva === 'PERMISSIVE'));
  const anonPrivBefore = before['3_privilegios_de_tabela'].find((r) => r.tabela === 'gmn_audits' && r.papel === 'anon');
  assert.ok(anonPrivBefore.privilegios.includes('DELETE') && anonPrivBefore.privilegios.includes('SELECT'));
  assert.equal(before['8_papeis'].find((r) => r.papel === 'service_role').bypassrls, true);
  assert.equal(before['12_privilegios_efetivos_nas_5_tabelas'].filter((r) => r.papel === 'service_role' && r.tem).length, 35);
  ok('auditoria JSON executa e descreve o estado "antes" (RLS ativo, política permissiva antiga, anon com SELECT/DELETE, service_role BYPASSRLS)');

  // ANTES: a política permissiva antiga EXPÕE dados a anon/authenticated (prova do risco)
  assert.equal((await as(c, 'anon', 'select count(*)::int n from gmn_leads')).rows[0].n, 1);
  assert.equal((await as(c, 'authenticated', 'select count(*)::int n from gmn_audits')).rows[0].n, 1);
  assert.equal((await as(c, 'anon', 'select count(*)::int n from gmn_audits')).rows[0].n, 0, 'sem política: RLS filtra');
  ok('ANTES: política permissiva antiga expõe dados (anon lê leads; authenticated lê/escreve audits); sem política o RLS só filtra');

  await c.query(HARDEN);
  ok('003 aplicada sem erro (bloco único)');

  for (const role of ['anon', 'authenticated']) {
    for (const t of TABLES) {
      const sel = await as(c, role, `select count(*) from public.${t}`);
      assert.equal(sel.error, '42501', `${role} select ${t}: ${sel.message}`);
    }
    assert.equal((await as(c, role, `update gmn_audits set target_keyword='x'`)).error, '42501');
    assert.equal((await as(c, role, `delete from gmn_audits`)).error, '42501');
    assert.equal((await as(c, role, `insert into prospecting_campaigns (city, niche_keyword, center_lat, center_lng) values ('x','y',0,0)`)).error, '42501');
  }
  ok('DEPOIS: anon e authenticated recebem 42501 (sem privilégio) em SELECT/INSERT/UPDATE/DELETE nas 5 tabelas, mesmo com política permissiva antiga');

  // service_role segue funcionando (inclui trigger updated_at e RLS ignorado)
  assert.equal((await as(c, 'service_role', 'select count(*)::int n from gmn_audits')).rows[0].n, 1);
  assert.equal((await as(c, 'service_role', 'select count(*)::int n from gmn_leads')).rows[0].n, 1);
  const t0 = (await c.query(`select updated_at from gmn_audits where id='33333333-3333-4333-8333-333333333333'`)).rows[0].updated_at;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!(await as(c, 'service_role', `update gmn_audits set status='RUNNING_EXTRACTION' where id='33333333-3333-4333-8333-333333333333'`)).error);
  const t1 = (await c.query(`select updated_at from gmn_audits where id='33333333-3333-4333-8333-333333333333'`)).rows[0].updated_at;
  assert.ok(t1 > t0, 'trigger set_gmn_audits_updated_at continua disparando para service_role');
  const ins = await as(c, 'service_role', `insert into prospecting_campaigns (city, niche_keyword, center_lat, center_lng) values ('Teste','Teste',0,0) returning id`);
  assert.ok(ins.rows?.[0]?.id, ins.message);
  assert.ok(!(await as(c, 'service_role', `delete from prospecting_campaigns where city='Teste'`)).error);
  ok('DEPOIS: service_role lê, insere, atualiza (trigger updated_at dispara) e apaga normalmente');

  const after = JSON.parse((await c.query(AUDIT)).rows[0].audit);
  assert.ok(after['2_politicas'].filter((p) => p.politica === 'gmn_deny_all').every((p) => p.permissiva === 'RESTRICTIVE'));
  assert.equal(after['2_politicas'].filter((p) => p.politica === 'gmn_deny_all').length, 5);
  assert.equal(after['12_privilegios_efetivos_nas_5_tabelas'].filter((r) => r.papel !== 'service_role' && r.tem).length, 0);
  assert.equal(after['12_privilegios_efetivos_nas_5_tabelas'].filter((r) => r.papel === 'service_role' && r.privilegio !== 'TRUNCATE' && r.tem).length > 0, true);
  assert.equal(after['3_privilegios_de_tabela'].filter((r) => r.papel === 'PUBLIC' || r.papel === 'anon' || r.papel === 'authenticated').length, 0);
  assert.ok(after['1_rls_por_tabela'].filter((r) => TABLES.includes(r.objeto)).every((r) => r.rls_ativo && !r.rls_forcado));
  ok('auditoria JSON "depois": 5 políticas RESTRICTIVE, anon/authenticated/PUBLIC sem nenhum privilégio, RLS ativo e SEM FORCE');

  // objetos futuros do postgres não herdam acesso
  await c.query(`create table public.futura (id int)`);
  assert.equal((await as(c, 'anon', 'select * from public.futura')).error, '42501');
  ok('tabela futura criada pelo postgres NÃO é acessível a anon');

  // idempotência
  await c.query(HARDEN);
  ok('003 é idempotente (segunda execução sem erro)');

  // ---------- reversão ----------
  await c.query(ROLLBACK);
  const rolled = JSON.parse((await c.query(AUDIT)).rows[0].audit);
  assert.equal(rolled['2_politicas'].filter((p) => p.politica === 'gmn_deny_all').length, 0);
  assert.ok(rolled['3_privilegios_de_tabela'].find((r) => r.tabela === 'gmn_audits' && r.papel === 'anon').privilegios.includes('DELETE'));
  assert.ok(rolled['1_rls_por_tabela'].filter((r) => TABLES.includes(r.objeto)).every((r) => r.rls_ativo), 'RLS continua ligado');
  assert.equal((await as(c, 'service_role', 'select count(*)::int n from gmn_audits')).rows[0].n, 1);
  // a política antiga reaparece como a ÚNICA barreira, como antes
  assert.equal((await as(c, 'anon', 'select count(*)::int n from gmn_leads')).rows[0].n, 1);
  assert.deepEqual(await aclOf(), aclBefore, 'ACLs das tabelas idênticas às originais');
  assert.deepEqual(await defaclOf(), defBefore, 'privilégios padrão idênticos aos originais');
  ok('REVERSÃO: remove a política da 003, devolve os privilégios e mantém o RLS ligado (estado anterior)');
  ok('REVERSÃO EXATA: conjunto de privilégios (ACL) de cada tabela e privilégios padrão idênticos aos de antes da 003 (a ordem das entradas na lista não tem significado)');
  await c.end();

  // ---------- CENÁRIO 2: pré-validações abortam sem alterar nada ----------
  const expectAbort = async (name, setup, teardown, message) => {
    const d = await freshDb();
    await setup(d);
    let error = null;
    try { await d.query(HARDEN); } catch (e) { error = e; }
    assert.ok(error && new RegExp(message).test(error.message), `${name}: ${error?.message}`);
    const state = JSON.parse((await d.query(AUDIT)).rows[0].audit);
    assert.equal(state['2_politicas'].filter((p) => p.politica === 'gmn_deny_all').length, 0, `${name}: nada criado`);
    assert.ok(state['3_privilegios_de_tabela'].find((r) => r.tabela === 'gmn_leads' && r.papel === 'anon'), `${name}: anon manteve os privilégios`);
    await teardown?.(d);
    await d.end();
    ok(`PRÉ-VALIDAÇÃO aborta e nada muda: ${name}`);
  };
  await expectAbort('service_role sem BYPASSRLS', (d) => d.query(`alter role service_role nobypassrls`), (d) => d.query(`alter role service_role bypassrls`), 'BYPASSRLS');
  await expectAbort('service_role sem INSERT em gmn_audits', (d) => d.query(`revoke insert on public.gmn_audits from service_role`), null, 'service_role sem INSERT em public.gmn_audits');
  await expectAbort('projeto errado (sem o bucket gmn-audit-pdfs-private)', (d) => d.query(`delete from storage.buckets where id = 'gmn-audit-pdfs-private'`), null, 'não parece ser o projeto do GMN');
  await expectAbort('tabela ausente', (d) => d.query(`drop table public.gmn_battlefield_points`), null, 'não existe');

  console.log(`\nTODOS OS ${results.length} TESTES LOCAIS APROVADOS`);
} catch (e) {
  console.error('\nFALHOU:', e.message);
  process.exitCode = 1;
} finally {
  await root.end().catch(() => {});
  await pg.stop().catch(() => {});
}
