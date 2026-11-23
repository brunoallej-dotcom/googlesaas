#!/usr/bin/env bash
# Passo 1 do job `seals-deliver` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.2): a partir dos objetos IMUTÁVEIS do git no SHA da
# execução (nunca dos caminhos do checkout; revisão do PR #74, item 6), calcula o sha256 da lista de confiança do ambiente e monta a lista
# ORDENADA de TODOS os arquivos de link-audit-seals/<amb>/seals/ a entregar: manifestos por `auditId` e por `seq` (a ordem dos bytes do
# caminho, que tem largura fixa), depois os fechos. Cada arquivo é copiado UMA vez do blob (`git cat-file blob`, tamanho conferido antes e
# depois) para uma cópia privada 0600, cujo sha256 vai para a lista; o `put` do passo 4 lê só essa cópia (e confere o sha256 de novo). Só
# git, sha256sum e utilitários do sistema: nenhum npm, node ou código do repositório (P9-W09).
# Cada arquivo: caminho na gramática do receptor (§5.7), modo 100644 blob no git e até 256 KiB. Teto de 1000 arquivos, conferido antes de
# olhar qualquer um (SEALS_TOO_MANY).
# Ambiente: GMN_AMB, GMN_SHA. Saídas: trust_sha256 e count. Em $RUNNER_TEMP/gmn-seals (0700): `files` (0600, uma linha `<relpath> <sha256>`)
# e `blobs/<sha256>` (0600, os bytes exatos de cada arquivo). Saída pública: códigos fixos e o caminho relativo só quando ele casa a gramática.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly TREE_ENTRY='^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})$'

gmn_require_amb
gmn_require_sha
[ "$(git rev-parse HEAD)" = "$GMN_SHA" ] || gmn_fail CHECKOUT_MISMATCH

umask 077
rm -rf -- "$GMN_CI_SEALS_DIR"
mkdir -m 0700 -- "$GMN_CI_SEALS_DIR" "${GMN_CI_SEALS_DIR}/blobs"

# A lista de confiança do commit: blob 100644, até 8 KiB (tamanho do objeto conferido antes de ler), sha256 dos bytes do blob.
trust_entry="$(git ls-tree "$GMN_SHA" -- "link-audit-seals/${GMN_AMB}/trust-keys.txt")" || gmn_fail CHECKOUT_MISMATCH
[[ "${trust_entry%%$'\t'*}" =~ $TREE_ENTRY ]] || gmn_fail HASH_INPUT_MISSING trust-keys.txt
trust_object="${BASH_REMATCH[1]}"
[ "$(git cat-file -s "$trust_object")" -le "$GMN_CI_TRUST_MAX_BYTES" ] || gmn_fail TRUST_LIST_TOO_LARGE
trust_sha256="$(git cat-file blob "$trust_object" | sha256sum | cut -d' ' -f1)" || gmn_fail HASH_INPUT_MISSING trust-keys.txt
gmn_is_hex "$trust_sha256" 64 || gmn_fail HASH_INPUT_MISSING trust-keys.txt
gmn_output trust_sha256 "$trust_sha256"

seals_dir="link-audit-seals/${GMN_AMB}/seals"
tree="${GMN_CI_SEALS_DIR}/tree"
git -c core.quotePath=false ls-tree -r -z "$GMN_SHA" -- "${seals_dir}/" >"$tree" || gmn_fail CHECKOUT_MISMATCH
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
  size="$(git cat-file -s "$object")" || gmn_fail CHECKOUT_MISMATCH "$relpath"
  [ "$size" -le "$GMN_CI_SEAL_MAX_BYTES" ] || gmn_fail SEALS_TOO_LARGE "$relpath"
  copy="${GMN_CI_SEALS_DIR}/blobs/.copia"
  git cat-file blob "$object" >"$copy" || gmn_fail CHECKOUT_MISMATCH "$relpath"
  [ "$(stat -c %s -- "$copy")" = "$size" ] || gmn_fail CHECKOUT_MISMATCH "$relpath"
  digest="$(gmn_sha256_file "$copy")"
  mv -f -- "$copy" "${GMN_CI_SEALS_DIR}/blobs/${digest}"
  printf '%s %s\n' "$relpath" "$digest" >>"${GMN_CI_SEALS_DIR}/${bucket}"
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
