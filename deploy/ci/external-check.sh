#!/usr/bin/env bash
# Passo 10 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): verificação externa SOMENTE LEITURA, do runner,
# contra https://$GMN_PUBLIC_HOST, com repetição por até 2 min. TLS válido (o curl verifica; nunca -k), sem seguir redirecionamento,
# sem cookie nem credencial. Só os ids e os códigos HTTP vão ao log (nunca o domínio, que é segredo do ambiente).
#   EX-01 /login = 200 · EX-02 /api/system/health = 401 · EX-03 /api/link-audit/evidence = 401
# - A URL vai ao curl pela configuração no stdin (`--config -`), nunca na linha de comando; `-q` (primeiro argumento) ignora .curlrc.
# - Cada chamada só conta se o curl sair com 0 (um código impresso antes de um erro, como o 28 de prazo, NÃO vale).
# - O prazo de 2 min é conferido antes de cada tentativa e de cada chamada; o `--max-time` de cada chamada é o menor entre o teto por
#   chamada e o tempo que falta.
# Ambiente: GMN_PUBLIC_HOST. Saída do passo: ex (ex.: "EX-01:200 EX-02:401 EX-03:401").
set -euo pipefail
cd "$(dirname "$0")/../.."
. deploy/ci/lib.sh

readonly HOST_PATTERN='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
readonly ATTEMPTS=12
readonly INTERVAL_SECONDS=10
readonly DEADLINE_SECONDS=120
readonly REQUEST_TIMEOUT_SECONDS=10
readonly -a CHECKS=(
  "EX-01 /login 200"
  "EX-02 /api/system/health 401"
  "EX-03 /api/link-audit/evidence 401"
)

[[ "${GMN_PUBLIC_HOST:-}" =~ $HOST_PATTERN ]] || gmn_fail EX_CONFIG_INVALID GMN_PUBLIC_HOST

now() {
  local value
  value="$(date +%s)"
  [[ "$value" =~ ^[0-9]+$ ]] || gmn_fail INTERNAL clock
  printf '%s' "$value"
}
start="$(now)"
remaining() { printf '%s' "$((DEADLINE_SECONDS - ($(now) - start)))"; }

# http_code CAMINHO: o código HTTP, ou 000 se o curl não saiu com 0, se não sobrou tempo ou se a saída não é um código.
http_code() {
  local left max_time code rc
  left="$(remaining)"
  if [ "$left" -le 0 ]; then
    printf '000'
    return 0
  fi
  max_time=$((left < REQUEST_TIMEOUT_SECONDS ? left : REQUEST_TIMEOUT_SECONDS))
  set +e
  code="$(printf 'url = "https://%s%s"\n' "$GMN_PUBLIC_HOST" "$1" |
    curl -q --silent --output /dev/null --write-out '%{http_code}' --proto '=https' --tlsv1.2 --max-redirs 0 \
      --max-time "$max_time" --config - 2>/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || ! [[ "$code" =~ ^[0-9]{3}$ ]]; then code=000; fi
  printf '%s' "$code"
}

summary=""
first_failure="EX-01"
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  [ "$(remaining)" -gt 0 ] || break
  summary=""
  first_failure=""
  for check in "${CHECKS[@]}"; do
    read -r id path expected <<<"$check"
    code="$(http_code "$path")"
    summary="${summary:+$summary }${id}:${code}"
    if [ "$code" != "$expected" ] && [ -z "$first_failure" ]; then first_failure="$id"; fi
  done
  echo "tentativa ${attempt}/${ATTEMPTS}: ${summary}"
  [ -n "$first_failure" ] || break
  [ "$attempt" -lt "$ATTEMPTS" ] || break
  left="$(remaining)"
  [ "$left" -gt 0 ] || break
  sleep "$((left < INTERVAL_SECONDS ? left : INTERVAL_SECONDS))"
done

[ -z "$summary" ] || gmn_output ex "$summary"
[ -z "$first_failure" ] || gmn_fail EX_CHECK_FAILED "$first_failure"
echo "verificação externa: OK (${summary})"
