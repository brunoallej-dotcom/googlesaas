# Runbook do responsável: deploy pelo CI (P-9)

> **Status: PREPARAÇÃO (fatia P9.4, 23/11/2026).** Nada disto foi executado. Este runbook é do **responsável**: nenhum passo é do
> manager ou de um worker (spec `docs/specs/ci-deploy-and-seal-delivery.md` §10.1). Repositório **público**: aqui só há marcadores
> (`<HOST_VPS>`, `<PORTA_SSH>`, `<IP_DA_VPS>`, `<DOMINIO_HML>`, `<DOMINIO_PRODUCAO>`, `<USUARIO_GITHUB>`, `<DONO>/<REPO>`, `<SHA40>`,
> `<ARQUIVO_DE_VARIAVEIS>`, `<PASTA_FORA_DO_REPO>`, `<SEU_USUARIO_SSH>`). Os valores reais ficam no cofre e no dossiê offline, nunca
> em arquivo versionado, issue, PR, chat ou log.
>
> **O que já existe (P9.4):** o workflow `.github/workflows/deploy.yml` (job `deploy`, disparado à mão na `main` e aprovado por você
> no ambiente `homologacao` ou `producao`), os scripts do job em `deploy/ci/`, o `stack.yml` com os nomes do Traefik parametrizados e
> os secrets em sintaxe longa, e a sobreposição de homologação `stack-hml.yml` (stack `gmn-hml`).
>
> **O que ainda não existe:** os **receptores** (deploy na P9.3a; manifestos na P9.3b), com o modelo do *wrapper* e o arquivo
> `deploy/hostinger/receivers.sha256`; e a **entrega de manifestos** pelo CI (jobs `seals-verify` e `seals-deliver`, P9.5). Até a
> P9.5, um dispatch com `acao = entregar-selos` não roda nenhum job. Os passos H-04 e o teste do P9-O03 dependem da P9.3a/P9.3b e
> serão completados por elas.

## 0. Regras que valem em todo o runbook

- **Segredo nunca na linha de comando** (fica em `ps`, no histórico do shell e em logs de sessão): sempre `read -rs` para uma
  variável e dela para o **stdin** do comando (`printf` é embutido do shell, não vira processo), ou para um arquivo `0600` fora do
  repositório, apagado com `shred -u` no fim. Todo bloco que mexe com segredo começa com `set +x`.
- **Segredos do GitHub só de ambiente**, nunca de repositório: se faltar no ambiente, um segredo de repositório com o mesmo nome
  seria usado. `gh secret list` (sem `--env`) não pode listar nenhum dos nomes da tabela do H-03.
- **Deploy de produção só pelo workflow** (`CLAUDE.md`). O caminho manual antigo (`build-images.sh` + `scp` + `docker load` +
  `docker stack deploy`) é histórico e **proibido em produção** (`GUIA-DE-IMPLANTACAO.md` §1–§2).
- **Nada é apagado no host** num incidente ou rollback: manifestos, imagens, stacks, pastas e secrets ficam
  (`PLANO-DE-ROLLBACK.md`).
- **Pré-requisitos de código na `main`:** P9.2 (lista de confiança `link-audit-seals/<amb>/trust-keys.txt` e o check `seals`), P9.3a
  (receptor de deploy) e P9.4 (este runbook). A P9.3b (receptor de manifestos e a regra `2750` da pasta de manifestos no
  `verificar-pastas-fase6.sh`) antes do H-06.

### 0.1 Códigos que o job imprime

O log do Actions é público: o job só imprime `ERRO <CÓDIGO>[ <DETALHE>]`, hashes e campos públicos. O resumo do job traz uma linha
por execução (spec §5.9), que vai para o `RELATORIO-DE-IMPLANTACAO.md` (e, na P9.5, para o livro de manifestos).

| Código | Passo | O que fazer |
|---|---|---|
| `CI_PENDING` / `CI_NOT_GREEN` | 1, CI verde | esperar o `ci.yml` do commit terminar verde (ou corrigir e disparar de novo) |
| `GITHUB_API_FAILED` | 1 | instabilidade da API ou permissão `actions: read` ausente; disparar de novo |
| `NOT_MAIN_HEAD` | 2 e 9 | a `main` andou desde o disparo (ou durante o build): disparar um deploy novo, da cabeça atual |
| `INPUT_INVALID <NOME>` | qualquer | entrada fora do padrão (não deveria acontecer pelo formulário) |
| `CHECKOUT_MISMATCH` | 4 | o checkout não é o SHA do disparo; disparar de novo |
| `BUILD_CONFIG_MISSING` / `BUILD_CONFIG_INVALID <NOME>` | 4 | segredo de build ausente no ambiente, ou a URL não começa com `https://` |
| `BUILD_FAILED <alvo>` / `BUNDLE_FAILED` / `BUNDLE_SIZE_OUT_OF_RANGE` | 4 e 5 | ver o log do build (sem segredo) |
| `HASH_INPUT_MISSING <arquivo>` / `TRUST_LIST_TOO_LARGE` | 6 | arquivo ausente no commit ou lista acima de 8 KiB |
| `SSH_CONFIG_MISSING` / `SSH_CONFIG_INVALID <NOME>` | 7 a 9 | segredo SSH ausente ou fora do formato (H-05, H-09) |
| `SSH_CONNECT_FAILED HOST_KEY` | 8 e 9 | chave de host diferente da fixada: **pare** e confira no console (H-09; pode ser ataque) |
| `SSH_CONNECT_FAILED AUTH` / `OTHER` | 8 e 9 | chave pública ausente no host, `sshd`, porta ou rede (Q-2, aceita em 23/11/2026: porta aberta aos runners, só chave, `fail2ban`) |
| `BUNDLE_MISSING` / `BUNDLE_CHANGED` / `TRUST_LIST_CHANGED` | 8 e 9 | o arquivo mudou entre passos do job: investigar o runner; disparar de novo |
| `E_…` (ex.: `E_STACK_FILE_MISMATCH`) | 8 e 9 | código do receptor (spec §5.8); `E_STACK_FILE_MISMATCH` = instalar a stack do commit (H-08) |
| `RECEIVER_FAILED EXIT_<n>` / `RECEIVER_BAD_OUTPUT` | 8 e 9 | o receptor saiu fora da gramática pública: ler o log local do receptor no host |
| `TRUST_LIST_INSTALLED_MISMATCH` | 9 | a lista instalada não é a enviada: incidente; conferir o log do receptor |
| `EX_CHECK_FAILED EX-0n` / `EX_CONFIG_INVALID` | 10 | `EX-01` `/login` ≠ 200, `EX-02`/`EX-03` ≠ 401: o serviço já foi atualizado; decidir pelo §5 |

## 1. Homologação: ações H-01 a H-10

Ordem sugerida: H-01, H-02, H-03, H-05 (só gerar os pares), H-04, H-05 (host), H-06, H-07, H-08, H-09, H-10 e o primeiro deploy (§2).

### H-01 Recursos da VPS e custo

Confirme, só lendo, que a VPS comporta a segunda pilha (web 1 CPU / 1 GiB, Redis 0,5 CPU / 512 MiB) e que o laboratório Supabase
fica no plano gratuito (D-G0-12; Q-1 confirmada em 23/11/2026). A conferência continua na hora de criar a pilha, e nenhum custo novo
entra sem aprovação própria.

```bash
free -m; nproc; df -h /var/lib/docker /srv
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
```

### H-02 Laboratório Supabase descartável

Crie um projeto Supabase **novo e descartável** (nunca o de produção) e aplique nele a migração `004` pelo roteiro do PG-G08 (spec dos
portões). Anote no cofre a URL, a chave anônima, a `service_role`, a credencial do papel `gmn_guard_writer` e a CA. Nenhum desses
valores pode ser igual a um de produção (P9-O08).

### H-03 Ambiente `homologacao` no GitHub

1. *Settings → Environments → New environment* `homologacao`, **antes** do primeiro disparo. Se o workflow citar um ambiente que não
   existe, o GitHub o cria **sem proteção** (o job falharia por falta de segredos, mas o ambiente ficaria aberto até você
   configurá-lo).
2. *Required reviewers*: `<USUARIO_GITHUB>`. *Prevent self-review*: **desligado** (você dispara e aprova; Q-4 aceita por escrito em 23/11/2026, rever com uma segunda pessoa).
   *Allow administrators to bypass configured protection rules*: **desligado**.
3. *Deployment branches and tags*: *Selected branches and tags*, só `main`.
4. Segredos **do ambiente** (o `GMN_SSH_KNOWN_HOSTS` sai do H-09; as chaves, do H-05):

   | Segredo | Valor de homologação |
   |---|---|
   | `GMN_SSH_HOST` | `<HOST_VPS>`, exatamente o mesmo texto da linha do `known_hosts` |
   | `GMN_SSH_PORT` | só se a porta **não** for 22. Ausente = 22. Um segredo curto como `22` seria mascarado em todo o log (inclusive dentro dos hashes) |
   | `GMN_SSH_KNOWN_HOSTS` | a linha fixada da chave de host (H-09) |
   | `GMN_DEPLOY_SSH_KEY` | chave privada de `gmn-hml-deploy` (H-05) |
   | `GMN_SEALS_SSH_KEY` | chave privada de `gmn-hml-seals` (H-05; usada a partir da P9.5) |
   | `GMN_BUILD_SUPABASE_URL` | URL do **laboratório** (a mesma do `NEXT_PUBLIC_SUPABASE_URL` do arquivo de variáveis de homologação) |
   | `GMN_BUILD_SUPABASE_ANON_KEY` | chave anônima do **laboratório** |
   | `GMN_PUBLIC_HOST` | `<DOMINIO_HML>`, sem `https://` e sem caminho |

   ```bash
   set +x
   read -rsp 'host da VPS: ' V; printf '%s' "$V" | gh secret set GMN_SSH_HOST --env homologacao --repo <DONO>/<REPO>; unset V
   read -rsp 'URL do laboratório: ' V; printf '%s' "$V" | gh secret set GMN_BUILD_SUPABASE_URL --env homologacao --repo <DONO>/<REPO>; unset V
   read -rsp 'anon do laboratório: ' V; printf '%s' "$V" | gh secret set GMN_BUILD_SUPABASE_ANON_KEY --env homologacao --repo <DONO>/<REPO>; unset V
   read -rsp 'domínio de homologação: ' V; printf '%s' "$V" | gh secret set GMN_PUBLIC_HOST --env homologacao --repo <DONO>/<REPO>; unset V
   gh secret list --env homologacao --repo <DONO>/<REPO>     # só os nomes; os valores não voltam
   gh secret list --repo <DONO>/<REPO>                       # nenhum dos nomes acima como segredo de repositório
   ```
5. **P9-O01:** captura da tela de proteção do ambiente (revisor, só `main`, sem contorno) no relatório do ensaio.

### H-04 Node 22.23.2 e receptores no host

O Node dos receptores é o oficial, a mesma versão do `Dockerfile` (`node:22.23.2`), fora de contêiner (Q-3), conferido por
`SHASUMS256.txt`:

```bash
set +x
W="$(mktemp -d)" && cd "$W"
curl -fsSLO https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
grep ' node-v22.23.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -        # precisa dizer: OK
sudo install -d -m 0755 -o root -g root /opt/gmn-receivers /opt/gmn-receivers/node
sudo tar -xJf node-v22.23.2-linux-x64.tar.xz -C /opt/gmn-receivers/node --strip-components=1 --no-same-owner
sudo chown -R root:root /opt/gmn-receivers/node && sudo chmod -R go-w /opt/gmn-receivers/node
/opt/gmn-receivers/node/bin/node --version                                     # v22.23.2
sha256sum /opt/gmn-receivers/node/bin/node                                    # registrar (P9-O04)
cd / && rm -rf -- "$W"
```

Recomendado: conferir também a assinatura do `SHASUMS256.txt` (`SHASUMS256.txt.sig`) com as chaves públicas de release do Node.

**Receptores:** os artefatos `gmn-deploy-receiver.cjs` e `gmn-seal-receiver.cjs`, o hash versionado `deploy/hostinger/receivers.sha256`
e o modelo do *wrapper* (root, `0755`, que confere o sha256 do artefato a cada execução) chegam na **P9.3a** e na **P9.3b**, que
completam este passo. A regra fica: instalar do clone limpo do commit, como root, `0444`, depois de `sha256sum -c` contra o hash
do commit; o CI **nunca** atualiza receptor. Até lá, o `command=` do H-05 aponta para um *wrapper* que ainda não existe, e toda
conexão falha fechada. Os caminhos `/opt/gmn-receivers/bin/gmn-hml-deploy` e `/opt/gmn-receivers/bin/gmn-hml-seals` abaixo são os
sugeridos; use os que a P9.3a/P9.3b fixarem.

### H-05 Usuários, chaves e `sshd`

**Na sua estação**, fora do repositório, um par Ed25519 por usuário e por ambiente, sem frase (o CI usa `BatchMode`):

```bash
umask 077
ssh-keygen -t ed25519 -a 100 -N '' -C gmn-hml-deploy -f <PASTA_FORA_DO_REPO>/gmn-hml-deploy
ssh-keygen -t ed25519 -a 100 -N '' -C gmn-hml-seals -f <PASTA_FORA_DO_REPO>/gmn-hml-seals
gh secret set GMN_DEPLOY_SSH_KEY --env homologacao --repo <DONO>/<REPO> < <PASTA_FORA_DO_REPO>/gmn-hml-deploy
gh secret set GMN_SEALS_SSH_KEY --env homologacao --repo <DONO>/<REPO> < <PASTA_FORA_DO_REPO>/gmn-hml-seals
```

Só os arquivos `.pub` vão para a VPS. As privadas ficam na estação apenas até o teste do P9-O03 (abaixo) e então são apagadas com
`shred -u`; a cópia que vale é a do segredo do ambiente.

**Na VPS** (usuários com shell `/bin/sh`, porque o `sshd` roda o comando forçado pelo shell do usuário; `nologin` o impediria):

```bash
sudo useradd --system --shell /bin/sh --home-dir /nonexistent --no-create-home gmn-hml-deploy
sudo useradd --system --shell /bin/sh --home-dir /nonexistent --no-create-home gmn-hml-seals
sudo usermod -aG docker gmn-hml-deploy                 # só o de deploy; o de manifestos NUNCA no docker nem no sudo
sudo usermod -p '*' gmn-hml-deploy && sudo usermod -p '*' gmn-hml-seals   # sem senha válida, sem conta "travada" para a chave
id gmn-hml-deploy; id gmn-hml-seals
sudo install -d -m 0755 -o root -g root /etc/ssh/authorized_keys
printf 'restrict,command="%s" %s\n' /opt/gmn-receivers/bin/gmn-hml-deploy "$(cat gmn-hml-deploy.pub)" | sudo tee /etc/ssh/authorized_keys/gmn-hml-deploy >/dev/null
printf 'restrict,command="%s" %s\n' /opt/gmn-receivers/bin/gmn-hml-seals "$(cat gmn-hml-seals.pub)" | sudo tee /etc/ssh/authorized_keys/gmn-hml-seals >/dev/null
sudo chown root:root /etc/ssh/authorized_keys/gmn-hml-deploy /etc/ssh/authorized_keys/gmn-hml-seals
sudo chmod 0644 /etc/ssh/authorized_keys/gmn-hml-deploy /etc/ssh/authorized_keys/gmn-hml-seals
```

**Porta SSH (Q-2, aceita):** aberta aos runners do GitHub, que saem de faixas grandes e variáveis, só com chave, sem senha e com
`fail2ban` ativo; só os quatro usuários restritos (dois por ambiente) entram pelo CI.

**`sshd`:** acrescente ao **fim** de `/etc/ssh/sshd_config` (um bloco `Match` no fim do arquivo principal não vaza para o resto da
configuração). Guarde uma cópia antes e mantenha a sessão de root aberta até confirmar o login com o seu usuário numa segunda sessão:

```bash
sudo cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.antes-gmn-p9
sudo tee -a /etc/ssh/sshd_config >/dev/null <<'EOF'

# GMN (P-9): usuários do deploy pelo CI. Chave em pasta do root e um comando forçado por usuário (redundante com o command=).
Match User gmn-hml-deploy
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    ForceCommand /opt/gmn-receivers/bin/gmn-hml-deploy
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
Match User gmn-hml-seals
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    ForceCommand /opt/gmn-receivers/bin/gmn-hml-seals
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
EOF
sudo sshd -t                                                     # sem saída = configuração válida
sudo sshd -T -C user=gmn-hml-deploy,host=teste,addr=127.0.0.1 | grep -Ei '^(forcecommand|authorizedkeysfile|permittty|allowtcpforwarding|passwordauthentication|x11forwarding) '
sudo sshd -T -C user=<SEU_USUARIO_SSH>,host=teste,addr=127.0.0.1 | grep -i '^forcecommand'   # precisa dizer: forcecommand none
sudo systemctl reload ssh
```

**P9-O03** (depois do H-04 completo, com o receptor instalado): da estação, um comando fora da gramática é recusado, e só então as
privadas locais são apagadas.

```bash
ssh -i <PASTA_FORA_DO_REPO>/gmn-hml-deploy -o IdentitiesOnly=yes -p <PORTA_SSH> gmn-hml-deploy@<HOST_VPS> qualquer-coisa   # ERRO E_COMMAND
ssh -i <PASTA_FORA_DO_REPO>/gmn-hml-seals -o IdentitiesOnly=yes -p <PORTA_SSH> gmn-hml-seals@<HOST_VPS> qualquer-coisa     # ERRO E_COMMAND
shred -u <PASTA_FORA_DO_REPO>/gmn-hml-deploy <PASTA_FORA_DO_REPO>/gmn-hml-seals
```

Registre no relatório: `id` dos dois usuários, as duas linhas do `authorized_keys` (só o começo, `restrict,command="…" ssh-ed25519`),
a saída do `sshd -T` e as duas recusas.

### H-06 Pastas de homologação

Tudo sob `/srv/gmn-hml/` (o receptor confere o prefixo, `E_DATA_PREFIX`). Recibos e livro em **dispositivos próprios** por montagem
*loop*: passa no `verificar-pastas-fase6.sh`, mas **não** é independência física (limite declarado da homologação, spec §5.11). As
pastas usadas ficam numa subpasta do sistema de arquivos montado (a raiz dele tem `lost+found`).

```bash
sudo install -d -m 0755 -o root -g root /srv/gmn-hml /opt/gmn-hml
sudo install -d -m 0700 -o 10001 -g 10001 /srv/gmn-hml/audits /srv/gmn-hml/link-audits /srv/gmn-hml/evidence
sudo install -d -m 0700 -o 999 -g 1000 /srv/gmn-hml/redis
sudo install -d -m 0700 -o 10001 -g 10001 /srv/gmn-hml/decisoes /srv/gmn-hml/resultados
sudo install -d -m 0700 -o root -g root /var/lib/gmn-hml-loop
sudo fallocate -l 512M /var/lib/gmn-hml-loop/recibos.img
sudo fallocate -l 512M /var/lib/gmn-hml-loop/livro.img
sudo mkfs.ext4 -q -F /var/lib/gmn-hml-loop/recibos.img
sudo mkfs.ext4 -q -F /var/lib/gmn-hml-loop/livro.img
sudo install -d -m 0755 -o root -g root /srv/gmn-hml/vol-recibos /srv/gmn-hml/vol-livro
printf '%s\n' '/var/lib/gmn-hml-loop/recibos.img /srv/gmn-hml/vol-recibos ext4 loop,nodev,nosuid,noexec 0 2' \
  '/var/lib/gmn-hml-loop/livro.img /srv/gmn-hml/vol-livro ext4 loop,nodev,nosuid,noexec 0 2' | sudo tee -a /etc/fstab >/dev/null
sudo mount /srv/gmn-hml/vol-recibos && sudo mount /srv/gmn-hml/vol-livro
sudo install -d -m 0700 -o 10001 -g 10001 /srv/gmn-hml/vol-recibos/decisoes /srv/gmn-hml/vol-recibos/resultados /srv/gmn-hml/vol-livro/livro
sudo install -d -m 2750 -o gmn-hml-seals -g 10001 /srv/gmn-hml/manifestos       # regra da P9.3b (P9-O05)
stat -c '%U:%g %a %n' /srv/gmn-hml/manifestos                                    # gmn-hml-seals:10001 2750
```

Estado e logs dos receptores (confira com o modelo de *wrapper* da P9.3a/P9.3b):

```bash
sudo install -d -m 0755 -o root -g root /var/lib/gmn-deploy /var/lib/gmn-seals /var/log/gmn-receivers
sudo install -d -m 0711 -o gmn-hml-deploy -g gmn-hml-deploy /var/lib/gmn-deploy/homologacao
sudo install -d -m 0700 -o gmn-hml-seals -g gmn-hml-seals /var/lib/gmn-seals/homologacao
sudo install -m 0600 -o gmn-hml-deploy -g gmn-hml-deploy /dev/null /var/log/gmn-receivers/homologacao-deploy.log
sudo install -m 0600 -o gmn-hml-seals -g gmn-hml-seals /dev/null /var/log/gmn-receivers/homologacao-seals.log
```

A conferência das seis pastas (com o `verificar-pastas-fase6.sh` instalado no H-08, do mesmo commit) roda no fim do H-08.

### H-07 Secrets `gmn-hml_*` no Swarm

Doze secrets, **todos gerados ou obtidos de novo** (nenhum valor igual ao de produção; P9-O08). Guarde cada valor no cofre, pelo
próprio cofre, antes do `unset`. Os ids das chaves HMAC são rótulos públicos próprios de homologação.

```bash
set +x
read -rsp 'service_role do laboratório: ' V; printf %s "$V" | docker secret create gmn-hml_supabase_service_role -; unset V
read -rsp 'anon do laboratório: ' V; printf %s "$V" | docker secret create gmn-hml_supabase_anon -; unset V
printf %s 'homologacao-sem-serper' | docker secret create gmn-hml_serper_api_key -
REDIS_PW="$(openssl rand -hex 32)"
printf %s "$REDIS_PW" | docker secret create gmn-hml_redis_password -
printf %s "redis://:${REDIS_PW}@gmn-redis:6379/0" | docker secret create gmn-hml_redis_url -
printf 'requirepass %s\n' "$REDIS_PW" | docker secret create gmn-hml_redis_conf -; unset REDIS_PW
K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_ORIGEM_HML>' "$K" | docker secret create gmn-hml_link_audit_origin_key -; unset K
K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_LIVRO_HML>' "$K" | docker secret create gmn-hml_link_audit_ledger_key -; unset K
K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_LOG_HML>' "$K" | docker secret create gmn-hml_link_audit_log_key -; unset K
K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_GUARDA_HML>' "$K" | docker secret create gmn-hml_link_audit_guard_key -; unset K
read -rsp 'URL do papel gmn_guard_writer do laboratório: ' V; printf %s "$V" | docker secret create gmn-hml_link_audit_guard_db_url -; unset V
docker secret create gmn-hml_link_audit_guard_db_ca - < <PASTA_FORA_DO_REPO>/ca-do-laboratorio.pem
docker secret ls --format '{{.Name}}' | grep '^gmn-hml_' | sort                 # exatamente os 12 nomes
```

O `gmn-hml_serper_api_key` guarda um texto fixo **não secreto**: a sobreposição desliga o Serper (`SERPER_API_KEY_FILE: ""`), mas a
lista de secrets do serviço não se remove por sobreposição. Formatos e regras das chaves: `PROVA-DE-ORIGEM-E-DE-COLETA.md` §1–§2.

**P9-O08:** registre no relatório do ensaio W5.3, com a data, a lista dos 12 secrets, as duas chaves SSH e os segredos do ambiente,
declarando que todos foram gerados ou obtidos de novo para a homologação.

### H-08 Stack, sobreposição, arquivo de variáveis e DNS

**Arquivos da stack do commit exato**, de um clone limpo (o receptor compara o sha256 dos instalados com o do commit a cada deploy:
`E_STACK_FILE_MISMATCH`). `<SHA40>` é o commit que será implantado (a cabeça da `main`):

```bash
D="$(mktemp -d)"
git clone --quiet https://github.com/<DONO>/<REPO>.git "$D/repo"
git -C "$D/repo" checkout --quiet --detach <SHA40>
git -C "$D/repo" status --porcelain                                              # vazio
sha256sum "$D/repo/deploy/hostinger/stack.yml" "$D/repo/deploy/hostinger/stack-hml.yml" "$D/repo/deploy/hostinger/verificar-pastas-fase6.sh"
sudo install -m 0644 -o root -g root "$D/repo/deploy/hostinger/stack.yml" /opt/gmn-hml/stack.yml
sudo install -m 0644 -o root -g root "$D/repo/deploy/hostinger/stack-hml.yml" /opt/gmn-hml/stack-hml.yml
sudo install -m 0755 -o root -g root "$D/repo/deploy/hostinger/verificar-pastas-fase6.sh" /opt/gmn-hml/verificar-pastas-fase6.sh
sha256sum /opt/gmn-hml/stack.yml /opt/gmn-hml/stack-hml.yml                      # iguais aos do clone (e, depois, aos do resumo do job)
rm -rf -- "$D"
```

Sempre que um commit mudar `stack.yml` ou `stack-hml.yml`, repita este bloco antes do deploy.

**Arquivo de variáveis de homologação** (root:`gmn-hml-deploy`, `0640`, editado só por você; o receptor o lê com um parser estrito e
nunca o executa como shell):

```bash
sudo install -m 0640 -o root -g gmn-hml-deploy /dev/null /opt/gmn-hml/<ARQUIVO_DE_VARIAVEIS>
sudoedit /opt/gmn-hml/<ARQUIVO_DE_VARIAVEIS>
```

Regras (spec §5.6 passo 4): só `NOME=valor`, aspas simples ou duplas **sem** expansão, `#` e linhas vazias; nada de `export`, `$()`
ou `${}`. **Proibidas:** `GMN_IMAGE_TAG` e `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (o receptor define as duas; a lista vem de
`link-audit-seals/homologacao/trust-keys.txt`), `GMN_AUTH_DISABLED`, `GMN_DEMO_MODE`. **Homologação:** `GMN_TRAEFIK_NAME=gmn-hml`
(obrigatória e diferente de `gmn`), `GMN_WORKER_REPLICAS` ausente ou `0`, `GMN_DATA_ROOT` e os seis `GMN_RAIZ_DADOS_*` sob
`/srv/gmn-hml/`. A trava de homologação **não** vai no arquivo: vem da sobreposição. Modelo (só marcadores):

```text
GMN_HOST=<DOMINIO_HML>
GMN_TRAEFIK_NAME=gmn-hml
GMN_NODE_HOSTNAME=<NO_DO_SWARM>
GMN_HTTP_ENTRYPOINT=web
NEXT_PUBLIC_SUPABASE_URL=<URL_DO_LABORATORIO>
GMN_OPERATOR_EMAILS=<OPERADORES_DE_HOMOLOGACAO>
GMN_DATA_ROOT=/srv/gmn-hml
GMN_RAIZ_DADOS_DECISOES=/srv/gmn-hml/decisoes
GMN_RAIZ_DADOS_RECIBOS_DECISOES=/srv/gmn-hml/vol-recibos/decisoes
GMN_RAIZ_DADOS_RESULTADOS=/srv/gmn-hml/resultados
GMN_RAIZ_DADOS_RECIBOS_RESULTADOS=/srv/gmn-hml/vol-recibos/resultados
GMN_RAIZ_DADOS_LIVRO=/srv/gmn-hml/vol-livro/livro
GMN_RAIZ_DADOS_MANIFESTOS=/srv/gmn-hml/manifestos
GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS=
GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS=
GMN_WORKER_REPLICAS=0
```

**Conferência das pastas** (P9-O05; registrar a saída):

```bash
sudo bash /opt/gmn-hml/verificar-pastas-fase6.sh /srv/gmn-hml/decisoes /srv/gmn-hml/vol-recibos/decisoes /srv/gmn-hml/resultados \
  /srv/gmn-hml/vol-recibos/resultados /srv/gmn-hml/vol-livro/livro /srv/gmn-hml/manifestos
```

**P9-H07** (fusão dos dois arquivos no Docker do host): renderize a configuração para um arquivo só do root (ela contém valores do
arquivo de variáveis, como os e-mails dos operadores), confira só as linhas abaixo e apague-o:

```bash
sudo sh -c 'set -a; . /opt/gmn-hml/<ARQUIVO_DE_VARIAVEIS>; set +a; GMN_IMAGE_TAG=homologacao-<SHA40> GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS= docker stack config -c /opt/gmn-hml/stack.yml -c /opt/gmn-hml/stack-hml.yml > /root/gmn-hml-config.yml'
sudo grep -cE '^\s+name: gmn-hml_' /root/gmn-hml-config.yml                    # 12
sudo grep -nE 'GMN_LINK_AUDIT_HOMOLOGATION|SERPER_API_KEY_FILE|replicas:|target: gmn_|routers\.gmn' /root/gmn-hml-config.yml
sudo shred -u /root/gmn-hml-config.yml
```

Esperado: 12 secrets `gmn-hml_*` (externos), `GMN_LINK_AUDIT_HOMOLOGATION: "1"` só no web, Worker com `replicas: 0`, `target: gmn_*`
mantidos e routers `gmn-hml`. **`SERPER_API_KEY_FILE`:** a spec pede `""` no web e no Worker, mas a fusão de dois `-c` do Docker não
sobrescreve uma variável com valor vazio (conferido na P9.4 com o `docker stack config` do Docker CLI 29.10): a linha deve aparecer como
`/run/secrets/gmn_serper_api_key`. Nesse caso, a garantia é o texto fixo **não secreto** do `gmn-hml_serper_api_key` (nenhuma chave
válida do Serper chega à homologação; uma busca por ação do operador falha na autenticação do Serper, sem custo). Registre o que
aparecer e decida antes do ensaio se aceita esse limite ou se pede a correção (por exemplo, a variável do arquivo com padrão no
`stack.yml`, conferida pelo receptor). Se os secrets de topo não fundirem, a alternativa é a da spec §5.11
(`name: ${GMN_SECRET_PREFIX:-gmn}_…` no próprio `stack.yml`).

**DNS:** registro A (e AAAA, se houver) de `<DOMINIO_HML>` para `<IP_DA_VPS>`; conferir com `dig +short <DOMINIO_HML>`.

### H-09 Chave de host fixada (sem TOFU)

Na estação, colete a chave de host; no **console da VPS** (terminal do painel do provedor, não pela mesma conexão SSH), compare a
impressão digital, caractere por caractere:

```bash
ssh-keyscan -p <PORTA_SSH> -t ed25519 <HOST_VPS> 2>/dev/null > <PASTA_FORA_DO_REPO>/known_hosts_gmn
ssh-keygen -lf <PASTA_FORA_DO_REPO>/known_hosts_gmn                            # estação: SHA256:…
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub                                 # console da VPS: o mesmo SHA256:…
gh secret set GMN_SSH_KNOWN_HOSTS --env homologacao --repo <DONO>/<REPO> < <PASTA_FORA_DO_REPO>/known_hosts_gmn
```

Com porta diferente de 22 a linha começa com `[<HOST_VPS>]:<PORTA_SSH>`. O host da linha tem de ser exatamente o `GMN_SSH_HOST`. O
job recusa linhas com marcador (`@cert-authority`, `@revoked`) ou curinga, e nunca aceita chave nova sozinho
(`StrictHostKeyChecking=yes`). A chave de host é a mesma para os dois ambientes (mesma VPS); grave o segredo em cada ambiente.

### H-10 Check obrigatório e CODEOWNERS

1. Na proteção da `main` (*branch protection* ou *ruleset*), acrescente o check obrigatório **`seals (append-only, v2)`** (P9.2) aos
   que já existem.
2. Crie `.github/CODEOWNERS` por PR (é você quem o escreve, com o seu usuário):

   ```text
   /.github/workflows/ @<USUARIO_GITHUB>
   /deploy/hostinger/ @<USUARIO_GITHUB>
   /deploy/ci/ @<USUARIO_GITHUB>
   /link-audit-seals/**/trust-keys.txt @<USUARIO_GITHUB>
   ```
3. *Require review from Code Owners*: com uma só conta no GitHub, o autor do PR não consegue aprovar o próprio PR, e os PRs abertos
   pela mesma conta ficariam travados. Decida e registre: ligar só quando houver uma segunda pessoa (como na Q-4) e, até lá, usar o
   CODEOWNERS como pedido automático de revisão e documentação de quem responde por esses caminhos.
4. **P9-O02:** captura da proteção da `main` e do CODEOWNERS no relatório.

## 2. Primeiro deploy de homologação

Pré-condições: H-01 a H-10 feitos; o commit é a cabeça da `main` e o `ci.yml` dele está verde; o ensaio W5.3 e a G2 nunca ao mesmo
tempo na mesma pilha.

```bash
gh workflow run deploy.yml --repo <DONO>/<REPO> --ref main -f ambiente=homologacao -f acao=deploy
gh run list --repo <DONO>/<REPO> --workflow deploy.yml --limit 1
```

Aprove em *Actions → a execução → Review deployments → homologacao*. O job confere o CI verde e a cabeça da `main`, constrói as duas
imagens com a tag `homologacao-<SHA40>`, envia o pacote (`upload`), confere a cabeça da `main` de novo, chama o `deploy` (o receptor
roda as verificações PD-01 a PD-08) e faz a verificação externa (EX-01 a EX-03). Copie a linha do resumo para o relatório.

**P9-H06** (registrar no relatório do ensaio W5.3, junto do P9-H07):

```bash
docker service inspect gmn-hml_gmn-web --format '{{json .Spec.TaskTemplate.ContainerSpec.Secrets}}' | tr '{' '\n' | grep -oE '"(SecretName|Name)":"[^"]+"'
docker service inspect gmn-hml_gmn-web --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep -E '^(GMN_LINK_AUDIT_HOMOLOGATION|SERPER_API_KEY_FILE)='
docker service ls --filter name=gmn-hml_ --format '{{.Name}} {{.Replicas}}'      # web 1/1, gmn-redis 1/1, worker 0/0
```

Esperado: os secrets com `SecretName` `gmn-hml_*` e `File.Name` `gmn_*` (o caminho `/run/secrets/gmn_*`), a trava `=1` e o
`SERPER_API_KEY_FILE` como registrado no P9-H07. Depois, `VERIFICACAO-POS-DEPLOY.md` inteiro com `STACK=gmn-hml` e `HOST=<DOMINIO_HML>`.

## 3. Produção: o que muda

Antes do primeiro deploy de produção (G3), repita H-03 a H-09 com os nomes de produção, mais:

| Item | Produção |
|---|---|
| Ambiente do GitHub | `producao`, mesma proteção (P9-O01) e segredos próprios: projeto Supabase de **produção**, `GMN_PUBLIC_HOST=<DOMINIO_PRODUCAO>` |
| Usuários | `gmn-deploy` (grupo `docker`) e `gmn-seals` (sem `docker`), pares novos, *wrappers* do ambiente `producao` |
| Arquivos | `/opt/gmn/stack.yml` (sem sobreposição: o `deploy` manda `-`), `/opt/gmn/<ARQUIVO_DE_VARIAVEIS>` root:`gmn-deploy` `0640` |
| Arquivo de variáveis | **sem** `GMN_LINK_AUDIT_HOMOLOGATION` (proibida), sem `GMN_TRAEFIK_NAME` (o padrão `gmn`), sem `GMN_IMAGE_TAG` e sem a lista de confiança; `GMN_WORKER_REPLICAS` igual às réplicas atuais do Worker (`E_WORKER_REPLICAS_DRIFT`) |
| Pastas | as reais (`GUIA-DE-IMPLANTACAO.md` §3.3), com a pasta de manifestos `gmn-seals:10001 2750` (P9-O05) |
| Secrets do Swarm | os `gmn_*` de produção (`GUIA-DE-IMPLANTACAO.md` §3.1 e §3.4) |
| Lista de confiança | `link-audit-seals/producao/trust-keys.txt`, nenhum id `ensaio-` |
| Estado e logs | `/var/lib/gmn-deploy/producao`, `/var/lib/gmn-seals/producao`, `/var/log/gmn-receivers/producao-*.log` |

Ainda para produção: a impressão do projeto de **produção** escrita no *wrapper* de homologação (`--forbid-supabase`), para que a
homologação nunca aponte para ele (`E_HML_PRODUCTION_PROJECT`), calculada sem expor a URL:

```bash
set +x
read -rsp 'URL do Supabase de produção: ' U; printf '%s' "$U" | sha256sum | cut -c1-12; unset U
```

E a autorização escrita da implantação (checklist §0). **P9-O07:** primeiro deploy de produção pelo workflow, `VERIFICACAO-POS-DEPLOY.md`
inteiro com `STACK=gmn` e `HOST=<DOMINIO_PRODUCAO>`, e o primeiro teste de escrita só numa auditoria sintética combinada (P-9). Com
o Worker ligado, faça o deploy com a fila vazia (`GUIA-DE-IMPLANTACAO.md` §7). A entrega de manifestos em produção é só pelo canal
(P9.5, ensaiada na G2, P9-O06); nunca à mão.

## 4. Rotação das chaves SSH

A cada 12 meses (junto da rotação da chave de assinatura, D12) ou na hora, sob suspeita. Sem janela sem acesso:

1. Gere o par novo na estação, fora do repositório (H-05).
2. Acrescente a linha nova (`restrict,command="…" ssh-ed25519 …`) ao `/etc/ssh/authorized_keys/<usuário>`, mantendo a antiga.
3. Troque o segredo do ambiente (`gh secret set … < <PASTA_FORA_DO_REPO>/<arquivo>`), rode um deploy (ou, na P9.5, uma entrega) e
   confira o resumo verde.
4. Remova a linha antiga do `authorized_keys` e apague a privada local com `shred -u`. Registre a data no relatório.

Chave de host da VPS trocada (reinstalação, por exemplo): repita o H-09 nos dois ambientes; até lá o job falha com
`SSH_CONNECT_FAILED HOST_KEY`, que é o comportamento certo.

## 5. Incidente: cortar o acesso do CI

Suspeita de chave vazada, execução estranha no histórico de aprovações ou `TRUST_LIST_INSTALLED_MISMATCH`:

```bash
sudo cp -p /etc/ssh/authorized_keys/gmn-deploy /root/authorized_keys-gmn-deploy.incidente   # evidência
sudo truncate -s 0 /etc/ssh/authorized_keys/gmn-deploy                                    # corta novas conexões na hora
sudo pkill -u gmn-deploy || true                                                           # encerra sessões em andamento
sudo tail -n 50 /var/log/gmn-receivers/producao-deploy.log                                 # o que o receptor recebeu
```

Depois: apague os segredos do ambiente afetado (`gh secret delete GMN_DEPLOY_SSH_KEY --env producao --repo <DONO>/<REPO>`), revise o
histórico de aprovações do ambiente e o log local dos receptores, e gere pares novos (§4) só depois de entender a causa. Troque
`gmn-deploy`/`producao` pelos nomes do usuário e do ambiente afetados (`gmn-seals`, `gmn-hml-deploy`, `gmn-hml-seals`). **Nada é
apagado no host:** manifestos, imagens, stacks, pastas e secrets ficam. A produção continua rodando como está; sem o pipeline, ela
fica parada até ele voltar, porque o deploy manual **não** é opção em produção.

## 6. Rollback

Pela spec §10.3 e pelo `PLANO-DE-ROLLBACK.md`:

- **Da aplicação (normal):** PR com o commit de reversão na `main`, CI verde e deploy pelo workflow. O resultado é uma imagem nova,
  com a tag do commit de reversão.
- **Da aplicação (emergência):** `docker service rollback "${STACK}_gmn-web"` por você, no host, registrado como desvio no
  relatório; depois, o commit de reversão e o deploy normal, para o host voltar a bater com a `main`. **Nunca** para imagem anterior
  ao livro depois do primeiro `ENROLL` (R6-09; o receptor não sabe disso, é regra sua).
- **O Swarm voltou sozinho** (`E_ROLLED_BACK`): o serviço está na especificação anterior e a lista de confiança **não** foi
  instalada; corrija por commit e dispare de novo.
- **Do pipeline:** corte o acesso (§5) e apague os segredos do ambiente. Sem o pipeline, a produção fica parada até ele voltar.
- **Receptor com defeito:** reinstale a versão anterior (hash do commit anterior, `sha256sum -c`); o CI nunca atualiza receptor.

## 7. Onde registrar

| Conferência | Onde |
|---|---|
| P9-O01 ambientes protegidos; P9-O02 check obrigatório e CODEOWNERS | relatório do ensaio W5.3 (homologação) e `RELATORIO-DE-IMPLANTACAO.md` (produção) |
| P9-O03 usuários, `authorized_keys`, `sshd -T` e `E_COMMAND`; P9-O04 `sha256sum -c` de Node e receptores | idem |
| P9-O05 `stat` da pasta de manifestos e saída do `verificar-pastas-fase6.sh` | EN-12 da G2 e linha G-3 do portão |
| P9-O06 entrega pelo canal na G2 | relatório da G2 (P9.5) |
| P9-O07 primeiro deploy de produção; P9-O08 nenhum segredo em comum | `RELATORIO-DE-IMPLANTACAO.md`; relatório do ensaio W5.3 |
| P9-H06 e P9-H07 primeiro deploy de homologação | relatório do ensaio W5.3 |
| Linha do resumo de cada deploy (spec §5.9) | `RELATORIO-DE-IMPLANTACAO.md` (e livro de manifestos, a partir da P9.5) |
