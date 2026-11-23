#!/bin/sh
# MODELO do wrapper do comando forçado da chave de deploy de HOMOLOGAÇÃO (usuário gmn-hml-deploy, stack gmn-hml).
# Spec docs/specs/ci-deploy-and-seal-delivery.md §5.6 ("Instalação" e "Implementação (P9.3a)"), §5.11; instalação: RUNBOOK-DEPLOY-PELO-CI.md, H-04.
# Só marcadores (<…>): o responsável instala uma cópia PREENCHIDA em /opt/gmn-receivers/bin/gmn-hml-deploy (root:root, 0755), aponta para ela o
# `command=` do authorized_keys e o `ForceCommand` do sshd, e nunca versiona a cópia preenchida. Com qualquer marcador sem preencher, o wrapper
# falha fechado (E_ARTIFACT ou E_INTERNAL). <IMPRESSAO_SUPABASE_PRODUCAO> = os 12 primeiros hex do sha256 dos bytes da URL do projeto Supabase de
# PRODUÇÃO, sem quebra de linha (H-04): o receptor de homologação recusa esse projeto (E_HML_PRODUCTION_PROJECT). O que ele faz, a cada execução:
#  1. confere o sha256 do artefato instalado contra o fixado aqui (o de deploy/hostinger/receivers.sha256 no commit); diferente ou ilegível ⇒
#     `ERRO E_ARTIFACT` no stderr e saída 17, sem rodar o Node;
#  2. limpa o ambiente (`env -i`) e repassa só o PATH fixo e o comando pedido pelo CI (SSH_ORIGINAL_COMMAND, que o receptor confere pela
#     gramática fechada; nunca interpretado por este shell);
#  3. roda o Node 22 fixado, por caminho absoluto, com os parâmetros FIXOS do ambiente (nada vem do CI).
set -eu
ARTIFACT='/opt/gmn-receivers/<VERSAO>/gmn-deploy-receiver.cjs'
ARTIFACT_SHA256='<SHA256_DO_ARTEFATO>'
NODE='/opt/gmn-receivers/node/bin/node'

actual="$(/usr/bin/sha256sum -- "$ARTIFACT" 2>/dev/null)" || actual=''
actual="${actual%% *}"
if [ "$actual" != "$ARTIFACT_SHA256" ]; then
  printf '%s\n' 'ERRO E_ARTIFACT' >&2
  exit 17
fi
exec /usr/bin/env -i PATH=/usr/bin:/bin "SSH_ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND-}" "$NODE" --disable-sigusr1 "$ARTIFACT" \
  --env homologacao --stack-name gmn-hml --stack /opt/gmn-hml/stack.yml --overlay /opt/gmn-hml/stack-hml.yml \
  --host-vars '/opt/gmn-hml/<ARQUIVO_DE_VARIAVEIS>' --data-prefix /srv/gmn-hml/ --forbid-supabase '<IMPRESSAO_SUPABASE_PRODUCAO>' \
  --folders-check /opt/gmn-hml/verificar-pastas-fase6.sh --state /var/lib/gmn-deploy/homologacao --log /var/log/gmn-receivers/homologacao-deploy.log
