#!/usr/bin/env bash
# Executa um comando em um ambiente ISOLADO para validar o projeto sem tocar em nenhum serviço:
#   - namespace de rede próprio: só o loopback do namespace (127.0.0.1 dele); sem rota externa e sem acesso às portas
#     do host (ex.: o Redis 6379 de outro projeto). A prova é feita ANTES do comando e o script aborta se falhar;
#   - ambiente limpo (env -i): nenhuma variável do shell passa;
#   - recusa-se a rodar se existir qualquer arquivo .env* na árvore (o Next, o Worker e os scripts leem .env.local,
#     .env, .env.production e .env.production.local mesmo com NODE_ENV=development; `env -i` não impede isso).
# Uso (a partir de qualquer pasta):
#   scripts/run-isolated.sh npm test
#   scripts/run-isolated.sh npx tsc --noEmit --incremental false
#   scripts/run-isolated.sh --offline-fonts npm run build   # build sem rede (fonte do Google simulada; NÃO publicar este .next)
# Requer `unshare` com namespaces de usuário (padrão no WSL2/Ubuntu). Não imprime valores de variáveis.
set -euo pipefail

FLAG=""
if [ "${1:-}" = "--offline-fonts" ]; then FLAG="--offline-fonts"; shift; fi
[ "$#" -ge 1 ] || { echo "uso: $0 [--offline-fonts] <comando...>" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Guarda: nenhum arquivo .env* além dos modelos (somente marcadores de exemplo).
FOUND="$(find . \( -path ./node_modules -o -path ./.next -o -path ./.git \) -prune -o -name '.env*' -print | grep -v -E '^\./(deploy/hostinger/\.env\.production\.example|\.env\.example)$' || true)"
if [ -n "$FOUND" ]; then
  echo "RECUSADO: há arquivos de ambiente na árvore do projeto (só os nomes; valores NÃO lidos):" >&2
  echo "$FOUND" >&2
  exit 3
fi

if [ "${GMN_ISOLATED_INNER:-0}" != "1" ]; then
  export GMN_ISOLATED_INNER=1
  # shellcheck disable=SC2086
  exec unshare -rn "$ROOT/scripts/run-isolated.sh" $FLAG "$@"
fi

# --- dentro do namespace de rede vazio ---
ip link set lo up
# /dev/tcp é recurso do bash: uma conexão que SUCEDER aborta tudo (qualquer erro = inalcançável).
if timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/443' 2>/dev/null; then echo "[isolado] FALHA: a rede externa está alcançável" >&2; exit 4; fi
if timeout 3 bash -c 'echo > /dev/tcp/127.0.0.1/6379' 2>/dev/null; then echo "[isolado] FALHA: a porta 6379 do host está alcançável" >&2; exit 4; fi
echo "[isolado] rede externa e 127.0.0.1:6379 do host inalcançáveis; ambiente limpo; sem .env* na árvore"

EXTRA=()
if [ "$FLAG" = "--offline-fonts" ]; then
  MOCK="$(mktemp --suffix=.json)"
  trap 'rm -f "$MOCK"' EXIT
  cat > "$MOCK" <<'JSON'
{"https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap":"@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(https://fonts.gstatic.com/s/inter/mock/inter-latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }"}
JSON
  EXTRA=("NEXT_FONT_GOOGLE_MOCKED_RESPONSES=$MOCK")
fi

# Sem `exec`: o trap precisa limpar o arquivo temporário depois do comando.
env -i PATH="$PATH" HOME="$HOME" NEXT_TELEMETRY_DISABLED=1 "${EXTRA[@]}" "$@"
