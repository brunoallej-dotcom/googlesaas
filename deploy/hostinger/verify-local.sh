#!/usr/bin/env bash
# Validação LOCAL das imagens e da stack: sem VPS, sem Supabase/Redis/Serper reais, sem rede externa nos containers.
# (O build baixa a imagem-base e os pacotes npm; os containers de teste rodam em rede --internal.)
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="verify"
NET="gmn-verify-net"
WEB="gmn-verify-web"
fail() { echo "FALHOU: $*" >&2; exit 1; }
cleanup() { docker rm -f "$WEB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1) stack.yml renderiza (compose e swarm)"
export GMN_HOST=gmn.exemplo.invalid GMN_IMAGE_TAG="$TAG" GMN_NODE_HOSTNAME=no-teste NEXT_PUBLIC_SUPABASE_URL=https://exemplo.supabase.co GMN_OPERATOR_EMAILS=op@exemplo.invalid
docker compose -f deploy/hostinger/stack.yml config -q
docker stack config -c deploy/hostinger/stack.yml >/dev/null

echo "== 2) build (valores públicos fictícios)"
for target in web worker; do
  docker build -f deploy/hostinger/Dockerfile --target "$target" \
    --build-arg NEXT_PUBLIC_SUPABASE_URL=https://exemplo.supabase.co --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-fake-publica \
    -t "gmn-${target}:${TAG}" . >/dev/null
done

echo "== 3) conteúdo das imagens"
for image in web worker; do
  [ "$(docker run --rm --entrypoint id "gmn-${image}:${TAG}" -u)" = "10001" ] || fail "${image}: não roda como uid 10001"
  docker run --rm --entrypoint sh "gmn-${image}:${TAG}" -c 'test -z "$(find /app -maxdepth 1 -name ".env*")" && test -f /app/assets/fonts/Inter-400.woff' || fail "${image}: .env na imagem ou fonte ausente"
  docker run --rm --entrypoint sh "gmn-${image}:${TAG}" -c 'test -z "$(ls -A /app/.data/audits)" && test ! -e /app/tests && test ! -e /app/docs' || fail "${image}: dados/tests/docs na imagem"
done

echo "== 4) entrypoint falha fechada"
BASE=(-e GMN_ROLE=web -e NODE_ENV=production -e SUPABASE_SERVICE_ROLE_KEY=x -e GMN_OPERATOR_EMAILS=a@b.co -e NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co -e NEXT_PUBLIC_SUPABASE_ANON_KEY=y -e "REDIS_URL=redis://:senha@gmn-redis:6379/0")
expect_refusal() { if docker run --rm "${BASE[@]}" "$@" "gmn-web:${TAG}" true >/dev/null 2>&1; then fail "deveria recusar: $*"; fi; }
expect_refusal -e GMN_AUTH_DISABLED=true
expect_refusal -e NODE_ENV=development
expect_refusal -e GMN_DEMO_MODE=true
expect_refusal -e GMN_ROLE=outro
expect_refusal -e "REDIS_URL=redis://:senha@redis:6379/0"
expect_refusal -e "REDIS_URL=redis://redis-do-vra:6379"
docker run --rm "${BASE[@]}" "gmn-web:${TAG}" true >/dev/null 2>&1 || fail "configuração válida foi recusada"

echo "== 5) web sobe, healthcheck, 401 sem sessão, cabeçalhos (rede interna, sem egress)"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$WEB" --network "$NET" --read-only --tmpfs /tmp --tmpfs /app/.next/cache --cap-drop ALL "${BASE[@]}" "gmn-web:${TAG}" >/dev/null
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$WEB")"; [ "$status" = healthy ] && break; sleep 2
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "$WEB")" = healthy ] || { docker logs "$WEB" | tail -20; fail "web não ficou healthy"; }
probe() { docker exec "$WEB" node -e "fetch('http://127.0.0.1:3000$1',{method:'${2:-GET}',redirect:'manual',headers:{host:'gmn.exemplo.invalid'${3:-}}}).then(async r=>{console.log(r.status, [...r.headers.keys()].join(','));process.exit(0)})"; }
probe /login | grep -q '^200 ' || fail "/login não respondeu 200"
probe /api/prospect | grep -q '^401 ' || fail "/api/prospect sem sessão deveria ser 401"
probe /api/system/health | grep -q '^401 ' || fail "health sem sessão deveria ser 401"
probe /dev/battlefield-preview | grep -q '^404 ' || fail "/dev deveria ser 404 em produção"
probe /api/audit/completed | grep -q '^401 ' || fail "/api/audit/completed sem sessão deveria ser 401"
# o bypass de desenvolvimento não funciona nem com Host de loopback
docker exec "$WEB" node -e "fetch('http://127.0.0.1:3000/api/prospect',{method:'POST',headers:{host:'localhost:3000','content-type':'application/json'},body:'{}'}).then(r=>{console.log(r.status);process.exit(r.status===401||r.status===403?0:1)})" || fail "Host loopback não pode abrir o acesso"
docker exec "$WEB" node -e "fetch('http://127.0.0.1:3000/login',{headers:{host:'gmn.exemplo.invalid'}}).then(r=>{const h=r.headers;const ok=h.get('x-frame-options')==='DENY'&&h.get('x-content-type-options')==='nosniff'&&h.get('content-security-policy-report-only')&&!h.get('x-powered-by');process.exit(ok?0:1)})" || fail "cabeçalhos de segurança ausentes"

echo "== 6) worker: módulos resolvem; o Worker NÃO é iniciado"
docker run --rm --entrypoint node "gmn-worker:${TAG}" -e "for (const m of ['tsx/package.json','bullmq','ioredis','@next/env','@supabase/supabase-js','zod','pdfkit']) require.resolve(m); console.log('modulos ok')" | grep -q 'modulos ok' || fail "worker: módulo ausente"
docker run --rm --entrypoint node "gmn-worker:${TAG}" --import tsx -e "console.log('tsx ok')" | grep -q 'tsx ok' || fail "worker: tsx não executa"
docker run --rm --network none --entrypoint node "gmn-worker:${TAG}" --import tsx -e "const m=require('./src/workers/audit-worker.ts'); console.log('import ok', typeof m.startAuditWorker)" | grep -q 'import ok function' || fail "worker: o módulo real não carrega sob tsx (alias @/)"
docker run --rm --entrypoint sh "gmn-worker:${TAG}" -c 'test -f /app/tsconfig.json && test -f /app/src/workers/audit-worker.ts' || fail "worker: tsconfig/src ausentes"

echo "TUDO OK"
