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
# dele repetem host e endereço). O erro do receptor também não passa adiante como veio: o código tem de ser um do conjunto FECHADO do
# §5.8 (com a saída numérica correspondente), o detalhe tem de vir da lista fechada daquele código, e a linha pública é remontada aqui.
# Qualquer outra coisa vira RECEIVER_UNKNOWN_ERROR EXIT_<n>, sem repetir nada do receptor.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly SSH_CONNECT_FAILED_RC=255
readonly MAX_COMMAND_BYTES=512
readonly PUBLIC_ERROR_LINE='^ERRO E_[A-Z0-9_]+( [A-Za-z0-9_-]{1,64})?$'
# Códigos do receptor de deploy e os comuns aos dois receptores (spec §5.8), com a saída numérica de cada um.
declare -rA RECEIVER_EXIT_CODES=(
  [E_COMMAND]=10 [E_INPUT_TOO_LARGE]=11 [E_INPUT_TRUNCATED]=12 [E_HASH_MISMATCH]=13 [E_TRUST_LIST_MISMATCH]=14
  [E_TRUST_LIST_INVALID]=15 [E_LOCKED]=16 [E_ARTIFACT]=17 [E_INTERNAL]=29
  [E_NOT_STAGED]=50 [E_STACK_FILE_MISMATCH]=51 [E_HOST_CONFIG]=52 [E_HOST_FOLDERS]=53 [E_SUPABASE_MISMATCH]=54
  [E_HML_PRODUCTION_PROJECT]=55 [E_WORKER_REPLICAS_DRIFT]=56 [E_DISK_LOW]=57 [E_BUNDLE_TAGS]=58 [E_DOCKER_LOAD]=59
  [E_STACK_CONFIG]=60 [E_STACK_DEPLOY]=61 [E_ROLLED_BACK]=62 [E_CONVERGE_TIMEOUT]=63 [E_POSTDEPLOY_CHECK]=64
  [E_DATA_PREFIX]=65 [E_TRUST_LIST_TRANSITION]=66
)
# Nomes que o E_HOST_CONFIG pode trazer (spec §5.6 passo 4: proibidas, obrigatórias e as pastas de homologação). O receptor da P9.3a
# usa esta lista; um nome novo entra aqui no mesmo PR. Sem detalhe também vale: linha fora do parser sem nome desta lista, nome reservado
# ou arquivo ilegível (spec §5.6, "Implementação (P9.3a)").
readonly HOST_CONFIG_NAMES=" GMN_IMAGE_TAG GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS GMN_AUTH_DISABLED GMN_DEMO_MODE GMN_LINK_AUDIT_HOMOLOGATION \
GMN_TRAEFIK_NAME GMN_WORKER_REPLICAS GMN_DATA_ROOT GMN_RAIZ_DADOS_DECISOES GMN_RAIZ_DADOS_RECIBOS_DECISOES GMN_RAIZ_DADOS_RESULTADOS \
GMN_RAIZ_DADOS_RECIBOS_RESULTADOS GMN_RAIZ_DADOS_LIVRO GMN_RAIZ_DADOS_MANIFESTOS NEXT_PUBLIC_SUPABASE_URL GMN_HOST GMN_NODE_HOSTNAME \
GMN_OPERATOR_EMAILS "

# receiver_error SAÍDA ARQUIVO: imprime "CÓDIGO[ DETALHE]" se a primeira linha de erro do receptor casar o conjunto fechado; senão nada.
receiver_error() {
  local rc="$1" line marker code detail
  line="$(grep -E -m1 -- "$PUBLIC_ERROR_LINE" "$2" || true)"
  [ -n "$line" ] || return 0
  read -r marker code detail <<<"$line"
  [ "$marker" = ERRO ] && [ "${RECEIVER_EXIT_CODES[$code]:-}" = "$rc" ] || return 0
  case "$code" in
    E_HOST_CONFIG)
      # sem detalhe (linha ilegível ou nome fora da lista: o receptor nunca ecoa o que não é da lista) ou um nome da lista fechada
      [ -z "$detail" ] || [[ "$HOST_CONFIG_NAMES" == *" $detail "* ]] || return 0
      ;;
    E_POSTDEPLOY_CHECK)
      [[ "$detail" =~ ^PD-0[1-8]$ ]] || return 0
      ;;
    *)
      [ -z "$detail" ] || return 0
      ;;
  esac
  printf '%s%s' "$code" "${detail:+ $detail}"
}

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
public_error="$(receiver_error "$rc" "$stderr_file")"
ssh_hint=OTHER
if grep -q 'Host key verification failed' "$stderr_file"; then ssh_hint=HOST_KEY; elif grep -q 'Permission denied' "$stderr_file"; then ssh_hint=AUTH; fi
rm -f -- "$stderr_file"

if [ "$rc" -eq "$SSH_CONNECT_FAILED_RC" ]; then gmn_fail SSH_CONNECT_FAILED "$ssh_hint"; fi
if [ "$rc" -ne 0 ]; then
  [ -n "$public_error" ] || gmn_fail RECEIVER_UNKNOWN_ERROR "EXIT_${rc}"
  read -r code detail <<<"$public_error"
  gmn_fail "$code" "$detail"
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
