# Roteiro H1 — implantação supervisionada da GMN na VPS Hostinger

**Regras do roteiro**
- Execute **um bloco por vez** e cole a saída (sem segredos) para conferência antes do próximo. Cada bloco diz o que esperar e quando **PARAR**.
- A **P0** roda só na sua máquina. A **P1** é leitura: não altera nenhum serviço; só cria a pasta nova `/opt/gmn` com as "fotos do antes" (P1.3). A primeira alteração de verdade é a **P2** (cria só recursos novos da GMN) e exige o seu "pode seguir".
- Se você já é `root` no terminal da Hostinger, omita o `sudo`.
- **Proibido neste roteiro:** `docker system prune`, `docker volume prune`, `docker stack rm`, qualquer alteração em Traefik, n8n, Evolution, Portainer, PostgreSQL, VRA Worker ou na rede `automacaotrafegopagoredeinterna`.
- O Worker permanece com **0 réplicas**. Nenhum passo consome Serper.
- Nunca cole no chat: chaves, senhas, `.env.local`, saída de `docker service inspect` completa (pode ter variáveis), nem `docker secret` (não são legíveis mesmo).

---
## P0 — Na sua máquina (WSL), antes de tocar a VPS

### P0.1 Provar o estado do código e das imagens
```bash
cd /mnt/d/gmn-intelligence-platform-corrigido/gmn-intelligence-platform
npm run typecheck && npm test 2>&1 | grep -E '^# (tests|pass|fail)'      # fail 0
deploy/hostinger/verify-local.sh 2>&1 | tail -3                          # TUDO OK  (usa valores fictícios, sem rede externa)
```
**PARAR** se algo falhar.

### P0.2 Construir as imagens de produção (valores PÚBLICOS do Supabase; nunca a service role)
```bash
cd /mnt/d/gmn-intelligence-platform-corrigido/gmn-intelligence-platform
export NEXT_PUBLIC_SUPABASE_URL="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- | tr -d "\"' \r")"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2- | tr -d "\"' \r")"
echo "URL=${NEXT_PUBLIC_SUPABASE_URL}  anon=$([ -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ] && echo definida || echo VAZIA)"
deploy/hostinger/build-images.sh 1.0.0
```
(O comando só **lê** duas linhas públicas de `.env.local`; não escreve nada nele.) Anote os dois `id=` e o SHA-256 do pacote impressos no fim. **PARAR** se a anon estiver `VAZIA`.

### P0.3 Provar que nenhum segredo entrou nas imagens
```bash
docker history --no-trunc gmn-web:1.0.0 gmn-worker:1.0.0 | grep -iE 'service_role|SERPER|REDIS_URL|password|secret' || echo "histórico limpo"
docker run --rm --entrypoint sh gmn-web:1.0.0 -c 'ls -a /app | grep -E "^\.env" || echo "sem .env na imagem"'
```
Esperado: `histórico limpo` e `sem .env na imagem`.

### P0.4 Pacote de evidências e backup independente (antes de copiar para a VPS)
```bash
cd /mnt/d/gmn-evidencias-privadas/link-audit/tuvaplast-20261022-maps01
sha256sum -c SHA256SUMS | grep -vc ': OK$'                               # 0  (nenhuma linha fora de OK)
find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum   # ANOTE este hash agregado
mkdir -p /mnt/d/gmn-backups/tuvaplast-20261024 && rsync -a --checksum ./ /mnt/d/gmn-backups/tuvaplast-20261024/
cd /mnt/d/gmn-backups/tuvaplast-20261024 && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum   # igual ao anterior
```
O original **não é alterado**. **PARAR** se os dois hashes divergirem.

---
## P1 — VPS, SOMENTE LEITURA (nada é criado ou alterado)

### P1.1 Identidade e Swarm
```bash
hostname; whoami; lsb_release -ds; docker version --format '{{.Server.Version}}'
docker info --format 'swarm={{.Swarm.LocalNodeState}} manager={{.Swarm.ControlAvailable}} nodeID={{.Swarm.NodeID}}'
docker node ls
```
Esperado: `swarm=active manager=true`, Docker 29.x. Anote o **HOSTNAME do nó** (vai em `GMN_NODE_HOSTNAME`). **PARAR** se `manager=false` ou houver mais de um nó (precisamos fixar o nó dos dados).

### P1.2 Recursos livres (a GMN reserva até ~2,5 GB de RAM e ~2,5 vCPU de limite)
```bash
free -h; nproc; df -h / /srv 2>/dev/null; docker system df
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | head -20
```
Esperado: ≥ 3 GB de RAM disponível e ≥ 10 GB livres em disco. **PARAR** se a memória disponível for menor que 3 GB (risco para n8n/Evolution/PostgreSQL).

### P1.3 Estado atual (foto "antes" — usada para provar que nada mudou)
```bash
mkdir -p /opt/gmn && docker service ls > /opt/gmn/antes-services.txt && docker network ls > /opt/gmn/antes-networks.txt && docker secret ls > /opt/gmn/antes-secrets.txt
docker service ls --format '{{.Name}}  {{.Image}}  {{.Replicas}}' | tee /opt/gmn/antes-resumo.txt
sha256sum /opt/gmn/antes-*.txt
```
Esperado: n8n, Evolution, Portainer, PostgreSQL, VRA Worker e Redis(VRA) todos com réplicas completas. **PARAR** se algum já estiver degradado (resolver antes).

### P1.4 Rede externa e conflitos de nome
```bash
docker network ls --filter name=automacaotrafegopagoredeinterna --format '{{.Name}} {{.Driver}} {{.Scope}}'
docker network inspect automacaotrafegopagoredeinterna --format 'attachable={{.Attachable}} internal={{.Internal}} subnet={{range .IPAM.Config}}{{.Subnet}}{{end}}'
docker service ls --format '{{.Name}}' | grep -E '^gmn' || echo "nenhum serviço gmn existente"
docker secret ls --format '{{.Name}}' | grep -E '^gmn_' || echo "nenhum secret gmn_ existente"
```
Esperado: `overlay swarm`, nenhum serviço/secret `gmn` pré-existente. **PARAR** se a rede não existir ou se já houver `gmn*`.

### P1.5 Traefik (versão, provider, entrypoints, resolver) — sem imprimir variáveis de ambiente
```bash
docker service ls --format '{{.Name}}  {{.Image}}' | grep -i traefik
T="$(docker service ls --format '{{.Name}}' | grep -i traefik | head -1)"; echo "serviço: $T"
docker service inspect "$T" --format '{{json .Spec.TaskTemplate.ContainerSpec.Args}}' | tr ',' '\n' | tr -d '[]"' | grep -E 'providers|entrypoints|certificatesresolvers|forwarded|trusted|constraints|exposedbydefault|acme' | sed -E 's/(token|secret|key)=.*/\1=***/I'
docker service inspect "$T" --format '{{json .Endpoint.Spec.Ports}}'
```
Confira e me envie:
1. versão `traefik:v3.5.3`;
2. **provider**: precisa existir `--providers.swarm...` (a label `traefik.swarm.network` só vale com o provider Swarm). Se aparecer `--providers.docker`, **PARAR** e me avisar (a label certa muda);
3. nome do **entrypoint de 80** (`--entrypoints.NOME.address=:80`) → vai em `GMN_HTTP_ENTRYPOINT`; e do de 443 (esperado `websecure`);
4. resolver `letsencryptresolver` e o **tipo de desafio** (`httpchallenge` / `tlschallenge` / `dnschallenge`);
5. `exposedbydefault`/`constraints` (a stack já usa `traefik.enable=true`; se houver `constraints`, as labels precisam combinar);
6. `forwardedHeaders.insecure`/`trustedIPs` (se existirem, **PARAR**: o IP do cliente poderia ser forjado);
7. **modo das portas 80/443**: `PublishMode` `host` ou `ingress`. Em `ingress` o app tende a ver um IP interno (a stack já trata isso com balde global de login; ver CHECKLIST).

### P1.6 DNS do domínio (nenhum registro é criado por este roteiro)
```bash
IPV4="$(curl -4 -s --max-time 8 https://ifconfig.me || hostname -I | awk '{print $1}')"; echo "IP da VPS: $IPV4"
for R in 1.1.1.1 8.8.8.8; do echo "== $R"; dig +short A gmn.somosvra.com.br @$R; dig +short AAAA gmn.somosvra.com.br @$R; dig +short CNAME gmn.somosvra.com.br @$R; done
dig +short CAA somosvra.com.br
```
Esperado: o registro **A de `gmn.somosvra.com.br` = IP da VPS** nos dois resolvedores; sem AAAA (ou AAAA que também aponte para a VPS); sem CNAME para outro lugar; CAA vazio ou que permita `letsencrypt.org`. **PARAR — não solicitar certificado** se o A não aparecer: crie o registro **somente `gmn`** no painel DNS (não altere os demais), aguarde propagar e repita este bloco.

### P1.7 Portas já em uso
```bash
ss -ltnp 2>/dev/null | awk 'NR==1 || /:(80|443|3000|6379)\b/'
```
Esperado: 80/443 do Traefik; **3000 e 6379 livres no host** (a GMN não publica portas).

> Fim da P1. Envie as saídas (P1.1–P1.7). Eu confirmo o `GMN_NODE_HOSTNAME`, o `GMN_HTTP_ENTRYPOINT` e a decisão sobre o IP real e digo "pode seguir para a P2".

---
## P2 — Preparar a VPS (cria **somente** recursos novos da GMN) — **exige o seu "pode seguir"**

### P2.1 Transferir e conferir as imagens (da sua máquina)
```bash
cd /mnt/d/gmn-intelligence-platform-corrigido/gmn-intelligence-platform/deploy/hostinger
cat dist/gmn-images-1.0.0.tar.gz.sha256                                  # compare com o hash anotado no P0.2
scp dist/gmn-images-1.0.0.tar.gz dist/gmn-images-1.0.0.tar.gz.sha256 USUARIO@IP_DA_VPS:/opt/gmn/
```
Na VPS:
```bash
cd /opt/gmn && sha256sum -c gmn-images-1.0.0.tar.gz.sha256               # gmn-images-1.0.0.tar.gz: OK
```
**PARAR** se não disser `OK`.

### P2.2 Carregar as imagens (não substitui nada: tags novas `gmn-web`/`gmn-worker`)
```bash
gunzip -c /opt/gmn/gmn-images-1.0.0.tar.gz | docker load
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^gmn-'
```
Compare os IDs com os anotados no P0.2 (o ID curto é o início do `id=sha256:...`).

### P2.3 Diretórios privados dos dados
```bash
docker run --rm redis:7.4.11-alpine id redis                              # esperado uid=999 gid=1000 (ajuste o install se for outro)
install -d -m 0755 -o root -g root /srv/gmn /opt/gmn
install -d -m 0700 -o 10001 -g 10001 /srv/gmn/audits /srv/gmn/link-audits /srv/gmn/evidence
install -d -m 0700 -o 999 -g 1000 /srv/gmn/redis
ls -ld /srv/gmn /srv/gmn/*
```

### P2.4 Segredos (digitados na hora; ficam no Swarm; nada em arquivo)
```bash
read -rsp 'SUPABASE service role: ' V; echo; printf %s "$V" | docker secret create gmn_supabase_service_role -; unset V
read -rsp 'SUPABASE anon key: '     V; echo; printf %s "$V" | docker secret create gmn_supabase_anon -; unset V
read -rsp 'SERPER api key: '        V; echo; printf %s "$V" | docker secret create gmn_serper_api_key -; unset V
REDIS_PW="$(openssl rand -hex 32)"
printf %s "$REDIS_PW" | docker secret create gmn_redis_password -
printf %s "redis://:${REDIS_PW}@gmn-redis:6379/0" | docker secret create gmn_redis_url -
printf 'requirepass %s\n' "$REDIS_PW" | docker secret create gmn_redis_conf -; unset REDIS_PW
docker secret ls --format '{{.Name}}' | grep '^gmn_' | sort
```
Esperado: 6 nomes. Guarde os valores num gerenciador de senhas (o Swarm não devolve). O Serper fica **configurado, mas sem uso** (Worker em 0 réplicas).

### P2.5 Arquivos da stack
Da sua máquina:
```bash
cd /mnt/d/gmn-intelligence-platform-corrigido/gmn-intelligence-platform/deploy/hostinger
sha256sum stack.yml .env.production.example
scp stack.yml .env.production.example USUARIO@IP_DA_VPS:/opt/gmn/
```
Na VPS:
```bash
cd /opt/gmn && sha256sum stack.yml .env.production.example               # iguais aos de cima
install -m 0600 .env.production.example .env.production && rm .env.production.example
nano .env.production    # GMN_HOST=gmn.somosvra.com.br  GMN_IMAGE_TAG=1.0.0  GMN_NODE_HOSTNAME=<P1.1>  NEXT_PUBLIC_SUPABASE_URL=<público>  GMN_OPERATOR_EMAILS=<operadores>  GMN_HTTP_ENTRYPOINT=<P1.5>  GMN_WORKER_REPLICAS=0
```
**GMN_WORKER_REPLICAS deve ficar 0.** Sem nenhuma chave neste arquivo.

### P2.6 Renderizar e revisar (nada é criado)
```bash
cd /opt/gmn && set -a && . ./.env.production && set +a
docker stack config -c stack.yml > /opt/gmn/stack.rendered.yml && echo "renderizou"
grep -nE 'replicas|image:|published|ports:|automacaotrafegopagoredeinterna|traefik\.(swarm|docker)\.network|constraints|node.hostname' stack.rendered.yml
```
Confira: `gmn-worker` com `replicas: 0`; **nenhum** `ports:`/`published`; `traefik.swarm.network=automacaotrafegopagoredeinterna`; rede externa só no `gmn-web`; imagens `gmn-web:1.0.0`/`gmn-worker:1.0.0`; sem valores secretos na saída. `stack.rendered.yml` pode ser enviado a mim.

### P2.7 Lista de conferência antes de criar serviços (responda "ok" a cada)
- [ ] Swarm manager (P1.1) · [ ] rede externa existe (P1.4) · [ ] RAM/disco (P1.2) · [ ] `stack config` ok (P2.6)
- [ ] imagens carregadas e IDs conferidos (P2.2) · [ ] 6 secrets (P2.4) · [ ] diretórios (P2.3)
- [ ] DNS do domínio aponta para a VPS (P1.6) · [ ] backup do TUVAPLAST verificado (P0.4)
- [ ] rollback lido (`PLANO-DE-ROLLBACK.md`): reverter = `docker service scale gmn_gmn-web=0 gmn_gmn-worker=0`; dados nunca são apagados
- [ ] Worker em 0 e você ciente de que **não se deve enfileirar auditorias** enquanto estiver em 0

---
## P3 — Publicar (**só após o "pode seguir" da P2.7**)

```bash
cd /opt/gmn && set -a && . ./.env.production && set +a
docker stack deploy --resolve-image never -c stack.yml gmn
sleep 45
docker stack services gmn
docker service ls | diff - /opt/gmn/antes-services.txt || true            # só devem aparecer as linhas novas gmn_*
```
Esperado: `gmn_gmn-web 1/1`, `gmn_gmn-redis 1/1`, `gmn_gmn-worker 0/0`. Os demais serviços **idênticos** ao "antes". **Rollback imediato** se qualquer serviço antigo mudar: `docker service scale gmn_gmn-web=0`.

Acompanhe o web:
```bash
docker service ps gmn_gmn-web --no-trunc | head -5
docker service logs --tail 30 gmn_gmn-web 2>&1 | grep -viE 'key|secret|token'
```

---
## P4 — Verificação (somente leitura + o login real)
Siga `VERIFICACAO-POS-DEPLOY.md` (seções 1–8) e `CHECKLIST-DE-SEGURANCA.md`. Os blocos principais:

```bash
H=gmn.somosvra.com.br
curl -sI https://$H/login | grep -iE '^(HTTP|strict-transport|x-frame|content-security-policy-report-only)'
curl -sI http://$H/login | head -3                                          # redireciona para https
for p in /api/prospect /api/audit/completed /api/system/health /api/link-audit/evidence /api/system/client-address; do printf '%s -> ' $p; curl -s -o /dev/null -w '%{http_code}\n' https://$H$p; done   # todos 401
curl -s -o /dev/null -w '%{http_code}\n' https://$H/dev/battlefield-preview   # 404
ss -ltn | grep -E ':(3000|6379)\b' || echo "3000/6379 não escutam no host"
docker service ls | diff - /opt/gmn/antes-services.txt                      # só gmn_* a mais
```
No navegador: entrar com um operador real; conferir cookie `HttpOnly; Secure; SameSite=Strict`; abrir `https://gmn.somosvra.com.br/api/system/client-address` (deve mostrar o **seu** IP público, `shared:false`, e ignorar cabeçalhos forjados).

### P4.1 Migrar as evidências da TUVAPLAST
Siga `PLANO-DE-MIGRACAO-DE-EVIDENCIAS.md` (rsync com `--checksum`, conferência SHA-256 nos dois lados, hash agregado igual ao do P0.4). Depois, em "Auditoria por Link → Auditorias armazenadas", `tuvaplast-20261022-maps01` deve aparecer com integridade OK.

### P4.2 Nenhum Worker, nenhum crédito
```bash
docker service ps gmn_gmn-worker | head -3                                  # nenhuma tarefa em execução
docker service logs gmn_gmn-worker 2>&1 | wc -l                             # 0
```
No painel do Serper: saldo igual ao anterior ao deploy (anote o saldo no início da P2.4).

---
## P5 — Relatório
Preencha `RELATORIO-DE-IMPLANTACAO.md` (modelo nesta pasta) com as saídas desta execução; ele inclui o plano de rollback aplicável.
