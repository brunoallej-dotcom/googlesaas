-- ============================================================================
-- PROPOSTA (NÃO APLICADA): 004_link_audit_guard.sql                    (G1.b.2a, 22/11/2026)
-- Guarda externa do livro de cabeças da Auditoria por Link (Fase 6): tabela append-only num esquema dedicado.
-- Fica em supabase/proposed/ DE PROPÓSITO, fora de supabase/migrations/, para que nenhuma ferramenta a aplique sozinha.
-- Quem aplica é o RESPONSÁVEL: primeiro no laboratório Supabase descartável (D-G0-12, PG-G08), depois em produção.
--
-- Contrato: spec `docs/specs/link-audit-production-gates.md` §5.1.6 opção (1) (desenho mínimo), §5.1.4 regras 7 e 8,
-- §5.1.7 (pseudônimo e números) e PG-G08; ADR-0003. Teste local: `supabase/proposed/local-test/guard-run.sh`.
--
-- O QUE CRIA (tudo por esta migração, nada pelo console):
--   - papel `gmn_guard_owner` (NOLOGIN, sem atributo privilegiado): DONO do esquema, da tabela e das três funções. Os objetos
--     nascem com `SET ROLE gmn_guard_owner`, então nenhum privilégio padrão do `postgres` se aplica a eles, e a função de
--     publicação `SECURITY DEFINER` roda com os privilégios desse dono, nunca com os do `postgres`;
--   - esquema `gmn_link_audit_guard`, que NÃO deve entrar em "Exposed schemas" da Data API (conferência do PG-G08, fora do SQL);
--   - tabela `gmn_link_audit_guard.ledger_heads (audit_ref, key_id, ledger_seq, sha256, recorded_at)`: `audit_ref` é o
--     pseudônimo HMAC-SHA-256 do `auditId` (D-G0-5; o `auditId` nunca chega aqui), `key_id` o id público da chave que o gerou,
--     `recorded_at` a hora do provedor (só informativa: a ordem vale pelo `ledger_seq`). Restrição única (audit_ref, ledger_seq);
--   - função `gmn_link_audit_guard.publish_head(audit_ref, key_id, ledger_seq, sha256)`: `SECURITY DEFINER`, `SET search_path = ''`,
--     objetos qualificados, trava consultiva por `audit_ref` e a REGRA 7 de forma atômica. Devolve `RECORDED` (gravado),
--     `ALREADY_RECORDED` (o mesmo registro já existe, em qualquer posição: idempotente), `CONFLICT` (mesma posição com outro
--     `sha256` ou outro `key_id`) ou `STALE` (posição nova abaixo da maior já gravada). Entrada fora do formato ⇒ erro;
--   - gatilhos de defesa em profundidade: `BEFORE UPDATE OR DELETE` (linha) e `BEFORE TRUNCATE` (instrução) recusam sempre;
--     `BEFORE INSERT` aplica a mesma regra 7, para que nem um INSERT direto (de quem tivesse o privilégio) contorne a monotonia,
--     e fixa `recorded_at` na hora do provedor;
--   - papel de LOGIN `gmn_guard_writer` (credencial da VPS, `GMN_LINK_AUDIT_GUARD_DB_URL`): só USAGE no esquema, SELECT na tabela
--     e EXECUTE na função de publicação. Sem INSERT/UPDATE/DELETE/TRUNCATE diretos, sem CREATE, sem associação a papel nenhum;
--   - papel de LOGIN `gmn_guard_reader` (reconciliação, credencial FORA da VPS): só USAGE e SELECT, sessão somente leitura;
--   - REVOKE ALL de PUBLIC, anon, authenticated e service_role (e authenticator) no esquema, na tabela e nas funções.
--
-- SENHAS: esta migração cria os papéis de login SEM senha (não autenticam). A senha é definida pelo responsável FORA do
-- repositório e fora do histórico do editor SQL, de preferência no psql com `\password gmn_guard_writer` (o cliente envia o
-- hash SCRAM, nunca a senha em claro). Idem para `gmn_guard_reader`, com outra senha, guardada fora da VPS.
--
-- ATÔMICA: uma transação só (BEGIN … COMMIT). Qualquer erro — inclusive uma conferência final — desfaz TUDO.
-- IDEMPOTENTE: rodar de novo não apaga nem altera cabeças já gravadas; reimpõe atributos, privilégios e funções.
-- CONFERÊNCIA DE PRIVILÉGIOS NO PRÓPRIO SQL (como a 003): blocos finais que abortam se existir qualquer privilégio proibido,
-- consultando o catálogo (pg_roles, pg_auth_members, pg_proc) e as ACLs (aclexplode), não só has_*_privilege.
--
-- LIMITES DECLARADOS (spec §5.1.6, ADR-0003): o dono/administrador do projeto Supabase (o papel `postgres`, `supabase_admin`,
-- o painel) consegue alterar ou remover gatilhos, privilégios e linhas, desligar gatilhos (`session_replication_role`) e
-- restaurar o banco. Esta migração protege contra o host comprometido (service_role, anon, authenticated e a credencial de
-- escrita), não contra o dono do projeto. O `postgres` do Supabase é membro de `pg_read_all_data` e lê a tabela.
-- ============================================================================
begin;

-- 1) Pré-validações (abortam sem alterar nada) ------------------------------------------------------------------
do $pre$
declare
  papel text;
begin
  if pg_catalog.current_setting('server_version_num')::integer < 160000 then
    raise exception 'GUARDA abortada: requer PostgreSQL 16 ou mais novo (opções de associação SET/INHERIT); nada foi alterado.';
  end if;
  -- assinatura de projeto Supabase: os papéis da Data API existem (o REVOKE abaixo depende deles)
  foreach papel in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    if not exists (select 1 from pg_catalog.pg_roles r where r.rolname = papel) then
      raise exception 'GUARDA abortada: o papel % não existe (este não parece ser um projeto Supabase); nada foi alterado.', papel;
    end if;
  end loop;
  -- nome do esquema/tabela ocupado por outro dono ⇒ não é a guarda: aborta em vez de adotar objetos de terceiros
  if exists (select 1 from pg_catalog.pg_namespace n join pg_catalog.pg_roles r on r.oid = n.nspowner
             where n.nspname = 'gmn_link_audit_guard' and r.rolname <> 'gmn_guard_owner') then
    raise exception 'GUARDA abortada: o esquema gmn_link_audit_guard já existe com outro dono; nada foi alterado.';
  end if;
  if pg_catalog.to_regclass('gmn_link_audit_guard.ledger_heads') is not null
     and (select r.rolname from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
          where c.oid = pg_catalog.to_regclass('gmn_link_audit_guard.ledger_heads')) <> 'gmn_guard_owner' then
    raise exception 'GUARDA abortada: a tabela gmn_link_audit_guard.ledger_heads já existe com outro dono; nada foi alterado.';
  end if;
end
$pre$;

-- 2) Papéis (criados se faltarem; os atributos são reimpostos em toda execução) ------------------------------------
do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'gmn_guard_owner') then
    create role gmn_guard_owner nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'gmn_guard_writer') then
    create role gmn_guard_writer login; -- sem senha: não autentica até o responsável defini-la (cabeçalho)
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'gmn_guard_reader') then
    create role gmn_guard_reader login; -- idem, com senha própria guardada FORA da VPS
  end if;
end
$roles$;

-- NOSUPERUSER não é repetido: só um superusuário pode citar esse atributo (PG 16+). Papel criado pelo `postgres` nasce sem ele,
-- e a conferência final aborta se algum papel da guarda o tiver.
alter role gmn_guard_owner nologin noinherit nocreatedb nocreaterole noreplication nobypassrls;
alter role gmn_guard_writer login noinherit nocreatedb nocreaterole noreplication nobypassrls connection limit 10;
alter role gmn_guard_reader login noinherit nocreatedb nocreaterole noreplication nobypassrls connection limit 3;
-- Prazos do lado do servidor (D-G0-3: 3 s por chamada também no banco, além do cliente) e isolamento exigido pela função.
alter role gmn_guard_writer set statement_timeout = '3s';
alter role gmn_guard_writer set lock_timeout = '3s';
alter role gmn_guard_writer set idle_in_transaction_session_timeout = '5s';
alter role gmn_guard_writer set default_transaction_isolation = 'read committed';
alter role gmn_guard_reader set default_transaction_read_only = on;
alter role gmn_guard_reader set statement_timeout = '30s';
alter role gmn_guard_reader set idle_in_transaction_session_timeout = '60s';

-- 3) Esquema e objetos, criados COMO o dono (associação temporária do `postgres`, desfeita no passo 5) --------------
grant gmn_guard_owner to current_user with inherit false, set true;
create schema if not exists gmn_link_audit_guard authorization gmn_guard_owner;
set local role gmn_guard_owner;

create table if not exists gmn_link_audit_guard.ledger_heads (
  audit_ref text not null constraint ledger_heads_audit_ref_format check (audit_ref ~ '^[0-9a-f]{64}$'),
  key_id text not null constraint ledger_heads_key_id_format check (key_id ~ '^[a-z0-9][a-z0-9-]{3,31}$'),
  -- 1..4000 = MAX_LEDGER_RECORDS do livro (`src/lib/link-audit-ledger/types.ts`; um teste trava a igualdade)
  ledger_seq integer not null constraint ledger_heads_ledger_seq_range check (ledger_seq between 1 and 4000),
  sha256 text not null constraint ledger_heads_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint ledger_heads_audit_ref_ledger_seq_key unique (audit_ref, ledger_seq)
);
comment on table gmn_link_audit_guard.ledger_heads is
  'Guarda externa do livro de cabeças (Fase 6, ADR-0003): append-only, regra 7 por audit_ref (pseudônimo HMAC, nunca o auditId).';

-- Função de PUBLICAÇÃO (a única escrita): regra 7 atômica por audit_ref.
create or replace function gmn_link_audit_guard.publish_head(p_audit_ref text, p_key_id text, p_ledger_seq integer, p_sha256 text)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $publish$
declare
  v_sha256 text;
  v_key_id text;
  v_max integer;
begin
  -- a leitura depois da trava precisa ver o que outra transação gravou antes de soltá-la: só em READ COMMITTED
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'guarda: publish_head exige isolamento read committed';
  end if;
  if p_audit_ref is null or p_audit_ref !~ '^[0-9a-f]{64}$' then raise exception 'guarda: audit_ref fora do formato'; end if;
  if p_key_id is null or p_key_id !~ '^[a-z0-9][a-z0-9-]{3,31}$' then raise exception 'guarda: key_id fora do formato'; end if;
  if p_ledger_seq is null or p_ledger_seq < 1 or p_ledger_seq > 4000 then raise exception 'guarda: ledger_seq fora da faixa'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'guarda: sha256 fora do formato'; end if;

  -- trava consultiva POR AUDITORIA (pelo pseudônimo), solta no fim da transação
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gmn_link_audit_guard:' || p_audit_ref, 0));

  select h.sha256, h.key_id into v_sha256, v_key_id
    from gmn_link_audit_guard.ledger_heads h
   where h.audit_ref = p_audit_ref and h.ledger_seq = p_ledger_seq;
  if found then
    if v_sha256 = p_sha256 and v_key_id = p_key_id then
      return 'ALREADY_RECORDED'; -- mesmo registro, em qualquer posição: idempotente, sem linha nova
    end if;
    return 'CONFLICT';
  end if;

  select pg_catalog.max(h.ledger_seq) into v_max
    from gmn_link_audit_guard.ledger_heads h
   where h.audit_ref = p_audit_ref;
  if v_max is not null and p_ledger_seq < v_max then
    return 'STALE';
  end if;

  insert into gmn_link_audit_guard.ledger_heads (audit_ref, key_id, ledger_seq, sha256)
       values (p_audit_ref, p_key_id, p_ledger_seq, p_sha256);
  return 'RECORDED';
end
$publish$;

-- Gatilho: UPDATE, DELETE e TRUNCATE recusados SEMPRE (mesmo para quem tivesse o privilégio).
create or replace function gmn_link_audit_guard.refuse_change()
  returns trigger
  language plpgsql
  set search_path = ''
as $refuse$
begin
  raise exception 'guarda: registros imutáveis (% recusado)', tg_op;
end
$refuse$;

-- Gatilho: INSERT direto só dentro da regra 7 (posição nova e não abaixo da maior), com a mesma trava da publicação.
create or replace function gmn_link_audit_guard.enforce_publication_order()
  returns trigger
  language plpgsql
  set search_path = ''
as $order$
declare
  v_max integer;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'guarda: inserção exige isolamento read committed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gmn_link_audit_guard:' || new.audit_ref, 0));
  if exists (select 1 from gmn_link_audit_guard.ledger_heads h where h.audit_ref = new.audit_ref and h.ledger_seq = new.ledger_seq) then
    raise exception 'guarda: posição já gravada (regra 7)';
  end if;
  select pg_catalog.max(h.ledger_seq) into v_max from gmn_link_audit_guard.ledger_heads h where h.audit_ref = new.audit_ref;
  if v_max is not null and new.ledger_seq < v_max then
    raise exception 'guarda: posição abaixo da maior já gravada (regra 7)';
  end if;
  new.recorded_at := pg_catalog.now(); -- hora do provedor, nunca a de quem insere
  return new;
end
$order$;

create or replace trigger ledger_heads_refuse_update_delete
  before update or delete on gmn_link_audit_guard.ledger_heads
  for each row execute function gmn_link_audit_guard.refuse_change();
create or replace trigger ledger_heads_refuse_truncate
  before truncate on gmn_link_audit_guard.ledger_heads
  for each statement execute function gmn_link_audit_guard.refuse_change();
create or replace trigger ledger_heads_publication_order
  before insert on gmn_link_audit_guard.ledger_heads
  for each row execute function gmn_link_audit_guard.enforce_publication_order();

-- 4) Privilégios explícitos (o dono concede; ninguém mais tem nada) -------------------------------------------------
revoke all on schema gmn_link_audit_guard from public, anon, authenticated, service_role, authenticator;
revoke all on table gmn_link_audit_guard.ledger_heads from public, anon, authenticated, service_role, authenticator;
revoke all on function gmn_link_audit_guard.publish_head(text, text, integer, text) from public, anon, authenticated, service_role, authenticator;
revoke all on function gmn_link_audit_guard.refuse_change() from public, anon, authenticated, service_role, authenticator;
revoke all on function gmn_link_audit_guard.enforce_publication_order() from public, anon, authenticated, service_role, authenticator;
-- reexecução: zera o que os papéis da guarda tinham e concede de novo só o desenho mínimo
revoke all on schema gmn_link_audit_guard from gmn_guard_writer, gmn_guard_reader;
revoke all on table gmn_link_audit_guard.ledger_heads from gmn_guard_writer, gmn_guard_reader;
revoke all on function gmn_link_audit_guard.publish_head(text, text, integer, text) from gmn_guard_writer, gmn_guard_reader;
revoke all on function gmn_link_audit_guard.refuse_change() from gmn_guard_writer, gmn_guard_reader;
revoke all on function gmn_link_audit_guard.enforce_publication_order() from gmn_guard_writer, gmn_guard_reader;
grant usage on schema gmn_link_audit_guard to gmn_guard_writer, gmn_guard_reader;
grant select on table gmn_link_audit_guard.ledger_heads to gmn_guard_writer, gmn_guard_reader;
grant execute on function gmn_link_audit_guard.publish_head(text, text, integer, text) to gmn_guard_writer;

-- 5) Volta a ser `postgres` e desfaz a associação temporária ao dono --------------------------------------------------
reset role;
revoke gmn_guard_owner from current_user;

-- 6) Conferência final (qualquer divergência desfaz TUDO) ----------------------------------------------------------------
do $post$
declare
  v_schema oid := 'gmn_link_audit_guard'::regnamespace;
  v_table oid := 'gmn_link_audit_guard.ledger_heads'::regclass;
  v_publish oid := 'gmn_link_audit_guard.publish_head(text, text, integer, text)'::regprocedure;
  v_refuse oid := 'gmn_link_audit_guard.refuse_change()'::regprocedure;
  v_order oid := 'gmn_link_audit_guard.enforce_publication_order()'::regprocedure;
  v_owner oid := (select oid from pg_catalog.pg_roles where rolname = 'gmn_guard_owner');
  v_writer oid := (select oid from pg_catalog.pg_roles where rolname = 'gmn_guard_writer');
  v_reader oid := (select oid from pg_catalog.pg_roles where rolname = 'gmn_guard_reader');
  v_fn oid;
  v_role text;
  v_priv text;
  v_bad text;
begin
  -- 6.1 donos
  if (select nspowner from pg_catalog.pg_namespace where oid = v_schema) <> v_owner then raise exception 'GUARDA falhou: dono do esquema; tudo foi desfeito.'; end if;
  if (select relowner from pg_catalog.pg_class where oid = v_table) <> v_owner then raise exception 'GUARDA falhou: dono da tabela; tudo foi desfeito.'; end if;
  foreach v_fn in array array[v_publish, v_refuse, v_order] loop
    if (select proowner from pg_catalog.pg_proc where oid = v_fn) <> v_owner then
      raise exception 'GUARDA falhou: dono da função %; tudo foi desfeito.', v_fn::regprocedure;
    end if;
    if not coalesce((select 'search_path=""' = any(proconfig) from pg_catalog.pg_proc where oid = v_fn), false) then
      raise exception 'GUARDA falhou: a função % sem search_path vazio; tudo foi desfeito.', v_fn::regprocedure;
    end if;
  end loop;
  if not (select prosecdef from pg_catalog.pg_proc where oid = v_publish) then raise exception 'GUARDA falhou: publish_head sem SECURITY DEFINER; tudo foi desfeito.'; end if;
  if (select prosecdef from pg_catalog.pg_proc where oid = v_refuse) or (select prosecdef from pg_catalog.pg_proc where oid = v_order) then
    raise exception 'GUARDA falhou: função de gatilho com SECURITY DEFINER; tudo foi desfeito.';
  end if;

  -- 6.2 ACL (PUBLIC é pseudopapel: confere-se no ACL, não por has_*). Não nula e só os papéis da guarda, com o desenho mínimo.
  if (select nspacl from pg_catalog.pg_namespace where oid = v_schema) is null
     or (select relacl from pg_catalog.pg_class where oid = v_table) is null
     or exists (select 1 from pg_catalog.pg_proc where oid in (v_publish, v_refuse, v_order) and proacl is null) then
    raise exception 'GUARDA falhou: ACL nula (o padrão dá EXECUTE a PUBLIC nas funções); tudo foi desfeito.';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('esquema:%s:%s', a.grantee, a.privilege_type), ',') into v_bad
    from pg_catalog.aclexplode((select nspacl from pg_catalog.pg_namespace where oid = v_schema)) a
   where not (a.grantee = v_owner or (a.grantee in (v_writer, v_reader) and a.privilege_type = 'USAGE' and not a.is_grantable));
  if v_bad is not null then raise exception 'GUARDA falhou: privilégio proibido no esquema (%); tudo foi desfeito.', v_bad; end if;
  select pg_catalog.string_agg(pg_catalog.format('tabela:%s:%s', a.grantee, a.privilege_type), ',') into v_bad
    from pg_catalog.aclexplode((select relacl from pg_catalog.pg_class where oid = v_table)) a
   where not (a.grantee = v_owner or (a.grantee in (v_writer, v_reader) and a.privilege_type = 'SELECT' and not a.is_grantable));
  if v_bad is not null then raise exception 'GUARDA falhou: privilégio proibido na tabela (%); tudo foi desfeito.', v_bad; end if;
  select pg_catalog.string_agg(pg_catalog.format('publish_head:%s:%s', a.grantee, a.privilege_type), ',') into v_bad
    from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid = v_publish)) a
   where not (a.grantee = v_owner or (a.grantee = v_writer and a.privilege_type = 'EXECUTE' and not a.is_grantable));
  if v_bad is not null then raise exception 'GUARDA falhou: privilégio proibido em publish_head (%); tudo foi desfeito.', v_bad; end if;
  select pg_catalog.string_agg(pg_catalog.format('gatilho:%s:%s', a.grantee, a.privilege_type), ',') into v_bad
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
   where p.oid in (v_refuse, v_order) and a.grantee <> v_owner;
  if v_bad is not null then raise exception 'GUARDA falhou: EXECUTE em função de gatilho (%); tudo foi desfeito.', v_bad; end if;
  if not exists (select 1 from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid = v_publish)) a where a.grantee = v_writer and a.privilege_type = 'EXECUTE') then
    raise exception 'GUARDA falhou: gmn_guard_writer sem EXECUTE em publish_head; tudo foi desfeito.';
  end if;

  -- 6.3 privilégios EFETIVOS dos papéis da Data API (inclui herança e papéis predefinidos como pg_read_all_data/pg_write_all_data)
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    foreach v_priv in array array['USAGE', 'CREATE'] loop
      if pg_catalog.has_schema_privilege(v_role, v_schema, v_priv) then raise exception 'GUARDA falhou: % tem % no esquema; tudo foi desfeito.', v_role, v_priv; end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege(v_role, v_table, v_priv) then raise exception 'GUARDA falhou: % tem % na tabela; tudo foi desfeito.', v_role, v_priv; end if;
    end loop;
    foreach v_fn in array array[v_publish, v_refuse, v_order] loop
      if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then raise exception 'GUARDA falhou: % executa %; tudo foi desfeito.', v_role, v_fn::regprocedure; end if;
    end loop;
  end loop;

  -- 6.4 escrita e leitura da guarda: exatamente o desenho mínimo
  if not pg_catalog.has_schema_privilege(v_writer, v_schema, 'USAGE') or not pg_catalog.has_table_privilege(v_writer, v_table, 'SELECT')
     or not pg_catalog.has_function_privilege(v_writer, v_publish, 'EXECUTE') then
    raise exception 'GUARDA falhou: gmn_guard_writer sem USAGE, SELECT ou EXECUTE; tudo foi desfeito.';
  end if;
  if not pg_catalog.has_schema_privilege(v_reader, v_schema, 'USAGE') or not pg_catalog.has_table_privilege(v_reader, v_table, 'SELECT') then
    raise exception 'GUARDA falhou: gmn_guard_reader sem USAGE ou SELECT; tudo foi desfeito.';
  end if;
  foreach v_role in array array['gmn_guard_writer', 'gmn_guard_reader'] loop
    if pg_catalog.has_schema_privilege(v_role, v_schema, 'CREATE') then raise exception 'GUARDA falhou: % tem CREATE no esquema; tudo foi desfeito.', v_role; end if;
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege(v_role, v_table, v_priv) then raise exception 'GUARDA falhou: % tem % na tabela; tudo foi desfeito.', v_role, v_priv; end if;
    end loop;
    if pg_catalog.has_function_privilege(v_role, v_refuse, 'EXECUTE') or pg_catalog.has_function_privilege(v_role, v_order, 'EXECUTE') then
      raise exception 'GUARDA falhou: % executa função de gatilho; tudo foi desfeito.', v_role;
    end if;
  end loop;
  if pg_catalog.has_function_privilege(v_reader, v_publish, 'EXECUTE') then raise exception 'GUARDA falhou: gmn_guard_reader executa publish_head; tudo foi desfeito.'; end if;

  -- 6.5 atributos e associações dos três papéis
  if exists (select 1 from pg_catalog.pg_roles where oid in (v_owner, v_writer, v_reader)
             and (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls or rolinherit)) then
    raise exception 'GUARDA falhou: papel da guarda com atributo privilegiado; tudo foi desfeito.';
  end if;
  if (select rolcanlogin from pg_catalog.pg_roles where oid = v_owner) then raise exception 'GUARDA falhou: gmn_guard_owner com LOGIN; tudo foi desfeito.'; end if;
  -- os papéis da guarda não são membros de NENHUM papel (nem postgres, service_role, authenticated, anon, authenticator, supabase_admin…)
  if exists (select 1 from pg_catalog.pg_auth_members where member in (v_owner, v_writer, v_reader)) then
    raise exception 'GUARDA falhou: papel da guarda é membro de outro papel; tudo foi desfeito.';
  end if;
  -- e ninguém USA os papéis da guarda: só a concessão de administração (sem SET e sem INHERIT) que o CREATE ROLE dá a quem os criou
  select pg_catalog.string_agg(pg_catalog.format('%s->%s', m.member::regrole, m.roleid::regrole), ',') into v_bad
    from pg_catalog.pg_auth_members m
   where m.roleid in (v_owner, v_writer, v_reader) and (m.set_option or m.inherit_option);
  if v_bad is not null then raise exception 'GUARDA falhou: alguém pode assumir um papel da guarda (%); tudo foi desfeito.', v_bad; end if;

  -- 6.6 gatilhos presentes e habilitados
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t where t.tgrelid = v_table and not t.tgisinternal and t.tgenabled = 'O'
        and t.tgname in ('ledger_heads_refuse_update_delete', 'ledger_heads_refuse_truncate', 'ledger_heads_publication_order')) <> 3 then
    raise exception 'GUARDA falhou: gatilhos ausentes ou desabilitados; tudo foi desfeito.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = v_table and contype = 'u' and conname = 'ledger_heads_audit_ref_ledger_seq_key') then
    raise exception 'GUARDA falhou: restrição única (audit_ref, ledger_seq) ausente; tudo foi desfeito.';
  end if;
end
$post$;

commit;
