#!/usr/bin/env bash
# Passo 5 do job `seals-deliver` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.9, RC-08): uma tabela do ambiente no resumo do job
# ($GITHUB_STEP_SUMMARY, PÚBLICO), uma linha por arquivo da lista, na ordem de envio: execução, tentativa, commit, ambiente, caminho relativo,
# sha256 dos bytes, resultado e código. O custodiante copia as linhas para o livro de manifestos, que as junta às da verificação da MESMA
# execução pelo id da execução, pelo caminho e pelo sha256 (p1-livro-de-manifestos.md §2).
#   WRITTEN         = verificado no host (verificador v2) e gravado;
#   ALREADY_PRESENT = "conteúdo idêntico já presente": o host já tinha os MESMOS bytes e o receptor só os comparou (sem nova verificação
#                     no host; revisão do PR #72). Nunca é mostrado como verificado no host;
#   FALHOU          = a recusa CONFIRMADA que parou a entrega (código fixo); os arquivos seguintes ficam "não enviado";
#   indeterminado   = a chamada começou (`STARTED`) mas não há resultado confirmado: conexão perdida, resposta fora do conjunto fechado ou job
#                     cancelado no meio da chamada (revisão do PR #74, item 7). O receptor pode ter gravado: conferir no host.
#   "não enviado" só para os arquivos cuja chamada nunca começou.
# Só campos públicos, validados por padrão fixo (o que não casa vira `-`): nunca host, porta, conteúdo de arquivo nem saída do ssh.
# Ambiente (do workflow, `if: always()`): GMN_AMB, GMN_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY; GMN_O_<PASSO> (outcome) e
# GMN_E_<PASSO> (código) de HEAD CHECKOUT FILES SSH HEAD2 DELIVER; GMN_V_TRUST_SHA256. Lê $RUNNER_TEMP/gmn-seals/files e results.
set -euo pipefail

readonly -a STEPS=(HEAD CHECKOUT FILES SSH HEAD2 DELIVER)
readonly SEALS_DIR="${RUNNER_TEMP:?RUNNER_TEMP ausente}/gmn-seals"
readonly RELPATH='^(aud-[0-9a-f]{16}/seal-(000[1-9]|00[1-9][0-9]|01[0-9][0-9]|02[0-4][0-9]|025[0-6])\.json|_closures/[a-z0-9][a-z0-9-]{3,31}\.json)$'
readonly HEX64='^[0-9a-f]{64}$'
readonly CODE='^[A-Z][A-Z0-9_]{1,63}( [A-Za-z0-9_-]{1,64})?$'
readonly LABEL_WRITTEN='`WRITTEN`: gravado (verificado no host)'
readonly LABEL_ALREADY_PRESENT='`ALREADY_PRESENT`: conteúdo idêntico já presente'
readonly LABEL_FAILED='`FALHOU`'
readonly LABEL_UNDETERMINED='resultado indeterminado (conferir no host)'
readonly LABEL_NOT_SENT='não enviado'
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY ausente}"

# valid VALOR PADRÃO: o valor, se casar o padrão; senão `-`.
valid() { if [[ "$1" =~ $2 ]]; then printf '%s' "$1"; else printf -- '-'; fi; }
var() { local name="$1"; printf '%s' "${!name:-}"; }

# O resultado da execução: o código do primeiro passo que não terminou com sucesso (como no resumo do deploy).
result="OK"
for step in "${STEPS[@]}"; do
  outcome="$(var "GMN_O_${step}")"
  [ "$outcome" = success ] && continue
  case "$outcome" in
    failure)
      result="$(valid "$(var "GMN_E_${step}")" "$CODE")"
      [ "$result" != "-" ] || result="FALHOU_${step}"
      ;;
    cancelled) result="CANCELADO" ;;
    *) result="INCOMPLETO" ;;
  esac
  break
done

amb="$(valid "$(var GMN_AMB)" '^(homologacao|producao)$')"
run_id="$(valid "$(var GITHUB_RUN_ID)" '^[0-9]{1,20}$')"
attempt="$(valid "$(var GITHUB_RUN_ATTEMPT)" '^[0-9]{1,6}$')"
sha="$(valid "$(var GMN_SHA)" '^[0-9a-f]{40}$')"

# Os resultados por caminho (results: `<relpath>\t<sha256>\t<resultado>\t<código>`), só linhas que casam os padrões; a ÚLTIMA linha de cada
# arquivo vale (`STARTED` antes da chamada, o resultado depois).
declare -A outcome_of=()
declare -A code_of=()
if [ -f "${SEALS_DIR}/results" ] && [ ! -L "${SEALS_DIR}/results" ]; then
  while IFS=$'\t' read -r relpath sha256 outcome code; do
    [[ "$relpath" =~ $RELPATH ]] && [[ "$sha256" =~ $HEX64 ]] || continue
    case "$outcome" in WRITTEN | ALREADY_PRESENT | FALHOU | INDETERMINADO | STARTED) ;; *) continue ;; esac
    outcome_of["$relpath $sha256"]="$outcome"
    code_of["$relpath $sha256"]="$(valid "$code" "$CODE")"
  done <"${SEALS_DIR}/results"
fi

rows=()
written=0
present=0
not_sent=0
undetermined=0
if [ -f "${SEALS_DIR}/files" ] && [ ! -L "${SEALS_DIR}/files" ]; then
  while IFS=' ' read -r relpath sha256 extra || [ -n "${relpath:-}" ]; do
    [ -z "$extra" ] && [[ "$relpath" =~ $RELPATH ]] && [[ "$sha256" =~ $HEX64 ]] || continue
    key="$relpath $sha256"
    case "${outcome_of[$key]:-}" in
      WRITTEN) label="$LABEL_WRITTEN"; written=$((written + 1)) ;;
      ALREADY_PRESENT) label="$LABEL_ALREADY_PRESENT"; present=$((present + 1)) ;;
      FALHOU) label="$LABEL_FAILED" ;;
      INDETERMINADO | STARTED) label="$LABEL_UNDETERMINED"; undetermined=$((undetermined + 1)) ;;
      *) label="$LABEL_NOT_SENT"; not_sent=$((not_sent + 1)) ;;
    esac
    rows+=("| \`${run_id}\` | \`${attempt}\` | \`${sha}\` | \`${amb}\` | \`${relpath}\` | \`${sha256}\` | ${label} | \`${code_of[$key]:--}\` |")
  done <"${SEALS_DIR}/files"
fi

{
  echo "### Entrega de manifestos (${amb})"
  echo
  if [ "$result" = OK ]; then
    echo "Resultado: \`OK\` (${written} gravado(s) e verificado(s) no host, ${present} com conteúdo idêntico já presente)."
  else
    echo "Resultado: \`${result}\`. A entrega para no primeiro erro (RC-10): ${not_sent} arquivo(s) não enviado(s)."
  fi
  if [ "$undetermined" -gt 0 ]; then
    echo
    echo "**${undetermined} arquivo(s) com resultado indeterminado:** a chamada começou, mas não houve resposta confirmada (conexão perdida,"
    echo "resposta fora do conjunto fechado ou execução cancelada). O receptor pode ter gravado: conferir no host (runbook §8.4) antes de registrar."
  fi
  echo
  echo "Lista de confiança do commit (sha256): \`$(valid "$(var GMN_V_TRUST_SHA256)" "$HEX64")\`."
  echo
  if [ "${#rows[@]}" -eq 0 ]; then
    echo "Nenhum arquivo listado nesta execução."
  else
    echo "| execução | tentativa | commit | ambiente | caminho relativo | sha256 dos bytes | resultado | código |"
    echo "|---|---|---|---|---|---|---|---|"
    printf '%s\n' "${rows[@]}"
  fi
  echo
  echo "\`ALREADY_PRESENT\` = conteúdo idêntico já presente: o host já tinha um arquivo com os mesmos bytes, e o receptor só comparou os bytes"
  echo "(a verificação v2 no host vale só para \`WRITTEN\`). Host, porta e conteúdo de arquivo nunca entram neste resumo (spec §5.9)."
} >>"$GITHUB_STEP_SUMMARY"
echo "resumo da entrega: ${result}"
