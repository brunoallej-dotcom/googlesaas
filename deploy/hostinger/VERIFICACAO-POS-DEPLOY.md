# Verificação pós-deploy (comandos somente leitura)

Substitua `HOST` pelo domínio (ex.: `gmn.somosvra.com.br`). Execute após o `docker stack deploy` autorizado.

## 1. Serviços e tarefas
```bash
docker stack services gmn                         # web 1/1 · gmn-redis 1/1 · worker 0/0 (desligado de propósito)
docker stack ps gmn --no-trunc                    # sem tarefas em Failed/Rejected
docker service ls                                 # TODOS os serviços antigos inalterados (traefik, n8n, evolution, portainer, postgres, vra)
docker service logs --tail 50 gmn_gmn-web             # "[gmn-entrypoint] papel=web ok" e Next "Ready"
docker service logs --tail 20 gmn_gmn-redis
```
## 2. Rede e portas
```bash
docker service inspect gmn_gmn-web --format '{{json .Endpoint.Ports}}'        # sem portas publicadas
docker service inspect gmn_gmn-redis --format '{{json .Endpoint.Ports}}'
docker service inspect gmn_gmn-web --format '{{json .Spec.TaskTemplate.Networks}}'     # gmn_gmn_internal + automacao...
docker service inspect gmn_gmn-redis --format '{{json .Spec.TaskTemplate.Networks}}' # só gmn_gmn_internal
ss -ltn | grep -E ':(3000|6379)\b' || echo "3000/6379 não escutam no host"
```
## 3. Labels do Traefik (na stack, em `deploy.labels`)
```bash
docker service inspect gmn_gmn-web --format '{{json .Spec.Labels}}' | tr ',' '\n' | grep traefik
```
Esperado: `traefik.swarm.network=automacaotrafegopagoredeinterna` (provider Swarm do Traefik 3.5; não há labels `traefik.docker.*`), router `gmn` com `Host(HOST)`, `websecure`, `certresolver=letsencryptresolver`, porta 3000.
## 4. HTTPS, redirecionamento e cabeçalhos
```bash
dig +short HOST                                   # IP da VPS
curl -sI http://HOST/login | head -5              # 301/308 para https (se o redirecionamento da stack estiver ativo)
curl -sI https://HOST/login | grep -iE '^(HTTP|strict-transport|x-frame|x-content-type|referrer|content-security-policy-report-only)'
echo | openssl s_client -connect HOST:443 -servername HOST 2>/dev/null | openssl x509 -noout -issuer -dates
```
Esperado: `HTTP/2 200`, `strict-transport-security`, `x-frame-options: DENY`, certificado Let's Encrypt válido.
## 5. Autenticação (sem credenciais)
```bash
for p in /api/prospect /api/audit/completed /api/system/health /api/link-audit/evidence; do printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://HOST$p"; done   # todos 401
curl -s -o /dev/null -w '%{http_code}\n' https://HOST/dev/battlefield-preview                                   # 404
# (o teste de Host de loopback é feito dentro do container por `verify-local.sh`: de fora, o Traefik responde 404 a Host desconhecido)
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 1.2.3.4' -H 'X-Forwarded-For: 1.2.3.4' https://HOST/login   # 200
# Depois de logado no navegador, abra https://HOST/api/system/client-address: address = SEU IP público (não 1.2.3.4), shared:false.
# Com cabeçalhos forjados (extensão do navegador ou curl com o cookie) o resultado não pode mudar; xRealIpPresentButIgnored:true é o esperado.
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://HOST/api/auth/login   # 401 (credenciais inválidas)
```
Depois, entrar pelo navegador com um operador da lista; o cookie deve ser `HttpOnly; Secure; SameSite=Strict`.
## 6. Redis exclusivo e fila
```bash
docker exec $(docker ps -q -f name=gmn_gmn-redis) sh -c 'REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli ping'     # PONG
docker exec $(docker ps -q -f name=gmn_gmn-redis) sh -c 'REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli dbsize'  # só chaves da GMN
```
O Redis não responde de fora: `redis-cli -h IP_DA_VPS -p 6379 ping` deve falhar.
## 7. Dados
```bash
sudo ls -ld /srv/gmn/* ; sudo stat -c '%U:%G %a %n' /srv/gmn/*     # 10001:10001 700 (redis 999:1000)
docker exec $(docker ps -q -f name=gmn_gmn-web) sh -c 'ls /data/evidence; touch /data/evidence/x 2>&1 | head -1'   # leitura ok; escrita negada (ro)
```
Na interface: `/auditoria-por-link` lista `tuvaplast-20261022-maps01` com integridade OK.
## 8. Saúde da aplicação (logado)
`/api/system/health` (com sessão): Redis OK, Supabase OK, Worker "sem batimento" (esperado enquanto `replicas: 0`).
## 9. Custos
Nenhuma auditoria deve estar `RUNNING`; confirme no painel do Serper que o consumo não mudou desde o deploy.
