-- ============================================================================
-- GMN: AUDITORIA DE SEGURANÇA DO BANCO (SOMENTE LEITURA)
-- Cole no SQL Editor do Supabase e execute. Só há SELECT: nada é criado, alterado ou apagado.
-- Copie o resultado de CADA consulta de volta para a conversa (ou salve como CSV).
-- Objetivo: provar o estado real de RLS, políticas, privilégios e Storage, em vez de
-- presumir segurança porque uma consulta anônima voltou vazia.
-- ============================================================================

-- 1) RLS por tabela (rls_ativo deve ser true em todas as tabelas gmn_* / prospecting_*)
select n.nspname as esquema, c.relname as objeto, c.relkind as tipo,
       c.relrowsecurity as rls_ativo, c.relforcerowsecurity as rls_forcado
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'storage') and c.relkind in ('r', 'p', 'v', 'm')
order by 1, 2;

-- 2) Políticas existentes (o que cada papel PODE fazer; qual = USING, with_check = WITH CHECK)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname in ('public', 'storage')
order by 1, 2, 3;

-- 3) Privilégios em tabelas para anon / authenticated / PUBLIC (a existência de privilégio
--    mostra que, se o RLS falhar ou for desligado, o dado fica exposto)
select grantee, table_schema, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privilegios
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
group by 1, 2, 3
order by 2, 3, 1;

-- 4) Funções do esquema public: quem pode executar via /rpc, e se são SECURITY DEFINER
select p.proname as funcao, pg_get_function_identity_arguments(p.oid) as argumentos,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_executa,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_executa
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by 1;

-- 5) Privilégios padrão (o que um objeto NOVO herda automaticamente)
select pg_get_userbyid(defaclrole) as criador, defaclnamespace::regnamespace as esquema,
       defaclobjtype as tipo, defaclacl as acl
from pg_default_acl
order by 1, 2, 3;

-- 6) Views no esquema public (views ignoram o RLS do dono se não forem security_invoker)
select c.relname as view, c.reloptions as opcoes
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v', 'm');

-- 7) Papéis e BYPASSRLS (service_role deve ignorar RLS; anon/authenticated NÃO)
select rolname, rolbypassrls, rolsuper
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin');

-- 8) Buckets do Storage (public = true significa leitura sem login, independentemente de políticas)
select id, name, public, file_size_limit, allowed_mime_types, created_at
from storage.buckets
order by created_at;

-- 9) Quantidade de objetos por bucket
select bucket_id, count(*) as objetos
from storage.objects
group by 1;

-- 10) Tabelas publicadas no Realtime (publicação expõe alterações a quem tiver acesso)
select pubname, schemaname, tablename
from pg_publication_tables
where schemaname = 'public'
order by 1, 2, 3;
