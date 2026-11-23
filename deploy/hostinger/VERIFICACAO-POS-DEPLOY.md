# Verificação pós-deploy (comandos somente leitura)

Defina antes o ambiente (P9.4: o nome da stack é um parâmetro):
```bash
STACK=gmn;     HOST='<DOMINIO_PRODUCAO>'; DADOS=/srv/gmn          # produção
STACK=gmn-hml; HOST='<DOMINIO_HML>';      DADOS=/srv/gmn-hml      # homologação (sobreposição stack-hml.yml)
```
Execute depois do deploy aprovado pelo workflow `.github/workflows/deploy.yml`. O receptor de deploy já roda as verificações PD-01 a
PD-08 e o job as EX-01 a EX-03 (`RUNBOOK-DEPLOY-PELO-CI.md`); este roteiro é a conferência completa do responsável. Em homologação, o
Worker fica sempre em 0, a trava `GMN_LINK_AUDIT_HOMOLOGATION=1` existe só no web e a stack de produção não pode mudar.

## 1. Serviços e tarefas
```bash
docker stack services "$STACK"                    # web 1/1 · gmn-redis 1/1 · worker 0/0 (desligado de propósito; em homologação, sempre)
docker stack ps "$STACK" --no-trunc               # sem tarefas em Failed/Rejected
docker service ls                                 # TODOS os serviços antigos inalterados (traefik, n8n, evolution, portainer, postgres, vra e, em homologação, a stack de produção)
docker service logs --tail 50 "${STACK}_gmn-web"      # "[gmn-entrypoint] papel=web ok" e Next "Ready"
docker service logs --tail 20 "${STACK}_gmn-redis"
docker service inspect "${STACK}_gmn-web" --format '{{json .Spec.TaskTemplate.ContainerSpec.Image}}'   # gmn-web:<amb>-<sha40> do resumo do job
```
## 2. Rede e portas
```bash
docker service inspect "${STACK}_gmn-web" --format '{{json .Endpoint.Ports}}'        # sem portas publicadas
docker service inspect "${STACK}_gmn-redis" --format '{{json .Endpoint.Ports}}'
docker service inspect "${STACK}_gmn-web" --format '{{json .Spec.TaskTemplate.Networks}}'     # ${STACK}_gmn_internal + automacao...
docker service inspect "${STACK}_gmn-redis" --format '{{json .Spec.TaskTemplate.Networks}}' # só ${STACK}_gmn_internal
ss -ltn | grep -E ':(3000|6379)\b' || echo "3000/6379 não escutam no host"
```
## 3. Labels do Traefik (na stack, em `deploy.labels`)
```bash
docker service inspect "${STACK}_gmn-web" --format '{{json .Spec.Labels}}' | tr ',' '\n' | grep traefik
```
Esperado: `traefik.swarm.network=automacaotrafegopagoredeinterna` (provider Swarm do Traefik 3.5; não há labels `traefik.docker.*`), router `gmn` (produção) ou `gmn-hml` (homologação, `GMN_TRAEFIK_NAME`) com `Host(HOST)`, `websecure`, `certresolver=letsencryptresolver`, porta 3000. Nenhum router da homologação com o nome de um de produção.
## 4. HTTPS, redirecionamento e cabeçalhos
```bash
dig +short "$HOST"                                # IP da VPS
curl -sI "http://$HOST/login" | head -5           # 301/308 para https (se o redirecionamento da stack estiver ativo)
curl -sI "https://$HOST/login" | grep -iE '^(HTTP|strict-transport|x-frame|x-content-type|referrer|content-security-policy-report-only)'
echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -issuer -dates
```
Esperado: `HTTP/2 200`, `strict-transport-security`, `x-frame-options: DENY`, certificado Let's Encrypt válido.
## 5. Autenticação (sem credenciais)
```bash
for p in /api/prospect /api/audit/completed /api/system/health /api/link-audit/evidence; do printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST$p"; done   # todos 401
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST/dev/battlefield-preview"                                   # 404
# (o teste de Host de loopback é feito dentro do container por `verify-local.sh`: de fora, o Traefik responde 404 a Host desconhecido)
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 1.2.3.4' -H 'X-Forwarded-For: 1.2.3.4' "https://$HOST/login"   # 200
# Depois de logado no navegador, abra https://HOST/api/system/client-address: address = SEU IP público (não 1.2.3.4), shared:false.
# Com cabeçalhos forjados (extensão do navegador ou curl com o cookie) o resultado não pode mudar; xRealIpPresentButIgnored:true é o esperado.
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' "https://$HOST/api/auth/login"   # 401 (credenciais inválidas)
```
Depois, entrar pelo navegador com um operador da lista; o cookie deve ser `HttpOnly; Secure; SameSite=Strict`.
## 6. Redis exclusivo e fila
```bash
docker exec "$(docker ps -q -f name="${STACK}_gmn-redis")" sh -c 'REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli ping'     # PONG
docker exec "$(docker ps -q -f name="${STACK}_gmn-redis")" sh -c 'REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli dbsize'  # só chaves da GMN
```
O Redis não responde de fora: `redis-cli -h IP_DA_VPS -p 6379 ping` deve falhar. O caminho `/run/secrets/gmn_redis_password` é o mesmo nas duas stacks (sintaxe longa com `target`); em homologação o secret do Swarm é `gmn-hml_redis_password`.
## 7. Dados
```bash
sudo ls -ld "$DADOS"/* ; sudo stat -c '%U:%G %a %n' "$DADOS"/*     # 10001:10001 700 (redis 999:1000)
docker exec "$(docker ps -q -f name="${STACK}_gmn-web")" sh -c 'ls /data/evidence; touch /data/evidence/x 2>&1 | head -1'   # leitura ok; escrita negada (ro)
```
Na interface: `/auditoria-por-link` lista `aud-001-autorizacao-01` com integridade OK (produção; em homologação, só dados sintéticos).
## 8. Saúde da aplicação (logado)
`/api/system/health` (com sessão): Redis OK, Supabase OK, Worker "sem batimento" (esperado enquanto `replicas: 0`).
## 9. Custos
Nenhuma auditoria deve estar `RUNNING`; confirme no painel do Serper que o consumo não mudou desde o deploy. Em homologação não há
chave válida do Serper (o secret `gmn-hml_serper_api_key` guarda um texto fixo não secreto; ver o §10).
## 10. Trava de homologação e Serper
```bash
docker service inspect "${STACK}_gmn-web" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep -E '^(GMN_LINK_AUDIT_HOMOLOGATION|SERPER_API_KEY_FILE)='
```
Esperado em homologação: `GMN_LINK_AUDIT_HOMOLOGATION=1` e o `SERPER_API_KEY_FILE` registrado no P9-H07 (vazio, se a fusão do Docker
aplicar a sobreposição; senão, o secret `gmn-hml_serper_api_key`, com texto fixo não secreto). Em produção: nenhuma linha
`GMN_LINK_AUDIT_HOMOLOGATION` e `SERPER_API_KEY_FILE=/run/secrets/gmn_serper_api_key`.
