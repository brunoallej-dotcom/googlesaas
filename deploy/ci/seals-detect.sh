#!/usr/bin/env bash
# Primeiro passo do job `seals-verify` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5; revisão do PR #74, item 2): o `push` do deploy.yml
# vale para TODA a `main`, sem filtro `paths` (o GitHub avalia o filtro só sobre os primeiros 300 arquivos do diff, e um push grande pularia o
# workflow em silêncio). Este passo decide, pelo diff LOCAL `github.event.before..github.sha` (histórico completo do checkout), se o push mexeu
# em link-audit-seals/*/seals/. Nada mudou ali ⇒ `changed=false`, `ambientes=[]` e o job termina verde, "nada a entregar", sem instalar nada.
# Base inutilizável (before todo zero, fora do histórico, fora da forma) ⇒ SEALS_NO_BASE (falha fechada). No dispatch, `changed=true` para o
# ambiente escolhido. Só git: nenhum npm, node ou código do repositório.
# Ambiente: GMN_SHA, GMN_EVENT (github.event_name), GMN_BEFORE (github.event.before), GMN_DISPATCH_AMB (inputs.ambiente).
# Saídas: changed=true|false e, sem mudança, ambientes=[].
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly OBJECT_NAME='^([0-9a-f]{40}|[0-9a-f]{64})$'

gmn_require_sha
[ "$(git rev-parse HEAD)" = "$GMN_SHA" ] || gmn_fail CHECKOUT_MISMATCH
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY ausente}"

case "${GMN_EVENT:-}" in
  workflow_dispatch)
    case "${GMN_DISPATCH_AMB:-}" in
      homologacao | producao) ;;
      *) gmn_fail INPUT_INVALID GMN_DISPATCH_AMB ;;
    esac
    gmn_output changed true
    echo "dispatch: verificar e entregar ${GMN_DISPATCH_AMB}"
    exit 0
    ;;
  push) ;;
  *) gmn_fail INPUT_INVALID GMN_EVENT ;;
esac

before="${GMN_BEFORE:-}"
if ! [[ "$before" =~ $OBJECT_NAME ]] || [[ "$before" =~ ^0+$ ]]; then gmn_fail SEALS_NO_BASE; fi
git cat-file -e "${before}^{commit}" 2>/dev/null || gmn_fail SEALS_NO_BASE

names="$(umask 077 && mktemp "${RUNNER_TEMP}/gmn-seals-detect.XXXXXX")"
# os mesmos cuidados do preparo do job `seals` (ci.yml): submódulos sempre visíveis, sem diff externo nem textconv, caminhos crus (-z)
git -c diff.ignoreSubmodules=none -c core.quotePath=false diff --name-only --no-renames --ignore-submodules=none --no-ext-diff --no-textconv -z \
  "$before" "$GMN_SHA" -- link-audit-seals >"$names" || gmn_fail SEALS_NO_BASE
changed=false
while IFS= read -r -d '' path; do
  case "$path" in
    link-audit-seals/*/seals/*)
      changed=true
      break
      ;;
  esac
done <"$names"
rm -f -- "$names"

gmn_output changed "$changed"
if [ "$changed" = true ]; then
  echo "o push mexe em link-audit-seals/*/seals/: verificar"
  exit 0
fi
gmn_output ambientes '[]'
{
  echo "### seals-verify: ambientes a entregar"
  echo
  echo "Nada mudou sob \`link-audit-seals/*/seals/\` neste push: nada a entregar (nada instalado nem verificado)."
} >>"$GITHUB_STEP_SUMMARY"
echo "nada a entregar"
