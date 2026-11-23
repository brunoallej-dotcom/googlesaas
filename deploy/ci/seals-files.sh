#!/usr/bin/env bash
# Passo 1 do job `seals-deliver` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.2): no checkout do SHA, calcula o sha256 da lista de
# confiança do ambiente e monta a lista ORDENADA de TODOS os arquivos de link-audit-seals/<amb>/seals/ a entregar: manifestos por `auditId` e
# por `seq` (a ordem dos bytes do caminho, que tem largura fixa), depois os fechos. Só git, sha256sum e utilitários do sistema: nenhum npm,
# node ou código do repositório (P9-W09; a verificação com código já rodou no `seals-verify`, sem segredo).
# Cada arquivo: caminho na gramática do receptor (§5.7), modo 100644 no git, arquivo comum no checkout (sem link), até 256 KiB e bytes do
# checkout = blob do commit (`git hash-object --no-filters`). Teto de 1000 arquivos, conferido antes de olhar qualquer um (SEALS_TOO_MANY).
# Ambiente: GMN_AMB, GMN_SHA. Saídas: trust_sha256 e count; a lista em $RUNNER_TEMP/gmn-seals/files (0600), uma linha `<relpath> <sha256>`.
# Saída pública: códigos fixos e o caminho relativo só quando ele casa a gramática (o resumo o publica de qualquer forma).
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly TREE_ENTRY='^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})$'

gmn_require_amb
gmn_require_sha
[ "$(git rev-parse HEAD)" = "$GMN_SHA" ] || gmn_fail CHECKOUT_MISMATCH

trust_file="link-audit-seals/${GMN_AMB}/trust-keys.txt"
gmn_regular_file "$trust_file" || gmn_fail HASH_INPUT_MISSING trust-keys.txt
[ "$(stat -c %s -- "$trust_file")" -le "$GMN_CI_TRUST_MAX_BYTES" ] || gmn_fail TRUST_LIST_TOO_LARGE
trust_sha256="$(gmn_sha256_file "$trust_file")"
gmn_output trust_sha256 "$trust_sha256"

seals_dir="link-audit-seals/${GMN_AMB}/seals"
umask 077
rm -rf -- "$GMN_CI_SEALS_DIR"
mkdir -m 0700 -- "$GMN_CI_SEALS_DIR"
tree="${GMN_CI_SEALS_DIR}/tree"
git -c core.quotePath=false ls-tree -r -z HEAD -- "${seals_dir}/" >"$tree" || gmn_fail CHECKOUT_MISMATCH
count="$(tr -cd '\0' <"$tree" | wc -c)"
[ "$count" -le "$GMN_CI_SEALS_MAX_FILES" ] || gmn_fail SEALS_TOO_MANY
[ "$count" -ge 1 ] || gmn_fail SEALS_EMPTY

: >"${GMN_CI_SEALS_DIR}/manifests"
: >"${GMN_CI_SEALS_DIR}/closures"
while IFS= read -r -d '' entry; do
  meta="${entry%%$'\t'*}"
  relpath="${entry#*$'\t'}"
  relpath="${relpath#"${seals_dir}/"}"
  if [[ "$relpath" =~ $GMN_CI_SEAL_RELPATH ]]; then
    bucket=manifests
  elif [[ "$relpath" =~ $GMN_CI_CLOSURE_RELPATH ]]; then
    bucket=closures
  else
    gmn_fail SEALS_UNEXPECTED_PATH
  fi
  [[ "$meta" =~ $TREE_ENTRY ]] || gmn_fail SEALS_BAD_MODE "$relpath"
  object="${BASH_REMATCH[1]}"
  file="${seals_dir}/${relpath}"
  gmn_regular_file "$file" || gmn_fail SEALS_BAD_MODE "$relpath"
  [ "$(stat -c %s -- "$file")" -le "$GMN_CI_SEAL_MAX_BYTES" ] || gmn_fail SEALS_TOO_LARGE "$relpath"
  [ "$(git hash-object --no-filters -- "$file")" = "$object" ] || gmn_fail CHECKOUT_MISMATCH "$relpath"
  printf '%s %s\n' "$relpath" "$(gmn_sha256_file "$file")" >>"${GMN_CI_SEALS_DIR}/${bucket}"
done <"$tree"

# Ordem determinística (§5.5.2): manifestos por auditId e seq (caminho de largura fixa, ordem dos bytes), depois os fechos.
{
  LC_ALL=C sort -- "${GMN_CI_SEALS_DIR}/manifests"
  LC_ALL=C sort -- "${GMN_CI_SEALS_DIR}/closures"
} >"${GMN_CI_SEALS_DIR}/files"
manifests="$(wc -l <"${GMN_CI_SEALS_DIR}/manifests")"
closures="$(wc -l <"${GMN_CI_SEALS_DIR}/closures")"
rm -f -- "$tree" "${GMN_CI_SEALS_DIR}/manifests" "${GMN_CI_SEALS_DIR}/closures"
gmn_output count "$count"
echo "${count} arquivo(s) a entregar (${manifests} manifesto(s), ${closures} fecho(s)); lista de confiança do commit: sha256 ${trust_sha256}"
