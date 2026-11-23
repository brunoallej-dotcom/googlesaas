#!/usr/bin/env bash
# Job `seals` do ci.yml (P9.2; spec docs/specs/ci-deploy-and-seal-delivery.md §5.4): prepara, sem rede e sem segredo, as
# entradas do `npm run link-audit:seals-check` e diz se algo mudou sob link-audit-seals/.
#
# Base da comparação: no pull_request, o primeiro pai do commit de merge (HEAD^1); no push, github.event.before. Sem base
# utilizável (before todo zero de um branch novo, before que não está no histórico, evento desconhecido) a spec é omissa:
# falha FECHADA com SEALS_NO_BASE (nada é dado como "sem mudança").
#
# Entradas (ambiente; nunca ${{ }} no run:): SEALS_EVENT (github.event_name), SEALS_BEFORE (github.event.before),
# SEALS_OUT (pasta de trabalho), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (opcional).
# Saídas: changed=true|false em GITHUB_OUTPUT; com mudança, em SEALS_OUT: changes (git diff --name-status --no-renames -z),
# modes (git ls-tree -r -z) e base-trust/<amb>/trust-keys.txt (a lista do commit-base, quando existe).
# Saída pública: só códigos fixos e o commit-base. Nunca conteúdo de arquivo.
set -euo pipefail

readonly SEALS_PATH='link-audit-seals'
readonly ENVIRONMENTS=(producao homologacao)
readonly OBJECT_NAME='^([0-9a-f]{40}|[0-9a-f]{64})$'
readonly ALL_ZERO='^0+$'

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi
}

refuse() {
  printf 'ERRO %s\n' "$1" >&2
  summary '### seals (append-only, v2)' '' "Resultado: \`ERRO $1\`"
  exit 2
}

[ -n "${SEALS_OUT:-}" ] && [ -n "${GITHUB_OUTPUT:-}" ] || refuse SEALS_USAGE

case "${SEALS_EVENT:-}" in
  pull_request)
    base="$(git rev-parse --verify --quiet 'HEAD^1^{commit}')" || refuse SEALS_NO_BASE
    ;;
  push)
    before="${SEALS_BEFORE:-}"
    if ! [[ "$before" =~ $OBJECT_NAME ]] || [[ "$before" =~ $ALL_ZERO ]]; then refuse SEALS_NO_BASE; fi
    git cat-file -e "${before}^{commit}" 2>/dev/null || refuse SEALS_NO_BASE
    base="$before"
    ;;
  *)
    refuse SEALS_NO_BASE
    ;;
esac

mkdir -p "$SEALS_OUT/base-trust"
git diff --name-status --no-renames -z "$base" HEAD -- "$SEALS_PATH" > "$SEALS_OUT/changes"

if [ ! -s "$SEALS_OUT/changes" ]; then
  echo 'changed=false' >> "$GITHUB_OUTPUT"
  summary '### seals (append-only, v2)' '' "Nada mudou sob \`$SEALS_PATH/\` desde \`$base\`: nada a verificar (sem instalar nada)."
  exit 0
fi

git ls-tree -r -z HEAD -- "$SEALS_PATH" > "$SEALS_OUT/modes"
for env in "${ENVIRONMENTS[@]}"; do
  list="$SEALS_PATH/$env/trust-keys.txt"
  entry="$(git ls-tree "$base" -- "$list")"
  if [ -z "$entry" ]; then continue; fi
  case "$entry" in
    "100644 blob "*) ;;
    *) refuse SEALS_BAD_MODE ;;
  esac
  mkdir -p "$SEALS_OUT/base-trust/$env"
  git cat-file blob "$base:$list" > "$SEALS_OUT/base-trust/$env/trust-keys.txt"
done

echo 'changed=true' >> "$GITHUB_OUTPUT"
printf 'Base da comparação: %s\n' "$base"
