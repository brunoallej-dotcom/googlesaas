/**
 * Entrada FINA do receptor de deploy (P9.3a; spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.6). Empacotada por
 * `scripts/build-receivers-artifact.ts` no artefato único `gmn-deploy-receiver.cjs` (hash em `deploy/hostinger/receivers.sha256`), que o wrapper do
 * comando forçado chama com `env -i PATH=/usr/bin:/bin SSH_ORIGINAL_COMMAND=… <node> --disable-sigusr1 gmn-deploy-receiver.cjs <parâmetros fixos>`.
 * Escreve EXATAMENTE uma linha pública (stdout `OK …` ou stderr `ERRO …`) e sai com o código do §5.8. A lógica fica em `src/lib/deploy-receiver/`.
 */
// PRIMEIRO import: desliga o JIT do zod antes de qualquer esquema existir
import './receiver-artifact-zod';
import { createNodeDeps } from '../src/lib/deploy-receiver/node-adapters';
import { runDeployReceiver } from '../src/lib/deploy-receiver/receiver';
import { publicErrorLine, RECEIVER_EXIT_CODES, type ReceiverOutcome } from '../src/lib/deploy-receiver/codes';

/** Definido como `true` só pelo build do artefato (`define` do esbuild); no código-fonte o identificador não existe. */
declare const GMN_DEPLOY_RECEIVER_ARTIFACT: boolean | undefined;
const IS_ARTIFACT = typeof GMN_DEPLOY_RECEIVER_ARTIFACT !== 'undefined' && GMN_DEPLOY_RECEIVER_ARTIFACT === true;
const INTERNAL: ReceiverOutcome = { exitCode: RECEIVER_EXIT_CODES.E_INTERNAL, stdout: null, stderr: publicErrorLine('E_INTERNAL', null) };

let finished = false;

/** Escreve a única linha pública e encerra (sem esperar o stdin, que pode continuar aberto). */
function finish(outcome: ReceiverOutcome): void {
  if (finished) return;
  finished = true;
  const stream = outcome.stdout !== null ? process.stdout : process.stderr;
  const line = outcome.stdout ?? outcome.stderr ?? '';
  stream.write(`${line}\n`, () => process.exit(outcome.exitCode));
}

export function main(): void {
  // a saída pública é só a linha final: um stdout/stderr fechado (ssh caído) não pode virar exceção com caminho
  process.stdout.on('error', () => process.exit(RECEIVER_EXIT_CODES.E_INTERNAL));
  process.stderr.on('error', () => process.exit(RECEIVER_EXIT_CODES.E_INTERNAL));
  // nenhum aviso do Node (depreciação, experimental) pode virar uma segunda linha no stderr público
  process.removeAllListeners('warning');
  process.on('uncaughtException', () => finish(INTERNAL));
  process.on('unhandledRejection', () => finish(INTERNAL));
  // job cancelado ou ssh caído no meio do deploy: o receptor termina o que começou (trava, lista e log coerentes) em vez de parar num passo qualquer
  process.on('SIGHUP', () => undefined);
  runDeployReceiver({ argv: process.argv.slice(2), env: process.env }, createNodeDeps).then(finish, () => finish(INTERNAL));
}

if (IS_ARTIFACT || /deploy-receiver\.ts$/.test(process.argv[1] ?? '')) main();
