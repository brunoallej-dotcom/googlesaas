# Runbook — verificação SOMENTE LEITURA (Supabase, VPS, Redis, CI/GitHub)

> ## NÃO EXECUTAR sem autorização escrita do responsável; esta etapa só PREPARA os procedimentos.
>
> Nada neste documento foi executado. Ele descreve o que rodar **depois** que o responsável autorizar, por escrito, cada bloco (qual ambiente, quem opera, janela).
> Complementa `docs/release/matriz-de-liberacao.md` (cada procedimento indica os critérios que ele alimenta) e `deploy/hostinger/VERIFICACAO-POS-DEPLOY.md`.

## Regras comuns a todos os procedimentos

1. **Autorização escrita** do responsável antes de cada bloco; registre data, operador e saída (sem segredos).
2. **Nunca** ler, imprimir ou colar `.env*`, chaves, tokens, senhas, valores de `docker secret`, `REDIS_URL` ou o conteúdo de `/run/secrets/*`.
3. **Nunca** usar a porta 6379 do host: ela pertence a **outro projeto**. O Redis da GMN só é acessado de dentro do contêiner do serviço `gmn-redis`.
4. Nenhum comando de escrita: sem `docker exec` que altere estado, sem `docker service update/scale/rm`, sem `docker stack deploy`, sem `FLUSH*`/`DEL`/`CONFIG SET`.
5. Nenhuma consulta paga (Serper). Nenhum comando abaixo chama o Serper.
6. Saída com dados pessoais (e-mails de operadores, leads) fica fora de tickets e chats; mascare antes de compartilhar.
7. Se um comando se comportar diferente do descrito aqui, **pare** e reporte; não improvise.

---

## 1. Supabase

Observação: o Supabase **não** é acessado a partir da VPS neste runbook. Os scripts do repositório rodam na máquina de desenvolvimento com variáveis de ambiente carregadas. Todos eles chamam `loadEnvConfig` (`@next/env`), que **lê arquivos `.env*` da pasta atual**: execute-os com as variáveis fornecidas por fora (por exemplo, o `~/.gmn-dev/dev.env` descrito no `NOTES.md`), e **nunca** abra nem imprima o arquivo.

### 1.1 `npm run db:check` — integridade do banco e dos PDFs

- **Objetivo:** achar inconsistências: auditoria concluída sem payload, `place_id` divergente do lead, PDF registrado sem arquivo em disco, duplicidade ativa por empresa + palavra-chave, auditoria "em andamento" parada. (Critério da matriz: P-04.)
- **Confirmação de leitura:** `scripts/check-integrity.ts` só faz `select` (até 1000 auditorias, 5000 leads) e `fs.stat`; o cabeçalho do script declara "SOMENTE LEITURA... não consulta o Serper e não usa Redis". Não escreve em disco nem no banco.
- **Variáveis necessárias:** `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (sem elas: "Supabase não configurado: nada a verificar"). Opcionais: caminhos dos PDFs (`allowedPdfRoots`) e minutos de inatividade.
- **Autorização:** responsável (usa a **service role**, que ignora RLS: lê todas as linhas).
- **Comando:** `scripts/run-isolated.sh` **não** serve aqui (ele bloqueia a rede). Usar diretamente: `npm run db:check`
- **Saída esperada:** `Auditorias: N | leads: M`, linhas `  ! ...` para cada ponto de atenção e a linha final `Nenhum problema encontrado.` ou `K ponto(s) de atenção (nada foi alterado).`
- **Como interpretar:** "arquivo PDF ausente em disco" não é falha grave (o PDF é regenerado do banco ao baixar); "concluída sem payload" e "place_id difere do lead" são problemas de dados; "duplicidade ativa" exige decisão humana; "parada... pode ser retomada" é candidata a **Retomar** (não repete as 49 consultas).
- **O que NÃO fazer:**
  - [ ] Não colar a service role em chat, ticket ou histórico de shell.
  - [ ] Não "corrigir" os pontos listados direto no banco; qualquer correção é um procedimento separado e autorizado.
  - [ ] Não rodar em loop ou agendado sem autorização (cada execução lê até 6000 linhas).
  - [ ] Não executar `npm run g4:remove`, `pdf:migrate`, `pdf:regenerate`, `pdf:fix-metadata`, `g5:smoke`: esses scripts **não** foram avaliados como somente leitura.

### 1.2 `npm run validate:recovery` — recuperação das auditorias sem custo

- **Objetivo:** provar que as auditorias existentes podem ser recuperadas, regeneradas e baixadas **sem** Serper/Redis/Worker, e que nada mudou. Critério: P-04, P-07 (repetição após a homologação).
- **O que faz:** tira um *snapshot* (hash) das 5 tabelas (`prospecting_campaigns`, `gmn_leads`, `gmn_audits`, `gmn_battlefield_rounds`, `gmn_battlefield_points`, até 5000 linhas cada) e dos PDFs de `public/audits`; roda as checagens (reaproveitamento do Battlefield, fase da auditoria, geração de PDF em memória, 49 pontos); tira novo snapshot e exige igualdade. Instala uma guarda em `fetch` que bloqueia qualquer host que não seja o do Supabase.
- **Confirmação de leitura:** no Supabase só há `select`. **Atenção (efeito local):** o script **grava um arquivo JSON** de relatório em `.data/migration/recovery-<timestamp>.json` na pasta do projeto e **lê** `public/audits/` (falha com `ENOENT` se a pasta não existir; o G4 a esvaziou, a pasta precisa existir, mesmo vazia). Isso é escrita local, fora do banco; avalie se é aceitável e **não** rode dentro da VPS.
- **Variáveis necessárias:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (e a configuração de PDF/bucket usada pelo `resolvePdfWithFallbacks`).
- **Autorização:** responsável.
- **Comando:** `npm run validate:recovery`
- **Saída esperada:** linhas `OK    <auditId8> <verificação> <detalhe>`; ao final `RECUPERAÇÃO VALIDADA: N verificações.` e código de saída 0. Último registro de referência: 32/32 (16/10/2026, desatualizado).
- **Como interpretar:** `FALHOU` em "nenhuma linha/arquivo alterado" ou "nenhuma chamada externa" é **grave** (algo escreveu ou chamou fora do Supabase): pare e reporte. Qualquer outra falha indica incompatibilidade de payload.
- **O que NÃO fazer:**
  - [ ] Não rodar com Worker/Redis ligados esperando "provar" algo: o script declara que não os usa.
  - [ ] Não apagar nem editar o JSON gerado em `.data/migration/`.
  - [ ] Não executar enquanto uma auditoria real estiver em andamento (o snapshot mudaria por motivo legítimo e geraria falso negativo).
  - [ ] Não repetir sem necessidade (lê 5 tabelas inteiras duas vezes).

### 1.3 `npm run rls:probe` — sondas de acesso por papel (anon, token forjado, opcionalmente operador)

- **Objetivo:** provar o que os papéis `anon` e `authenticated` conseguem fazer por HTTP (REST e Storage) e se a `service_role` mantém acesso. Critérios: P-01, P-03.
- **Classificação honesta:** **quase** somente leitura, **não estritamente**. Pelo código (`src/lib/rls-probe.ts`): para cada tabela faz `GET`; faz `PATCH` e `DELETE` com `id = 00000000-0000-0000-0000-000000000000` (filtro impossível, 0 linhas afetadas, com `Prefer: return=representation`); faz `POST /rest/v1/rpc/trigger_set_updated_at` com corpo `{}` (teste de **EXECUTE** de uma função de gatilho; deve falhar, mas é uma invocação); lista buckets e objetos (`POST .../object/list`) e `HEAD` em um objeto conhecido. Também usa a **service role** (`SUPABASE_SERVICE_ROLE_KEY`) para listar o bucket e escolher um objeto conhecido. Se a RLS/privilégios estiverem **frouxos** (situação atual, antes do G5), as escritas com filtro impossível continuam sem efeito, mas o risco existe; por isso, exige autorização expressa.
- **Variáveis necessárias:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (ausentes: "Variáveis do Supabase ausentes", saída 2). Opcional: `SUPABASE_AUDIT_BUCKET` (padrão `gmn-audit-pdfs`; **atenção: o bucket privado novo é `gmn-audit-pdfs-private`**, defina-o se quiser sondar o bucket vigente). Com `--authenticated`: `GMN_OPERATOR_EMAILS` (usa o primeiro e-mail) e a senha do operador (pedida no terminal, oculta; ou `GMN_PROBE_PASSWORD`, **não recomendado**).
- **Comando (sem operador):** `npm run rls:probe`
- **Comando (com operador, só se autorizado):** `npm run rls:probe -- --authenticated`
- **Saída esperada:** uma linha por sonda `VEREDITO papel operação recurso HTTP status detalhe`, e o resumo `EXPOSTO: n | só RLS como barreira: n | inesperado: n | service_role sem acesso: n`, seguido de `Nenhum dado exposto...` (saída 0) ou `ATENÇÃO...` (saída 1). Erros de execução saem com código 2.
- **Como interpretar:** antes do G5 espera-se "só RLS como barreira" > 0 (privilégios totais de anon/authenticated, RLS como única proteção; 15 linhas segundo `rls-audit.md`). Depois do G5, essas linhas devem virar "BLOQUEADO POR PRIVILÉGIO". `EXPOSED` = dado exposto: incidente. `service_role sem acesso` = **reverter** com `003_rls_hardening.rollback.sql` (somente com autorização).
- **O que NÃO fazer:**
  - [ ] Não usar `--authenticated` em produção sem autorização e sem a senha digitada no terminal (nunca em variável persistente nem em histórico).
  - [ ] Não aplicar `003_rls_hardening.sql` "só para ver"; o G5 é um evento separado.
  - [ ] Não alterar `IMPOSSIBLE_ID` nem os filtros no script para "testar de verdade".
  - [ ] Não copiar a saída com chaves/URLs completas para fora do canal combinado.

### 1.4 `supabase/audit/rls-audit.sql` e `supabase/audit/rls-audit-json.sql` — auditoria SQL de RLS

- **Objetivo:** estado real de RLS, políticas, privilégios, funções do esquema `public`, views, papéis (`BYPASSRLS`), buckets, objetos e Realtime. Critérios: P-01, P-03.
- **Confirmação de leitura:** lidos integralmente. `rls-audit.sql` tem 10 consultas `select` (o próprio cabeçalho diz "Só há SELECT"); `rls-audit-json.sql` é **uma única instrução SELECT** que devolve uma célula `audit` com JSON. Nenhum `INSERT/UPDATE/DELETE/DDL/GRANT/REVOKE/DO` (as ocorrências de `INSERT`, `UPDATE`, etc. no JSON estão apenas na lista de nomes de privilégios que a consulta verifica).
- **Pré-requisito/autorização:** responsável, com acesso ao **SQL Editor do Supabase** (execução no painel, não por script). Não precisa de variáveis de ambiente locais.
- **Comando:** colar o conteúdo do arquivo no SQL Editor e executar. Preferir `rls-audit-json.sql` (uma célula, fácil de arquivar); `rls-audit.sql` devolve 10 resultados que devem ser copiados um a um.
- **Saída esperada:** `rls-audit-json.sql`: uma linha, coluna `audit` (JSON). Referência: `docs/phase5/evidence/rls-audit-2026-10-17.json` (RLS ligado, 0 políticas, privilégios totais para anon/authenticated).
- **Como interpretar:** `rls_ativo = true` em todas as tabelas `gmn_*`/`prospecting_*`; **nenhum privilégio** para `anon`/`authenticated`/`PUBLIC` após o G5; `service_role` com `BYPASSRLS`; buckets com `public = false`; funções `SECURITY DEFINER` não executáveis por anon.
- **O que NÃO fazer:**
  - [ ] Não editar o SQL antes de colar (qualquer alteração invalida a garantia de só leitura; releia).
  - [ ] Não colar `003_rls_hardening.sql` nem o `rollback` no mesmo editor "aproveitando a aba".
  - [ ] Não publicar o JSON completo fora do canal combinado (contém nomes de papéis e estrutura do banco).
  - [ ] Não sobrescrever o arquivo de evidência de 17/10; salvar o novo com data no nome.

---

## 2. VPS (Docker Swarm)

- **Autorização:** responsável, com o operador designado e a janela. Sessão SSH **somente leitura por convenção**.
- **Contexto:** stack `gmn`; serviços `gmn_gmn-web`, `gmn_gmn-worker`, `gmn_gmn-redis`; dados em `${GMN_DATA_ROOT:-/srv/gmn}`; o worker nasce com 0 réplicas por desenho (`stack.yml:166`). Critérios: P-08, P-14, P-18, P-19, P-22, P-25, P-LA, L-04, L-06.

### 2.1 Estado dos serviços e tarefas

- **Comandos:**
  ```bash
  docker service ls
  docker stack services gmn
  docker stack ps gmn --no-trunc
  docker service ps gmn_gmn-web --no-trunc
  ```
- **Esperado:** web 1/1; redis 1/1; worker `0/0` (se ainda desligado) ou `1/1` (se já liberado); nenhuma tarefa `Failed`/`Rejected` recente; os demais serviços da VPS (Traefik, n8n, Evolution, Portainer, PostgreSQL, VRA) **inalterados**.
- **Interpretar:** `Rejected` com "no suitable node" indica restrição `node.hostname`; reinícios repetidos do web indicam recusa do entrypoint (ver 2.6).
- **Não fazer:** [ ] `docker service scale/update/rm` · [ ] `docker stack deploy/rm` · [ ] `docker service rollback` · [ ] tocar nos serviços de outros projetos.

### 2.2 Configuração efetiva (sem expor valores)

- **Comandos:**
  ```bash
  # imagem efetiva (confere digest/tag; critério P-14)
  docker service inspect gmn_gmn-web    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
  docker service inspect gmn_gmn-worker --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
  docker service inspect gmn_gmn-redis  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
  # estratégia de atualização
  docker service inspect gmn_gmn-web --format '{{json .Spec.UpdateConfig}}'
  # portas publicadas (esperado: nenhuma)
  docker service inspect gmn_gmn-web   --format '{{json .Endpoint.Ports}}'
  docker service inspect gmn_gmn-redis --format '{{json .Endpoint.Ports}}'
  # SOMENTE OS NOMES das variáveis de ambiente (nunca os valores)
  docker service inspect gmn_gmn-web --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | cut -d= -f1 | sort
  ```
- **Esperado:** imagens `gmn-web:<tag>`, `gmn-worker:<tag>`, `redis:7.4.11-alpine` (hoje **sem digest**: ver matriz P-14); `Ports` = `[]` ou `null`; nomes de variáveis sem nenhum `GMN_LINK_AUDIT_*` (critério P-LA) — **exceto** `GMN_LINK_AUDIT_EVIDENCE_DIR`, que o `stack.yml` atual define.
- **Interpretar:** presença de `GMN_LINK_AUDIT_DECISIONS_DIR`, `..._RESULTS_DIR`, `..._ORIGIN_KEY` ou `..._LEDGER_KEY` na Entrega 1 significa que a Lumos foi ligada: **parar e reportar**.
- **Não fazer:** [ ] **não** rodar `docker service inspect` sem o filtro `--format` e sem o `cut -d= -f1` na parte de Env (imprimiria `GMN_OPERATOR_EMAILS` e `NEXT_PUBLIC_*`) · [ ] não usar `docker inspect` em contêiner e imprimir `.Config.Env` completo · [ ] não colar a saída de Env em chat.

### 2.3 Segredos (somente nomes)

- **Comandos:**
  ```bash
  docker secret ls
  ```
  **Não** usar `docker secret inspect` (devolve metadados; os valores nunca são expostos, mas evite).
- **Esperado:** seis secrets externos: `gmn_supabase_service_role`, `gmn_supabase_anon`, `gmn_serper_api_key`, `gmn_redis_url`, `gmn_redis_password`, `gmn_redis_conf`; **sem** `gmn_link_audit_*` na Entrega 1. A coluna `CREATED` serve de evidência de data de rotação (critério P-20).
- **Não fazer:** [ ] `docker secret create/rm` · [ ] ler `/run/secrets/*` em qualquer contêiner · [ ] listar o conteúdo de arquivos `.env.production` (`cat`).

### 2.4 Volumes, diretórios de dados e disco

- **Comandos:**
  ```bash
  docker volume ls
  stat -c '%n  %u:%g  %a  %F' /srv/gmn /srv/gmn/audits /srv/gmn/link-audits /srv/gmn/evidence /srv/gmn/redis
  df -hT /srv/gmn
  df -hi /srv/gmn
  ```
  (Ajuste `/srv/gmn` se `GMN_DATA_ROOT` for outro; confirme o valor com o responsável, **sem** abrir `.env.production`.)
- **Esperado:** diretórios existentes; dono compatível com o contêiner (web `10001:10001`; Redis `999:1000`); `df -T` mostrando `ext4` ou `xfs` (critério L-06; **nunca** NFS/SMB/drvfs); espaço livre confortável.
- **Interpretar:** modo/dono errados fazem o web/Redis falharem na gravação; disco > 80% merece alerta (critério P-21).
- **Não fazer:** [ ] `chmod/chown/rm/mv` · [ ] `ls -R` ou `cat` em `/srv/gmn/evidence`, `audits` (PDFs e evidências de clientes, dado sensível) — use apenas `stat`/`df` · [ ] `du -a` em volumes grandes em horário de pico.

### 2.5 Portas e escuta no host

- **Comando:** `ss -ltn`
- **Esperado:** 80/443 do Traefik; **3000 e 6379 não escutando para a GMN** (`ss -ltn | grep -E ':(3000|6379)\b'`). **Atenção:** a porta 6379 do host pode estar legitimamente em uso por **outro projeto**; sua presença **não** é falha da GMN e **não** deve ser usada. O que importa é que `gmn_gmn-redis` não publique porta (2.2).
- **Não fazer:** [ ] conectar na 6379 do host (`redis-cli -p 6379`, `nc`, `telnet`) · [ ] `nmap` em IP da VPS · [ ] alterar firewall.

### 2.6 Logs (com limite)

- **Comandos:**
  ```bash
  docker service logs --tail 100 --no-trunc gmn_gmn-web
  docker service logs --tail 100 gmn_gmn-redis
  docker service logs --tail 100 gmn_gmn-worker      # só se o worker estiver ligado
  ```
  Sempre com `--tail N` (N ≤ 200). **Não** usar `-f` sem `timeout`.
- **Esperado:** web: `[gmn-entrypoint] papel=web ok` e Next "Ready"; ausência de `RECUSADO:` (o entrypoint sai com código 78 ao recusar: `NODE_ENV`, bypass de auth, modo demo, `.env*` na imagem, variável faltante, `REDIS_URL` fora de `gmn-redis`); sem stack trace repetido.
- **Interpretar:** `RECUSADO: variável obrigatória ausente: X` mostra **só o nome** da variável; `Redis` com `NOAUTH`/`ECONNREFUSED` indica problema de senha/URL.
- **Não fazer:** [ ] colar logs sem revisar (podem conter e-mails de operador ou IDs de clientes; o app deve mascarar, mas confirme) · [ ] `docker service logs` sem `--tail` · [ ] `docker logs -f` em produção sem limite de tempo · [ ] `docker exec` no web ou no worker.

### 2.7 Verificação de rede e TLS (opcional, de fora)

- **Comandos (da máquina do operador):** `curl -sI https://HOST/login` e `curl -s -o /dev/null -w '%{http_code}\n' https://HOST/login`; verificação de IP real depois de logado em `https://HOST/api/system/client-address` (navegador).
- **Esperado:** 200; cabeçalhos de segurança, `Strict-Transport-Security`, **`Content-Security-Policy-Report-Only`** (hoje não há CSP imposta: critério P-24); `address` = seu IP público, `shared:false`, `source: x-forwarded-for:last-hop` (critério P-22). `shared:true` (IP 10.x/172.x) = NAT do ingress: decisão do dono.
- **Não fazer:** [ ] enviar cabeçalhos `X-Forwarded-For` forjados contra produção sem autorização (o teste é do `VERIFICACAO-POS-DEPLOY.md` §5 e é autorizado à parte) · [ ] varrer portas ou fazer testes de carga.

---

## 3. Redis (somente pelo contêiner `gmn-redis` da própria stack)

- **Autorização:** responsável. Critérios: P-18.
- **Regra de ouro:** o Redis da GMN **não** publica porta no host. **Nunca** conectar à porta 6379 do host (é de outro projeto). Usa-se `docker exec` **somente** com comandos de leitura do `redis-cli`, dentro do contêiner `gmn_gmn-redis`, na **mesma máquina** onde a tarefa está (restrição `node.hostname`).
- **Senha:** o `redis-cli` lê a senha do arquivo de secret **dentro** do contêiner (`REDISCLI_AUTH`), sem a imprimir e sem passá-la na linha de comando. É o mesmo mecanismo do healthcheck da stack (`stack.yml:223`).
- **Localizar o contêiner:**
  ```bash
  CID="$(docker ps --filter 'name=gmn_gmn-redis' --format '{{.ID}}' | head -n1)"; echo "$CID"
  ```
  Se vier vazio, o serviço não está neste nó: **pare** (não use o Redis de outro projeto como substituto).
- **Comandos (todos de leitura):**
  ```bash
  RC='REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli'
  docker exec "$CID" sh -c "$RC PING"                              # PONG
  docker exec "$CID" sh -c "$RC INFO server"                       # versão (esperado 7.4.x)
  docker exec "$CID" sh -c "$RC INFO memory"                       # used_memory, maxmemory
  docker exec "$CID" sh -c "$RC INFO persistence"                  # aof_enabled:1, rdb desligado
  docker exec "$CID" sh -c "$RC INFO keyspace"                     # chaves por banco
  docker exec "$CID" sh -c "$RC DBSIZE"
  docker exec "$CID" sh -c "$RC CONFIG GET maxmemory-policy"       # noeviction
  docker exec "$CID" sh -c "$RC CONFIG GET maxmemory"              # 268435456 (256mb)
  docker exec "$CID" sh -c "$RC CONFIG GET appendonly"             # yes
  docker exec "$CID" sh -c "$RC CONFIG GET appendfsync"            # everysec
  ```
- **Esperado (conforme `stack.yml:187-248`):** `PONG`; `maxmemory-policy = noeviction` (**obrigatório para o BullMQ**); `appendonly = yes`; `appendfsync = everysec`; `maxmemory = 256mb`; `DBSIZE` pequeno (fila + batimento). Auditorias duráveis ficam no Supabase, não no Redis.
- **Interpretar:** política diferente de `noeviction` pode descartar jobs; `used_memory` próximo de `maxmemory` com `noeviction` faz as gravações falharem (erro `OOM`); `aof_last_write_status:ok` indica persistência saudável.
- **O que NÃO fazer:**
  - [ ] Nada de `FLUSHALL`, `FLUSHDB`, `DEL`, `UNLINK`, `EXPIRE`, `SET`, `CONFIG SET`, `CONFIG REWRITE`, `SHUTDOWN`, `DEBUG`, `KEYS *` (bloqueante), `MONITOR`, `SLAVEOF/REPLICAOF`.
  - [ ] Não rodar `redis-cli` pelo host nem apontar para `127.0.0.1:6379`.
  - [ ] Não passar a senha em `-a` (apareceria em `ps`/histórico) nem imprimir `/run/secrets/*`.
  - [ ] Não inspecionar o conteúdo dos jobs (`GET`/`HGETALL` em chaves `bull:*`): podem conter dados de leads; use apenas contagens (`DBSIZE`, `INFO keyspace`).
  - [ ] Não reiniciar o serviço para "limpar" memória.

---

## 4. CI / GitHub (somente GET)

- **Autorização:** responsável. Requer `gh` autenticado por quem tem permissão no repositório e **rede**. Critérios: P-09, P-10, P-13, P-15, P-32.
- **Variáveis:** substituir `OWNER/REPO` pelo repositório (origem `brunoallej-dotcom/...`; confirmar com o responsável). O token do `gh` fica no cofre do próprio `gh`; **nunca** exportá-lo nem imprimi-lo (`gh auth token` é proibido).

### 4.1 Execuções do CI

- **Comandos:**
  ```bash
  gh run list --repo OWNER/REPO --workflow ci.yml --limit 10
  gh run view RUN_ID --repo OWNER/REPO
  gh run view RUN_ID --repo OWNER/REPO --log-failed | tail -n 100
  gh pr checks PR_NUMBER --repo OWNER/REPO
  ```
- **Esperado:** jobs `typecheck`, `test`, `build`, `security` (gitleaks) verdes na `main` e no PR. **Não** existem jobs de lint, imagem Docker, Trivy nem deploy (ver matriz P-09..P-12).
- **Interpretar:** `security` vermelho = possível segredo no histórico: tratar como incidente (não "consertar" reescrevendo histórico sem autorização). `--log-failed` pode conter trechos de código: revisar antes de compartilhar.
- **Não fazer:** [ ] `gh run rerun`, `gh run cancel`, `gh workflow run/enable/disable` · [ ] `gh pr merge/close/ready/review` · [ ] `gh secret set/delete`, `gh variable set` · [ ] `gh run download` (artefatos podem ter conteúdo sensível).

### 4.2 Proteção da branch `main` (GET)

- **Comando:** `gh api repos/OWNER/REPO/branches/main/protection` (método GET, padrão do `gh api`)
- **Esperado:** `required_status_checks` com `typecheck`, `test`, `build`, `security`; `required_pull_request_reviews`; `enforce_admins`; sem `allow_force_pushes`/`allow_deletions`. Resposta 404 "Branch not protected" = **sem proteção** (achado, não erro de comando).
- **Não fazer:** [ ] **nunca** `-X PUT`, `-X POST`, `-X PATCH` nem `-X DELETE`, nem `--method` diferente de GET · [ ] não usar `-f`/`--field`/`--input` (transformam a chamada em POST).

### 4.3 Alertas de dependências (GET)

- **Comandos:**
  ```bash
  gh api "repos/OWNER/REPO/dependabot/alerts?state=open&per_page=100" --jq '.[] | {n:.number, sev:.security_advisory.severity, pkg:.dependency.package.name, scope:.dependency.scope}'
  gh api repos/OWNER/REPO --jq '.security_and_analysis'
  ```
- **Esperado:** compara com `docs/phase5/dependency-audit.md` (16/10/2026: 9 avisos, 6 altos, 3 moderados, todos de toolchain de build: `next` embutindo `postcss`, `braces`, `micromatch`, `chokidar`, `fast-glob`, `tailwindcss`, `postcss-selector-parser`, `postcss-nested`). Resposta 403/404 pode significar que o Dependabot alerts está **desativado** (achado).
- **Interpretar:** apenas dependências com `scope: runtime` e severidade alta exigem ação antes da Entrega 1.
- **Não fazer:** [ ] `-X PATCH` em alertas (dispensar/fechar alerta) · [ ] `gh api -X PUT repos/.../vulnerability-alerts` (ligar/desligar) · [ ] mesclar PRs do Dependabot por este runbook.

### 4.4 Secret scanning (GET)

- **Comando:** `gh api "repos/OWNER/REPO/secret-scanning/alerts?state=open&per_page=100" --jq '.[] | {n:.number, tipo:.secret_type_display_name, estado:.state, criado:.created_at}'`
- **Esperado:** lista vazia. Resposta 404/403 = recurso indisponível/desativado (achado). A projeção `--jq` acima **omite** o campo `secret` de propósito.
- **Não fazer:** [ ] **nunca** imprimir o campo `.secret` (valor do segredo vazado) · [ ] não usar `/locations` por padrão (expõe caminhos e linhas) · [ ] não resolver/fechar alertas (`PATCH`) · [ ] se houver alerta real, **não** repetir o segredo em lugar algum: acionar o responsável e iniciar rotação (matriz P-20).

---

## Resumo de risco por procedimento

| Procedimento | Escreve algo? | Custo/Rede | Segredo necessário |
|---|---|---|---|
| 1.1 `db:check` | Não | Rede (Supabase) | service role |
| 1.2 `validate:recovery` | **Arquivo JSON local** em `.data/migration/` | Rede (Supabase) | service role |
| 1.3 `rls:probe` | PATCH/DELETE com id impossível (0 linhas) e chamada de `rpc/trigger_set_updated_at` | Rede (Supabase) | service role + anon (+ senha do operador com `--authenticated`) |
| 1.4 SQL de auditoria | Não | SQL Editor | nenhum local |
| 2.x VPS | Não | SSH | nenhum |
| 3 Redis | Não (apenas leitura via `redis-cli`) | SSH + `docker exec` | lê a senha do arquivo dentro do contêiner |
| 4.x GitHub | Não (somente GET) | Rede | token do `gh` (não exibir) |
