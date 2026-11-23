/**
 * Reconciliação EXTERNA da guarda do livro e verificador do portão G-1 (G1.b.2b; spec `docs/specs/link-audit-production-gates.md` GE-E5, PG-G09,
 * PG-G07, §10.1 G-1; runbook `docs/phase6-auditoria-link/producao-g1b-runbook-guarda.md`).
 *
 *   npm run link-audit:guard-reconcile -- reconcile --backup <rodada do livro> --records-dir <pasta dos registros> [--first] [--json]
 *   npm run link-audit:guard-reconcile -- gate [--backup <rodada do livro>] [--json]
 *
 * RODA FORA DA VPS, na máquina do responsável, com a credencial do papel de LEITURA `gmn_guard_reader` (nunca a do escritor, que fica na VPS) e a
 * chave do pseudônimo sob custódia dele. Somente leitura sobre a guarda e sobre o backup; o único arquivo gravado é o registro novo da reconciliação
 * (criação exclusiva, nunca sobrescreve). Não lê arquivo de ambiente: as variáveis vêm do ambiente do processo (ou de arquivos `*_FILE` próprios).
 * Todo o comando está em `src/lib/link-audit-guard-reconcile/cli.ts`; aqui só a entrega, com a raiz do projeto.
 */
import path from 'node:path';
import { runGuardReconcileCli } from '@/lib/link-audit-guard-reconcile/cli';

const UNEXPECTED_MESSAGE = 'Falha inesperada.';
const UNEXPECTED_EXIT = 4;

if (process.argv[1] && /link-audit-guard-reconcile\.ts$/.test(process.argv[1])) {
  runGuardReconcileCli(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line), { env: process.env, projectRoot: path.resolve(__dirname, '..') }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error(UNEXPECTED_MESSAGE);
      process.exitCode = UNEXPECTED_EXIT;
    },
  );
}
