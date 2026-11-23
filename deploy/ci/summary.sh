#!/usr/bin/env bash
# Passo 11 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.9, RC-08): uma linha por execução no resumo do job
# ($GITHUB_STEP_SUMMARY, PÚBLICO). Só campos públicos e validados por padrão fixo: o que não casa vira `-`. Nunca host, porta,
# domínio, URL, impressão do projeto Supabase nem saída do Docker. A lista é a INSTALADA (devolvida no `OK DEPLOYED`).
# Ambiente (do workflow, `if: always()`): GMN_AMB, GMN_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY;
#   GMN_O_<PASSO> (outcome) e GMN_E_<PASSO> (código) de CI HEAD CHECKOUT BUILD BUNDLE HASHES SSH UPLOAD HEAD2 DEPLOY EXTERNAL;
#   GMN_V_BUNDLE_SHA256, GMN_V_STACK_SHA256, GMN_V_OVERLAY_SHA256, GMN_V_TRUST_INSTALLED_SHA256, GMN_V_WEB_IMAGE,
#   GMN_V_WORKER_IMAGE, GMN_V_EX.
set -euo pipefail

readonly -a STEPS=(CI HEAD CHECKOUT BUILD BUNDLE HASHES SSH UPLOAD HEAD2 DEPLOY EXTERNAL)
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY ausente}"

# valid VALOR PADRÃO: o valor, se casar o padrão; senão `-`.
valid() { if [[ "$1" =~ $2 ]]; then printf '%s' "$1"; else printf -- '-'; fi; }
var() { local name="$1"; printf '%s' "${!name:-}"; }
code_of() { valid "$(var "GMN_E_$1")" '^[A-Z][A-Z0-9_]{1,63}$'; }

readonly HEX64='^[0-9a-f]{64}$'
readonly IMAGE_ID='^sha256:[0-9a-f]{64}$'

result="OK"
for step in "${STEPS[@]}"; do
  outcome="$(var "GMN_O_${step}")"
  [ "$outcome" = success ] && continue
  case "$outcome" in
    failure)
      result="$(code_of "$step")"
      [ "$result" != "-" ] || result="FALHOU_${step}"
      ;;
    cancelled) result="CANCELADO" ;;
    *) result="INCOMPLETO" ;;
  esac
  break
done

ci="-"
case "$(var GMN_O_CI)" in
  success) ci="sim" ;;
  failure) ci="$(code_of CI)" ;;
esac
head="-"
if [ "$(var GMN_O_HEAD)" = failure ]; then
  head="$(code_of HEAD)"
elif [ "$(var GMN_O_HEAD2)" = failure ]; then
  head="$(code_of HEAD2) (antes do deploy)"
elif [ "$(var GMN_O_HEAD)" = success ] && [ "$(var GMN_O_HEAD2)" = success ]; then
  head="sim (início e antes do deploy)"
elif [ "$(var GMN_O_HEAD)" = success ]; then
  head="sim (início)"
fi

amb="$(valid "$(var GMN_AMB)" '^(homologacao|producao)$')"
row=(
  "$(valid "$(var GITHUB_RUN_ID)" '^[0-9]{1,20}$') (tentativa $(valid "$(var GITHUB_RUN_ATTEMPT)" '^[0-9]{1,6}$'))"
  "$(valid "$(var GMN_SHA)" '^[0-9a-f]{40}$')"
  "$amb"
  "$(valid "$(var GMN_V_BUNDLE_SHA256)" "$HEX64")"
  "$(valid "$(var GMN_V_STACK_SHA256)" "$HEX64")"
  "$(valid "$(var GMN_V_OVERLAY_SHA256)" '^([0-9a-f]{64}|-)$')"
  "$(valid "$(var GMN_V_TRUST_INSTALLED_SHA256)" "$HEX64")"
  "$(valid "$(var GMN_V_WEB_IMAGE)" "$IMAGE_ID")"
  "$(valid "$(var GMN_V_WORKER_IMAGE)" "$IMAGE_ID")"
  "$ci"
  "$head"
  "$(valid "$(var GMN_V_EX)" '^EX-01:[0-9]{3} EX-02:[0-9]{3} EX-03:[0-9]{3}$')"
  "$result"
)
line="|"
for cell in "${row[@]}"; do line="${line} \`${cell}\` |"; done

{
  echo "### Deploy pelo CI (${amb})"
  echo
  echo "| execução | commit | ambiente | pacote sha256 | stack sha256 | sobreposição sha256 | lista instalada sha256 | imagem web | imagem worker | CI verde | cabeça da \`main\` | EX-01..03 | resultado |"
  echo "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  echo "$line"
  echo
  echo "Host, porta, domínio e a impressão do projeto Supabase nunca entram neste resumo (spec §5.9)."
} >>"$GITHUB_STEP_SUMMARY"
echo "resumo: ${result}"
