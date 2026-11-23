/**
 * Verificação dos manifestos, fechos e listas de confiança antes do merge (P9.2; spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.4):
 *
 *   npm run link-audit:seals-check -- --changes <arquivo> --modes <arquivo> --base-trust <pasta> --repo <raiz>
 *
 * Roda no job `seals` do `ci.yml`, sem segredo. O workflow entrega a lista de mudanças (`git diff --name-status --no-renames -z`), os modos
 * (`git ls-tree -r -z`) e as listas do commit-base; este comando não chama git nem rede. Todo o comando está em
 * `src/lib/link-audit-seals-channel/cli.ts`; aqui só a entrega, com o adaptador de disco padrão.
 */
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import { runSealsCheckCli, SEALS_CHECK_EXIT } from '../src/lib/link-audit-seals-channel/cli';

if (process.argv[1] && /link-audit-seals-check\.ts$/.test(process.argv[1])) {
  runSealsCheckCli(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line), { fs: nodeFsOps }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('ERRO SEALS_INTERNAL');
      process.exitCode = SEALS_CHECK_EXIT.UNEXPECTED;
    },
  );
}
