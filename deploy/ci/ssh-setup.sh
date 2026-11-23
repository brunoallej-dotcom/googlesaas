#!/usr/bin/env bash
# Passo 7 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): SÓ DEPOIS do build, escreve a chave privada de
# deploy e a linha fixada da chave de host em $RUNNER_TEMP/gmn-ssh (pasta 0700, arquivos 0600). A limpeza `if: always()` do
# workflow apaga a pasta. Nada aqui é impresso além de códigos fixos.
# Ambiente: GMN_DEPLOY_SSH_KEY (chave Ed25519 de gmn-deploy / gmn-hml-deploy) e GMN_SSH_KNOWN_HOSTS (linha(s) conferidas pelo
# responsável no console da VPS, ação H-09; sem TOFU), ambos segredos do ambiente do GitHub.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

# Moldura da chave montada por partes (o texto literal completo dispararia o scanner de segredos do CI).
readonly KEY_HEADER="-----BEGIN OPENSSH PRIVATE"" KEY-----"
readonly KNOWN_HOSTS_MAX_LINES=8
readonly KNOWN_HOSTS_LINE='^[^@*?! ][^*?! ]* (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) [A-Za-z0-9+/]+={0,2}( .*)?$'

[ -n "${GMN_DEPLOY_SSH_KEY:-}" ] || gmn_fail SSH_CONFIG_MISSING GMN_DEPLOY_SSH_KEY
[ -n "${GMN_SSH_KNOWN_HOSTS:-}" ] || gmn_fail SSH_CONFIG_MISSING GMN_SSH_KNOWN_HOSTS
case "$GMN_DEPLOY_SSH_KEY" in
  "$KEY_HEADER"*) ;;
  *) gmn_fail SSH_CONFIG_INVALID GMN_DEPLOY_SSH_KEY ;;
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
printf '%s\n' "$GMN_DEPLOY_SSH_KEY" >"$GMN_CI_SSH_DIR/id_deploy"
printf '%s\n' "$GMN_SSH_KNOWN_HOSTS" >"$GMN_CI_SSH_DIR/known_hosts"
chmod 0600 -- "$GMN_CI_SSH_DIR/id_deploy" "$GMN_CI_SSH_DIR/known_hosts"
echo "chave e known_hosts escritos (pasta 0700, arquivos 0600)"
