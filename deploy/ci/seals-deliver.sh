#!/usr/bin/env bash
# Passos 3 e 4 do job `seals-deliver` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.2): entrega TODOS os arquivos da lista ordenada
# do passo 1 (seals-files.sh) ao receptor de manifestos, um `put <relpath> <sha256> <trust-sha256>` por arquivo, com a cópia privada do blob
# do commit no stdin (nunca o caminho do checkout; o sha256 da cópia é conferido de novo antes do envio; revisão do PR #74, item 6), e
# PARA NO PRIMEIRO ERRO (RC-10). Mandar tudo é idempotente: arquivo igual já presente volta `OK ALREADY_PRESENT`. Só ssh e sha256sum: nenhum
# npm, node ou código do repositório (P9-W09). Host, porta, usuário e opções fixas vêm da configuração privada (ssh-setup.sh seals).
# Ambiente: GMN_AMB, GMN_SHA, GMN_TRUST_SHA256 (saída do passo 1).
# Resposta do receptor (§5.7, "Para o job de entrega"; conjunto fechado de src/lib/seal-receiver/codes.ts, conferido por teste). O stdout e o
# stderr são capturados SEPARADOS, com teto, e a resposta INTEIRA é conferida contra a saída numérica (revisão do PR #74, item 4):
#   sucesso: saída 0, stdout = EXATAMENTE uma linha `OK WRITTEN|ALREADY_PRESENT <relpath> <sha256>\n` (ecoando o pedido) e stderr vazio;
#   recusa: stdout vazio e stderr = EXATAMENTE uma linha `ERRO <CÓDIGO>[ <DETALHE>]\n` do conjunto fechado, com a saída numérica do código;
#     detalhe só em E_V2_REFUSED e E_CLOSURE_REFUSED, das listas fechadas;
#   saída 29 com stdout e stderr vazios (stdout ou stderr do receptor fechados) = E_INTERNAL.
# Qualquer outra coisa vira RECEIVER_UNKNOWN_ERROR EXIT_<n>, sem repetir nada do receptor nem do ssh; só a linha remontada é publicada.
# Conexão que falha (255) vira SSH_CONNECT_FAILED HOST_KEY|AUTH|OTHER. O resultado de cada arquivo vai para $RUNNER_TEMP/gmn-seals/results (0600; só
# caminho relativo, sha256, resultado e código), que o resumo publica (§5.9).
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly MAX_PUT_COMMAND_BYTES=256
readonly INTERNAL_EXIT=29
readonly ERROR_LINE='^ERRO (E_[A-Z0-9_]+)( ([A-Za-z0-9_-]{1,64}))?$'
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

# file_is ARQUIVO TEXTO: verdadeiro se os bytes do arquivo são EXATAMENTE o TEXTO (ASCII): mesmo tamanho e mesmo sha256 (nenhum byte a mais,
# nenhuma linha a mais, nenhum NUL).
file_is() {
  [ "$(stat -c %s -- "$1")" -eq "${#2}" ] && [ "$(gmn_sha256_file "$1")" = "$(printf '%s' "$2" | sha256sum | cut -d' ' -f1)" ]
}

# seal_response SAÍDA: classifica a resposta INTEIRA do `put` atual (GMN_SSH_STDOUT e GMN_SSH_STDERR) contra a saída numérica. Define outcome
# (WRITTEN | ALREADY_PRESENT | REFUSED | UNKNOWN) e, na recusa, public = "CÓDIGO[ DETALHE]" remontado do conjunto fechado.
seal_response() {
  local rc="$1" line code detail verdict
  outcome=UNKNOWN
  public=''
  if [ "$rc" -eq 0 ]; then
    [ ! -s "$GMN_SSH_STDERR" ] || return 0
    for verdict in WRITTEN ALREADY_PRESENT; do
      if file_is "$GMN_SSH_STDOUT" "OK ${verdict} ${relpath} ${sha256}"$'\n'; then
        outcome="$verdict"
        return 0
      fi
    done
    return 0
  fi
  [ ! -s "$GMN_SSH_STDOUT" ] || return 0
  if [ ! -s "$GMN_SSH_STDERR" ]; then
    # stdout ou stderr do receptor fechados: saída 29 sem NENHUM texto (§5.7, "Saída e log")
    if [ "$rc" -eq "$INTERNAL_EXIT" ]; then
      outcome=REFUSED
      public=E_INTERNAL
    fi
    return 0
  fi
  IFS= read -r line <"$GMN_SSH_STDERR" || true
  [[ "$line" =~ $ERROR_LINE ]] || return 0
  code="${BASH_REMATCH[1]}"
  detail="${BASH_REMATCH[3]}"
  [ "${SEAL_RECEIVER_EXIT_CODES[$code]:-}" = "$rc" ] || return 0
  case "$code" in
    E_V2_REFUSED) [ -z "$detail" ] || [[ "$V2_REFUSAL_DETAILS" == *" $detail "* ]] || return 0 ;;
    E_CLOSURE_REFUSED) [ -z "$detail" ] || [[ "$CLOSURE_REFUSAL_DETAILS" == *" $detail "* ]] || return 0 ;;
    *) [ -z "$detail" ] || return 0 ;;
  esac
  # exatamente UMA linha no stderr, sem nada antes nem depois
  file_is "$GMN_SSH_STDERR" "ERRO ${code}${detail:+ $detail}"$'\n' || return 0
  outcome=REFUSED
  public="${code}${detail:+ $detail}"
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
  ssh_hint="$(gmn_ssh_hint "$GMN_SSH_STDERR")"
  seal_response "$GMN_SSH_RC"
  rm -f -- "$GMN_SSH_STDOUT" "$GMN_SSH_STDERR"

  if [ "$GMN_SSH_RC" -eq "$GMN_CI_SSH_CONNECT_FAILED_RC" ]; then refuse SSH_CONNECT_FAILED "$ssh_hint"; fi
  case "$outcome" in
    WRITTEN | ALREADY_PRESENT)
      record "$outcome" OK
      printf 'OK %s %s %s\n' "$outcome" "$relpath" "$sha256"
      ;;
    REFUSED)
      read -r code detail <<<"$public"
      refuse "$code" "$detail"
      ;;
    *) refuse RECEIVER_UNKNOWN_ERROR "EXIT_${GMN_SSH_RC}" ;;
  esac
done 3<"$list"

gmn_output sent "$sent"
echo "entrega concluída: ${sent} arquivo(s), todos OK"
