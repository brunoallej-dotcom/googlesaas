# shellcheck shell=bash
# Funções comuns dos passos do job `deploy` (.github/workflows/deploy.yml; spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1).
# Carregado com `. deploy/ci/lib.sh` pelos scripts desta pasta; não é executável sozinho.
#
# Regras (testadas em tests/deploy-ci-scripts.test.ts e tests/deploy-workflow.test.ts):
#  - o log do Actions é PÚBLICO: só códigos fixos (`ERRO <CÓDIGO>[ <DETALHE>]`), hashes e campos públicos vão ao stdout/stderr.
#    Nunca host, porta, domínio, URL do Supabase, impressão do projeto, chave ou saída do ssh;
#  - nada de rastreamento do shell (o comando remoto leva a impressão do projeto Supabase);
#  - nenhum valor vem da linha de comando: tudo pelo ambiente do passo (segredos de ambiente via `env:` do workflow).

readonly GMN_CI_SSH_DIR="${RUNNER_TEMP:?RUNNER_TEMP ausente}/gmn-ssh"
readonly GMN_CI_BUNDLE_DIR="${RUNNER_TEMP}/gmn-bundle"
readonly GMN_CI_BUNDLE_FILE="${GMN_CI_BUNDLE_DIR}/gmn-images.tar.gz"
readonly GMN_CI_STACK_FILE="deploy/hostinger/stack.yml"
readonly GMN_CI_OVERLAY_FILE="deploy/hostinger/stack-hml.yml"
# Tetos da gramática do receptor de deploy (spec §5.6): pacote de 1 byte a 3 GiB; lista de confiança até 8 KiB.
readonly GMN_CI_BUNDLE_MAX_BYTES=3221225472
readonly GMN_CI_TRUST_MAX_BYTES=8192

# gmn_fail CÓDIGO [DETALHE]: registra o código na saída do passo (para o resumo) e termina com 1. O detalhe é só um nome fixo.
gmn_fail() {
  local code="$1" detail="${2:-}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'code=%s\n' "$code" >>"$GITHUB_OUTPUT"; fi
  printf 'ERRO %s%s\n' "$code" "${detail:+ $detail}" >&2
  exit 1
}

# gmn_output NOME VALOR: saída do passo (só valores públicos e já validados).
gmn_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi
}

gmn_is_hex() { [[ "$1" =~ ^[0-9a-f]+$ ]] && [ "${#1}" -eq "$2" ]; }

gmn_require_amb() {
  case "${GMN_AMB:-}" in
    homologacao | producao) ;;
    *) gmn_fail INPUT_INVALID GMN_AMB ;;
  esac
}

gmn_require_sha() {
  gmn_is_hex "${GMN_SHA:-}" 40 || gmn_fail INPUT_INVALID GMN_SHA
}

# Tag das duas imagens: <amb>-<sha40> (spec §5.5.1 passo 4).
gmn_image_tag() { printf '%s-%s' "$GMN_AMB" "$GMN_SHA"; }

gmn_sha256_file() { sha256sum -- "$1" | cut -d' ' -f1; }

# Arquivo regular (não link simbólico) e legível.
gmn_regular_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ]; }
