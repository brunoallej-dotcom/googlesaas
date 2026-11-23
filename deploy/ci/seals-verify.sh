#!/usr/bin/env bash
# Job `seals-verify` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5, tabela dos jobs): SEM segredo e sem ambiente, roda o mesmo
# `seals-check` da P9.2 sobre o commit e calcula a MATRIZ de ambientes do `seals-deliver`:
#   push na main (caminho link-audit-seals/*/seals/**): o modo de mudanças sobre o push (base = github.event.before, preparada pelo mesmo
#     .github/scripts/seals-prepare.sh do ci.yml: S-01 a S-14, com o S-10 nas auditorias tocadas) e, em cada ambiente com arquivo NOVO sob
#     <amb>/seals/, o modo árvore (S-03 a S-08 em todos os arquivos do ambiente);
#   dispatch com acao = entregar-selos: só o modo árvore do ambiente escolhido (todo arquivo já passou pelo S-10 no merge, e o receptor verifica
#     de novo no host os que faltam lá).
# Um ambiente entra na matriz só se tem pelo menos um arquivo sob link-audit-seals/<amb>/seals/. A saída `ambientes` é um JSON de um conjunto
# FECHADO ([], ["homologacao"], ["producao"], ["homologacao","producao"]), montado só de literais e conferido antes de sair.
# Ambiente: GMN_SHA, GMN_EVENT (github.event_name), GMN_BEFORE (github.event.before, no push), GMN_DISPATCH_AMB (inputs.ambiente, no
# dispatch). O resumo público recebe as tabelas do comando (uma linha por arquivo: caminho, sha256, seq, sealSha256 / campos do fecho).
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly OBJECT_NAME='^([0-9a-f]{40}|[0-9a-f]{64})$'
readonly -a SEALS_ENVIRONMENTS=(homologacao producao)
readonly ALLOWED_MATRICES=' [] ["homologacao"] ["producao"] ["homologacao","producao"] '
readonly WORK_DIR="${RUNNER_TEMP}/gmn-seals-verify"

# seals_check ARGUMENTOS…: o comando da P9.2 (resumo no stdout, acrescentado ao resumo do job; recusa ⇒ `ERRO <CÓDIGO>` dele no stderr).
seals_check() {
  if ! npm run --silent link-audit:seals-check -- "$@" | tee -a "$GITHUB_STEP_SUMMARY"; then gmn_fail SEALS_REFUSED; fi
}

# has_deliverables AMB: verdadeiro se a árvore do commit tem algum arquivo sob link-audit-seals/<amb>/seals/.
has_deliverables() {
  local entry
  while IFS= read -r -d '' entry; do
    case "${entry#*$'\t'}" in "link-audit-seals/$1/seals/"*) return 0 ;; esac
  done <"${WORK_DIR}/modes"
  return 1
}

# touched_by_push ARQUIVO: marca os ambientes com arquivo ACRESCENTADO sob <amb>/seals/ (o comando já recusou qualquer outro status ali).
touched_by_push() {
  local status path
  while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    [ "$status" = A ] || continue
    case "$path" in
      link-audit-seals/homologacao/seals/*) touched_homologacao=true ;;
      link-audit-seals/producao/seals/*) touched_producao=true ;;
    esac
  done <"$1"
}

gmn_require_sha
[ "$(git rev-parse HEAD)" = "$GMN_SHA" ] || gmn_fail CHECKOUT_MISMATCH
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY ausente}"
umask 077
rm -rf -- "$WORK_DIR"
mkdir -m 0700 -- "$WORK_DIR"
touched_homologacao=false
touched_producao=false

case "${GMN_EVENT:-}" in
  push)
    before="${GMN_BEFORE:-}"
    if ! [[ "$before" =~ $OBJECT_NAME ]] || [[ "$before" =~ ^0+$ ]]; then gmn_fail SEALS_NO_BASE; fi
    git cat-file -e "${before}^{commit}" 2>/dev/null || gmn_fail SEALS_NO_BASE
    : >"${WORK_DIR}/prepare-output"
    SEALS_BASE="$before" SEALS_HEAD="$PWD" SEALS_OUT="${WORK_DIR}/push" GITHUB_OUTPUT="${WORK_DIR}/prepare-output" \
      bash .github/scripts/seals-prepare.sh || gmn_fail SEALS_PREPARE_FAILED
    if grep -qx 'changed=true' "${WORK_DIR}/prepare-output"; then
      seals_check --changes "${WORK_DIR}/push/changes" --modes "${WORK_DIR}/push/modes" --base-trust "${WORK_DIR}/push/base-trust" --repo "$PWD"
      touched_by_push "${WORK_DIR}/push/changes"
    fi
    ;;
  workflow_dispatch)
    case "${GMN_DISPATCH_AMB:-}" in
      homologacao) touched_homologacao=true ;;
      producao) touched_producao=true ;;
      *) gmn_fail INPUT_INVALID GMN_DISPATCH_AMB ;;
    esac
    ;;
  *) gmn_fail INPUT_INVALID GMN_EVENT ;;
esac

git -c core.quotePath=false ls-tree -r -z HEAD -- link-audit-seals >"${WORK_DIR}/modes"
deliver_homologacao=false
deliver_producao=false
for env in "${SEALS_ENVIRONMENTS[@]}"; do
  touched_var="touched_${env}"
  [ "${!touched_var}" = true ] || continue
  seals_check --tree "$env" --modes "${WORK_DIR}/modes" --repo "$PWD"
  if has_deliverables "$env"; then printf -v "deliver_${env}" '%s' true; fi
done

case "${deliver_homologacao}:${deliver_producao}" in
  true:true) ambientes='["homologacao","producao"]' ;;
  true:false) ambientes='["homologacao"]' ;;
  false:true) ambientes='["producao"]' ;;
  *) ambientes='[]' ;;
esac
[[ "$ALLOWED_MATRICES" == *" ${ambientes} "* ]] || gmn_fail INTERNAL ambientes
gmn_output ambientes "$ambientes"
{
  echo
  echo "### seals-verify: ambientes a entregar"
  echo
  if [ "$ambientes" = '[]' ]; then echo "Nenhum: nada a entregar nesta execução."; else echo "\`${ambientes}\` (um job \`seals-deliver\` por ambiente, com aprovação no ambiente protegido)."; fi
} >>"$GITHUB_STEP_SUMMARY"
echo "ambientes a entregar: ${ambientes}"
