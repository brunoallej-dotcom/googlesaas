#!/usr/bin/env bash
# Passos 8 e 9 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): chama o receptor de deploy por SSH, na
# gramática fechada do §5.6, e confere a resposta. O receptor é o único comando da chave (`restrict,command=` no host).
#   upload <sha40> <bundle-sha256> <bytes>                                                    (pacote no stdin)
#   deploy <sha40> <bundle-sha256> <stack-sha256> <overlay-sha256|-> <trust-sha256> <supabase-fp12>   (lista no stdin)
# Uso: deploy/ci/receiver-call.sh upload|deploy. Ambiente: GMN_AMB, GMN_SHA, GMN_BUNDLE_SHA256 e, no upload, GMN_BUNDLE_BYTES; no
# deploy, GMN_STACK_SHA256, GMN_OVERLAY_SHA256, GMN_TRUST_SHA256 e GMN_BUILD_SUPABASE_URL (segredo; só a impressão de 12 hex vai ao
# receptor, nunca impressa). Host, porta, usuário e opções fixas vêm da configuração privada escrita no passo 7 (ssh-setup.sh):
# `ssh -F <config> gmn-receiver`, nada disso na linha de comando.
# Saída pública: a linha `OK …` do receptor ou uma linha `ERRO <CÓDIGO>[ <DETALHE>]`. O stderr do ssh NUNCA vai ao log (as mensagens
# dele repetem host e endereço): só passa a linha de erro do receptor, se casar a gramática pública do §5.8.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly SSH_CONNECT_FAILED_RC=255
readonly MAX_COMMAND_BYTES=512
readonly PUBLIC_ERROR_LINE='^ERRO E_[A-Z0-9_]+( [A-Za-z0-9_-]{1,64})?$'

verb="${1:-}"
gmn_require_amb
gmn_require_sha
gmn_regular_file "$GMN_CI_SSH_DIR/id_deploy" || gmn_fail SSH_CONFIG_MISSING id_deploy
gmn_regular_file "$GMN_CI_SSH_DIR/known_hosts" || gmn_fail SSH_CONFIG_MISSING known_hosts
gmn_regular_file "$GMN_CI_SSH_CONFIG" || gmn_fail SSH_CONFIG_MISSING config
gmn_is_hex "${GMN_BUNDLE_SHA256:-}" 64 || gmn_fail INPUT_INVALID GMN_BUNDLE_SHA256

prepare_upload() {
  if ! [[ "${GMN_BUNDLE_BYTES:-}" =~ ^[1-9][0-9]{0,9}$ ]] || [ "$GMN_BUNDLE_BYTES" -gt "$GMN_CI_BUNDLE_MAX_BYTES" ]; then
    gmn_fail INPUT_INVALID GMN_BUNDLE_BYTES
  fi
  gmn_regular_file "$GMN_CI_BUNDLE_FILE" || gmn_fail BUNDLE_MISSING
  [ "$(stat -c %s -- "$GMN_CI_BUNDLE_FILE")" = "$GMN_BUNDLE_BYTES" ] || gmn_fail BUNDLE_CHANGED
  remote_command="upload ${GMN_SHA} ${GMN_BUNDLE_SHA256} ${GMN_BUNDLE_BYTES}"
  stdin_file="$GMN_CI_BUNDLE_FILE"
  expected="^OK UPLOADED ${GMN_SHA} ${GMN_BUNDLE_SHA256}\$"
}

prepare_deploy() {
  local name overlay trust_file fp12
  for name in GMN_STACK_SHA256 GMN_TRUST_SHA256; do gmn_is_hex "${!name:-}" 64 || gmn_fail INPUT_INVALID "$name"; done
  overlay="${GMN_OVERLAY_SHA256:-}"
  case "$GMN_AMB" in
    producao) [ "$overlay" = "-" ] || gmn_fail INPUT_INVALID GMN_OVERLAY_SHA256 ;;
    homologacao) gmn_is_hex "$overlay" 64 || gmn_fail INPUT_INVALID GMN_OVERLAY_SHA256 ;;
  esac
  trust_file="link-audit-seals/${GMN_AMB}/trust-keys.txt"
  gmn_regular_file "$trust_file" || gmn_fail HASH_INPUT_MISSING trust-keys.txt
  [ "$(gmn_sha256_file "$trust_file")" = "$GMN_TRUST_SHA256" ] || gmn_fail TRUST_LIST_CHANGED
  [ -n "${GMN_BUILD_SUPABASE_URL:-}" ] || gmn_fail BUILD_CONFIG_MISSING GMN_BUILD_SUPABASE_URL
  # Impressão do projeto: 12 primeiros hex do sha256 dos bytes da URL, sem quebra de linha (o receptor calcula igual sobre o
  # NEXT_PUBLIC_SUPABASE_URL do arquivo do host). Nunca impressa: só vai no comando remoto (argv do ssh, fora do log), nunca ao resumo
  # nem às saídas do passo.
  fp12="$(printf '%s' "$GMN_BUILD_SUPABASE_URL" | sha256sum | cut -c1-12)"
  gmn_is_hex "$fp12" 12 || gmn_fail INTERNAL supabase-fp12
  remote_command="deploy ${GMN_SHA} ${GMN_BUNDLE_SHA256} ${GMN_STACK_SHA256} ${overlay} ${GMN_TRUST_SHA256} ${fp12}"
  stdin_file="$trust_file"
  expected="^OK DEPLOYED ${GMN_AMB}-${GMN_SHA} (sha256:[0-9a-f]{64}) (sha256:[0-9a-f]{64}) ${GMN_STACK_SHA256} ${overlay} ([0-9a-f]{64})\$"
}

case "$verb" in
  upload) prepare_upload ;;
  deploy) prepare_deploy ;;
  *) gmn_fail INPUT_INVALID verb ;;
esac
[ "${#remote_command}" -le "$MAX_COMMAND_BYTES" ] || gmn_fail INTERNAL command-length

stderr_file="$(mktemp "${RUNNER_TEMP}/gmn-ssh-stderr.XXXXXX")"
set +e
response="$(LC_ALL=C ssh -F "$GMN_CI_SSH_CONFIG" -T "$GMN_CI_SSH_ALIAS" "$remote_command" <"$stdin_file" 2>"$stderr_file")"
rc=$?
set -e
public_error="$(grep -E -m1 -- "$PUBLIC_ERROR_LINE" "$stderr_file" || true)"
ssh_hint=OTHER
if grep -q 'Host key verification failed' "$stderr_file"; then ssh_hint=HOST_KEY; elif grep -q 'Permission denied' "$stderr_file"; then ssh_hint=AUTH; fi
rm -f -- "$stderr_file"

if [ "$rc" -eq "$SSH_CONNECT_FAILED_RC" ]; then gmn_fail SSH_CONNECT_FAILED "$ssh_hint"; fi
if [ "$rc" -ne 0 ]; then
  if [ -n "$public_error" ]; then
    code="$(cut -d' ' -f2 <<<"$public_error")"
    gmn_output code "$code"
    printf '%s\n' "$public_error" >&2
    exit 1
  fi
  gmn_fail RECEIVER_FAILED "EXIT_${rc}"
fi
if [[ "$response" == *$'\n'* ]] || ! [[ "$response" =~ $expected ]]; then gmn_fail RECEIVER_BAD_OUTPUT "$verb"; fi
printf '%s\n' "$response"

if [ "$verb" = deploy ]; then
  gmn_output web_image "${BASH_REMATCH[1]}"
  gmn_output worker_image "${BASH_REMATCH[2]}"
  gmn_output trust_installed_sha256 "${BASH_REMATCH[3]}"
  # P9-D11: a lista INSTALADA (relida do arquivo pelo receptor) tem de ser a enviada.
  [ "${BASH_REMATCH[3]}" = "$GMN_TRUST_SHA256" ] || gmn_fail TRUST_LIST_INSTALLED_MISMATCH
fi
