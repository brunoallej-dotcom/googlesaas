#!/usr/bin/env bash
# Roda os roteiros de navegador (Chromium headless) em ambiente ISOLADO, com dados fictícios e servidor local em loopback.
#   scripts/browser/run.sh [--build] [i5|i6|i7|all]      (padrão: all)
#   --build   refaz antes o build de produção offline (necessário depois de mudar o código; o .next gerado NÃO é para publicar)
# Variáveis opcionais: VISUAL_OUT (pasta de capturas e resultado-*.json; padrão: pasta nova em /tmp/gmn-browser-out-XXXXXX) e VISUAL_BROWSER (caminho do Chromium).
# Códigos de saída de cada roteiro: 0 = tudo aprovado; 1 = alguma verificação reprovada; 2 = roteiro inexistente; 3 = árvore com .env*; 77 = sem Chromium (SKIPPED); 78 = falta o build ou ele é mais antigo que src/; 79 = Node < 22.
# `--build` só vale como PRIMEIRO argumento.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BUILD=0
if [ "${1:-}" = "--build" ]; then BUILD=1; shift; fi
WHICH="${1:-all}"
OUT="${VISUAL_OUT:-$(mktemp -d /tmp/gmn-browser-out-XXXXXX)}"
mkdir -p "$OUT"
echo "saída em $OUT"

if [ "$BUILD" = "1" ]; then
  scripts/run-isolated.sh --offline-fonts npm run build > "$OUT/build.log" 2>&1 || { echo "BUILD FALHOU (ver $OUT/build.log)"; exit 1; }
  echo "build ok"
fi

case "$WHICH" in
  all) SCRIPTS="$(cd scripts/browser && ls i[0-9]*.cjs | sed 's/\.cjs$//' | tr '\n' ' ')" ;;   # todos os roteiros presentes
  i5) SCRIPTS="i5-workspace" ;;
  i6) SCRIPTS="i6-navigation" ;;
  i7) SCRIPTS="i7-homologacao" ;;
  *) echo "uso: $0 [--build] [i5|i6|i7|all]" >&2; exit 2 ;;
esac

STATUS=0
for S in $SCRIPTS; do
  [ -f "scripts/browser/$S.cjs" ] || { echo "ERRO: o roteiro scripts/browser/$S.cjs não existe"; exit 2; }
  if [ -n "${VISUAL_BROWSER:-}" ]; then
    scripts/run-isolated.sh env VISUAL_OUT="$OUT" VISUAL_BROWSER="$VISUAL_BROWSER" node "scripts/browser/$S.cjs" > "$OUT/$S.log" 2>&1
  else
    scripts/run-isolated.sh env VISUAL_OUT="$OUT" node "scripts/browser/$S.cjs" > "$OUT/$S.log" 2>&1
  fi
  CODE=$?
  echo "== $S: saída $CODE — $(grep -E 'resumo:' "$OUT/$S.log" | tail -1)"
  grep -E "FALHA" "$OUT/$S.log" | cut -c1-400
  [ "$CODE" -eq 0 ] || STATUS=1
done
exit "$STATUS"
