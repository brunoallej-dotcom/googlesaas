-- ============================================================================
-- PROPOSTA (NÃO APLICADA): 003_rls_hardening.sql        (revisão 3, 17/10/2026, conferida com o JSON real)
-- Fica em supabase/proposed/ DE PROPÓSITO, fora de supabase/migrations/, para que nenhuma ferramenta
-- a aplique sozinha. Só aplicar com autorização expressa (portão G5).
--
-- Por quê: a sonda real mostrou que o papel `anon` tem privilégio de SELECT, UPDATE e DELETE nas 5
-- tabelas e que SOMENTE o RLS impede o acesso. O app usa exclusivamente a service role (que ignora
-- RLS) e o login usa só o esquema `auth`; anon e authenticated não precisam de acesso algum às tabelas.
--
-- É UM ÚNICO bloco DO (uma instrução = atômica): qualquer erro desfaz tudo. O bloco:
--   1) PRÉ-VALIDA (aborta sem alterar nada) que este é o projeto do GMN (bucket gmn-audit-pdfs-private
--      existe), que service_role tem BYPASSRLS e SELECT/INSERT/UPDATE/DELETE nas 5 tabelas e que as 5
--      tabelas existem;
--   2) habilita RLS, cria a política RESTRITIVA gmn_deny_all para anon/authenticated e REVOGA os
--      privilégios de anon/authenticated/PUBLIC nas tabelas e sequências do esquema public;
--   3) impede que objetos NOVOS criados pelo papel postgres herdem acesso de anon/authenticated;
--   4) PÓS-VALIDA (aborta e desfaz tudo) que anon/authenticated ficaram sem nenhum privilégio e que
--      service_role continua com os 4 privilégios.
-- NÃO altera: storage.*, esquema auth, funções, triggers, dados, FORCE RLS, políticas pré-existentes.
-- Políticas antigas (se a auditoria mostrar alguma) ficam inertes por falta de privilégio; removê-las é
-- um passo separado e revisado.
-- ============================================================================
do $g5$
declare
  tabelas text[] := array['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'];
  t text;
  p text;
begin
  -- 1) Pré-validações -------------------------------------------------------
  -- Assinatura do projeto: evita rodar no projeto Supabase errado (leitura apenas).
  if not exists (select 1 from storage.buckets where id = 'gmn-audit-pdfs-private') then
    raise exception 'G5 abortado: este não parece ser o projeto do GMN (bucket gmn-audit-pdfs-private ausente); nada foi alterado.';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'G5 abortado: service_role não tem BYPASSRLS; nada foi alterado.';
  end if;
  foreach t in array tabelas loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'G5 abortado: a tabela public.% não existe; nada foi alterado.', t;
    end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception 'G5 abortado: service_role sem % em public.%; nada foi alterado.', p, t;
      end if;
    end loop;
  end loop;

  -- 2) RLS + política restritiva + revogação de privilégios ------------------
  foreach t in array tabelas loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists gmn_deny_all on public.%I', t);
    -- RESTRICTIVE: é combinada por E com qualquer política permissiva antiga, então nega mesmo assim.
    execute format(
      'create policy gmn_deny_all on public.%I as restrictive for all to anon, authenticated using (false) with check (false)', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
  end loop;
  revoke all on all sequences in schema public from anon, authenticated;

  -- 3) Objetos futuros do papel postgres não herdam acesso de anon/authenticated
  begin
    alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
    alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
    alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
  exception when insufficient_privilege then
    raise notice 'Sem permissão para alterar privilégios padrão do papel postgres; ignorado (as tabelas atuais já estão protegidas).';
  end;

  -- 4) Pós-validações (qualquer falha desfaz TUDO) ---------------------------
  foreach t in array tabelas loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), p) or has_table_privilege('authenticated', format('public.%I', t), p) then
        raise exception 'G5 falhou: anon/authenticated ainda têm % em public.%; tudo foi desfeito.', p, t;
      end if;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception 'G5 falhou: service_role perdeu % em public.%; tudo foi desfeito.', p, t;
      end if;
    end loop;
  end loop;
end
$g5$;
