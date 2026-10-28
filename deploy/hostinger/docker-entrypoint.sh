#!/bin/sh
# Entrypoint comum (web e worker). Falha FECHADA antes de iniciar o processo:
#  - carrega segredos de arquivos (Docker/Swarm secrets) para variáveis de ambiente;
#  - recusa configurações perigosas (bypass de autenticação, modo demo, .env dentro da imagem);
#  - exige as variáveis mínimas do papel (GMN_ROLE=web|worker).
set -eu

fail() {
  echo "[gmn-entrypoint] RECUSADO: $1" >&2
  exit 78
}

# 1) Segredos por arquivo (lista fixa: nada de varrer o ambiente).
for name in SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY SERPER_API_KEY REDIS_URL; do
  eval "file=\${${name}_FILE:-}"
  if [ -n "$file" ]; then
    [ -r "$file" ] || fail "segredo ilegível: $file"
    value="$(cat "$file")"
    [ -n "$value" ] || fail "segredo vazio: $file"
    export "$name=$value"
    unset "${name}_FILE"
  fi
done

# 2) Produção, sem bypass, sem demo, sem .env na imagem.
[ "${NODE_ENV:-}" = "production" ] || fail "NODE_ENV precisa ser 'production' (valor atual: '${NODE_ENV:-}')"
[ -z "${GMN_AUTH_DISABLED:-}" ] || fail "GMN_AUTH_DISABLED não pode existir em produção"
[ "${GMN_DEMO_MODE:-}" != "true" ] || fail "GMN_DEMO_MODE=true (dados simulados) é proibido em produção"
if [ -n "$(find /app -maxdepth 1 -name '.env*' ! -name '.env.example' 2>/dev/null)" ]; then
  fail "há arquivo .env* dentro da imagem (o ambiente vem só de variáveis e segredos)"
fi

# 3) Variáveis mínimas por papel.
role="${GMN_ROLE:-}"
case "$role" in
  web|worker) ;;
  *) fail "GMN_ROLE precisa ser 'web' ou 'worker'" ;;
esac
for required in SUPABASE_SERVICE_ROLE_KEY GMN_OPERATOR_EMAILS REDIS_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
  eval "value=\${${required}:-}"
  [ -n "$value" ] || fail "variável obrigatória ausente: $required"
done
case "${REDIS_URL}" in
  redis://:*@gmn-redis:*|rediss://:*@gmn-redis:*) ;;
  *) fail "REDIS_URL precisa usar senha e o host exclusivo 'gmn-redis' (nunca o Redis de outro serviço)" ;;
esac

echo "[gmn-entrypoint] papel=${role} ok" >&2
exec "$@"
