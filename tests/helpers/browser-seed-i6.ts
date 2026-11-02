/*
 * Semente 100% FICTÍCIA para os roteiros de navegador (scripts/browser/). Fica em tests/helpers porque usa os serviços de evidências, decisões e
 * resultados, que as regras de isolamento só permitem a rotas de servidor e a testes (scripts/ não pode importá-los). Grava SÓ no diretório temporário recebido; não lê .env*, não acessa
 * Redis/Supabase/Serper e a sessão é assinada pelo segredo ALEATÓRIO desta execução (recebido pela variável de ambiente GMN_SEED_SECRET, nunca versionado).
 */
import { WITNESS_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/witness';
import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService } from '../../src/lib/link-audit-decisions';
import { createEvidenceReader } from '../../src/lib/link-audit-evidence';
import { createSessionToken, SESSION_COOKIE } from '../../src/lib/auth/session';
import { createOriginAuthenticator } from '../../src/lib/link-audit-origin';
import { seal, serialize } from '../../src/lib/link-audit-storage';
import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { clock, rec } from './link-audit-decisions-fixtures';
import { errno, faulty, writeFull } from './link-audit-evidence-fixtures';
import { sealAuditsForBrowserSeed } from './link-audit-evidence-provenance-fixtures';
import { previewOver } from './link-audit-preview-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService } from './link-audit-results-fixtures';

/* Cinco auditorias FICTÍCIAS em estados distintos + cookies de sessão assinados por segredo fictício. */
(async () => {
  const [root, email, flag] = process.argv.slice(2) as [string, string, string | undefined];
  const secret = process.env.GMN_SEED_SECRET ?? '';
  if (secret.length < 16) throw new Error('GMN_SEED_SECRET ausente');
  // `flag` (I7), separada por vírgulas: `with-scored` = auditoria com resultado PONTUADO selado (fixture rica válida); `with-forged` = duas
  // auditorias com pendências FORJADAS (arquivo sem etiqueta de origem, citando o operador), para provar a recusa no navegador
  const flags = (flag ?? '').split(',');
  const withScored = flags.includes('with-scored');
  const withForged = flags.includes('with-forged');
  const originKey = process.env.GMN_LINK_AUDIT_ORIGIN_KEY ?? '';
  if (originKey.length < 40) throw new Error('GMN_LINK_AUDIT_ORIGIN_KEY ausente'); // a MESMA chave do servidor: só assim as pendências legítimas são comprovadas
  const origin = createOriginAuthenticator(originKey);
  const d = (name: string): string => path.join(root, name);
  for (const dir of ['evidence', 'decisions', 'anchors', 'results', 'resanchors', 'other']) fs.mkdirSync(d(dir), { recursive: true });
  const SCORED_ID = 'auditoria-vis-scor1';
  const IDS = { main: 'auditoria-vis-main1', pdec: 'auditoria-vis-pdec1', pres: 'auditoria-vis-pres1', integ: 'auditoria-vis-integ', hist: 'auditoria-vis-hist1', ...(withScored ? { scored: SCORED_ID } : {}), ...(withForged ? { forgedDec: 'auditoria-vis-fdec1', forgedRun: 'auditoria-vis-frun1', unsealed: 'auditoria-vis-nseal', revoked: 'auditoria-vis-rev01' } : {}) };
  for (const id of Object.values(IDS)) await writeFull(d('evidence'), { auditId: id });
  // atestação da coleta (papel de quem tem a chave): TODAS as auditorias com evidência íntegra, exceto `unsealed` (coleta SEM prova, de propósito) e `integ` (adulterada abaixo)
  await sealAuditsForBrowserSeed(root, Object.entries(IDS).filter(([key]) => key !== 'unsealed' && key !== 'integ').map(([, id]) => id));
  const reader = createEvidenceReader({ baseDir: d('evidence'), authorize: () => true });
  const decisions = (fsOps?: Parameters<typeof createDecisionService>[0]['fs']) => createDecisionService({ knownHeads: WITNESS_NOT_REQUIRED, origin, baseDir: d('decisions'), anchorDir: d('anchors'), evidence: reader, evidenceBaseDir: d('evidence'), ...(fsOps ? { fs: fsOps } : {}) });
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
  const failing = makeService(env, preview(IDS.pres), { origin, fs: onlyFailing(d('resanchors')) });
  const pres = await failing.finalize(actor, IDS.pres, await body(IDS.pres));
  if (pres.ok || pres.code !== 'RESULT_ANCHOR_PENDING') throw new Error('semente: resultado pendente não gerado');

  // E: resultado CONFIRMADO e depois uma decisão nova (histórico)
  const ok = await makeService(env, preview(IDS.hist), { origin }).finalize(actor, IDS.hist, await body(IDS.hist));
  if (!ok.ok) throw new Error('semente: resultado histórico');
  const list = await decisions().list(actor, IDS.hist);
  if (!list.ok) throw new Error('semente: lista');
  const later = await decisions().create(actor, IDS.hist, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo'), expectedHead: list.value.head }, clock);
  if (!later.ok) throw new Error('semente: decisão posterior');

  // F (só com `with-scored`): resultado PONTUADO selado pelo serviço REAL de resultados com uma entrada RICA válida. A coleta de hoje nunca
  // produz isso (teto de 17 % < 40 %); aqui serve para provar que a tela distingue PONTUADA de INCONCLUSIVA e marca o histórico como desatualizado.
  if (withScored) {
    const evaluation = buildEvaluation({ auditId: SCORED_ID, kind: 'PONTUADO' });
    const scored = await makeService(env, new FakeEvaluator(evaluation), { origin }).finalize(actor, SCORED_ID, bodyOf(evaluation));
    if (!scored.ok) throw new Error('semente: resultado PONTUADO ' + JSON.stringify(scored).slice(0, 200));
  }

  // G (só com `with-forged`): pendências FORJADAS. Cria-se uma pendente LEGÍTIMA (recibo falhando) e depois a "forja" de quem só escreve na pasta de
  // dados: remove-se a etiqueta de origem e refaz-se o selo SHA-256 (qualquer um refaz). O arquivo continua citando o operador como autor.
  if (withForged) {
    // R3-MINOR-2: decisão CRIADA e REVOGADA (confirmadas) e um resultado SELADO sobre esse histórico (o head das decisões = seq 2 vira testemunha)
    const revoked = IDS.revoked as string;
    const made = await decisions().create(actor, revoked, { record: rec.c2(), expectedHead: null }, clock);
    if (!made.ok) throw new Error('semente: decisão do cenário de revogação');
    const undone = await decisions().revoke(actor, revoked, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito.', expectedHead: made.value.head }, clock);
    if (!undone.ok) throw new Error('semente: revogação');
    const sealed = await makeService(env, preview(revoked), { origin }).finalize(actor, revoked, await body(revoked));
    if (!sealed.ok) throw new Error('semente: resultado selado sobre a revogação ' + JSON.stringify(sealed).slice(0, 200));
    const forge = (file: string): void => {
      const content = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      delete content.contentSha256;
      delete content.origin;
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, serialize(seal(content)));
      fs.chmodSync(file, 0o444);
    };
    const forgedDec = IDS.forgedDec as string;
    const forgedRun = IDS.forgedRun as string;
    const fdec = await decisions(onlyFailing(d('anchors'))).create(actor, forgedDec, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo'), expectedHead: null }, clock);
    if (fdec.ok || fdec.code !== 'ANCHOR_PENDING') throw new Error('semente: decisão forjada não gerada');
    forge(path.join(d('decisions'), forgedDec, 'd0001.json'));
    const frun = await makeService(env, preview(forgedRun), { origin, fs: onlyFailing(d('resanchors')) }).finalize(actor, forgedRun, await body(forgedRun));
    if (frun.ok || frun.code !== 'RESULT_ANCHOR_PENDING') throw new Error('semente: resultado forjado não gerado');
    forge(path.join(d('results'), forgedRun, 's0001.json'));
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