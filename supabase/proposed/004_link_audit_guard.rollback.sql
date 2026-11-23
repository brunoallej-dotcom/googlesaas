-- ============================================================================
-- ROLLBACK (NÃO APLICADO) da proposta 004_link_audit_guard.sql                (G1.b.2a, 22/11/2026)
-- Volta ao estado anterior à 004: sem o esquema gmn_link_audit_guard e sem os papéis gmn_guard_owner, gmn_guard_writer
-- e gmn_guard_reader. Nada fora disso é tocado (nenhum objeto de public, auth, storage; nenhum privilégio padrão).
--
-- APAGA A TESTEMUNHA. Com cabeças gravadas, remover a guarda é apagar o registro que detecta o rollback coordenado
-- (spec `docs/specs/link-audit-production-gates.md` §5.1; regra do projeto: nada histórico é apagado sem autorização).
-- Por isso, com QUALQUER linha em ledger_heads o rollback ABORTA, a menos que o responsável confirme na MESMA sessão,
-- depois de guardar a cópia das cabeças pela reconciliação (GE-E5):
--     set gmn.guard_rollback_confirm = 'APAGAR-CABECAS-DA-GUARDA';
-- Sem linhas (laboratório recém-criado, aplicação abortada), roda sem confirmação.
--
-- Atômico (BEGIN … COMMIT) e idempotente (sem nada da 004, não faz nada). Confere o resultado no fim.
-- As senhas dos papéis somem com eles: as credenciais GMN_LINK_AUDIT_GUARD_DB_URL e a da reconciliação deixam de valer.
-- ============================================================================
begin;

do $pre$
declare
  v_rows bigint;
begin
  if pg_catalog.to_regclass('gmn_link_audit_guard.ledger_heads') is not null then
    -- o `postgres` do Supabase é membro de pg_read_all_data; sem ele, quem roda precisa ser o dono (passo abaixo)
    execute 'select pg_catalog.count(*) from gmn_link_audit_guard.ledger_heads' into v_rows;
    if v_rows > 0 and coalesce(pg_catalog.current_setting('gmn.guard_rollback_confirm', true), '') <> 'APAGAR-CABECAS-DA-GUARDA' then
      raise exception 'ROLLBACK da guarda abortado: ledger_heads tem % cabeça(s); apagar a testemunha exige a confirmação do responsável (cabeçalho); nada foi alterado.', v_rows;
    end if;
  end if;
  if exists (select 1 from pg_catalog.pg_namespace n join pg_catalog.pg_roles r on r.oid = n.nspowner
             where n.nspname = 'gmn_link_audit_guard' and r.rolname <> 'gmn_guard_owner') then
    raise exception 'ROLLBACK da guarda abortado: o esquema gmn_link_audit_guard não é da guarda (outro dono); nada foi alterado.';
  end if;
end
$pre$;

-- remove o esquema COMO o dono (o `postgres` não é dono nem membro; a associação é temporária e some com o papel)
do $drop$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'gmn_guard_owner') then
    grant gmn_guard_owner to current_user with inherit false, set true;
  end if;
end
$drop$;
do $schema$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'gmn_link_audit_guard') then
    set local role gmn_guard_owner;
    drop schema gmn_link_audit_guard cascade; -- tabela, gatilhos e as três funções
    reset role;
  end if;
end
$schema$;

-- papéis: os privilégios deles eram só nos objetos do esquema (já removidos) e os ajustes de papel somem com o DROP ROLE.
-- Se alguém concedeu a eles algo FORA da 004, o DROP ROLE falha e o rollback inteiro é desfeito (conferir à mão, sem DROP OWNED).
do $roles$
declare
  v_role text;
begin
  foreach v_role in array array['gmn_guard_writer', 'gmn_guard_reader', 'gmn_guard_owner'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute pg_catalog.format('drop role %I', v_role);
    end if;
  end loop;
end
$roles$;

do $post$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'gmn_link_audit_guard') then
    raise exception 'ROLLBACK da guarda falhou: o esquema continua; tudo foi desfeito.';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname in ('gmn_guard_owner', 'gmn_guard_writer', 'gmn_guard_reader')) then
    raise exception 'ROLLBACK da guarda falhou: papel da guarda continua; tudo foi desfeito.';
  end if;
end
$post$;

commit;
