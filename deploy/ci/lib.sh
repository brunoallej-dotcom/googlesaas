# shellcheck shell=bash
# Funções comuns dos passos dos jobs `deploy`, `seals-verify` e `seals-deliver` (.github/workflows/deploy.yml; spec
# docs/specs/ci-deploy-and-seal-delivery.md §5.5, §5.5.1 e §5.5.2). Carregado com `. deploy/ci/lib.sh` pelos scripts desta pasta; não é
# executável sozinho.
#
# Regras (testadas em tests/deploy-ci-scripts.test.ts e tests/deploy-workflow.test.ts):
#  - o log do Actions é PÚBLICO: só códigos fixos (`ERRO <CÓDIGO>[ <DETALHE>]`), hashes e campos públicos vão ao stdout/stderr.
#    Nunca host, porta, domínio, URL do Supabase, impressão do projeto, chave ou saída do ssh;
#  - nada de rastreamento do shell (o comando remoto leva a impressão do projeto Supabase);
#  - nenhum valor vem da linha de comando: tudo pelo ambiente do passo (segredos de ambiente via `env:` do workflow).

readonly GMN_CI_SSH_DIR="${RUNNER_TEMP:?RUNNER_TEMP ausente}/gmn-ssh"
# Configuração privada do ssh (0600) com um apelido fixo por papel (gmn_ssh_role): host, porta e usuário nunca vão à linha de comando.
readonly GMN_CI_SSH_CONFIG="${GMN_CI_SSH_DIR}/config"
readonly GMN_CI_BUNDLE_DIR="${RUNNER_TEMP}/gmn-bundle"
# Saída do Docker (build e save) só em arquivo 0600 aqui, nunca no log público; a limpeza `if: always()` apaga a pasta.
readonly GMN_CI_BUILD_DIR="${RUNNER_TEMP}/gmn-build"
readonly GMN_CI_BUNDLE_FILE="${GMN_CI_BUNDLE_DIR}/gmn-images.tar.gz"
readonly GMN_CI_STACK_FILE="deploy/hostinger/stack.yml"
readonly GMN_CI_OVERLAY_FILE="deploy/hostinger/stack-hml.yml"
# Tetos da gramática do receptor de deploy (spec §5.6): pacote de 1 byte a 3 GiB; lista de confiança até 8 KiB.
readonly GMN_CI_BUNDLE_MAX_BYTES=3221225472
readonly GMN_CI_TRUST_MAX_BYTES=8192
# Entrega de manifestos (§5.5.2): a lista ordenada dos arquivos e o resultado de cada `put` (só campos públicos: caminho relativo, sha256,
# resultado e código), em 0600; o teto de arquivos por execução; o teto de bytes por arquivo do receptor (§5.7 passo 1); a gramática do
# `relpath` do receptor de manifestos (§5.7, a mesma de src/lib/seal-receiver/grammar.ts; paridade conferida por teste).
readonly GMN_CI_SEALS_DIR="${RUNNER_TEMP}/gmn-seals"
readonly GMN_CI_SEALS_MAX_FILES=1000
readonly GMN_CI_SEAL_MAX_BYTES=262144
readonly GMN_CI_SEAL_RELPATH='^aud-[0-9a-f]{16}/seal-(000[1-9]|00[1-9][0-9]|01[0-9][0-9]|02[0-4][0-9]|025[0-6])\.json$'
readonly GMN_CI_CLOSURE_RELPATH='^_closures/[a-z0-9][a-z0-9-]{3,31}\.json$'
readonly GMN_CI_SSH_CONNECT_FAILED_RC=255
# Teto do que o ssh pode escrever no stdout e no stderr capturados (KiB, `ulimit -f`): as respostas dos receptores têm uma linha curta.
readonly GMN_CI_SSH_OUTPUT_MAX_KIB=64

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

# gmn_ssh_role PAPEL: a chave, o usuário de host e o apelido de cada job (spec §5.5: `GMN_DEPLOY_SSH_KEY` só no `deploy`, `GMN_SEALS_SSH_KEY` só no
# `seals-deliver`; usuários do §5.10). Só literais fixos; o papel vem de um argumento FIXO do workflow (`deploy` ou `seals`), nunca de segredo
# ou entrada. Define GMN_CI_SSH_KEY_VAR (nome da variável do segredo), GMN_CI_SSH_KEY_NAME, GMN_CI_SSH_KEY_FILE, GMN_CI_SSH_ALIAS e, com
# GMN_AMB já validado, GMN_CI_SSH_USER.
gmn_ssh_role() {
  case "${1:-}" in
    deploy)
      GMN_CI_SSH_KEY_VAR=GMN_DEPLOY_SSH_KEY
      GMN_CI_SSH_KEY_NAME=id_deploy
      GMN_CI_SSH_ALIAS=gmn-receiver
      case "${GMN_AMB:-}" in producao) GMN_CI_SSH_USER=gmn-deploy ;; homologacao) GMN_CI_SSH_USER=gmn-hml-deploy ;; *) GMN_CI_SSH_USER= ;; esac
      ;;
    seals)
      GMN_CI_SSH_KEY_VAR=GMN_SEALS_SSH_KEY
      GMN_CI_SSH_KEY_NAME=id_seals
      GMN_CI_SSH_ALIAS=gmn-seal-receiver
      case "${GMN_AMB:-}" in producao) GMN_CI_SSH_USER=gmn-seals ;; homologacao) GMN_CI_SSH_USER=gmn-hml-seals ;; *) GMN_CI_SSH_USER= ;; esac
      ;;
    *) gmn_fail INPUT_INVALID role ;;
  esac
  GMN_CI_SSH_KEY_FILE="${GMN_CI_SSH_DIR}/${GMN_CI_SSH_KEY_NAME}"
}

# gmn_require_ssh_files: a chave do papel, o known_hosts e a configuração privada escritos pelo ssh-setup.sh (arquivos comuns, sem link).
gmn_require_ssh_files() {
  gmn_regular_file "$GMN_CI_SSH_KEY_FILE" || gmn_fail SSH_CONFIG_MISSING "$GMN_CI_SSH_KEY_NAME"
  gmn_regular_file "$GMN_CI_SSH_DIR/known_hosts" || gmn_fail SSH_CONFIG_MISSING known_hosts
  gmn_regular_file "$GMN_CI_SSH_CONFIG" || gmn_fail SSH_CONFIG_MISSING config
}

# gmn_receiver_ssh COMANDO ARQUIVO_STDIN: a ÚNICA chamada ssh dos jobs (receptor de deploy e de manifestos), só pela configuração privada
# (`ssh -F`: host, porta e usuário nunca na linha de comando; nenhuma outra configuração lida). O stdout e o stderr vão, SEPARADOS e com teto
# (`ulimit -f`, revisão do PR #74, item 4), para dois arquivos 0600 em $RUNNER_TEMP, que quem chama classifica e apaga: o stderr do ssh e do
# receptor NUNCA vai ao log. Define GMN_SSH_RC, GMN_SSH_STDOUT, GMN_SSH_STDERR e GMN_SSH_RESPONSE (o stdout como texto, para o deploy).
gmn_receiver_ssh() {
  GMN_SSH_STDOUT="$(umask 077 && mktemp "${RUNNER_TEMP}/gmn-ssh-stdout.XXXXXX")"
  GMN_SSH_STDERR="$(umask 077 && mktemp "${RUNNER_TEMP}/gmn-ssh-stderr.XXXXXX")"
  set +e
  (
    ulimit -f "$GMN_CI_SSH_OUTPUT_MAX_KIB"
    LC_ALL=C exec ssh -F "$GMN_CI_SSH_CONFIG" -T "$GMN_CI_SSH_ALIAS" "$1" <"$2" >"$GMN_SSH_STDOUT" 2>"$GMN_SSH_STDERR"
  )
  GMN_SSH_RC=$?
  set -e
  GMN_SSH_RESPONSE="$(cat -- "$GMN_SSH_STDOUT")"
}

# gmn_ssh_hint ARQUIVO: dica FIXA de uma conexão que falhou (saída 255): HOST_KEY, AUTH ou OTHER. Nada do texto do ssh sai daqui.
gmn_ssh_hint() {
  if grep -q 'Host key verification failed' "$1"; then
    printf 'HOST_KEY'
  elif grep -q 'Permission denied' "$1"; then
    printf 'AUTH'
  else
    printf 'OTHER'
  fi
}
