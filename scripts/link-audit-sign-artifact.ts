/**
 * Entrada do ARTEFATO ÚNICO do `sign` e do `close-key` (P1 W4.6; spec `docs/specs/link-audit-p1-attestation.md` §5.5.1 itens 5–7, IA-03 artefato, IA-24).
 *
 * Empacotada por `scripts/build-sign-artifact.ts` (esbuild, opções fixas) num único `link-audit-sign.cjs`, cujo SHA-256 é versionado em
 * `docs/phase6-auditoria-link/p1-sign-artifact.sha256` e conferido pelo CI. Despacha SÓ `sign` e `close-key` para `sign-cli.ts` (o `export` fica de
 * fora: ele alcança o leitor de evidências e, por ele, `node:dns`/`node:net`). A estação roda o artefato pela linha fixada no runbook:
 *
 *   env -i /caminho/absoluto/do/node --disable-sigusr1 --permission --allow-fs-read=… --allow-fs-write=<manifestos> link-audit-sign.cjs sign …
 *
 * Empacotado (`LINK_AUDIT_SIGN_ARTIFACT` definido pelo build): a raiz do "projeto" é a pasta do artefato (a chave nunca pode estar nela), a barreira do
 * runtime exige essa linha, e o recibo leva o SHA-256 dos bytes deste arquivo em execução (o esperado NÃO é embutido: seria autorreferência). Pelo
 * código-fonte (testes, `tsx`), é o mesmo comando do `npm run link-audit:seal`, com `artifactSha256` nulo.
 */
import path from 'node:path';
import { CLOSE_KEY_USAGE, runCloseKeyCli, runSignCli, SIGN_USAGE, type SignCliDeps } from '../src/lib/link-audit-attestation/sign-cli';

/** Definido como `true` só pelo build do artefato (`define` do esbuild); no código-fonte o identificador não existe. */
declare const LINK_AUDIT_SIGN_ARTIFACT: boolean | undefined;
const IS_ARTIFACT = typeof LINK_AUDIT_SIGN_ARTIFACT !== 'undefined' && LINK_AUDIT_SIGN_ARTIFACT === true;

export const ARTIFACT_USAGE: readonly string[] = [
  'Artefato único do sign (W4.6): env -i <node por caminho absoluto> --disable-sigusr1 --permission --allow-fs-read=… --allow-fs-write=… link-audit-sign.cjs <sign|close-key> <opções>',
  '  As opções são as do npm run link-audit:seal (abaixo); a linha completa, com as permissões, está no runbook do custodiante.',
  ...SIGN_USAGE,
  ...CLOSE_KEY_USAGE,
];
const EXIT_USAGE = 1;
const EXIT_UNEXPECTED = 4;
const UNEXPECTED_MESSAGE = 'Falha inesperada.';

type Line = (line: string) => void;

/** As dependências padrão: no artefato, a pasta e o arquivo dele; no código-fonte, a raiz do repositório (como o `npm run link-audit:seal`). */
function baseDeps(): SignCliDeps {
  return IS_ARTIFACT ? { projectRoot: path.dirname(__filename), artifact: { file: __filename } } : { projectRoot: path.resolve(__dirname, '..') };
}

/** Despacha `sign` ou `close-key`; qualquer outro subcomando é erro de uso (código 1). Nunca lança. */
export async function runSignArtifact(argv: readonly string[], out: Line, err: Line, now: () => Date = () => new Date(), deps: Partial<SignCliDeps> = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'sign') return await runSignCli(rest, out, err, now, { ...baseDeps(), ...deps });
    if (command === 'close-key') return await runCloseKeyCli(rest, out, err, now, { ...baseDeps(), ...deps });
    const message = 'Informe o subcomando: sign ou close-key (o export não faz parte do artefato).';
    if (argv.includes('--json')) out(JSON.stringify({ ok: false, code: 'USAGE', message }));
    else [message, ...ARTIFACT_USAGE].forEach((line) => err(line));
    return EXIT_USAGE;
  } catch {
    err(UNEXPECTED_MESSAGE);
    return EXIT_UNEXPECTED;
  }
}

if (IS_ARTIFACT || /link-audit-sign-artifact\.ts$/.test(process.argv[1] ?? '')) {
  runSignArtifact(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error(UNEXPECTED_MESSAGE);
      process.exitCode = EXIT_UNEXPECTED;
    },
  );
}
