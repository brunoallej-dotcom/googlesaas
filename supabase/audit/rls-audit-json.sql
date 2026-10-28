-- ============================================================================
-- GMN: AUDITORIA DE SEGURANÇA DO BANCO, VERSÃO DE CONSULTA ÚNICA (SOMENTE LEITURA)
--
-- É UMA ÚNICA instrução SELECT. Não cria, altera nem apaga nada (sem INSERT, UPDATE, DELETE,
-- DDL, GRANT, REVOKE ou DO). Devolve UMA célula (coluna "audit") com um JSON que contém as seções
-- abaixo. O SQL Editor do Supabase costuma exibir só o resultado da última instrução; por isso
-- tudo vem em uma só consulta.
--
-- COMO USAR: Supabase → SQL Editor → New query → cole TODO este arquivo → Run.
-- Depois clique na célula da coluna "audit" → Copy (ou "Download CSV") e envie o conteúdo.
--
-- Seções do JSON:
--  1 RLS por tabela · 2 políticas · 3 privilégios de tabela (todos os papéis, incluindo PUBLIC) ·
--  3b privilégios por coluna · 4 privilégios de sequências · 5 funções do esquema public ·
--  6 privilégios padrão (objetos futuros) · 7 views · 8 papéis e BYPASSRLS · 9 pertencimento a papéis ·
--  10 buckets e objetos do Storage · 11 publicações Realtime · 12 privilégios EFETIVOS de
--  anon/authenticated/service_role nas 5 tabelas · 13 triggers · 14 extensões · 15 contagem de contas Auth
-- ============================================================================
select jsonb_pretty(jsonb_build_object(
  'coletado_em', now(),
  'versao_postgres', version(),
  'usuario_da_consulta', current_user,

  '1_rls_por_tabela', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'esquema', n.nspname, 'objeto', c.relname, 'tipo', c.relkind::text,
      'dono', pg_get_userbyid(c.relowner),
      'rls_ativo', c.relrowsecurity, 'rls_forcado', c.relforcerowsecurity
    ) order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'storage') and c.relkind in ('r', 'p', 'v', 'm')
  ),

  '2_politicas', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'esquema', schemaname, 'tabela', tablename, 'politica', policyname,
      'permissiva', permissive, 'papeis', to_jsonb(roles), 'comando', cmd,
      'using', qual, 'with_check', with_check
    ) order by schemaname, tablename, policyname), '[]'::jsonb)
    from pg_policies
    where schemaname in ('public', 'storage')
  ),

  '3_privilegios_de_tabela', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', t.relname, 'papel', t.papel, 'privilegios', t.privs
    ) order by t.relname, t.papel), '[]'::jsonb)
    from (
      select c.relname,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as papel,
             jsonb_agg(a.privilege_type order by a.privilege_type) as privs
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      group by c.relname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
    ) t
  ),

  '3b_privilegios_por_coluna', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', c.relname, 'coluna', at.attname,
      'papel', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilegio', a.privilege_type
    )), '[]'::jsonb)
    from pg_attribute at
    join pg_class c on c.oid = at.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(at.attacl) a
    where n.nspname = 'public' and at.attacl is not null and not at.attisdropped
  ),

  '4_privilegios_de_sequencias', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'sequencia', c.relname,
      'papel', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilegio', a.privilege_type
    )), '[]'::jsonb)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'S'
  ),

  '5_funcoes_public', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'funcao', p.proname, 'argumentos', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef, 'dono', pg_get_userbyid(p.proowner),
      'executam', (
        select coalesce(jsonb_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), '[]'::jsonb)
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.privilege_type = 'EXECUTE'
      )
    ) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),

  '6_privilegios_padrao', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'criador', pg_get_userbyid(d.defaclrole), 'esquema', d.defaclnamespace::regnamespace::text,
      'tipo', d.defaclobjtype::text, 'acl', d.defaclacl::text
    ) order by 1, 2, 3), '[]'::jsonb)
    from pg_default_acl d
  ),

  '7_views_public', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'view', c.relname, 'opcoes', c.reloptions, 'dono', pg_get_userbyid(c.relowner)
    )), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  ),

  '8_papeis', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'papel', rolname, 'bypassrls', rolbypassrls, 'superuser', rolsuper, 'login', rolcanlogin, 'herda', rolinherit
    ) order by rolname), '[]'::jsonb)
    from pg_roles
    where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin', 'dashboard_user')
  ),

  '9_pertencimento_a_papeis', (
    select coalesce(jsonb_agg(jsonb_build_object('papel', r.rolname, 'membro', m.rolname) order by r.rolname, m.rolname), '[]'::jsonb)
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid
    join pg_roles m on m.oid = am.member
    where r.rolname in ('anon', 'authenticated', 'service_role') or m.rolname in ('anon', 'authenticated', 'service_role')
  ),

  '10_storage', jsonb_build_object(
    'buckets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'publico', b.public, 'limite_bytes', b.file_size_limit, 'tipos', b.allowed_mime_types, 'criado_em', b.created_at
      ) order by b.created_at), '[]'::jsonb)
      from storage.buckets b
    ),
    'objetos_por_bucket', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'objetos', o.n) order by o.bucket_id), '[]'::jsonb)
      from (select bucket_id, count(*) as n from storage.objects group by bucket_id) o
    )
  ),

  '11_publicacoes_realtime', (
    select coalesce(jsonb_agg(jsonb_build_object('publicacao', pubname, 'esquema', schemaname, 'tabela', tablename)), '[]'::jsonb)
    from pg_publication_tables
    where schemaname = 'public'
  ),

  '12_privilegios_efetivos_nas_5_tabelas', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', t.tabela, 'papel', r.papel, 'privilegio', p.priv,
      'tem', has_table_privilege(r.papel, 'public.' || t.tabela, p.priv)
    ) order by t.tabela, r.papel, p.priv), '[]'::jsonb)
    from (values ('prospecting_campaigns'), ('gmn_leads'), ('gmn_audits'), ('gmn_battlefield_rounds'), ('gmn_battlefield_points')) as t(tabela)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(papel)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
    where to_regclass('public.' || t.tabela) is not null
  ),

  '13_triggers_nas_tabelas', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', c.relname, 'trigger', tg.tgname, 'funcao', tg.tgfoid::regproc::text, 'habilitado', tg.tgenabled::text
    ) order by c.relname, tg.tgname), '[]'::jsonb)
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not tg.tgisinternal and n.nspname = 'public'
  ),

  '14_extensoes', (
    select coalesce(jsonb_agg(extname order by extname), '[]'::jsonb) from pg_extension
  ),

  '15_contas_auth', (select count(*) from auth.users)
)) as audit;
