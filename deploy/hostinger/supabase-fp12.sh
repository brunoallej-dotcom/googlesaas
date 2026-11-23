#!/usr/bin/env bash
# Impressão do projeto Supabase (spec docs/specs/ci-deploy-and-seal-delivery.md §5.6 passo 5; revisão do PR #70): os 12 primeiros hex do
# sha256 da ORIGEM CANÔNICA `https://<host em minúsculas>`, sem barra, porta, caminho, consulta nem fragmento. Assim `https://X.supabase.co/`
# e `https://x.supabase.co:443` dão a mesma impressão, e o job (deploy/ci/receiver-call.sh), o receptor (src/lib/deploy-receiver/supabase.ts,
# mesma regra, conferida por teste) e o responsável (runbook H-04) calculam igual.
# Aceito: `https://` + host DNS (letras, dígitos, hífen e ponto; rótulos de 1 a 63; pelo menos dois rótulos) + `:443` opcional + `/` opcional.
# Qualquer outra coisa (http, usuário ou senha, outra porta, caminho, consulta, fragmento, espaço, mais de uma linha) ⇒ saída 1, sem imprimir.
# Uso: printf '%s' "$URL" | bash deploy/hostinger/supabase-fp12.sh   (a URL vem do stdin, nunca da linha de comando; só os 12 hex saem)
set -euo pipefail
export LC_ALL=C

url=''
IFS= read -r url || [ -n "$url" ] || exit 1
if IFS= read -r _extra || [ -n "${_extra:-}" ]; then exit 1; fi
[[ "$url" =~ ^https://([A-Za-z0-9.-]+)(:443)?/?$ ]] || exit 1
host="${BASH_REMATCH[1],,}"
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
[[ "$host" =~ ^${label}(\.${label})+$ ]] || exit 1
printf 'https://%s' "$host" | sha256sum | cut -c1-12
