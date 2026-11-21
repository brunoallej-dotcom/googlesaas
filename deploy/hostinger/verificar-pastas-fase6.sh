#!/usr/bin/env bash
# Pré-requisito da implantação da G1.a (spec dos portões §5.3, VC-E1/VC-E8; resultado registrado no ensaio EN-12 da G2 e na linha G-3 do
# portão). Confere, SÓ LENDO, as seis pastas da Fase 6 no host e FALHA (saída 1) se:
#  - alguma não existe ou não é diretório;
#  - o modo não é 0700 (o dono 10001:10001 é conferido à parte, com `stat -c '%u:%g %a %n'`, no GUIA-DE-IMPLANTACAO.md §3.3);
#  - duas resolvem (realpath, links simbólicos inclusive) para a mesma pasta, ou uma está dentro de outra (o código recusa);
#  - algum dos DOIS volumes de recibos divide dispositivo (stat -c %d) com algum dos DOIS volumes de dados (decisões e resultados: matriz
#    completa, não só "cada recibo × os próprios dados"), ou o livro divide dispositivo com dados ou recibos (checklist de produção §1:
#    "mesmo disco não é backup independente"; GUIA-DE-IMPLANTACAO.md §3.3).
# Uso: verificar-pastas-fase6.sh <decisoes> <recibos-decisoes> <resultados> <recibos-resultados> <livro> <manifestos>
#      (na VPS: os valores de GMN_RAIZ_DADOS_DECISOES, …_RECIBOS_DECISOES, …_RESULTADOS, …_RECIBOS_RESULTADOS, …_LIVRO e …_MANIFESTOS).
set -euo pipefail

NAMES=(decisoes recibos-decisoes resultados recibos-resultados livro manifestos)
fail() { echo "[verificar-pastas-fase6] RECUSADO: $1" >&2; exit 1; }

[ "$#" -eq "${#NAMES[@]}" ] || fail "uso: $0 <decisoes> <recibos-decisoes> <resultados> <recibos-resultados> <livro> <manifestos>"
ARGS=("$@")
REAL=()
DEV=()
for i in "${!NAMES[@]}"; do
  dir="${ARGS[$i]}"
  [ -d "$dir" ] || fail "${NAMES[$i]}: não é um diretório existente"
  REAL[i]="$(realpath -e -- "$dir")"
  mode="$(stat -c %a -- "${REAL[$i]}")"
  [ "$mode" = "700" ] || fail "${NAMES[$i]}: modo $mode (exigido 0700)"
  DEV[i]="$(stat -c %d -- "${REAL[$i]}")"
done

for i in "${!NAMES[@]}"; do
  for j in "${!NAMES[@]}"; do
    [ "$i" != "$j" ] || continue
    [ "${REAL[$i]}" != "${REAL[$j]}" ] || fail "${NAMES[$i]} e ${NAMES[$j]} são a mesma pasta"
    case "${REAL[$i]}/" in
      "${REAL[$j]}/"*) fail "${NAMES[$i]} está dentro de ${NAMES[$j]}" ;;
    esac
  done
done

same_device() { [ "${DEV[$1]}" = "${DEV[$2]}" ]; }
# índices: 0 decisoes, 1 recibos-decisoes, 2 resultados, 3 recibos-resultados, 4 livro, 5 manifestos
for r in 1 3; do                                         # cada volume de recibos × cada volume de dados
  for d in 0 2; do
    if same_device "$r" "$d"; then fail "${NAMES[$r]} no mesmo dispositivo que ${NAMES[$d]}"; fi
  done
done
for k in 0 1 2 3; do
  if same_device 4 "$k"; then fail "livro no mesmo dispositivo que ${NAMES[$k]}"; fi
done

echo "[verificar-pastas-fase6] OK: seis pastas distintas, modo 0700, nenhuma dentro de outra; recibos e livro em dispositivos independentes"
