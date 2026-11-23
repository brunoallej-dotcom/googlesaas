#!/usr/bin/env bash
# Passo 6 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): hashes declarados ao receptor de deploy.
#  - deploy/hostinger/stack.yml (o receptor compara com a stack INSTALADA pelo responsável: E_STACK_FILE_MISMATCH);
#  - em homologação, deploy/hostinger/stack-hml.yml (§5.11); em produção, `-`;
#  - link-audit-seals/<amb>/trust-keys.txt (a lista vai no stdin do `deploy`; até 8 KiB; vazia = política fechada).
# A impressão do projeto Supabase NÃO é calculada aqui: sai do segredo só dentro do passo do `deploy` e só vai ao receptor (nunca ao
# resumo nem às saídas do passo, que o log mostra).
# Ambiente: GMN_AMB. Saídas do passo: stack_sha256, overlay_sha256, trust_sha256 (públicos).
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

gmn_require_amb
trust_file="link-audit-seals/${GMN_AMB}/trust-keys.txt"

gmn_regular_file "$GMN_CI_STACK_FILE" || gmn_fail HASH_INPUT_MISSING stack.yml
gmn_regular_file "$trust_file" || gmn_fail HASH_INPUT_MISSING trust-keys.txt
[ "$(stat -c %s -- "$trust_file")" -le "$GMN_CI_TRUST_MAX_BYTES" ] || gmn_fail TRUST_LIST_TOO_LARGE

stack_sha="$(gmn_sha256_file "$GMN_CI_STACK_FILE")"
trust_sha="$(gmn_sha256_file "$trust_file")"
overlay_sha="-"
if [ "$GMN_AMB" = homologacao ]; then
  gmn_regular_file "$GMN_CI_OVERLAY_FILE" || gmn_fail HASH_INPUT_MISSING stack-hml.yml
  overlay_sha="$(gmn_sha256_file "$GMN_CI_OVERLAY_FILE")"
fi

gmn_output stack_sha256 "$stack_sha"
gmn_output overlay_sha256 "$overlay_sha"
gmn_output trust_sha256 "$trust_sha"
echo "stack.yml sha256=${stack_sha}"
echo "stack-hml.yml sha256=${overlay_sha}"
echo "trust-keys.txt (${GMN_AMB}) sha256=${trust_sha}"
