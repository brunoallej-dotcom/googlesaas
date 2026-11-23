#!/usr/bin/env bash
# Passo 10 do job `deploy` (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1): verificação externa SOMENTE LEITURA, do runner,
# contra https://$GMN_PUBLIC_HOST, com repetição por até 2 min. TLS válido (o curl verifica; nunca -k), sem seguir redirecionamento,
# sem cookie nem credencial. Só os ids e os códigos HTTP vão ao log (nunca o domínio, que é segredo do ambiente).
#   EX-01 /login = 200 · EX-02 /api/system/health = 401 · EX-03 /api/link-audit/evidence = 401
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

http_code() {
  local code
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --proto '=https' --tlsv1.2 --max-redirs 0 \
    --max-time "$REQUEST_TIMEOUT_SECONDS" "https://${GMN_PUBLIC_HOST}$1" 2>/dev/null || true)"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  printf '%s' "$code"
}

summary=""
first_failure=""
SECONDS=0
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
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
  if [ "$attempt" -ge "$ATTEMPTS" ] || [ "$SECONDS" -ge "$DEADLINE_SECONDS" ]; then break; fi
  sleep "$INTERVAL_SECONDS"
done

gmn_output ex "$summary"
[ -z "$first_failure" ] || gmn_fail EX_CHECK_FAILED "$first_failure"
echo "verificação externa: OK (${summary})"
