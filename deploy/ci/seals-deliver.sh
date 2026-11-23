#!/usr/bin/env bash
# Passos 3 e 4 do job `seals-deliver` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.2): entrega TODOS os arquivos da lista ordenada
# do passo 1 (seals-files.sh) ao receptor de manifestos, um `put <relpath> <sha256> <trust-sha256>` por arquivo, com a cópia privada do blob
# do commit no stdin (nunca o caminho do checkout; o sha256 da cópia é conferido de novo antes do envio; revisão do PR #74, item 6), e
# PARA NO PRIMEIRO ERRO (RC-10). Mandar tudo é idempotente: arquivo igual já presente volta `OK ALREADY_PRESENT`. Só ssh e sha256sum: nenhum
# npm, node ou código do repositório (P9-W09). Host, porta, usuário e opções fixas vêm da configuração privada (ssh-setup.sh seals).
# Ambiente: GMN_AMB, GMN_SHA, GMN_TRUST_SHA256 (saída do passo 1).
# Resposta do receptor (§5.7, "Para o job de entrega"; conjunto fechado de src/lib/seal-receiver/codes.ts, conferido por teste):
#   sucesso: saída 0 e exatamente uma linha `OK WRITTEN|ALREADY_PRESENT <relpath> <sha256>`, ecoando o `relpath` e o `sha256` enviados;
#   recusa: `ERRO <CÓDIGO>[ <DETALHE>]` com a saída numérica do código; detalhe só em E_V2_REFUSED e E_CLOSURE_REFUSED, das listas fechadas;
#   saída 29 sem texto nenhum (stdout ou stderr do receptor fechados) = E_INTERNAL.
# Qualquer outra coisa vira RECEIVER_UNKNOWN_ERROR EXIT_<n> (ou RECEIVER_BAD_OUTPUT put), sem repetir nada do receptor nem do ssh; conexão que
# falha (255) vira SSH_CONNECT_FAILED HOST_KEY|AUTH|OTHER. O resultado de cada arquivo vai para $RUNNER_TEMP/gmn-seals/results (0600; só
# caminho relativo, sha256, resultado e código), que o resumo publica (§5.9).
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly MAX_PUT_COMMAND_BYTES=256
readonly INTERNAL_EXIT=29
readonly PUBLIC_ERROR_LINE='^ERRO E_[A-Z0-9_]+( [A-Za-z0-9_-]{1,64})?$'
# Saída numérica de cada código do receptor de manifestos (§5.8): os comuns aos dois receptores e os próprios (30 a 37).
declare -rA SEAL_RECEIVER_EXIT_CODES=(
  [E_COMMAND]=10 [E_INPUT_TOO_LARGE]=11 [E_INPUT_TRUNCATED]=12 [E_HASH_MISMATCH]=13 [E_TRUST_LIST_MISMATCH]=14
  [E_TRUST_LIST_INVALID]=15 [E_LOCKED]=16 [E_ARTIFACT]=17 [E_INTERNAL]=29
  [E_FORMAT]=30 [E_EXISTS_DIFFERENT]=31 [E_V2_REFUSED]=32 [E_CLOSURE_REFUSED]=33 [E_UNSAFE_PATH]=34
  [E_WRITE_FAILED]=35 [E_WRITE_UNCONFIRMED]=36 [E_POSTWRITE_VERIFY]=37
)
# Detalhes do E_V2_REFUSED: as razões fixas do verificador v2 (EvidenceTrustReason) e HEAD_MISMATCH (V2_REFUSAL_DETAILS).
readonly V2_REFUSAL_DETAILS=" PROOF_NOT_CONFIGURED NO_SEAL LEGACY_NO_SEAL SEAL_INVALID EVIDENCE_NOT_SEALED EVIDENCE_MISSING \
EVIDENCE_HASH_MISMATCH VERIFICATION_ERROR SEAL_CHAIN_BROKEN SEAL_NOT_CUMULATIVE SEAL_DOWNGRADE SEAL_VERSION_NOT_ALLOWED \
SEAL_KEY_RETIRED_UNCOVERED SEAL_KEY_REVOKED HEAD_MISMATCH "
# Detalhes do E_CLOSURE_REFUSED: os motivos do S-11 contra as cadeias do host (CLOSURE_REFUSAL_DETAILS).
readonly CLOSURE_REFUSAL_DETAILS=" SIGNER_NOT_LISTED SIGNER_NOT_ACTIVE SIGNATURE_INVALID RETIRED_NOT_LISTED HEAD_NOT_IN_REPO "

# seal_error SAÍDA ARQUIVO: "CÓDIGO[ DETALHE]" se a resposta de erro do receptor casar o conjunto fechado; senão nada.
seal_error() {
  local rc="$1" line marker code detail
  line="$(grep -E -m1 -- "$PUBLIC_ERROR_LINE" "$2" || true)"
  if [ -z "$line" ]; then
    # stdout ou stderr do receptor fechados: saída 29 sem NENHUM texto (§5.7, "Saída e log")
    if [ "$rc" -eq "$INTERNAL_EXIT" ] && [ ! -s "$2" ]; then printf 'E_INTERNAL'; fi
    return 0
  fi
  read -r marker code detail <<<"$line"
  [ "$marker" = ERRO ] && [ "${SEAL_RECEIVER_EXIT_CODES[$code]:-}" = "$rc" ] || return 0
  case "$code" in
    E_V2_REFUSED) [ -z "$detail" ] || [[ "$V2_REFUSAL_DETAILS" == *" $detail "* ]] || return 0 ;;
    E_CLOSURE_REFUSED) [ -z "$detail" ] || [[ "$CLOSURE_REFUSAL_DETAILS" == *" $detail "* ]] || return 0 ;;
    *) [ -z "$detail" ] || return 0 ;;
  esac
  printf '%s%s' "$code" "${detail:+ $detail}"
}

# record RESULTADO CÓDIGO: uma linha do resultado do arquivo atual (só campos públicos e já validados).
record() { printf '%s\t%s\t%s\t%s\n' "$relpath" "$sha256" "$1" "$2" >>"$results"; }

# refuse CÓDIGO [DETALHE]: registra a falha do arquivo atual e para (RC-10: nada depois dele é enviado).
refuse() {
  record FALHOU "$1${2:+ $2}"
  gmn_fail "$1" "${2:-}"
}

gmn_require_amb
gmn_require_sha
gmn_is_hex "${GMN_TRUST_SHA256:-}" 64 || gmn_fail INPUT_INVALID GMN_TRUST_SHA256
gmn_ssh_role seals
gmn_require_ssh_files
list="${GMN_CI_SEALS_DIR}/files"
results="${GMN_CI_SEALS_DIR}/results"
gmn_regular_file "$list" || gmn_fail SEALS_LIST_MISSING
# o teto de 1000 arquivos por execução (§5.5.2) antes do primeiro `put`; a contagem do laço repete a conferência linha a linha
[ "$(wc -l <"$list")" -le "$GMN_CI_SEALS_MAX_FILES" ] || gmn_fail SEALS_TOO_MANY
umask 077
: >"$results"

sent=0
while IFS=' ' read -r relpath sha256 extra <&3 || [ -n "${relpath:-}" ]; do
  sent=$((sent + 1))
  [ "$sent" -le "$GMN_CI_SEALS_MAX_FILES" ] || gmn_fail SEALS_TOO_MANY
  if [ -n "$extra" ] || ! gmn_is_hex "$sha256" 64 || ! { [[ "$relpath" =~ $GMN_CI_SEAL_RELPATH ]] || [[ "$relpath" =~ $GMN_CI_CLOSURE_RELPATH ]]; }; then
    gmn_fail SEALS_LIST_INVALID
  fi
  file="${GMN_CI_SEALS_DIR}/blobs/${sha256}"
  gmn_regular_file "$file" || refuse SEALS_FILE_CHANGED
  [ "$(gmn_sha256_file "$file")" = "$sha256" ] || refuse SEALS_FILE_CHANGED
  remote_command="put ${relpath} ${sha256} ${GMN_TRUST_SHA256}"
  [ "${#remote_command}" -le "$MAX_PUT_COMMAND_BYTES" ] || refuse INTERNAL command-length

  gmn_receiver_ssh "$remote_command" "$file"
  public_error="$(seal_error "$GMN_SSH_RC" "$GMN_SSH_STDERR")"
  ssh_hint="$(gmn_ssh_hint "$GMN_SSH_STDERR")"
  rm -f -- "$GMN_SSH_STDERR"

  if [ "$GMN_SSH_RC" -eq "$GMN_CI_SSH_CONNECT_FAILED_RC" ]; then refuse SSH_CONNECT_FAILED "$ssh_hint"; fi
  if [ "$GMN_SSH_RC" -ne 0 ]; then
    [ -n "$public_error" ] || refuse RECEIVER_UNKNOWN_ERROR "EXIT_${GMN_SSH_RC}"
    read -r code detail <<<"$public_error"
    refuse "$code" "$detail"
  fi
  if [[ "$GMN_SSH_RESPONSE" == *$'\n'* ]] || ! [[ "$GMN_SSH_RESPONSE" =~ ^OK\ (WRITTEN|ALREADY_PRESENT)\ ([^ ]+)\ ([0-9a-f]{64})$ ]]; then
    refuse RECEIVER_BAD_OUTPUT put
  fi
  # o receptor ecoa EXATAMENTE o caminho e o sha256 do pedido
  [ "${BASH_REMATCH[2]}" = "$relpath" ] && [ "${BASH_REMATCH[3]}" = "$sha256" ] || refuse RECEIVER_BAD_OUTPUT put
  result="${BASH_REMATCH[1]}"
  record "$result" OK
  printf 'OK %s %s %s\n' "$result" "$relpath" "$sha256"
done 3<"$list"

gmn_output sent "$sent"
echo "entrega concluída: ${sent} arquivo(s), todos OK"
