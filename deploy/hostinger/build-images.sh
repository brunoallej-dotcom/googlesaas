#!/usr/bin/env bash
# Constrói as imagens de produção LOCALMENTE (máquina de desenvolvimento), sem enviar nada a registry nem à VPS.
# Uso:  NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... deploy/hostinger/build-images.sh 1.0.0
# Saída: deploy/hostinger/dist/gmn-images-<tag>.tar.gz + .sha256 (para scp -> docker load na VPS).
set -euo pipefail

TAG="${1:?uso: build-images.sh <tag>  (ex.: 1.0.0)}"
: "${NEXT_PUBLIC_SUPABASE_URL:?defina a URL pública do Supabase}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?defina a chave ANÔNIMA (pública) do Supabase; nunca a service role}"

cd "$(dirname "$0")/../.."
PLATFORM="${GMN_BUILD_PLATFORM:-linux/amd64}"   # a VPS é x86_64 (Ubuntu 22.04)
DIST="deploy/hostinger/dist"
mkdir -p "$DIST"

for target in web worker; do
  docker build --platform "$PLATFORM" -f deploy/hostinger/Dockerfile --target "$target" \
    --build-arg "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" \
    --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
    -t "gmn-${target}:${TAG}" .
done

docker save "gmn-web:${TAG}" "gmn-worker:${TAG}" | gzip -9 > "${DIST}/gmn-images-${TAG}.tar.gz"
(cd "$DIST" && sha256sum "gmn-images-${TAG}.tar.gz" > "gmn-images-${TAG}.tar.gz.sha256")

echo "Imagens:"
docker image inspect --format '  {{index .RepoTags 0}}  id={{.Id}}  tamanho={{.Size}}' "gmn-web:${TAG}" "gmn-worker:${TAG}"
echo "Pacote: ${DIST}/gmn-images-${TAG}.tar.gz"
cat "${DIST}/gmn-images-${TAG}.tar.gz.sha256"
