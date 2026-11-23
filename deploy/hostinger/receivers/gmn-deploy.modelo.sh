#!/bin/sh
# MODELO do wrapper do comando forçado da chave de deploy de PRODUÇÃO (usuário gmn-deploy).
# Spec docs/specs/ci-deploy-and-seal-delivery.md §5.6 ("Instalação" e "Implementação (P9.3a)"); instalação: RUNBOOK-DEPLOY-PELO-CI.md, H-04.
# Só marcadores (<…>): o responsável instala uma cópia PREENCHIDA em /opt/gmn-receivers/bin/gmn-deploy (root:root, 0755), aponta para ela o
# `command=` do authorized_keys e o `ForceCommand` do sshd, e nunca versiona a cópia preenchida. Com qualquer marcador sem preencher, o wrapper
# falha fechado (E_ARTIFACT ou E_INTERNAL). O que ele faz, a cada execução:
#  1. confere o sha256 do artefato instalado contra o fixado aqui (o de deploy/hostinger/receivers.sha256 no commit); diferente ou ilegível ⇒
#     `ERRO E_ARTIFACT` no stderr e saída 17, sem rodar o Node. Node, flock ou arquivo de trava ausentes ⇒ `ERRO E_INTERNAL` e saída 29
#     (nunca um caminho na saída);
#  2. trava EXCLUSIVA do ambiente pelo kernel: `flock -n` no arquivo de trava do root (H-06), segurado pelo descritor durante toda a
#     execução (o filho herda o descritor; morte do processo solta a trava sozinha). Outra execução com a trava ⇒ `ERRO E_LOCKED`, saída 16;
#  3. limpa o ambiente (`env -i`) e repassa só o PATH fixo e o comando pedido pelo CI (SSH_ORIGINAL_COMMAND, que o receptor confere pela
#     gramática fechada; nunca interpretado por este shell);
#  4. roda o Node 22 fixado, por caminho absoluto, com os parâmetros FIXOS do ambiente (nada vem do CI).
set -eu
ARTIFACT='/opt/gmn-receivers/<VERSAO>/gmn-deploy-receiver.cjs'
ARTIFACT_SHA256='<SHA256_DO_ARTEFATO>'
NODE='/opt/gmn-receivers/node/bin/node'
FLOCK='/usr/bin/flock'
LOCK='/var/lib/gmn-deploy/producao/deploy.flock'
# saída do flock -n quando outra execução tem a trava; nenhum código do receptor (spec §5.8) usa 75
LOCK_BUSY=75

fail() {
  printf '%s\n' "ERRO $1" >&2
  exit "$2"
}

actual="$(/usr/bin/sha256sum -- "$ARTIFACT" 2>/dev/null)" || actual=''
actual="${actual%% *}"
[ "$actual" = "$ARTIFACT_SHA256" ] || fail E_ARTIFACT 17
[ -x "$NODE" ] && [ -x "$FLOCK" ] && [ -f "$LOCK" ] && [ -r "$LOCK" ] || fail E_INTERNAL 29
status=0
"$FLOCK" -n -E "$LOCK_BUSY" "$LOCK" /usr/bin/env -i PATH=/usr/bin:/bin "SSH_ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND-}" "$NODE" --disable-sigusr1 "$ARTIFACT" \
  --env producao --stack-name gmn --stack /opt/gmn/stack.yml --host-vars '/opt/gmn/<ARQUIVO_DE_VARIAVEIS>' \
  --folders-check /opt/gmn/verificar-pastas-fase6.sh --state /var/lib/gmn-deploy/producao --log /var/log/gmn-receivers/producao-deploy.log || status=$?
[ "$status" -ne "$LOCK_BUSY" ] || fail E_LOCKED 16
exit "$status"
