#!/usr/bin/env bash
# Teste LOCAL da proposta 004_link_audit_guard.sql (guarda externa do livro, G1.b.2a) num PostgreSQL DESCARTÁVEL.
#
# Usa a imagem do Postgres do Supabase JÁ PRESENTE na máquina (`--pull never`: este script nunca baixa nada) num contêiner com
# `--network none` (sem rede alguma: nem externa, nem a do host; nenhuma porta publicada, nada na 6379). O contêiner é
# criado com `--rm` e removido no fim. A imagem traz os papéis do Supabase (anon, authenticated, service_role,
# authenticator, supabase_admin) e o `postgres` SEM superusuário, como no projeto real (PostgreSQL 17.11).
#
# A migração roda como `postgres` (como no editor SQL do Supabase); as conferências rodam como `supabase_admin`
# (superusuário da imagem) com `SET ROLE` para cada papel, ou com login real pelo loopback DO CONTÊINER quando o que
# se confere é ajuste de papel (prazo do servidor, sessão somente leitura, NOLOGIN).
#
# Uso:  bash supabase/proposed/local-test/guard-run.sh [<imagem>]
#   A imagem padrão é a do teste local, FIXADA POR DIGEST (a mesma do projeto: PostgreSQL 17.11). No CI, o workflow
#   `.github/workflows/guard-migration.yml` a puxa por esse digest antes e chama este script (que continua sem baixar nada).
# Saída: uma linha "OK …" por verificação e "TODOS OS N TESTES LOCAIS DA GUARDA APROVADOS"; qualquer falha ⇒ código ≠ 0.
# PRÉ-REQUISITOS OBRIGATÓRIOS (faltando, FALHA — nunca pula etapa): a imagem já presente, o Node e o `pg` instalados (`npm ci`).
# Não faz parte do `npm test` (precisa de Docker). Não lê nenhum arquivo de ambiente e não usa senha real.
set -euo pipefail

# public.ecr.aws/supabase/postgres:17.11.0.018 — digest conferido na imagem do teste local em 22/11/2026
IMAGE="${1:-public.ecr.aws/supabase/postgres@sha256:7c31363a3f7434ff14945f1b8a4880e6eca8b362e197e88b87c476c77aa3cf8c}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$HERE/../004_link_audit_guard.sql"
ROLLBACK="$HERE/../004_link_audit_guard.rollback.sql"
NAME="gmn-guard-localtest-$$-$RANDOM"
COUNT=0
# soquete Unix do contêiner montado numa pasta temporária: a etapa do adaptador real (Node + pg) conecta por ele, sem rede
SOCK="$(mktemp -d)"
chmod 0777 "$SOCK"

# A imagem troca o dono da pasta do soquete para o usuário do Postgres dela: antes de remover o contêiner, a pasta volta a quem rodou
# o teste (de dentro do contêiner, onde o dono atual tem permissão), já sem os arquivos do soquete; só então ela é apagada aqui fora.
cleanup() {
  docker exec "$NAME" find /var/run/postgresql -maxdepth 1 -name '.s.PGSQL.*' -delete >/dev/null 2>&1 || true
  docker exec "$NAME" chown "$(id -u):$(id -g)" /var/run/postgresql >/dev/null 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  case "$SOCK" in /tmp/tmp.*) rmdir "$SOCK" 2>/dev/null || true ;; esac
}
trap cleanup EXIT

ok() { COUNT=$((COUNT + 1)); echo "OK    $1"; }
fail() { echo "FALHOU: $1" >&2; exit 1; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "imagem $IMAGE ausente (o teste não baixa nada: puxe-a antes, pelo digest)"
command -v node >/dev/null 2>&1 || fail "node ausente (a etapa do adaptador real é obrigatória)"
[ -f "$ROOT/node_modules/pg/package.json" ] || fail "node_modules/pg ausente (rode npm ci; a etapa do adaptador real é obrigatória)"
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

admin -c "create role gmn_guard_owner nologin" -c "create schema gmn_link_audit_guard authorization gmn_guard_owner" -c "set role gmn_guard_owner" \
  -c "create function gmn_link_audit_guard.intrusa() returns int language sql as 'select 1'"
eq "o objeto extra tem EXECUTE para PUBLIC" "t" "$(admin -c "select has_function_privilege('anon', 'gmn_link_audit_guard.intrusa()', 'EXECUTE')")"
refused "esquema preexistente com o dono certo e uma função extra" 'função não esperada no esquema: intrusa\(\)' as_postgres_file "$MIGRATION"
eq "nada criado com o objeto extra" "0|true" "$(admin -c "select (select count(*) from pg_roles where rolname in ('gmn_guard_writer', 'gmn_guard_reader')) || '|' || (to_regclass('gmn_link_audit_guard.ledger_heads') is null)")"
admin -c "drop schema gmn_link_audit_guard cascade" -c "drop role gmn_guard_owner" 2>/dev/null
ok "pré-validação (revisão do PR #61): esquema preexistente com o dono gmn_guard_owner e um objeto NÃO esperado (função com EXECUTE para PUBLIC) ⇒ aborta e desfaz, nada criado"

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
eq "o trio já gravado existe" "1" "$(admin -c "select count(*) from gmn_link_audit_guard.ledger_heads where audit_ref = '$REF1' and key_id = 'gk-test-a' and ledger_seq = 3 and sha256 = '$C'")"
refused "inserção DIRETA do mesmo trio" 'guarda: posição já gravada \(regra 7\)' admin -c "begin" -c "create role gmn_guard_probe nologin" -c "grant usage on schema gmn_link_audit_guard to gmn_guard_probe" \
  -c "grant select, insert on gmn_link_audit_guard.ledger_heads to gmn_guard_probe" -c "set local role gmn_guard_probe" -c "insert into gmn_link_audit_guard.ledger_heads (audit_ref, key_id, ledger_seq, sha256) values ('$REF1', 'gk-test-a', 3, '$C')"
eq "a função de publicação aceita o mesmo trio" "ALREADY_RECORDED" "$(publish "$REF1" gk-test-a 3 "$C")"
eq "nenhuma linha nova" "5" "$(rows)"
ok "exceção INTENCIONAL à regra 7 (revisão do PR #61): a inserção direta do MESMO trio já gravado é recusada pelo gatilho, enquanto a função de publicação responde ALREADY_RECORDED (o único caminho legítimo); nenhuma linha nova"

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
refused "reaplicar com associação só de SET" 'associação não esperada a um papel da guarda \(service_role->gmn_guard_writer \(concedente supabase_admin, admin f, set t, inherit f\)\)' as_postgres_file "$MIGRATION"
admin -c "revoke gmn_guard_writer from service_role"
admin -c "grant anon to gmn_guard_writer"
refused "reaplicar com o writer membro de anon" 'papel da guarda é membro de outro papel' as_postgres_file "$MIGRATION"
admin -c "revoke anon from gmn_guard_writer"
eq "cabeças intactas depois das recusas" "6" "$(rows)"
ok "reaplicar com associação indevida feita por fora (authenticated herda o writer; service_role pode SET ROLE no writer; writer membro de anon) ⇒ a conferência aborta, nada muda"

# revisão do PR #61: inventário FECHADO do esquema e ACL de todos os objetos, numa guarda já em uso (com cabeças)
reapply_refused() { # <rótulo> <padrão do erro> <preparo> <desfazer>
  admin -c "$3"
  refused "$1" "$2" as_postgres_file "$MIGRATION"
  admin -c "$4"
}
reapply_refused "função extra com EXECUTE para PUBLIC" 'função não esperada no esquema: intrusa\(\)' \
  "set role gmn_guard_owner; create function gmn_link_audit_guard.intrusa() returns int language sql as 'select 1'" "drop function gmn_link_audit_guard.intrusa()"
reapply_refused "procedimento extra" 'função não esperada no esquema: rotina\(\) \[p\]' \
  "set role gmn_guard_owner; create procedure gmn_link_audit_guard.rotina() language sql as 'select 1'" "drop procedure gmn_link_audit_guard.rotina()"
reapply_refused "view extra com SELECT para PUBLIC" 'objeto não esperado no esquema: espelho \(relkind v\)' \
  "set role gmn_guard_owner; create view gmn_link_audit_guard.espelho as select * from gmn_link_audit_guard.ledger_heads; grant select on gmn_link_audit_guard.espelho to public" "drop view gmn_link_audit_guard.espelho"
reapply_refused "sequência extra" 'objeto não esperado no esquema: contador \(relkind S\)' \
  "set role gmn_guard_owner; create sequence gmn_link_audit_guard.contador" "drop sequence gmn_link_audit_guard.contador"
reapply_refused "tipo extra" 'tipo não esperado no esquema: estado' \
  "set role gmn_guard_owner; create type gmn_link_audit_guard.estado as enum ('a')" "drop type gmn_link_audit_guard.estado"
reapply_refused "operador extra" 'operador, classe' \
  "set role gmn_guard_owner; create operator gmn_link_audit_guard.=== (leftarg = int, rightarg = int, function = pg_catalog.int4eq)" "drop operator gmn_link_audit_guard.=== (int, int)"
reapply_refused "índice extra" 'objeto não esperado no esquema: ledger_heads_extra \(relkind i\)' \
  "set role gmn_guard_owner; create index ledger_heads_extra on gmn_link_audit_guard.ledger_heads (sha256)" "drop index gmn_link_audit_guard.ledger_heads_extra"
reapply_refused "privilégio padrão no esquema" 'privilégio padrão no esquema ou do dono' \
  "alter default privileges for role gmn_guard_owner in schema gmn_link_audit_guard grant select on tables to public" "alter default privileges for role gmn_guard_owner in schema gmn_link_audit_guard revoke select on tables from public"
reapply_refused "privilégio padrão global do dono" 'privilégio padrão no esquema ou do dono' \
  "alter default privileges for role gmn_guard_owner grant execute on functions to anon" "alter default privileges for role gmn_guard_owner revoke execute on functions from anon"
reapply_refused "coluna com privilégio para outro papel" 'coluna com privilégio próprio \(sha256\)' \
  "set role gmn_guard_owner; grant select (sha256) on gmn_link_audit_guard.ledger_heads to supabase_read_only_user" "set role gmn_guard_owner; revoke select (sha256) on gmn_link_audit_guard.ledger_heads from supabase_read_only_user"
reapply_refused "política de leitura (esconderia cabeças)" 'regra, política/RLS ou herança' \
  "set role gmn_guard_owner; create policy esconde on gmn_link_audit_guard.ledger_heads for select using (ledger_seq < 3)" "set role gmn_guard_owner; drop policy esconde on gmn_link_audit_guard.ledger_heads"
reapply_refused "RLS ligado" 'regra, política/RLS ou herança' \
  "alter table gmn_link_audit_guard.ledger_heads enable row level security" "alter table gmn_link_audit_guard.ledger_heads disable row level security"
reapply_refused "gatilho extra" 'gatilho não esperado na tabela: extra' \
  "set role gmn_guard_owner; create trigger extra after insert on gmn_link_audit_guard.ledger_heads for each row execute function gmn_link_audit_guard.refuse_change()" "drop trigger extra on gmn_link_audit_guard.ledger_heads"
reapply_refused "tabela numa publicação" 'estão numa publicação' \
  "create publication gmn_guard_probe for table gmn_link_audit_guard.ledger_heads" "drop publication gmn_guard_probe"
reapply_refused "esquema numa publicação" 'estão numa publicação' \
  "create publication gmn_guard_probe for tables in schema gmn_link_audit_guard" "drop publication gmn_guard_probe"
eq "cabeças intactas depois das recusas do inventário" "6" "$(rows)"
ok "inventário fechado (revisão do PR #61): função, procedimento, view, sequência, tipo, operador e índice extras, privilégio padrão (no esquema e global do dono), coluna com privilégio, política, RLS, gatilho extra e publicação (da tabela e do esquema) ⇒ a reaplicação aborta e nada muda"

# revisão do PR #61: DEFINIÇÃO EXATA do que a reaplicação não recria (colunas, restrições, índice) e dos gatilhos — nome certo, semântica errada aborta
T=gmn_link_audit_guard.ledger_heads
reapply_refused "restrição ausente" 'as restrições da tabela ledger_heads não são exatamente as desta migração' \
  "alter table $T drop constraint ledger_heads_sha256_format" "alter table $T add constraint ledger_heads_sha256_format check (sha256 ~ '^[0-9a-f]{64}\$')"
reapply_refused "CHECK mais permissivo com o mesmo nome" 'as restrições da tabela ledger_heads não são exatamente as desta migração' \
  "alter table $T drop constraint ledger_heads_ledger_seq_range; alter table $T add constraint ledger_heads_ledger_seq_range check (ledger_seq between 1 and 40000)" \
  "alter table $T drop constraint ledger_heads_ledger_seq_range; alter table $T add constraint ledger_heads_ledger_seq_range check (ledger_seq between 1 and 4000)"
reapply_refused "CHECK com o mesmo nome e NOT VALID" 'as restrições da tabela ledger_heads não são exatamente as desta migração' \
  "alter table $T drop constraint ledger_heads_key_id_format; alter table $T add constraint ledger_heads_key_id_format check (key_id ~ '^[a-z0-9][a-z0-9-]{3,31}\$') not valid" \
  "alter table $T drop constraint ledger_heads_key_id_format; alter table $T add constraint ledger_heads_key_id_format check (key_id ~ '^[a-z0-9][a-z0-9-]{3,31}\$')"
reapply_refused "UNIQUE com o mesmo nome e outras colunas" 'as restrições da tabela ledger_heads não são exatamente as desta migração' \
  "alter table $T drop constraint ledger_heads_audit_ref_ledger_seq_key; alter table $T add constraint ledger_heads_audit_ref_ledger_seq_key unique (audit_ref, ledger_seq, sha256)" \
  "alter table $T drop constraint ledger_heads_audit_ref_ledger_seq_key; alter table $T add constraint ledger_heads_audit_ref_ledger_seq_key unique (audit_ref, ledger_seq)"
reapply_refused "coluna com outro tipo" 'a tabela ledger_heads existe com outras colunas' \
  "alter table $T alter column recorded_at type timestamp without time zone" "alter table $T alter column recorded_at type timestamp with time zone"
reapply_refused "coluna aceitando NULL" 'a tabela ledger_heads existe com outras colunas' \
  "alter table $T alter column key_id drop not null" "alter table $T alter column key_id set not null"
reapply_refused "coluna com outro default" 'a tabela ledger_heads existe com outras colunas' \
  "alter table $T alter column recorded_at set default '2000-01-01'" "alter table $T alter column recorded_at set default now()"
reapply_refused "gatilho com um evento a menos" 'gatilho com definição diferente da desta migração \(ledger_heads_refuse_update_delete\)' \
  "set role gmn_guard_owner; create or replace trigger ledger_heads_refuse_update_delete before update on $T for each row execute function gmn_link_audit_guard.refuse_change()" \
  "set role gmn_guard_owner; create or replace trigger ledger_heads_refuse_update_delete before update or delete on $T for each row execute function gmn_link_audit_guard.refuse_change()"
reapply_refused "gatilho desligado" 'gatilho com definição diferente da desta migração \(ledger_heads_refuse_truncate\)' \
  "alter table $T disable trigger ledger_heads_refuse_truncate" "alter table $T enable trigger ledger_heads_refuse_truncate"
reapply_refused "gatilho ausente" 'os três gatilhos da guarda não estão todos presentes' \
  "drop trigger ledger_heads_publication_order on $T" "set role gmn_guard_owner; create trigger ledger_heads_publication_order before insert on $T for each row execute function gmn_link_audit_guard.enforce_publication_order()"
reapply_refused "tabela UNLOGGED" 'não é uma tabela comum, registrada e heap' \
  "alter table $T set unlogged" "alter table $T set logged"
eq "cabeças intactas depois das recusas da definição" "6" "$(rows)"
as_postgres_file "$MIGRATION"
ok "definição exata (revisão do PR #61): restrição ausente, CHECK mais permissivo ou NOT VALID com o mesmo nome, UNIQUE com outras colunas, coluna com outro tipo, NULL ou default, gatilho com um evento a menos, desligado ou ausente e tabela UNLOGGED ⇒ a reaplicação aborta e nada muda; desfeitos, a reaplicação volta a passar"

admin -c "set role gmn_guard_owner" -c "grant select (sha256) on gmn_link_audit_guard.ledger_heads to anon"
as_postgres_file "$MIGRATION"
eq "privilégio de coluna dos papéis da Data API revogado" "f" "$(admin -c "select has_column_privilege('anon', 'gmn_link_audit_guard.ledger_heads', 'sha256', 'SELECT')")"
ok "privilégio de COLUNA concedido a anon por fora: o REVOKE da tabela o retira na reaplicação e a conferência passa"

reapply_refused "ADMIN OPTION de terceiro no writer, sem SET nem INHERIT" 'associação não esperada a um papel da guarda \(authenticated->gmn_guard_writer \(concedente supabase_admin, admin t, set f, inherit f\)\)' \
  "grant gmn_guard_writer to authenticated with admin option, inherit false, set false" "revoke gmn_guard_writer from authenticated"
reapply_refused "ADMIN OPTION de terceiro no dono" 'associação não esperada a um papel da guarda \(service_role->gmn_guard_owner' \
  "grant gmn_guard_owner to service_role with admin option, inherit false, set false" "revoke gmn_guard_owner from service_role"
eq "só a associação administrativa do criador" "gmn_guard_owner>postgres:10:true:false:false,gmn_guard_reader>postgres:10:true:false:false,gmn_guard_writer>postgres:10:true:false:false" \
  "$(admin -c "select string_agg(r.rolname || '>' || m.rolname || ':' || a.grantor::oid || ':' || a.admin_option || ':' || a.set_option || ':' || a.inherit_option, ',' order by r.rolname) from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member where r.rolname like 'gmn_guard%'")"
ok "associações (revisão do PR #61): ADMIN OPTION dado por fora (sem SET nem INHERIT) ao writer ou ao dono ⇒ aborta; só fica a concessão administrativa que o CREATE ROLE dá ao executor (postgres, concedente de bootstrap, oid 10)"

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

# ---------------------------------------------------------------- 11. o ADAPTADOR REAL (createPostgresGuard + pg) contra a migração aplicada (obrigatória)
as_postgres_file "$MIGRATION"
ADAPTER_OUT="$(cd "$ROOT" && node --require ./tests/register-typescript.cjs supabase/proposed/local-test/guard-adapter-run.ts "$SOCK" 2>&1)" || fail "adaptador real: $ADAPTER_OUT"
echo "$ADAPTER_OUT" | grep '^OK' || true
[ "$(echo "$ADAPTER_OUT" | grep -c '^OK')" -ge 4 ] || fail "adaptador real: verificações a menos: $ADAPTER_OUT"
COUNT=$((COUNT + $(echo "$ADAPTER_OUT" | grep -c '^OK')))
docker exec -i "$NAME" psql -h /var/run/postgresql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "set gmn.guard_rollback_confirm = 'APAGAR-CABECAS-DA-GUARDA'" -f - < "$ROLLBACK"
eq "catálogo final" "$BEFORE" "$(catalog_snapshot)"
ok "depois da etapa do adaptador, o rollback confirmado volta ao catálogo original"

echo
echo "TODOS OS $COUNT TESTES LOCAIS DA GUARDA APROVADOS"
