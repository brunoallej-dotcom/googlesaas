#!/usr/bin/env bash
# Job `seals` do ci.yml (P9.2; spec docs/specs/ci-deploy-and-seal-delivery.md §5.4): prepara, sem rede e sem segredo, as
# entradas do `npm run link-audit:seals-check` e diz se algo mudou sob link-audit-seals/.
#
# Roda a partir da revisão CONFIÁVEL (a base, numa pasta própria; revisão do PR #68): o código que verifica não vem do PR
# verificado. O checkout do PR é só dado: o git lê dele a mudança e os modos.
#
# Entradas (ambiente; nunca ${{ }} no run:): SEALS_BASE (o commit-base já resolvido pelo passo anterior), SEALS_HEAD (a pasta
# do checkout do PR), SEALS_OUT (pasta de trabalho), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (opcional).
# Saídas: changed=true|false em GITHUB_OUTPUT; com mudança, em SEALS_OUT: changes (git diff --name-status --no-renames -z, sem
# esconder submódulo nenhum), modes (git ls-tree -r -z) e base-trust/<amb>/trust-keys.txt (a lista do commit-base, quando
# existe, com o tamanho conferido ANTES de ser lida). Saída pública: só códigos fixos e o commit-base; nunca conteúdo de arquivo.
set -euo pipefail

readonly SEALS_PATH='link-audit-seals'
readonly ENVIRONMENTS=(producao homologacao)
readonly OBJECT_NAME='^([0-9a-f]{40}|[0-9a-f]{64})$'
readonly MAX_TRUST_LIST_BYTES=8192

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi
}

refuse() {
  printf 'ERRO %s\n' "$1" >&2
  summary '### seals (append-only, v2)' '' "Resultado: \`ERRO $1\`"
  exit 2
}

# git sobre o checkout do PR, sem nada que o próprio PR possa configurar para esconder ou reescrever a mudança: submódulos sempre
# visíveis (um .gitmodules com `ignore = all` esconderia um gitlink do diff), sem diff externo nem textconv, caminhos crus (-z).
g() {
  git -C "$SEALS_HEAD" -c diff.ignoreSubmodules=none -c core.quotePath=false "$@"
}

[ -n "${SEALS_OUT:-}" ] && [ -n "${GITHUB_OUTPUT:-}" ] && [ -n "${SEALS_HEAD:-}" ] || refuse SEALS_USAGE
base="${SEALS_BASE:-}"
[[ "$base" =~ $OBJECT_NAME ]] || refuse SEALS_NO_BASE
g cat-file -e "${base}^{commit}" 2>/dev/null || refuse SEALS_NO_BASE

mkdir -p "$SEALS_OUT/base-trust"
g diff --name-status --no-renames --ignore-submodules=none --no-ext-diff --no-textconv -z "$base" HEAD -- "$SEALS_PATH" > "$SEALS_OUT/changes"

if [ ! -s "$SEALS_OUT/changes" ]; then
  echo 'changed=false' >> "$GITHUB_OUTPUT"
  summary '### seals (append-only, v2)' '' "Nada mudou sob \`$SEALS_PATH/\` desde \`$base\`: nada a verificar (sem instalar nada)."
  exit 0
fi

g ls-tree -r -z HEAD -- "$SEALS_PATH" > "$SEALS_OUT/modes"
for env in "${ENVIRONMENTS[@]}"; do
  list="$SEALS_PATH/$env/trust-keys.txt"
  entry="$(g ls-tree "$base" -- "$list")"
  if [ -z "$entry" ]; then continue; fi
  case "$entry" in
    "100644 blob "*) ;;
    *) refuse SEALS_BAD_MODE ;;
  esac
  object="$(printf '%s' "$entry" | cut -d ' ' -f 3 | cut -f 1)"
  [[ "$object" =~ $OBJECT_NAME ]] || refuse SEALS_BAD_MODE
  size="$(g cat-file -s "$object")"
  if [ "$size" -gt "$MAX_TRUST_LIST_BYTES" ]; then refuse SEALS_TOO_LARGE; fi # conferido ANTES de materializar a lista
  mkdir -p "$SEALS_OUT/base-trust/$env"
  g cat-file blob "$object" > "$SEALS_OUT/base-trust/$env/trust-keys.txt"
done

echo 'changed=true' >> "$GITHUB_OUTPUT"
printf 'Base da comparação: %s\n' "$base"
