#!/usr/bin/env bash
# Teste LOCAL da proposta 004_link_audit_guard.sql (guarda externa do livro, G1.b.2a) num PostgreSQL DESCARTÁVEL.
#
# Usa a imagem do Postgres do Supabase JÁ PRESENTE na máquina (`--pull never`: nada é baixado) num contêiner com
# `--network none` (sem rede alguma: nem externa, nem a do host; nenhuma porta publicada, nada na 6379). O contêiner é
# criado com `--rm` e removido no fim. A imagem traz os papéis do Supabase (anon, authenticated, service_role,
# authenticator, supabase_admin) e o `postgres` SEM superusuário, como no projeto real (PostgreSQL 17.11).
#
# A migração roda como `postgres` (como no editor SQL do Supabase); as conferências rodam como `supabase_admin`
# (superusuário da imagem) com `SET ROLE` para cada papel, ou com login real pelo loopback DO CONTÊINER quando o que
# se confere é ajuste de papel (prazo do servidor, sessão somente leitura, NOLOGIN).
#
# Uso:  bash supabase/proposed/local-test/guard-run.sh [<imagem>]
# Saída: uma linha "OK …" por verificação e "TODOS OS N TESTES LOCAIS DA GUARDA APROVADOS"; qualquer falha ⇒ código ≠ 0.
# Não faz parte do `npm test` (precisa de Docker). Não lê nenhum arquivo de ambiente e não usa senha real.
set -euo pipefail

IMAGE="${1:-public.ecr.aws/supabase/postgres:17.11.0.018}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$HERE/../004_link_audit_guard.sql"
ROLLBACK="$HERE/../004_link_audit_guard.rollback.sql"
NAME="gmn-guard-localtest-$$-$RANDOM"
COUNT=0
# soquete Unix do contêiner montado numa pasta temporária: a etapa do adaptador real (Node + pg) conecta por ele, sem rede
SOCK="$(mktemp -d)"
chmod 0777 "$SOCK"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$SOCK" 2>/dev/null || true; }
trap cleanup EXIT

ok() { COUNT=$((COUNT + 1)); echo "OK    $1"; }
fail() { echo "FALHOU: $1" >&2; exit 1; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "imagem $IMAGE ausente (o teste não baixa nada)"
docker run -d --rm --pull never --network none --name "$NAME" -v "$SOCK:/var/run/postgresql" -e POSTGRES_PASSWORD=sentinela-local "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  if docker exec "$NAME" psql -h /var/run/postgresql -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
# a imagem reinicia o servidor depois das migrações de inicialização: espera ficar estável
sleep 3
for _ in $(seq 1 30); do
  if docker exec "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -Atc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
[ "$(docker exec "$NAME" sh -c 'ls /sys/class/net' | tr -d '[:space:]')" = "lo" ] || fail "o contêiner tem interface de rede além do loopback"
ok "contêiner descartável sem rede (só loopback), imagem local, $(docker exec "$NAME" psql -h /var/run/postgresql -U supabase_admin -d postgres -Atc 'show server_version')"

# ---------------------------------------------------------------- utilitários
admin() { docker exec -i "$NAME" psql -h /var/run/postgresql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atq "$@"; }
as_postgres_file() { docker exec -i "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$1"; }
# executa SQL COMO o papel (SET ROLE a partir do superusuário da imagem); imprime o resultado
as_role() { local role="$1"; shift; admin -c "set role $role" -c "$1"; }
# login REAL pelo loopback do contêiner (trust só dentro dele): aplica os ajustes do papel (ALTER ROLE … SET)
login() { local role="$1"; shift; docker exec -i "$NAME" psql -h 127.0.0.1 -U "$role" -d postgres -v ON_ERROR_STOP=1 -Atq -c "$1"; }
eq() { [ "$2" = "$3" ] || fail "$1: esperado [$2], obtido [$3]"; }
# o comando precisa FALHAR e a mensagem de erro casar com o padrão
refused() {
  local label="$1" pattern="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then fail "$label: deveria ter sido recusado (saída: $out)"; fi
  echo "$out" | grep -Eq "$pattern" || fail "$label: recusa inesperada: $out"
}
hex() { printf "%064d" 0 | tr 0 "$1"; }
A="$(hex a)"; B="$(hex b)"; C="$(hex c)"; D="$(hex d)"
REF1="$(hex 1)"; REF2="$(hex 2)"; REF3="$(hex 3)"
publish() { as_role gmn_guard_writer "select gmn_link_audit_guard.publish_head('$1', '$2', $3, '$4')"; }
rows() { admin -c "select count(*) from gmn_link_audit_guard.ledger_heads"; }
catalog_snapshot() {
  admin -c "select string_agg(rolname || ':' || rolsuper || rolcreaterole || rolcanlogin, ',' order by rolname) from pg_roles" \
        -c "select string_agg(nspname || ':' || coalesce(nspacl::text, '-'), ',' order by nspname) from pg_namespace where nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%'" \
        -c "select string_agg(pg_get_userbyid(defaclrole) || ':' || defaclnamespace::text || ':' || defaclobjtype::text || ':' || defaclacl::text, ',' order by pg_get_userbyid(defaclrole), defaclnamespace, defaclobjtype) from pg_default_acl" \
        -c "select string_agg(r.rolname || '>' || m.rolname || ':' || admin_option || inherit_option || set_option, ',' order by r.rolname, m.rolname, a.grantor) from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member"
}

# a inicialização da imagem ainda aplica concessões depois de aceitar conexões: só segue com o catálogo ESTÁVEL (dois retratos iguais, 3 s apart)
BEFORE=""
for _ in $(seq 1 20); do
  FIRST="$(catalog_snapshot 2>/dev/null || true)"
  sleep 3
  SECOND="$(catalog_snapshot 2>/dev/null || true)"
  if [ -n "$FIRST" ] && [ "$FIRST" = "$SECOND" ] && docker exec "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -Atc 'select 1' >/dev/null 2>&1; then BEFORE="$SECOND"; break; fi
done
[ -n "$BEFORE" ] || fail "o catálogo da imagem não estabilizou"
ok "inicialização da imagem concluída (catálogo estável); retrato \"antes\" tirado"

# ---------------------------------------------------------------- 1. pré-validação e conferência final abortam sem alterar nada
admin -c "create schema gmn_link_audit_guard authorization postgres"
refused "esquema ocupado por outro dono" 'já existe com outro dono' as_postgres_file "$MIGRATION"
eq "nada criado com o esquema ocupado" "0" "$(admin -c "select count(*) from pg_roles where rolname like 'gmn_guard%'")"
admin -c "drop schema gmn_link_audit_guard"
ok "pré-validação: esquema com o nome da guarda e outro dono ⇒ aborta, nenhum papel criado"

admin -c "grant pg_read_all_data to service_role"
refused "service_role com leitura por papel predefinido" 'service_role tem (USAGE no esquema|SELECT na tabela)' as_postgres_file "$MIGRATION"
eq "conferência final desfaz tudo" "0|0" "$(admin -c "select (select count(*) from pg_roles where rolname like 'gmn_guard%') || '|' || (select count(*) from pg_namespace where nspname = 'gmn_link_audit_guard')")"
admin -c "revoke pg_read_all_data from service_role"
ok "conferência no SQL: privilégio vazado por outro caminho (service_role em pg_read_all_data) ⇒ a migração aborta e desfaz TUDO (papéis e esquema)"
eq "catálogo intacto depois das recusas" "$BEFORE" "$(catalog_snapshot)"
ok "catálogo (papéis, esquemas, privilégios padrão, associações) idêntico ao de antes depois das duas recusas"

# ---------------------------------------------------------------- 2. aplicação
as_postgres_file "$MIGRATION"
ok "004 aplicada como postgres (sem superusuário), numa transação, com a conferência final passando"

# ---------------------------------------------------------------- 3. PG-G08 pelo catálogo (conferência independente da do SQL)
eq "dono e SECURITY DEFINER" "gmn_guard_owner|true|{\"search_path=\\\"\\\"\"}" "$(admin -c "select pg_get_userbyid(proowner) || '|' || prosecdef || '|' || proconfig::text from pg_proc where oid = 'gmn_link_audit_guard.publish_head(text,text,integer,text)'::regprocedure")"
eq "funções de gatilho" "enforce_publication_order:gmn_guard_owner:false,refuse_change:gmn_guard_owner:false" "$(admin -c "select string_agg(proname || ':' || pg_get_userbyid(proowner) || ':' || prosecdef, ',' order by proname) from pg_proc where pronamespace = 'gmn_link_audit_guard'::regnamespace and proname <> 'publish_head'")"
eq "dono da tabela e do esquema" "gmn_guard_owner|gmn_guard_owner" "$(admin -c "select pg_get_userbyid(relowner) || '|' || (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'gmn_link_audit_guard') from pg_class where oid = 'gmn_link_audit_guard.ledger_heads'::regclass")"
eq "nenhum PUBLIC (grantee 0) e nenhuma ACL nula" "0|0" "$(admin -c "select (select count(*) from (select aclexplode(nspacl) a from pg_namespace where nspname = 'gmn_link_audit_guard' union all select aclexplode(relacl) from pg_class where oid = 'gmn_link_audit_guard.ledger_heads'::regclass union all select aclexplode(proacl) from pg_proc where pronamespace = 'gmn_link_audit_guard'::regnamespace) x where (x.a).grantee = 0) || '|' || (select count(*) from pg_proc where pronamespace = 'gmn_link_audit_guard'::regnamespace and proacl is null)")"
eq "atributos dos papéis" "gmn_guard_owner:false:false:false:false:false:false:false,gmn_guard_reader:true:false:false:false:false:false:false,gmn_guard_writer:true:false:false:false:false:false:false" "$(admin -c "select string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolcreaterole || ':' || rolcreatedb || ':' || rolreplication || ':' || rolbypassrls || ':' || rolinherit, ',' order by rolname) from pg_roles where rolname like 'gmn_guard%'")"
eq "os papéis da guarda não são membros de nada" "0" "$(admin -c "select count(*) from pg_auth_members where member in (select oid from pg_roles where rolname like 'gmn_guard%')")"
eq "ninguém assume os papéis da guarda (só ADMIN do criador)" "0" "$(admin -c "select count(*) from pg_auth_members where roleid in (select oid from pg_roles where rolname like 'gmn_guard%') and (set_option or inherit_option)")"
ok "PG-G08 catálogo: dono gmn_guard_owner, SECURITY DEFINER com search_path vazio só na publicação, ACL sem PUBLIC e não nula, papéis sem atributos privilegiados nem associações"
for role in anon authenticated service_role authenticator; do
  eq "$role: has_*_privilege" "f|f|f|f|f|f|f|f|f|f|f|f" "$(admin -c "select concat_ws('|', has_schema_privilege('$role', 'gmn_link_audit_guard', 'USAGE'), has_schema_privilege('$role', 'gmn_link_audit_guard', 'CREATE'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'SELECT'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'INSERT'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'UPDATE'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'DELETE'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'TRUNCATE'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'REFERENCES'), has_table_privilege('$role', 'gmn_link_audit_guard.ledger_heads', 'TRIGGER'), has_function_privilege('$role', 'gmn_link_audit_guard.publish_head(text,text,integer,text)', 'EXECUTE'), has_function_privilege('$role', 'gmn_link_audit_guard.refuse_change()', 'EXECUTE'), has_function_privilege('$role', 'gmn_link_audit_guard.enforce_publication_order()', 'EXECUTE'))")"
done
ok "PG-G08 papéis reais: anon, authenticated, service_role e authenticator sem nenhum privilégio no esquema, na tabela e nas três funções"
eq "writer" "t|f|t|f|f|f|f|t|f|f" "$(admin -c "select concat_ws('|', has_schema_privilege('gmn_guard_writer', 'gmn_link_audit_guard', 'USAGE'), has_schema_privilege('gmn_guard_writer', 'gmn_link_audit_guard', 'CREATE'), has_table_privilege('gmn_guard_writer', 'gmn_link_audit_guard.ledger_heads', 'SELECT'), has_table_privilege('gmn_guard_writer', 'gmn_link_audit_guard.ledger_heads', 'INSERT'), has_table_privilege('gmn_guard_writer', 'gmn_link_audit_guard.ledger_heads', 'UPDATE'), has_table_privilege('gmn_guard_writer', 'gmn_link_audit_guard.ledger_heads', 'DELETE'), has_table_privilege('gmn_guard_writer', 'gmn_link_audit_guard.ledger_heads', 'TRUNCATE'), has_function_privilege('gmn_guard_writer', 'gmn_link_audit_guard.publish_head(text,text,integer,text)', 'EXECUTE'), has_function_privilege('gmn_guard_writer', 'gmn_link_audit_guard.refuse_change()', 'EXECUTE'), has_function_privilege('gmn_guard_writer', 'gmn_link_audit_guard.enforce_publication_order()', 'EXECUTE'))")"
eq "reader" "t|f|t|f|f|f|f|f" "$(admin -c "select concat_ws('|', has_schema_privilege('gmn_guard_reader', 'gmn_link_audit_guard', 'USAGE'), has_schema_privilege('gmn_guard_reader', 'gmn_link_audit_guard', 'CREATE'), has_table_privilege('gmn_guard_reader', 'gmn_link_audit_guard.ledger_heads', 'SELECT'), has_table_privilege('gmn_guard_reader', 'gmn_link_audit_guard.ledger_heads', 'INSERT'), has_table_privilege('gmn_guard_reader', 'gmn_link_audit_guard.ledger_heads', 'UPDATE'), has_table_privilege('gmn_guard_reader', 'gmn_link_audit_guard.ledger_heads', 'DELETE'), has_table_privilege('gmn_guard_reader', 'gmn_link_audit_guard.ledger_heads', 'TRUNCATE'), has_function_privilege('gmn_guard_reader', 'gmn_link_audit_guard.publish_head(text,text,integer,text)', 'EXECUTE'))")"
ok "PG-G08 desenho mínimo: gmn_guard_writer só USAGE + SELECT + EXECUTE da publicação; gmn_guard_reader só USAGE + SELECT"

# ---------------------------------------------------------------- 4. regra 7 na função de publicação (como gmn_guard_writer)
eq "1ª posição" "RECORDED" "$(publish "$REF1" gk-test-a 1 "$A")"
eq "maior que o maior" "RECORDED" "$(publish "$REF1" gk-test-a 3 "$C")"
eq "mesmo registro abaixo do maior" "ALREADY_RECORDED" "$(publish "$REF1" gk-test-a 1 "$A")"
eq "mesmo registro na maior posição" "ALREADY_RECORDED" "$(publish "$REF1" gk-test-a 3 "$C")"
eq "republicação não grava" "2" "$(rows)"
eq "mesmo ledger_seq, outro sha256" "CONFLICT" "$(publish "$REF1" gk-test-a 3 "$D")"
eq "conflito abaixo do maior" "CONFLICT" "$(publish "$REF1" gk-test-a 1 "$B")"
eq "mesma posição, outro key_id" "CONFLICT" "$(publish "$REF1" gk-test-b 3 "$C")"
eq "posição nova abaixo do maior" "STALE" "$(publish "$REF1" gk-test-a 2 "$B")"
eq "recusas não gravam" "2" "$(rows)"
eq "outra auditoria é independente" "RECORDED" "$(publish "$REF2" gk-test-a 1 "$B")"
eq "maior por pseudônimo" "3|1" "$(as_role gmn_guard_writer "select (select max(ledger_seq) from gmn_link_audit_guard.ledger_heads where audit_ref = '$REF1') || '|' || (select max(ledger_seq) from gmn_link_audit_guard.ledger_heads where audit_ref = '$REF2')")"
ok "PG-G05 regra 7 na função: mesmo registro ⇒ ALREADY_RECORDED (também abaixo do maior, sem linha nova); outro sha256 ou key_id na posição ⇒ CONFLICT; posição nova abaixo do maior ⇒ STALE; maior ⇒ RECORDED; por pseudônimo"
for bad in "'curto', 'gk-test-a', 4, '$A'" "'$REF1', 'GK', 4, '$A'" "'$REF1', 'gk-test-a', 0, '$A'" "'$REF1', 'gk-test-a', 4001, '$A'" "'$REF1', 'gk-test-a', 4, 'curto'" "null, 'gk-test-a', 4, '$A'" "'$(hex A)', 'gk-test-a', 4, '$A'"; do
  refused "entrada inválida ($bad)" 'fora do formato|fora da faixa' as_role gmn_guard_writer "select gmn_link_audit_guard.publish_head($bad)"
done
refused "isolamento repeatable read" 'exige isolamento read committed' admin -c "begin isolation level repeatable read" -c "set local role gmn_guard_writer" -c "select gmn_link_audit_guard.publish_head('$REF3', 'gk-test-a', 1, '$A')" -c "commit"
eq "nada gravado pelas recusas" "3" "$(rows)"
ok "função: entrada fora do formato (pseudônimo, key_id, faixa 1..4000, sha256, maiúsculas) ou isolamento diferente de read committed ⇒ erro, nada gravado"

# ---------------------------------------------------------------- 5. trava consultiva por auditoria (duas sessões)
docker exec -d "$NAME" psql -h /var/run/postgresql -U supabase_admin -d postgres -c "begin" -c "set local role gmn_guard_writer" -c "select gmn_link_audit_guard.publish_head('$REF3', 'gk-test-a', 5, '$C')" -c "select pg_sleep(2)" -c "commit"
sleep 0.7
START=$(date +%s%N)
SECOND="$(publish "$REF3" gk-test-a 4 "$B")"
WAITED=$(( ($(date +%s%N) - START) / 1000000 ))
eq "a 2ª sessão vê a 1ª depois da trava" "STALE" "$SECOND"
[ "$WAITED" -ge 700 ] || fail "a 2ª publicação não esperou a trava (${WAITED} ms)"
docker exec -d "$NAME" psql -h /var/run/postgresql -U supabase_admin -d postgres -c "begin" -c "set local role gmn_guard_writer" -c "select gmn_link_audit_guard.publish_head('$REF3', 'gk-test-a', 6, '$C')" -c "select pg_sleep(2)" -c "commit"
sleep 0.7
eq "mesma posição concorrente" "CONFLICT" "$(publish "$REF3" gk-test-a 6 "$D")"
ok "trava consultiva por auditoria: a publicação concorrente espera a outra terminar e decide sobre o que ela gravou (STALE / CONFLICT limpos, nunca erro de unicidade nem posição fora de ordem)"

# ---------------------------------------------------------------- 6. papéis sem privilégio e a Data API (por SQL; a prova pela API é do laboratório, PG-G08)
for role in anon authenticated service_role authenticator; do
  refused "$role lê" 'permission denied for schema' as_role "$role" "select count(*) from gmn_link_audit_guard.ledger_heads"
  refused "$role insere" 'permission denied for schema' as_role "$role" "insert into gmn_link_audit_guard.ledger_heads values ('$REF2', 'gk-test-a', 9, '$A')"
  refused "$role publica" 'permission denied for schema' as_role "$role" "select gmn_link_audit_guard.publish_head('$REF2', 'gk-test-a', 9, '$A')"
done
ok "anon, authenticated, service_role e authenticator: ler, inserir e publicar ⇒ 42501 (sem USAGE no esquema)"
for stmt in "insert into gmn_link_audit_guard.ledger_heads values ('$REF2', 'gk-test-a', 9, '$A')" "update gmn_link_audit_guard.ledger_heads set sha256 = '$D'" "delete from gmn_link_audit_guard.ledger_heads" "truncate gmn_link_audit_guard.ledger_heads" "create table gmn_link_audit_guard.intrusa (x int)" "create function gmn_link_audit_guard.intrusa() returns int language sql as 'select 1'"; do
  refused "writer: $stmt" 'permission denied' as_role gmn_guard_writer "$stmt"
done
refused "writer desliga gatilhos" 'permission denied to set parameter' as_role gmn_guard_writer "set session_replication_role = replica"
refused "writer altera a tabela" 'must be owner' as_role gmn_guard_writer "alter table gmn_link_audit_guard.ledger_heads disable trigger all"
as_role gmn_guard_writer "grant select on gmn_link_audit_guard.ledger_heads to anon" >/dev/null 2>&1 || true # sem opção de concessão: só um aviso
eq "writer não concede" "f" "$(admin -c "select has_table_privilege('anon', 'gmn_link_audit_guard.ledger_heads', 'SELECT')")"
eq "writer lê" "5" "$(as_role gmn_guard_writer "select count(*) from gmn_link_audit_guard.ledger_heads")"
refused "reader publica" 'permission denied for function' as_role gmn_guard_reader "select gmn_link_audit_guard.publish_head('$REF2', 'gk-test-a', 9, '$A')"
refused "reader insere" 'permission denied for table' as_role gmn_guard_reader "insert into gmn_link_audit_guard.ledger_heads values ('$REF2', 'gk-test-a', 9, '$A')"
eq "reader lê" "5" "$(as_role gmn_guard_reader "select count(*) from gmn_link_audit_guard.ledger_heads")"
ok "gmn_guard_writer: sem INSERT/UPDATE/DELETE/TRUNCATE/CREATE diretos, não desliga gatilhos nem concede; lê. gmn_guard_reader: só lê"

# ---------------------------------------------------------------- 7. gatilhos (defesa em profundidade) mesmo para quem TEM o privilégio
PROBE_OUT="$(admin -c "begin" -c "create role gmn_guard_probe nologin" -c "grant usage on schema gmn_link_audit_guard to gmn_guard_probe" -c "grant select, insert, update, delete, truncate on gmn_link_audit_guard.ledger_heads to gmn_guard_probe" -c "set local role gmn_guard_probe" \
  -c "do \$t\$ begin begin update gmn_link_audit_guard.ledger_heads set sha256 = '$D'; raise exception 'UPDATE passou'; exception when others then if sqlerrm not like 'guarda: registros imutáveis (UPDATE%' then raise; end if; end; end \$t\$" \
  -c "do \$t\$ begin begin delete from gmn_link_audit_guard.ledger_heads; raise exception 'DELETE passou'; exception when others then if sqlerrm not like 'guarda: registros imutáveis (DELETE%' then raise; end if; end; end \$t\$" \
  -c "do \$t\$ begin begin truncate gmn_link_audit_guard.ledger_heads; raise exception 'TRUNCATE passou'; exception when others then if sqlerrm not like 'guarda: registros imutáveis (TRUNCATE%' then raise; end if; end; end \$t\$" \
  -c "do \$t\$ begin begin insert into gmn_link_audit_guard.ledger_heads values ('$REF1', 'gk-test-a', 3, '$C'); raise exception 'INSERT repetido passou'; exception when others then if sqlerrm not like 'guarda: posição já gravada%' then raise; end if; end; end \$t\$" \
  -c "do \$t\$ begin begin insert into gmn_link_audit_guard.ledger_heads values ('$REF1', 'gk-test-a', 2, '$B'); raise exception 'INSERT abaixo passou'; exception when others then if sqlerrm not like 'guarda: posição abaixo da maior%' then raise; end if; end; end \$t\$" \
  -c "do \$t\$ begin begin insert into gmn_link_audit_guard.ledger_heads values ('$REF1', 'gk-test-a', 8, '$C'), ('$REF1', 'gk-test-a', 7, '$B'); raise exception 'INSERT múltiplo fora de ordem passou'; exception when others then if sqlerrm not like 'guarda: posição abaixo da maior%' then raise; end if; end; end \$t\$" \
  -c "insert into gmn_link_audit_guard.ledger_heads (audit_ref, key_id, ledger_seq, sha256, recorded_at) values ('$REF1', 'gk-test-a', 9, '$D', '2000-01-01')" \
  -c "select extract(year from recorded_at)::int from gmn_link_audit_guard.ledger_heads where audit_ref = '$REF1' and ledger_seq = 9" -c "rollback" 2>&1)" || fail "gatilhos: $PROBE_OUT"
eq "recorded_at forçado pelo gatilho" "$(date -u +%Y)" "$(echo "$PROBE_OUT" | tail -1)"
refused "superusuário também não altera" 'registros imutáveis \(UPDATE' admin -c "update gmn_link_audit_guard.ledger_heads set sha256 = '$D'"
eq "tudo intacto" "5" "$(rows)"
ok "gatilhos com o privilégio concedido: UPDATE, DELETE, TRUNCATE, INSERT repetido, abaixo do maior e múltiplo fora de ordem ⇒ recusados; INSERT válido passa (limite declarado) com recorded_at do provedor; o superusuário também é barrado (sem session_replication_role)"

# ---------------------------------------------------------------- 8. ajustes dos papéis (login real) e NOLOGIN do dono
eq "prazo do servidor do writer" "3s|3s|read committed" "$(login gmn_guard_writer "select current_setting('statement_timeout') || '|' || current_setting('lock_timeout') || '|' || current_setting('transaction_isolation')")"
refused "prazo de 3 s no servidor" 'statement timeout' login gmn_guard_writer "select pg_sleep(4)"
eq "reader somente leitura" "on" "$(login gmn_guard_reader "show default_transaction_read_only")"
refused "reader escreve mesmo com privilégio" 'read-only transaction' login gmn_guard_reader "create temp table x (y int)"
refused "dono sem login" 'not permitted to log in' login gmn_guard_owner "select 1"
ok "login real: writer com statement_timeout e lock_timeout de 3 s (pg_sleep(4) cancelado) e read committed; reader em sessão somente leitura; gmn_guard_owner não faz login"

# ---------------------------------------------------------------- 9. idempotência (reaplicar não toca nas cabeças)
SNAP="$(admin -c "select string_agg(audit_ref || ':' || key_id || ':' || ledger_seq || ':' || sha256 || ':' || recorded_at, ',' order by audit_ref, ledger_seq) from gmn_link_audit_guard.ledger_heads")"
as_postgres_file "$MIGRATION"
eq "cabeças preservadas" "$SNAP" "$(admin -c "select string_agg(audit_ref || ':' || key_id || ':' || ledger_seq || ':' || sha256 || ':' || recorded_at, ',' order by audit_ref, ledger_seq) from gmn_link_audit_guard.ledger_heads")"
eq "segue publicando" "RECORDED" "$(publish "$REF1" gk-test-a 4 "$D")"
ok "004 idempotente: a 2ª execução passa a conferência e preserva as cabeças byte a byte"

admin -c "grant gmn_guard_writer to authenticated"
refused "reaplicar com associação herdada" 'authenticated tem USAGE no esquema' as_postgres_file "$MIGRATION"
admin -c "revoke gmn_guard_writer from authenticated"
admin -c "grant gmn_guard_writer to service_role with inherit false, set true"
refused "reaplicar com associação só de SET" 'alguém pode assumir um papel da guarda \(service_role->gmn_guard_writer\)' as_postgres_file "$MIGRATION"
admin -c "revoke gmn_guard_writer from service_role"
admin -c "grant anon to gmn_guard_writer"
refused "reaplicar com o writer membro de anon" 'papel da guarda é membro de outro papel' as_postgres_file "$MIGRATION"
admin -c "revoke anon from gmn_guard_writer"
eq "cabeças intactas depois das recusas" "6" "$(rows)"
ok "reaplicar com associação indevida feita por fora (authenticated herda o writer; service_role pode SET ROLE no writer; writer membro de anon) ⇒ a conferência aborta, nada muda"

# ---------------------------------------------------------------- 10. rollback
refused "rollback com cabeças sem confirmação" 'exige a confirmação do responsável' as_postgres_file "$ROLLBACK"
eq "nada removido" "6" "$(rows)"
ok "rollback com cabeças gravadas e SEM confirmação ⇒ aborta, nada removido (apagar a testemunha é decisão do responsável)"
docker exec -i "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "set gmn.guard_rollback_confirm = 'APAGAR-CABECAS-DA-GUARDA'" -f - < "$ROLLBACK"
eq "catálogo igual ao de antes da 004" "$BEFORE" "$(catalog_snapshot)"
ok "rollback com a confirmação: esquema e os três papéis removidos; papéis, esquemas, privilégios padrão e associações idênticos aos de antes da 004"
as_postgres_file "$ROLLBACK"
ok "rollback idempotente (sem nada da 004, não faz nada)"
as_postgres_file "$MIGRATION"
as_postgres_file "$ROLLBACK"
eq "aplicar e reverter sem cabeças" "$BEFORE" "$(catalog_snapshot)"
ok "laboratório recém-criado (sem cabeças): aplicar e reverter sem confirmação volta ao catálogo original"

# ---------------------------------------------------------------- 11. o ADAPTADOR REAL (createPostgresGuard + pg) contra a migração aplicada
if [ -d "$ROOT/node_modules/pg" ]; then
  as_postgres_file "$MIGRATION"
  ADAPTER_OUT="$(cd "$ROOT" && node --require ./tests/register-typescript.cjs supabase/proposed/local-test/guard-adapter-run.ts "$SOCK" 2>&1)" || fail "adaptador real: $ADAPTER_OUT"
  echo "$ADAPTER_OUT" | grep '^OK' || true
  COUNT=$((COUNT + $(echo "$ADAPTER_OUT" | grep -c '^OK')))
  docker exec -i "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "set gmn.guard_rollback_confirm = 'APAGAR-CABECAS-DA-GUARDA'" -f - < "$ROLLBACK"
  eq "catálogo final" "$BEFORE" "$(catalog_snapshot)"
  ok "depois da etapa do adaptador, o rollback confirmado volta ao catálogo original"
else
  echo "AVISO: node_modules/pg ausente; etapa do adaptador real pulada (rode npm ci)"
fi

echo
echo "TODOS OS $COUNT TESTES LOCAIS DA GUARDA APROVADOS"
