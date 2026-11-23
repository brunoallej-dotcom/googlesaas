#!/usr/bin/env bash
# Passo 7 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1) e passo 2 do job `seals-deliver` (§5.5.2): escreve em
# $RUNNER_TEMP/gmn-ssh (pasta 0700, arquivos 0600) a chave privada do PAPEL, a linha fixada da chave de host e uma configuração PRIVADA do ssh
# com o apelido fixo do papel (HostName, Port, User e todas as opções fixas): host, porta e usuário nunca vão à linha de comando. No `deploy`,
# só DEPOIS do build. A limpeza `if: always()` do workflow apaga a pasta. Nada aqui é impresso além de códigos fixos.
# Uso: deploy/ci/ssh-setup.sh deploy|seals (literal fixo do workflow; lib.sh, gmn_ssh_role):
#   deploy: GMN_DEPLOY_SSH_KEY (chave Ed25519 de gmn-deploy / gmn-hml-deploy), apelido `gmn-receiver`, arquivo id_deploy;
#   seals:  GMN_SEALS_SSH_KEY (chave Ed25519 de gmn-seals / gmn-hml-seals), apelido `gmn-seal-receiver`, arquivo id_seals (P9.5).
# Ambiente: GMN_AMB; a chave do papel, GMN_SSH_KNOWN_HOSTS (linha(s) conferidas pelo responsável no console da VPS, ação H-09; sem TOFU),
# GMN_SSH_HOST e GMN_SSH_PORT (opcional, padrão 22), segredos do ambiente.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

# Moldura da chave montada por partes (o texto literal completo dispararia o scanner de segredos do CI).
readonly KEY_HEADER="-----BEGIN OPENSSH PRIVATE"" KEY-----"
readonly KNOWN_HOSTS_MAX_LINES=8
readonly HOST_PATTERN='^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$'
readonly KNOWN_HOSTS_LINE='^[^@*?! ][^*?! ]* (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) [A-Za-z0-9+/]+={0,2}( .*)?$'

gmn_require_amb
gmn_ssh_role "${1:-}"
ssh_user="$GMN_CI_SSH_USER"
ssh_key="${!GMN_CI_SSH_KEY_VAR:-}"
[[ "${GMN_SSH_HOST:-}" =~ $HOST_PATTERN ]] || gmn_fail SSH_CONFIG_INVALID GMN_SSH_HOST
# Porta: segredo opcional. Ausente ou vazio = 22 (um segredo curto como "22" seria mascarado em todo o log, inclusive dentro dos hashes).
ssh_port="${GMN_SSH_PORT:-22}"
if ! [[ "$ssh_port" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$ssh_port" -gt 65535 ]; then gmn_fail SSH_CONFIG_INVALID GMN_SSH_PORT; fi
[ -n "$ssh_key" ] || gmn_fail SSH_CONFIG_MISSING "$GMN_CI_SSH_KEY_VAR"
[ -n "${GMN_SSH_KNOWN_HOSTS:-}" ] || gmn_fail SSH_CONFIG_MISSING GMN_SSH_KNOWN_HOSTS
case "$ssh_key" in
  "$KEY_HEADER"*) ;;
  *) gmn_fail SSH_CONFIG_INVALID "$GMN_CI_SSH_KEY_VAR" ;;
esac

# known_hosts: só linhas "<host> <tipo> <chave base64>", sem marcadores (@cert-authority, @revoked) nem curingas no host.
count=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  count=$((count + 1))
  [[ "$line" =~ $KNOWN_HOSTS_LINE ]] || gmn_fail SSH_CONFIG_INVALID GMN_SSH_KNOWN_HOSTS
done <<<"$GMN_SSH_KNOWN_HOSTS"
if [ "$count" -lt 1 ] || [ "$count" -gt "$KNOWN_HOSTS_MAX_LINES" ]; then gmn_fail SSH_CONFIG_INVALID GMN_SSH_KNOWN_HOSTS; fi

umask 077
rm -rf -- "$GMN_CI_SSH_DIR"
mkdir -m 0700 -- "$GMN_CI_SSH_DIR"
printf '%s\n' "$ssh_key" >"$GMN_CI_SSH_KEY_FILE"
printf '%s\n' "$GMN_SSH_KNOWN_HOSTS" >"$GMN_CI_SSH_DIR/known_hosts"
# Opções fixas da spec (§5.5.1 passo 7; o `seals-deliver` "como no deploy", §5.5.2) na configuração privada; `ssh -F` faz o ssh ignorar
# qualquer outra (nem a do sistema).
cat >"$GMN_CI_SSH_CONFIG" <<EOF
Host ${GMN_CI_SSH_ALIAS}
  HostName ${GMN_SSH_HOST}
  Port ${ssh_port}
  User ${ssh_user}
  IdentityFile "${GMN_CI_SSH_KEY_FILE}"
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  UserKnownHostsFile "${GMN_CI_SSH_DIR}/known_hosts"
  GlobalKnownHostsFile /dev/null
  LogLevel ERROR
  ConnectTimeout 20
  ServerAliveInterval 15
  RequestTTY no
  ForwardAgent no
  ForwardX11 no
  ClearAllForwardings yes
EOF
chmod 0600 -- "$GMN_CI_SSH_KEY_FILE" "$GMN_CI_SSH_DIR/known_hosts" "$GMN_CI_SSH_CONFIG"
echo "chave, known_hosts e ssh_config privados escritos (pasta 0700, arquivos 0600)"
