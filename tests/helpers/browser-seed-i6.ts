/*
 * Semente 100% FICTÍCIA para os roteiros de navegador (scripts/browser/). Fica em tests/helpers porque usa os serviços de evidências, decisões e
 * resultados, que as regras de isolamento só permitem a rotas de servidor e a testes (scripts/ não pode importá-los). Grava SÓ no diretório temporário recebido; não lê .env*, não acessa
 * Redis/Supabase/Serper e a sessão é assinada pelo segredo ALEATÓRIO desta execução (recebido pela variável de ambiente GMN_SEED_SECRET, nunca versionado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService } from '../../src/lib/link-audit-decisions';
import { createEvidenceReader } from '../../src/lib/link-audit-evidence';
import { createSessionToken, SESSION_COOKIE } from '../../src/lib/auth/session';
import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { clock, rec } from './link-audit-decisions-fixtures';
import { errno, faulty, writeFull } from './link-audit-evidence-fixtures';
import { previewOver } from './link-audit-preview-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService } from './link-audit-results-fixtures';

/* Cinco auditorias FICTÍCIAS em estados distintos + cookies de sessão assinados por segredo fictício. */
(async () => {
  const [root, email, flag] = process.argv.slice(2) as [string, string, string | undefined];
  const secret = process.env.GMN_SEED_SECRET ?? '';
  if (secret.length < 16) throw new Error('GMN_SEED_SECRET ausente');
  const withScored = flag === 'with-scored'; // I7: acrescenta uma auditoria com resultado PONTUADO selado (fixture rica válida)
  const d = (name: string): string => path.join(root, name);
  for (const dir of ['evidence', 'decisions', 'anchors', 'results', 'resanchors', 'other']) fs.mkdirSync(d(dir), { recursive: true });
  const SCORED_ID = 'auditoria-vis-scor1';
  const IDS = { main: 'auditoria-vis-main1', pdec: 'auditoria-vis-pdec1', pres: 'auditoria-vis-pres1', integ: 'auditoria-vis-integ', hist: 'auditoria-vis-hist1', ...(withScored ? { scored: SCORED_ID } : {}) };
  for (const id of Object.values(IDS)) await writeFull(d('evidence'), { auditId: id });
  const reader = createEvidenceReader({ baseDir: d('evidence'), authorize: () => true });
  const decisions = (fsOps?: Parameters<typeof createDecisionService>[0]['fs']) => createDecisionService({ baseDir: d('decisions'), anchorDir: d('anchors'), evidence: reader, evidenceBaseDir: d('evidence'), ...(fsOps ? { fs: fsOps } : {}) });
  const actor = { email };
  const onlyFailing = (prefix: string) => faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(prefix)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });

  // B: decisão PENDENTE (recibo da decisão não gravado)
  const pend = await decisions(onlyFailing(d('anchors'))).create(actor, IDS.pdec, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo'), expectedHead: null }, clock);
  if (pend.ok || pend.code !== 'ANCHOR_PENDING') throw new Error('semente: decisão pendente não gerada');

  const preview = (_auditId: string) => previewOver({ evidenceDir: d('evidence'), raw: decisions() } as never);
  const env = { base: d('results'), anchors: d('resanchors'), other: d('other') };
  const body = async (id: string) => {
    const p = await preview(id).preview(actor, id);
    if (!p.ok) throw new Error('semente: prévia ' + id);
    return { expectedHead: p.value.finalization.expectedHead, expectedInputSha256: p.value.finalization.expectedInputSha256 };
  };

  // C: resultado PENDENTE (recibo do resultado não gravado), autor = a sessão
  const failing = makeService(env, preview(IDS.pres), { fs: onlyFailing(d('resanchors')) });
  const pres = await failing.finalize(actor, IDS.pres, await body(IDS.pres));
  if (pres.ok || pres.code !== 'RESULT_ANCHOR_PENDING') throw new Error('semente: resultado pendente não gerado');

  // E: resultado CONFIRMADO e depois uma decisão nova (histórico)
  const ok = await makeService(env, preview(IDS.hist)).finalize(actor, IDS.hist, await body(IDS.hist));
  if (!ok.ok) throw new Error('semente: resultado histórico');
  const list = await decisions().list(actor, IDS.hist);
  if (!list.ok) throw new Error('semente: lista');
  const later = await decisions().create(actor, IDS.hist, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo'), expectedHead: list.value.head }, clock);
  if (!later.ok) throw new Error('semente: decisão posterior');

  // F (só com `with-scored`): resultado PONTUADO selado pelo serviço REAL de resultados com uma entrada RICA válida. A coleta de hoje nunca
  // produz isso (teto de 17 % < 40 %); aqui serve para provar que a tela distingue PONTUADA de INCONCLUSIVA e marca o histórico como desatualizado.
  if (withScored) {
    const evaluation = buildEvaluation({ auditId: SCORED_ID, kind: 'PONTUADO' });
    const scored = await makeService(env, new FakeEvaluator(evaluation)).finalize(actor, SCORED_ID, bodyOf(evaluation));
    if (!scored.ok) throw new Error('semente: resultado PONTUADO ' + JSON.stringify(scored).slice(0, 200));
  }

  // D: evidência ADULTERADA (integridade)
  const capture = path.join(d('evidence'), IDS.integ, 'c0001.capture.json');
  fs.chmodSync(capture, 0o644);
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('Padaria', 'Padarya'));

  const cookie = async (who: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(who, secret)}`;
  process.stdout.write(`IDS ${JSON.stringify(IDS)}\nCOOKIE ${await cookie(email)}\nINTRUSO ${await cookie('intruso@x.com')}\nOUTRO ${await cookie('bia@empresa.com')}\n`);
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});