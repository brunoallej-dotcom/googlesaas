-- ============================================================================
-- REVERSÃO da proposta 003_rls_hardening.sql (NÃO APLICADA)       (revisão 2, 17/10/2026)
--
-- AJUSTADO AO ESTADO REAL lido em produção em 17/10/2026 (rls-audit-json.sql, PostgreSQL 17.11):
--   * nas 5 tabelas: anon, authenticated, service_role e postgres tinham EXATAMENTE `arwdDxtm` (= ALL no
--     PG17: INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN), concedido por
--     postgres, sem GRANT OPTION; PUBLIC não tinha nada;
--   * RLS ligado, sem FORCE, e ZERO políticas (em public e em storage);
--   * privilégios padrão do papel postgres em public: tabelas `arwdDxtm`, sequências `rwU` e funções `X`
--     para anon, authenticated e service_role (é o que os GRANTs abaixo recriam);
--   * não há sequências nem views nem privilégios por coluna em public.
-- Portanto `GRANT ALL` aos três papéis devolve exatamente o estado anterior (nem mais, nem menos).
-- Mantém o RLS LIGADO e remove só a política criada pela 003. Único bloco DO (atômico).
-- ============================================================================
do $g5r$
declare
  tabelas text[] := array['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'];
  t text;
begin
  foreach t in array tabelas loop
    execute format('drop policy if exists gmn_deny_all on public.%I', t);
    execute format('grant all on table public.%I to anon, authenticated, service_role', t);
  end loop;
  -- Confere que o estado original foi restaurado (aborta e desfaz se não)
  foreach t in array tabelas loop
    if not (has_table_privilege('anon', format('public.%I', t), 'SELECT') and has_table_privilege('authenticated', format('public.%I', t), 'DELETE')
            and has_table_privilege('service_role', format('public.%I', t), 'INSERT')) then
      raise exception 'Reversão incompleta em public.%; tudo foi desfeito.', t;
    end if;
  end loop;
  begin
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
  exception when insufficient_privilege then
    raise notice 'Sem permissão para alterar privilégios padrão; ignorado.';
  end;
end
$g5r$;
