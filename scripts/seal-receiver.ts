/**
 * Entrada FINA do receptor de manifestos (P9.3b; spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.7). Empacotada por
 * `scripts/build-receivers-artifact.ts` no artefato único `gmn-seal-receiver.cjs` (hash em `deploy/hostinger/receivers.sha256`), que o wrapper do
 * comando forçado chama com `umask 027` e `env -i PATH=/usr/bin:/bin SSH_ORIGINAL_COMMAND=… <node 22> --disable-sigusr1 --permission <grants>
 * gmn-seal-receiver.cjs <parâmetros fixos>`. Escreve EXATAMENTE uma linha pública (stdout `OK …` ou stderr `ERRO …`) e sai com o código do §5.8.
 * A lógica fica em `src/lib/seal-receiver/`.
 */
// PRIMEIRO import: desliga o JIT do zod antes de qualquer esquema existir
import './receiver-artifact-zod';
import { createNodeSealDeps, processPermission, RECEIVER_UMASK } from '../src/lib/seal-receiver/node-adapters';
import { runSealReceiver } from '../src/lib/seal-receiver/receiver';
import { publicErrorLine, SEAL_RECEIVER_EXIT_CODES, type SealReceiverOutcome } from '../src/lib/seal-receiver/codes';

/** Definido como `true` só pelo build do artefato (`define` do esbuild); no código-fonte o identificador não existe. */
declare const GMN_SEAL_RECEIVER_ARTIFACT: boolean | undefined;
const IS_ARTIFACT = typeof GMN_SEAL_RECEIVER_ARTIFACT !== 'undefined' && GMN_SEAL_RECEIVER_ARTIFACT === true;
const INTERNAL: SealReceiverOutcome = { exitCode: SEAL_RECEIVER_EXIT_CODES.E_INTERNAL, stdout: null, stderr: publicErrorLine('E_INTERNAL', null) };

let finished = false;

/** Escreve a única linha pública e encerra (sem esperar o stdin, que pode continuar aberto). */
function finish(outcome: SealReceiverOutcome): void {
  if (finished) return;
  finished = true;
  const stream = outcome.stdout !== null ? process.stdout : process.stderr;
  const line = outcome.stdout ?? outcome.stderr ?? '';
  stream.write(`${line}\n`, () => process.exit(outcome.exitCode));
}

export function main(): void {
  // a saída pública é só a linha final: um stdout/stderr fechado (ssh caído) não pode virar exceção com caminho
  process.stdout.on('error', () => process.exit(SEAL_RECEIVER_EXIT_CODES.E_INTERNAL));
  process.stderr.on('error', () => process.exit(SEAL_RECEIVER_EXIT_CODES.E_INTERNAL));
  // nenhum aviso do Node (depreciação, experimental) pode virar uma segunda linha no stderr público
  process.removeAllListeners('warning');
  process.on('uncaughtException', () => finish(INTERNAL));
  process.on('unhandledRejection', () => finish(INTERNAL));
  // job cancelado ou ssh caído no meio de um put: o receptor termina o que começou (gravação, trava e log coerentes)
  process.on('SIGHUP', () => undefined);
  // o mesmo umask do wrapper (defesa): pastas novas 2750 com o setgid herdado; o 0444 do manifesto é explícito
  process.umask(RECEIVER_UMASK);
  runSealReceiver({ argv: process.argv.slice(2), env: process.env, permission: processPermission() }, createNodeSealDeps).then(finish, () => finish(INTERNAL));
}

if (IS_ARTIFACT || /scripts\/seal-receiver\.ts$/.test(process.argv[1] ?? '')) main();
