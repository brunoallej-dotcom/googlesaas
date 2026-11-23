# Portões de produção da Fase 6 — roteiro do laboratório do PG-G08 (guarda externa no Supabase)

> Spec: `docs/specs/link-audit-production-gates.md` §5.1.6 (desenho mínimo da opção 1), §5.1.7 (números e "Nota da G1.b.2a"),
> §6 (**PG-G08**) e §11.1 (o que fica a confirmar no laboratório); ADR-0003; migração `supabase/proposed/004_link_audit_guard.sql`
> (testada por `supabase/proposed/local-test/guard-run.sh`, 39 verificações, sem rede, localmente e no CI pelo `guard-migration.yml`). Escrito na G1.b.2b (22/11/2026).
>
> **Quem executa: o RESPONSÁVEL**, num projeto Supabase de laboratório **descartável** (D-G0-12), e depois, com autorização própria e
> separada, em produção. O manager não executa nada disto: é chamada externa real, criação de projeto e aplicação de migração.
> **Custo:** se o laboratório tiver qualquer custo, ele depende de aprovação própria do responsável **antes** da criação (D-G0-12).
>
> **Repositório público.** Todo comando usa marcadores (`<REF_LAB>`, `<HOST_DIRETO>`, `<HOST_POOLER>`, `<URL_DATA_API>`,
> `<ARQUIVO_CA>` …). Nenhum host, ref de projeto, IP, chave, senha ou e-mail real entra no repositório, nem no registro de evidências versionado: lá
> vão só datas, resultados (`PASSOU`/`FALHOU`), códigos e números de latência. O registro completo (com hosts) fica com o responsável,
> fora do repositório.

## 0. Antes de começar

- Máquina do responsável (fora da VPS) com: `psql` 16 ou mais novo, `openssl` 1.1.1 ou mais novo (tem `-starttls postgres`), `curl`
  7.55 ou mais novo (tem `-H @arquivo`), este repositório com `node_modules` instalado (para o verificador `gate` e a reconciliação).
- **Nenhum segredo em argumento, URL, histórico ou log** (revisão do PR #64): senhas e chaves só por `read -rs` para variáveis do shell e
  daí para arquivos `0600` de uma pasta temporária da sessão (`PGPASSFILE`, arquivos de cabeçalho do `curl`, arquivos `*_FILE` do CLI).
  **Nunca** `psql "postgresql://usuário:senha@…"` nem `curl -H "apikey: …"` com o valor no comando: o argumento de um processo aparece
  em `ps` para outros usuários da máquina e o comando vai para o histórico. Vale para **todo** o roteiro, no laboratório e em produção
  (§11).
- **TLS `verify-full` obrigatório em toda conexão `psql`** do roteiro, com a CA do projeto: `PGSSLMODE=verify-full` e
  `PGSSLROOTCERT=<ARQUIVO_CA>` exportados na sessão (abaixo); sem eles o `psql` aceitaria um certificado qualquer.

### 0.1 A sessão segura do roteiro (rodar uma vez, num shell só para isto)

Abra um shell novo só para o roteiro (`bash --norc --noprofile`), cole o bloco abaixo nele e, no fim do roteiro, `exit` (o `trap` apaga
a pasta temporária com o `PGPASSFILE`, os cabeçalhos e as respostas). Se a sessão do runbook da guarda (§0 dele) também for aberta neste
shell, em qualquer ordem, as duas usam o mesmo `trap` sobre a lista `GMN_SESSOES`: um não substitui o outro, e o `exit` apaga as duas
pastas (revisão final do PR #64).

```bash
set +x
umask 077
LAB="$(mktemp -d)"; GMN_SESSOES+=("$LAB")
# o MESMO trap no roteiro do laboratório e no runbook da guarda: apaga TODAS as pastas de sessão deste shell, em qualquer ordem
trap 'rm -rf -- "${GMN_SESSOES[@]}"' EXIT
# TLS obrigatório em TODA conexão psql (laboratório e produção): cadeia até a CA do projeto E nome do host
export PGSSLMODE=verify-full PGSSLROOTCERT=<ARQUIVO_CA> PGDATABASE=postgres PGPASSFILE="$LAB/pgpass"
: > "$PGPASSFILE"
# pg_como <usuário> <host> <porta>: pede a senha sem eco, guarda no PGPASSFILE 0600 da sessão e aponta PGHOST/PGPORT/PGUSER
pg_como() {
  local senha
  read -rsp "senha de $1 em $2:$3: " senha; echo
  printf '%s:%s:*:%s:%s\n' "$2" "$3" "$1" "$(printf '%s' "$senha" | sed 's/[\\:]/\\&/g')" >> "$PGPASSFILE"
  unset senha
  export PGHOST="$2" PGPORT="$3" PGUSER="$1"
}
# pg_usar <usuário> <host> <porta>: troca de usuário/host já cadastrado no PGPASSFILE, sem pedir de novo
pg_usar() { export PGUSER="$1" PGHOST="$2" PGPORT="$3"; }
# api_cabecalhos <nome>: pede a apikey e o bearer sem eco e grava os cabeçalhos num arquivo 0600 da sessão
api_cabecalhos() {
  local chave bearer
  read -rsp "apikey ($1): " chave; echo
  read -rsp "bearer ($1; Enter = a mesma apikey): " bearer; echo
  printf 'apikey: %s\nAuthorization: Bearer %s\n' "$chave" "${bearer:-$chave}" > "$LAB/h-$1"
  unset chave bearer
}
# api <nome> <método> <caminho> [cabeçalho de perfil] [corpo JSON]: código HTTP e os primeiros 300 bytes da resposta (em $LAB/resp)
api() {
  local args=(-sS -o "$LAB/resp" -w '%{http_code}\n' -X "$2" -H @"$LAB/h-$1")
  [ -n "${4:-}" ] && args+=(-H "$4")
  [ -n "${5:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "$5")
  curl "${args[@]}" "<URL_DATA_API>$3"; head -c 300 "$LAB/resp"; echo
}
```

`printf` e `read` são do próprio shell (não viram processo com argumentos); o `sed` recebe a senha pela entrada padrão, só para
escapar `\` e `:` no formato do `PGPASSFILE`.
- Abra o registro de evidências local (fora do repositório) com a data e a versão do commit aplicado.
- A sequência é a deste documento. **Pare** em qualquer `FALHOU` e anote; nada de "consertar" pelo console: correção é migração
  versionada nova, revisada.

## 1. Criar o laboratório e aplicar a 004 como `postgres`

0. **Primeiro passo obrigatório (spec GE-E4):** anexar ao registro a saída **verde** do job `guard-migration`
   (`.github/workflows/guard-migration.yml`) no **SHA exato** da 004 que será aplicada, e conferir o `sha256` do arquivo local contra o
   resumo do job: `sha256sum supabase/proposed/004_link_audit_guard.sql supabase/proposed/004_link_audit_guard.rollback.sql`. Sem o job
   verde nesse SHA, ou com hash diferente, **não aplique**.
1. Criar o projeto de laboratório (plano decidido pelo responsável; anotar o plano e a região no registro local).
2. Baixar a CA do banco no painel do projeto (configuração de SSL do banco) para `<ARQUIVO_CA>` e anotar a impressão digital:
   ```bash
   openssl x509 -in <ARQUIVO_CA> -noout -fingerprint -sha256 -subject -enddate
   ```
3. Aplicar a migração **como `postgres`**, por `psql` na sessão segura (§0.1; o editor SQL também serve, mas guarda histórico):
   ```bash
   pg_como postgres <HOST_DIRETO> 5432
   psql -v ON_ERROR_STOP=1 -f supabase/proposed/004_link_audit_guard.sql
   ```
   Esperado: `COMMIT` no fim. Qualquer `GUARDA abortada` ou `GUARDA falhou` desfaz tudo (transação única): anote a mensagem e pare.
4. Definir as senhas dos dois papéis de login **no próprio psql** (o cliente envia o hash SCRAM, nunca a senha em claro), uma senha
   diferente para cada um, geradas na hora e guardadas no cofre (a do leitor **nunca** vai para a VPS):
   ```bash
   psql                               # ainda como postgres, pela sessão segura (verify-full; senha do PGPASSFILE)
   postgres=> \password gmn_guard_writer
   postgres=> \password gmn_guard_reader
   postgres=> \q
   ```
5. Reaplicar a 004 uma vez (idempotência): esperado `COMMIT` de novo, sem alterar nada.

## 2. Catálogo e privilégios (a mesma conferência da migração, de fora)

Ainda como `postgres` (`pg_usar postgres <HOST_DIRETO> 5432; psql`), só leitura. Cada consulta tem o resultado esperado ao lado;
divergência = `FALHOU`.

```sql
-- dono e SECURITY DEFINER com search_path vazio (esperado: gmn_guard_owner | t | {"search_path=\"\""})
select pg_get_userbyid(proowner), prosecdef, proconfig from pg_proc
 where oid = 'gmn_link_audit_guard.publish_head(text,text,integer,text)'::regprocedure;
-- ACL não nula e sem PUBLIC (grantee 0) no esquema, na tabela e nas três funções (esperado: 0 | 0)
select (select count(*) from (select aclexplode(nspacl) a from pg_namespace where nspname = 'gmn_link_audit_guard'
        union all select aclexplode(relacl) from pg_class where oid = 'gmn_link_audit_guard.ledger_heads'::regclass
        union all select aclexplode(proacl) from pg_proc where pronamespace = 'gmn_link_audit_guard'::regnamespace) x
        where (x.a).grantee = 0),
       (select count(*) from pg_proc where pronamespace = 'gmn_link_audit_guard'::regnamespace and proacl is null);
-- papéis da Data API sem nada (esperado: uma linha "f" por papel e privilégio)
select r, p, has_table_privilege(r, 'gmn_link_audit_guard.ledger_heads', p)
  from unnest(array['anon','authenticated','service_role','authenticator']) r,
       unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select r, has_schema_privilege(r, 'gmn_link_audit_guard', 'USAGE'),
       has_function_privilege(r, 'gmn_link_audit_guard.publish_head(text,text,integer,text)', 'EXECUTE')
  from unnest(array['anon','authenticated','service_role','authenticator']) r;
-- atributos e associações dos papéis da guarda (esperado: só falsos, exceto rolcanlogin dos dois de login; 0 associações)
select rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit
  from pg_roles where rolname like 'gmn_guard%' order by 1;
select count(*) from pg_auth_members where member in (select oid from pg_roles where rolname like 'gmn_guard%');
-- privilégios padrão num esquema novo (§11.1: "a confirmar"); anote o que aparecer
select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
```

## 3. Prova pela Data API (REST): a tabela e a função NÃO respondem

Marcadores: `<URL_DATA_API>` (a URL da API do laboratório). As chaves `anon` e `service_role` e o JWT de um usuário de teste criado só
no laboratório (papel `authenticated`) são **digitados sem eco** quando o `api_cabecalhos` pede (§0.1), nunca colados no comando. Os
pedidos tentam o esquema da guarda pelos cabeçalhos de perfil do PostgREST (que não são segredo).

```bash
api_cabecalhos anon             # apikey = a chave anon; Enter no bearer
api_cabecalhos service_role     # apikey = a chave service_role; Enter no bearer
api_cabecalhos authenticated    # apikey = a chave anon; bearer = o JWT do usuário de teste
LINHA='{"audit_ref":"<64 hex de teste>","key_id":"gk-lab-1","ledger_seq":1,"sha256":"<64 hex de teste>"}'
RPC='{"p_audit_ref":"<64 hex de teste>","p_key_id":"gk-lab-1","p_ledger_seq":1,"p_sha256":"<64 hex de teste>"}'
for quem in anon authenticated service_role; do
  api "$quem" GET  '/rest/v1/ledger_heads?select=*' 'Accept-Profile: gmn_link_audit_guard'      # leitura da tabela
  api "$quem" POST '/rest/v1/ledger_heads' 'Content-Profile: gmn_link_audit_guard' "$LINHA"     # escrita direta
  api "$quem" POST '/rest/v1/rpc/publish_head' 'Content-Profile: gmn_link_audit_guard' "$RPC"   # a função por RPC
done
```

**Esperado nos nove pedidos:** código 4xx, corpo **sem nenhuma linha** da guarda — com o esquema fora de
*Exposed schemas*, o PostgREST recusa o perfil (erro de esquema inválido); se alguém o expuser por engano, o `REVOKE` ainda dá
"permission denied". Depois, conferir no banco que nada foi gravado: `pg_usar postgres <HOST_DIRETO> 5432; psql -Atc "select count(*) from
gmn_link_audit_guard.ledger_heads"` (esperado: 0 neste ponto do roteiro). Se o projeto tiver o GraphQL ligado, conferir também que a
introspecção com a chave `anon` não lista nenhum tipo da guarda:
`api anon POST /graphql/v1 '' '{"query":"{ __schema { types { name } } }"}'; grep -ciE 'ledger' "$LAB/resp"` (esperado: 0).

## 4. *Exposed schemas* (painel)

No painel do laboratório, nas configurações da Data API: anotar a lista de *Exposed schemas* e de *Extra search path*, com data.
**Esperado:** `gmn_link_audit_guard` **não** aparece em nenhuma das duas. (Hoje o estado deste item no projeto de produção não está
verificado: `docs/phase5/g5-s0-relatorio-2026-11-07.md:82`.)

## 5. TLS: cadeia e nome do certificado contra a CA, direto e pooler

Para cada host candidato — `<HOST_DIRETO>:5432`, `<HOST_POOLER>:5432` (modo sessão) e `<HOST_POOLER>:6543` (modo transação):

```bash
openssl s_client -starttls postgres -connect <HOST>:<PORTA> -servername <HOST> -CAfile <ARQUIVO_CA> \
  -verify_return_error -verify_hostname <HOST> </dev/null 2>/dev/null | grep -E 'Verify return code|subject=|issuer='
```

**Esperado:** `Verify return code: 0 (ok)` — cadeia até a CA fornecida **e** nome do host conferido (é o que o conector da guarda exige:
`rejectUnauthorized: true`, CA fornecida, nome verificado). Qualquer outro código = esse host **não** serve para a guarda como está.

Depois, a prova com o **conector de produção** (`pg`, `verify-full`), pelo verificador do portão, com o papel de leitura, sem backup:

```bash
# credencial do leitor e chave do pseudônimo em arquivos 0600 da sessão: o CLI aceita *_FILE (nada no argv nem no ambiente)
read -rsp 'URL do leitor (postgresql://gmn_guard_reader[.<REF_LAB>]:<senha com escape>@<HOST>:<PORTA>/postgres?sslmode=verify-full): ' V; echo
printf '%s' "$V" > "$LAB/reader-url"; unset V
read -rsp 'chave do pseudônimo do laboratório (<id>:<64 hex>): ' K; echo
printf '%s' "$K" > "$LAB/guard-key"; unset K
export GMN_LINK_AUDIT_GUARD_READER_DB_URL_FILE="$LAB/reader-url" GMN_LINK_AUDIT_GUARD_READER_DB_CA_FILE=<ARQUIVO_CA> GMN_LINK_AUDIT_GUARD_KEY_FILE="$LAB/guard-key"
npm run -s link-audit:guard-reconcile -- gate --json
```

**Esperado:** código 2 com `"code":"EXTERNAL_GUARD_NOT_VERIFIED"` e `"checks":{…"connection":"OK","reader":"OK"…}` — TLS verificado,
sessão do `gmn_guard_reader`, somente leitura, sem `EXECUTE` na publicação (sem rodada de backup, a situação das auditorias fica
`NOT_VERIFIED`, como deve). `GUARD_UNAVAILABLE` = conexão, TLS ou senha; `NOT_READER_ROLE`/`SESSION_NOT_READ_ONLY` = credencial errada.
Repetir para cada host candidato e anotar qual será usado pela VPS (item 7). No pooler, o usuário é `gmn_guard_reader.<REF_LAB>`.

Conferir também, pelo pooler escolhido, que os ajustes do papel valem na sessão (no modo transação podem não valer):

```bash
pg_como gmn_guard_writer[.<REF_LAB>] <HOST_ESCOLHIDO> <PORTA>
psql -At -c "show statement_timeout" -c "show lock_timeout" -c "show transaction_isolation"   # esperado: 3s / 3s / read committed
pg_como gmn_guard_reader[.<REF_LAB>] <HOST_ESCOLHIDO> <PORTA>
psql -At -c "show default_transaction_read_only"                                           # esperado: on
```

Se algum ajuste não vier pelo host escolhido, **esse host não serve** (o prazo de 3 s do servidor e a sessão somente leitura são parte
do desenho): use o modo sessão ou a conexão direta. O cliente (`pg`) usa consultas com parâmetros (protocolo estendido); se o modo
transação recusar, a mesma conclusão.

## 6. Latência contra o prazo de 3 s (D-G0-3)

O que conta é o caminho **da VPS (ou do host da pilha de homologação) até o host escolhido**, com uma conexão nova por chamada (o
adaptador não usa pool). Do host da pilha de homologação, com um `psql` 16+ e a **mesma sessão segura** (§0.1, `verify-full`), 30
chamadas como o **escritor**, cada uma abrindo conexão TLS, publicando uma posição nova de um pseudônimo de teste e fechando:

```bash
pg_como gmn_guard_writer[.<REF_LAB>] <HOST_ESCOLHIDO> <PORTA>
REF=$(openssl rand -hex 32); : > "$LAB/lat"
for i in $(seq 1 30); do
  /usr/bin/time -f '%e' -a -o "$LAB/lat" psql -Atqc "select gmn_link_audit_guard.publish_head('$REF', 'gk-lab-1', $i, '$(openssl rand -hex 32)')" >/dev/null
done
sort -n "$LAB/lat" | awk '{a[NR]=$1} END {print "p50", a[int(NR*0.5)], "p95", a[int(NR*0.95)], "max", a[NR]}'
```

Repetir como leitor (`pg_como gmn_guard_reader[.<REF_LAB>] …`, arquivo `$LAB/lat-leitura`) com uma leitura
(`select … from gmn_link_audit_guard.ledger_heads where audit_ref = '$REF' order by ledger_seq desc limit 1`).
**Critério:** máximo abaixo de 2 s nas duas séries ⇒ o prazo de 3 s fica confirmado (anotar p50, p95 e máximo). Máximo entre 2 s e 3 s,
ou qualquer chamada acima de 3 s ⇒ **não** confirmar: levar os números ao manager, que registra o número novo e o motivo na spec §5.1.7
(sem mudar a regra decidida). As linhas de teste ficam na tabela (append-only): use um pseudônimo aleatório, que nenhuma auditoria tem.

## 7. IPv4/IPv6 e alcance a partir da VPS

```bash
getent ahostsv4 <HOST_DIRETO>; getent ahostsv6 <HOST_DIRETO>
getent ahostsv4 <HOST_POOLER>; getent ahostsv6 <HOST_POOLER>
# na VPS (só leitura, sem segredo): o host escolhido responde na porta?
timeout 5 bash -c '</dev/tcp/<HOST_ESCOLHIDO>/<PORTA>' && echo alcança || echo NÃO alcança
```

Anotar: se a conexão direta tem endereço IPv4 no plano (ou exige complemento pago, que **não** se contrata sem autorização) e se a VPS
tem IPv6. Sem IPv6 na VPS e sem IPv4 direto, a guarda usa o pooler em modo sessão (item 5), com o usuário `gmn_guard_writer.<REF>`.

## 8. Pausa por inatividade

Anotar a política do plano (se o projeto pausa por inatividade e depois de quanto tempo) e como reativar. Projeto pausado = guarda
indisponível = Fase 6 parada, com falha fechada (D-G0-3; runbook da guarda §6). Se o plano pausa, anotar o que conta como atividade e
se a rotina semanal da reconciliação basta para evitar a pausa.

## 9. Ensaio curto da regra 7 e da reconciliação no laboratório

Com o laboratório já provado, um ensaio rápido (sem a pilha):

1. Na sessão segura (§0.1), como escritor (`pg_usar gmn_guard_writer[.<REF_LAB>] <HOST> <PORTA>; psql`), publicar para um pseudônimo de teste as posições 1 e 3 e repetir a 3 (`RECORDED`, `RECORDED`, `ALREADY_RECORDED`);
   tentar a 2 (`STALE`) e a 3 com outro hash (`CONFLICT`); como leitor, tentar publicar (`permission denied for function`).
2. Como `postgres`, tentar `update`/`delete`/`truncate` na tabela: recusados pelos gatilhos (`guarda: registros imutáveis`). **Não**
   usar `session_replication_role` aqui: é o limite declarado (o dono desliga os gatilhos), já demonstrado no teste local.

## 10. Registro das evidências (sem host, ref, IP nem chave)

Copiar para o registro local e, sanitizado, para o relatório do laboratório quando o manager pedir:

| Item | Resultado | Evidência (sanitizada) | Data |
|---|---|---|---|
| Job `guard-migration` verde no SHA exato da 004 e `sha256` conferido (§1, passo 0) | SIM / NÃO | SHA do commit e hashes | |
| 004 aplicada como `postgres`, reaplicada sem alteração | PASSOU / FALHOU | `COMMIT` nas duas | |
| Senhas definidas por `\password` (escritor e leitor distintos) | SIM / NÃO | — | |
| Catálogo e privilégios (§2) | PASSOU / FALHOU | contagens esperadas | |
| Data API: tabela e função recusadas para `anon`, `authenticated`, `service_role` (§3) | PASSOU / FALHOU | códigos HTTP; 0 linhas | |
| *Exposed schemas* sem o esquema da guarda (§4) | PASSOU / FALHOU | lista anotada | |
| TLS direto: cadeia e nome (§5) | PASSOU / FALHOU | `Verify return code` | |
| TLS pooler sessão / transação (§5) | PASSOU / FALHOU | idem | |
| Verificador `gate` sem backup: `connection: OK`, `reader: OK` (§5) | PASSOU / FALHOU | JSON sem host | |
| Ajustes do papel pelo host escolhido (3 s, read committed, read only) (§5) | PASSOU / FALHOU | valores | |
| Latência escrita / leitura: p50, p95, máx (§6) | CONFIRMA 3 s / NÃO | números | |
| IPv4/IPv6 e host escolhido para a VPS (§7) | — | direto ou pooler, modo | |
| Pausa por inatividade (§8) | — | política anotada | |
| Regra 7 e gatilhos no laboratório (§9) | PASSOU / FALHOU | desfechos | |

## 11. Depois, em produção (autorização própria do responsável)

Mesma sequência, com estas diferenças:

- **Antes:** autorização escrita do responsável para aplicar a 004 em produção; janela combinada; backup do projeto disponível.
- **A sessão segura do §0.1 vale igual em produção** (revisão do PR #64): `PGSSLMODE=verify-full` com a CA de **produção** em
  `PGSSLROOTCERT`, senhas só pelo `PGPASSFILE` 0600 da sessão, chaves da Data API de produção só pelos arquivos de cabeçalho do
  `api_cabecalhos`, credencial do leitor e chave do pseudônimo só pelos arquivos `*_FILE`. Nenhum segredo de produção em argumento,
  URL, histórico ou log; nada colado no comando.
- **Itens 1 a 5 e 7 a 8:** iguais (aplicar, senhas, catálogo, Data API com as chaves de produção — só pedidos que falham —, *Exposed
  schemas*, TLS, IPv4/IPv6, pausa). A CA de produção é a do projeto de produção (impressão digital anotada).
- **Item 6 (latência):** **não** publicar linhas de teste em produção: medir só a leitura (como leitor) e o tempo de conexão; a escrita
  foi medida no laboratório. Se a diferença de região entre laboratório e produção for relevante, medir a escrita na homologação.
- **Item 9:** não se faz em produção.
- Em seguida, a ativação segue o runbook da guarda (`producao-g1b-runbook-guarda.md` §1): secrets na VPS, deploy pelo CI, verificador
  do portão, primeira rodada de backup e primeira reconciliação, e só então o primeiro `ENROLL`.
- **Encerrar o laboratório** quando a G2 terminar (ou antes, se não for usado na homologação), revogando as senhas dos papéis e
  apagando o projeto; data registrada (atestação AT-G2-02 da spec §10.4).
