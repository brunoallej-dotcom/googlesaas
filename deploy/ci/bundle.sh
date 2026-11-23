#!/usr/bin/env bash
# Passo 5 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): `docker save` das duas imagens | `gzip -n` num
# arquivo em $RUNNER_TEMP, com sha256 e tamanho. O pacote NUNCA vira artefato do Actions nem vai a registry ou cache: segue só pelo
# SSH ao receptor de deploy (passo 8) e é apagado na limpeza (`if: always()`).
# Ambiente: GMN_AMB, GMN_SHA, RUNNER_TEMP. Saídas do passo: sha256, bytes.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

gmn_require_amb
gmn_require_sha
tag="$(gmn_image_tag)"

umask 077
mkdir -p -m 0700 "$GMN_CI_BUNDLE_DIR" "$GMN_CI_BUILD_DIR"
rm -f -- "$GMN_CI_BUNDLE_FILE"
docker save "gmn-web:${tag}" "gmn-worker:${tag}" 2>"${GMN_CI_BUILD_DIR}/save.log" | gzip -n >"$GMN_CI_BUNDLE_FILE" || gmn_fail BUNDLE_FAILED

bytes="$(stat -c %s -- "$GMN_CI_BUNDLE_FILE")"
if [ "$bytes" -lt 1 ] || [ "$bytes" -gt "$GMN_CI_BUNDLE_MAX_BYTES" ]; then gmn_fail BUNDLE_SIZE_OUT_OF_RANGE; fi
sha="$(gmn_sha256_file "$GMN_CI_BUNDLE_FILE")"
gmn_is_hex "$sha" 64 || gmn_fail BUNDLE_FAILED

gmn_output sha256 "$sha"
gmn_output bytes "$bytes"
echo "pacote: sha256=${sha} bytes=${bytes}"
