#!/bin/sh
# MODELO do wrapper do comando forçado da chave de manifestos de PRODUÇÃO (usuário gmn-seals).
# Spec docs/specs/ci-deploy-and-seal-delivery.md §5.7 ("Instalação" e "Implementação (P9.3b)"); instalação: RUNBOOK-DEPLOY-PELO-CI.md, H-04.
# Só marcadores (<…>): o responsável instala uma cópia PREENCHIDA em /opt/gmn-receivers/bin/gmn-seals (root:root, 0755), aponta para ela o
# `command=` do authorized_keys e o `ForceCommand` do sshd, e nunca versiona a cópia preenchida. <RAIZ_MANIFESTOS> = o valor de
# GMN_RAIZ_DADOS_MANIFESTOS de produção (GUIA-DE-IMPLANTACAO.md §3.3). Com qualquer marcador sem preencher, o wrapper falha fechado
# (E_ARTIFACT ou E_INTERNAL). O que ele faz, a cada execução:
#  1. confere o sha256 do artefato instalado contra o fixado aqui (o de deploy/hostinger/receivers.sha256 no commit); diferente ou ilegível ⇒
#     `ERRO E_ARTIFACT` no stderr e saída 17, sem rodar o Node. Node, flock ou arquivo de trava ausentes ⇒ `ERRO E_INTERNAL` e saída 29
#     (nunca um caminho na saída);
#  2. trava EXCLUSIVA do ambiente pelo kernel: `flock -n` no arquivo de trava do root, numa pasta do root que o usuário do receptor não
#     grava (/var/lib/gmn-receivers-locks/<amb>/, H-06), segurado pelo descritor durante toda a
#     execução (o filho herda o descritor; morte do processo solta a trava sozinha). Outra execução com a trava ⇒ `ERRO E_LOCKED`, saída 16;
#  3. `umask 027`: as pastas novas nascem 2750 e herdam o grupo 10001 pelo setgid da pasta de manifestos; o 0444 do manifesto é explícito;
#  4. limpa o ambiente (`env -i`) e repassa só o PATH fixo e o comando pedido pelo CI (SSH_ORIGINAL_COMMAND, que o receptor confere pela
#     gramática fechada; nunca interpretado por este shell);
#  5. roda o Node 22 fixado, por caminho absoluto, sob o modelo de permissões (`--permission`, um grant por caminho: o Node 20.7+ não aceita
#     a vírgula), com exatamente os grants do §5.7: leitura da pasta de manifestos, da lista INSTALADA e do próprio artefato; escrita na pasta de
#     manifestos, na pasta da trava de defesa e na pasta do log. Nenhum `--allow-child-process`, `--allow-worker`, `--allow-addons` ou
#     `--allow-wasi`. A linha 22 é obrigatória: do 24.22 em diante o fsync é bloqueado sob `--permission` (a gravação recusaria, E_WRITE_FAILED).
#     Os parâmetros fixos do ambiente vêm daqui, nunca do CI.
set -eu
# nenhuma variável do carregador dinâmico chega aos programas que este wrapper roda (sha256sum, grep, env): elas carregariam código ou
# escreveriam no stderr público antes do `env -i` (revisão do PR #72, item 5)
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE LD_PROFILE_OUTPUT
ARTIFACT='/opt/gmn-receivers/<VERSAO>/gmn-seal-receiver.cjs'
ARTIFACT_SHA256='<SHA256_DO_ARTEFATO>'
NODE='/opt/gmn-receivers/node/bin/node'
FLOCK='/usr/bin/flock'
LOCK='/var/lib/gmn-receivers-locks/producao/seals.flock'
SEALS_ROOT='<RAIZ_MANIFESTOS>'
TRUST_LIST='/var/lib/gmn-deploy/producao/trust-keys.txt'
NODE_LOCK='/var/lib/gmn-seals/producao/lock'
LOG='/var/log/gmn-receivers/producao-seals.log'
# saída do flock -n quando outra execução tem a trava; nenhum código do receptor (spec §5.8) usa 75
LOCK_BUSY=75

fail() {
  printf '%s\n' "ERRO $1" >&2
  exit "$2"
}

# a única linha de erro do receptor que sai daqui: UMA linha do conjunto fechado (`ERRO E_<CÓDIGO>[ <DETALHE>]`, só maiúsculas, dígitos, `_` e
# `-`; revisão do PR #72, item 5). Qualquer outra coisa no stderr (falha de exec do flock, do env ou do node, aviso, pilha com caminho) vira
# `ERRO E_INTERNAL`: o wrapper nunca ecoa caminho nem texto livre
NL='
'
public_error() {
  case "$1" in '' | *"$NL"*) return 1 ;; esac
  printf '%s\n' "$1" | LC_ALL=C /usr/bin/grep -Eqx 'ERRO E_[A-Z0-9_]+( [A-Z0-9_-]+)?' 2>/dev/null
}

actual="$(/usr/bin/sha256sum -- "$ARTIFACT" 2>/dev/null)" || actual=''
actual="${actual%% *}"
[ "$actual" = "$ARTIFACT_SHA256" ] || fail E_ARTIFACT 17
[ -x "$NODE" ] && [ -x "$FLOCK" ] && [ -f "$LOCK" ] && [ -r "$LOCK" ] || fail E_INTERNAL 29
umask 027
status=0
err=''
# o env -i vem ANTES do flock: o flock e o node nascem com o ambiente limpo. O stdout do receptor (a única linha OK) segue direto pelo
# descritor 3; o stderr do env, do flock e do node é capturado aqui e passa pelo filtro abaixo
{ err="$(/usr/bin/env -i PATH=/usr/bin:/bin "SSH_ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND-}" "$FLOCK" -n -E "$LOCK_BUSY" "$LOCK" "$NODE" --disable-sigusr1 --permission \
  "--allow-fs-read=$SEALS_ROOT" "--allow-fs-read=$TRUST_LIST" "--allow-fs-read=$ARTIFACT" \
  "--allow-fs-write=$SEALS_ROOT" "--allow-fs-write=${NODE_LOCK%/*}" "--allow-fs-write=${LOG%/*}" \
  "$ARTIFACT" --env producao --seals-root "$SEALS_ROOT" --trust-list "$TRUST_LIST" --lock "$NODE_LOCK" --log "$LOG" 2>&1 1>&3 3>&-)" || status=$?; } 3>&1
[ "$status" -ne "$LOCK_BUSY" ] || fail E_LOCKED 16
[ "$status" -ne 0 ] || exit 0
public_error "$err" || fail E_INTERNAL 29
printf '%s\n' "$err" >&2
exit "$status"
