#!/usr/bin/env bash
# Passo 4 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): constrói os alvos `web` e `worker` de
# deploy/hostinger/Dockerfile a partir do commit exato, linux/amd64, com a tag <amb>-<sha40> (a URL do Supabase é embutida no build:
# as imagens de homologação e de produção do mesmo commit são diferentes).
# Ambiente: GMN_AMB, GMN_SHA e os dois argumentos públicos do build, NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY
# (segredos do ambiente do GitHub, para não expor o projeto no log público). `--build-arg NOME` SEM `=valor`: o Docker lê o valor do
# ambiente, e ele nunca aparece na linha de comando. O `npm ci` roda DENTRO do build, isolado do runner; sem cache do GitHub, sem
# registry, sem push.
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

gmn_require_amb
gmn_require_sha
[ "$(git rev-parse HEAD)" = "$GMN_SHA" ] || gmn_fail CHECKOUT_MISMATCH
[ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ] || gmn_fail BUILD_CONFIG_MISSING GMN_BUILD_SUPABASE_URL
[ -n "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ] || gmn_fail BUILD_CONFIG_MISSING GMN_BUILD_SUPABASE_ANON_KEY
case "$NEXT_PUBLIC_SUPABASE_URL" in
  https://*) ;;
  *) gmn_fail BUILD_CONFIG_INVALID GMN_BUILD_SUPABASE_URL ;;
esac

tag="$(gmn_image_tag)"
for target in web worker; do
  docker build --platform linux/amd64 -f deploy/hostinger/Dockerfile --target "$target" \
    --build-arg NEXT_PUBLIC_SUPABASE_URL \
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY \
    -t "gmn-${target}:${tag}" . || gmn_fail BUILD_FAILED "$target"
done
echo "imagens construídas: gmn-web:${tag} gmn-worker:${tag}"
