# GMN Intelligence Platform — guia de implantação na VPS Hostinger (Docker Swarm + Traefik)

> **Status: PREPARAÇÃO.** Nada foi executado na VPS. Este guia só deve ser seguido **depois de autorização expressa**. Nenhum passo altera Traefik, n8n, Evolution API, Portainer, PostgreSQL ou o VRA Worker: a GMN é uma stack nova (`gmn`) que apenas **entra** na rede externa já existente (somente o serviço `web`).

## 0. Decisões a confirmar antes de começar
| Item | Padrão desta preparação | Como confirmar (somente leitura) |
|---|---|---|
| Domínio | `<DOMINIO_PRODUCAO>` (provisório; o valor real fica no arquivo de variáveis, `GMN_HOST`) | criar o registro DNS A (e AAAA, se houver) para o IP da VPS e aguardar propagar |
| Nó Swarm | `GMN_NODE_HOSTNAME` | `docker node ls` |
| Rede do Traefik | `automacaotrafegopagoredeinterna` (external) | `docker network ls \| grep automacao` |
| Entrypoint HTTP (porta 80) | `web` | `docker service inspect traefik_traefik --format '{{json .Spec.TaskTemplate.ContainerSpec.Args}}'` (procure `--entrypoints.<nome>.address=:80`) |
| HSTS/redirecionamento global no Traefik | a stack define os seus (host único) | mesma inspeção; se já houver redirecionamento global, o router `gmn-http` pode ficar sem efeito |
| Imagens | `docker save` → `scp` → `docker load` (sem registry) | alternativa: registry **privado** (ver §2.3) |

> **A URL pública do Supabase (`NEXT_PUBLIC_SUPABASE_URL`) é embutida no build** (verificado: 1 arquivo do web); trocá-la exige novas imagens. A **anon key não fica em nenhum arquivo da imagem** (verificado na P0): o web a lê em tempo de execução do secret `gmn_supabase_anon`.

## 1. Construir as imagens (máquina de desenvolvimento, com Docker)
Dentro de `gmn-intelligence-platform/`:
```bash
export NEXT_PUBLIC_SUPABASE_URL='https://SEU-PROJETO.supabase.co'      # valor público
export NEXT_PUBLIC_SUPABASE_ANON_KEY='...chave ANÔNIMA...'            # pública por desenho; NUNCA a service role
deploy/hostinger/build-images.sh 1.0.0
```
- Constrói `gmn-web:1.0.0` (Next.js standalone) e `gmn-worker:1.0.0` (BullMQ + `tsx`), `linux/amd64`, não-root (uid 10001), com `tini`.
- Gera `deploy/hostinger/dist/gmn-images-1.0.0.tar.gz` e `.sha256`. **Guarde o hash e os IDs das imagens** impressos ao final.
- Nada de segredos entra na imagem (`.dockerignore` exclui `.env*`, `.data`, testes e docs; só `NEXT_PUBLIC_*` públicos viram argumento de build).
- Antes de enviar, rode `deploy/hostinger/verify-local.sh` (build + testes dos containers em rede interna, sem custos).

## 2. Transferir as imagens
### 2.1 Enviar e conferir
```bash
scp deploy/hostinger/dist/gmn-images-1.0.0.tar.gz deploy/hostinger/dist/gmn-images-1.0.0.tar.gz.sha256 USUARIO@IP_DA_VPS:/tmp/
ssh USUARIO@IP_DA_VPS 'cd /tmp && sha256sum -c gmn-images-1.0.0.tar.gz.sha256'      # precisa dizer: OK
```
### 2.2 Carregar na VPS
```bash
ssh USUARIO@IP_DA_VPS 'gunzip -c /tmp/gmn-images-1.0.0.tar.gz | docker load && docker image ls | grep "^gmn-"'
```
Compare os IDs com os anotados no build. Apague `/tmp/gmn-images-*` depois.
### 2.3 Alternativa: registry privado
Use um registry **privado** (ex.: GHCR privado ou registry próprio), `docker login` só na VPS com token de leitura, e referencie `image: <registry>/gmn-web@sha256:<digest>` no `stack.yml`. Nunca publique estas imagens em registry público.

## 3. Preparar a VPS (somente recursos novos)
```bash
# conferências somente leitura
docker node ls; docker service ls; docker network ls | grep automacao

# raiz atravessável (0755, root); os dados em subpastas PRIVADAS (0700, uid 10001 = usuário da aplicação).
# Os arquivos de implantação ficam FORA dela (/opt/gmn) para o seu usuário SSH conseguir lê-los.
sudo install -d -m 0755 -o root -g root /srv/gmn /opt/gmn
sudo install -d -m 0700 -o 10001 -g 10001 /srv/gmn/audits /srv/gmn/link-audits /srv/gmn/evidence
docker run --rm redis:7.4.11-alpine id redis                   # confirme uid/gid do Redis (esperado 999:1000)
sudo install -d -m 0700 -o 999 -g 1000 /srv/gmn/redis
```
### 3.1 Segredos (Swarm secrets; nada em arquivo, imagem ou histórico do shell)
```bash
read -rsp 'service role: ' V; printf %s "$V" | docker secret create gmn_supabase_service_role -; unset V
read -rsp 'anon key: '     V; printf %s "$V" | docker secret create gmn_supabase_anon -; unset V
read -rsp 'serper key: '   V; printf %s "$V" | docker secret create gmn_serper_api_key -; unset V
REDIS_PW="$(openssl rand -hex 32)"
printf %s "$REDIS_PW" | docker secret create gmn_redis_password -
printf %s "redis://:${REDIS_PW}@gmn-redis:6379/0" | docker secret create gmn_redis_url -
printf 'requirepass %s\n' "$REDIS_PW" | docker secret create gmn_redis_conf -; unset REDIS_PW
```
A senha é hexadecimal (sem caracteres especiais na URL). O Redis lê a senha de um arquivo de configuração entregue por secret (não aparece na linha de comando nem em `ps`). **Guarde os valores num gerenciador de senhas** (secrets do Swarm não podem ser lidos de volta). `gmn_supabase_service_role` também assina as sessões de login.

### 3.2 Variáveis de implantação
```bash
install -m 0600 deploy/hostinger/.env.production.example /opt/gmn/.env.production   # preencher (sem segredos)
cp deploy/hostinger/stack.yml /opt/gmn/stack.yml
cp deploy/hostinger/verificar-pastas-fase6.sh /opt/gmn/verificar-pastas-fase6.sh   # conferência das pastas da Fase 6 (§3.3)
```

### 3.3 Pastas da Fase 6 no host (antes de implantar a versão da G1.a; ação do responsável)
O `stack.yml` monta seis pastas novas só no web, com origem por marcador **obrigatório** e sem caminho padrão (spec dos portões §5.3,
VC-E1 e VC-E8). Os caminhos reais ficam no arquivo de variáveis da implantação (fora do repositório), nas variáveis
`GMN_RAIZ_DADOS_DECISOES`, `GMN_RAIZ_DADOS_RECIBOS_DECISOES`, `GMN_RAIZ_DADOS_RESULTADOS`, `GMN_RAIZ_DADOS_RECIBOS_RESULTADOS`,
`GMN_RAIZ_DADOS_LIVRO` e `GMN_RAIZ_DADOS_MANIFESTOS`. Regras: **nenhuma pasta dentro de outra** (nem dentro da pasta de evidências; o
código recusa), sistema de arquivos **local** ext4/xfs (sem NFS/SMB), e os **recibos e o livro em disco/volume diferente** dos dados que
ancoram (decisões e resultados).
```bash
cd /opt/gmn && set -a; . ./.env.production; set +a        # carrega só os marcadores; nada é impresso
P6="$GMN_RAIZ_DADOS_DECISOES $GMN_RAIZ_DADOS_RECIBOS_DECISOES $GMN_RAIZ_DADOS_RESULTADOS $GMN_RAIZ_DADOS_RECIBOS_RESULTADOS $GMN_RAIZ_DADOS_LIVRO $GMN_RAIZ_DADOS_MANIFESTOS"
# criar: dono 10001:10001 (usuário da aplicação), modo 0700; o pai de cada uma precisa ser atravessável (0755, root)
for d in $P6; do sudo install -d -m 0700 -o 10001 -g 10001 "$d"; done
# conferir por stat (registrar a saída no relatório da G2, ensaio EN-12, e na linha G-3 do portão): esperado "10001:10001 700 <pasta>"
sudo stat -c '%u:%g %a %n' $P6
# recibos e livro em outro disco que os dados: o número do dispositivo (%d) dos recibos e do livro difere do das decisões e dos resultados
sudo stat -c '%d %n' $P6
# PRÉ-REQUISITO QUE FALHA: seis caminhos distintos (realpath), nenhum dentro de outro, modo 0700, recibos e livro em dispositivos
# independentes. Saída diferente de 0 ⇒ NÃO implantar. Registrar a saída no EN-12 da G2 e na linha G-3 do portão.
sudo bash /opt/gmn/verificar-pastas-fase6.sh "$GMN_RAIZ_DADOS_DECISOES" "$GMN_RAIZ_DADOS_RECIBOS_DECISOES" "$GMN_RAIZ_DADOS_RESULTADOS" \
  "$GMN_RAIZ_DADOS_RECIBOS_RESULTADOS" "$GMN_RAIZ_DADOS_LIVRO" "$GMN_RAIZ_DADOS_MANIFESTOS"
```
- `verificar-pastas-fase6.sh` vem de `deploy/hostinger/` (copiado para `/opt/gmn` junto com o `stack.yml`, §3.2) e só lê; é testado com
  diretórios temporários em `tests/deploy-verificar-pastas.test.ts` (pastas coincidentes, link simbólico, aninhadas, modo e mesmo disco).
- A pasta de manifestos é **só leitura** para o web (`read_only: true` no bind); a escrita é só pelo canal do CI (D15.5), fora da VPS.
- O Worker **não** monta nenhuma delas: conferir depois do deploy com
  `docker service inspect gmn_gmn-worker --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}'` (só a pasta de PDFs).
- Backup de cada uma (destinos independentes): `PLANO-DE-BACKUP-E-RESTAURACAO.md`, seção "Fase 6".

### 3.4 Segredos e variáveis da Fase 6
- **Secrets** (criados sem expor o valor; comandos em `PROVA-DE-ORIGEM-E-DE-COLETA.md` §2): `gmn_link_audit_origin_key`,
  `gmn_link_audit_ledger_key` e `gmn_link_audit_log_key`. Os da guarda (`gmn_link_audit_guard_db_url` e `gmn_link_audit_guard_key`)
  **entram na G1.b**, com o código que os lê, depois da migração da guarda: não fazem parte desta stack nem da ativação da G1.a.
- **Variáveis** no arquivo de variáveis da implantação (sem segredo): os seis marcadores `GMN_RAIZ_DADOS_*` acima e as listas públicas
  `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS`, `GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS` e `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (vazias por
  padrão: nenhum id revogado e atestação fechada).
- **Ordem de ativação:** volumes e chaves (G1.a) ⇒ guarda (G1.b) ⇒ primeiro `ENROLL` (`PROVA-DE-ORIGEM-E-DE-COLETA.md` §3b). O web atualiza com
  `stop-first` (R6-09): cada atualização tem uma breve indisponibilidade, e nunca há dois processos gravando nas pastas. Depois do primeiro
  `ENROLL`, não voltar a uma imagem anterior ao livro; o `failure_action: rollback` automático volta à especificação anterior do serviço,
  então a **primeira** implantação com o livro é validada (503/200 esperados) antes de qualquer `ENROLL`.

## 4. Validar e implantar (**só com autorização**)
```bash
cd /opt/gmn && set -a; . ./.env.production; set +a
docker stack config -c stack.yml > /dev/null              # valida labels, redes, volumes e segredos
docker stack deploy --resolve-image never -c stack.yml gmn
docker stack services gmn                                 # web 1/1, gmn-redis 1/1, worker 0/0 (desligado de propósito)
```
O Worker nasce com `replicas: 0` (variável `GMN_WORKER_REPLICAS`, padrão 0). O Redis e o web sobem; não há processamento. **Atenção:** o web já aceita enfileiramento (`/api/audit/enqueue`) e prospecção (`/api/prospect`, que usa o Serper por ação do operador); enquanto o Worker estiver desligado, não enfileire auditorias — elas seriam consumidas (e cobradas) assim que o Worker for ligado.

## 5. Migrar as evidências já coletadas
Siga `PLANO-DE-MIGRACAO-DE-EVIDENCIAS.md` (cópia verificável por SHA-256; os originais no Windows não são tocados).

## 6. Verificar
Siga `VERIFICACAO-POS-DEPLOY.md` e `CHECKLIST-DE-SEGURANCA.md`.

## 7. Ativar o Worker (somente depois de tudo acima validado)
1. Fila vazia: `docker exec $(docker ps -q -f name=gmn_gmn-redis) sh -c 'REDISCLI_AUTH="$(cat /run/secrets/gmn_redis_password)" redis-cli --scan --pattern "bull:gmn-audit-pipeline:wait" | wc -l'` deve dar `0` (jobs antigos seriam consumidos **na hora**).
2. Nenhuma auditoria `QUEUED` pendente que você não queira executar (Supabase).
3. Saldo e autorização do Serper confirmados (uma auditoria = 49 consultas pagas).
4. Registre `GMN_WORKER_REPLICAS=1` em `/opt/gmn/.env.production` (senão um novo `docker stack deploy` volta a 0 e interrompe a auditoria em andamento), rode `docker service scale gmn_gmn-worker=1` e acompanhe `docker service logs -f gmn_gmn-worker`. Para desligar: `docker service scale gmn_gmn-worker=0` (o encerramento aguarda o job ativo até 30 min).
