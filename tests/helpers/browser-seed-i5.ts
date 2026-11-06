/*
 * Semente 100% FICTÍCIA para os roteiros de navegador (scripts/browser/). Fica em tests/helpers porque usa os serviços de evidências, decisões e
 * resultados, que as regras de isolamento só permitem a rotas de servidor e a testes (scripts/ não pode importá-los). Grava SÓ no diretório temporário recebido; não lê .env*, não acessa
 * Redis/Supabase/Serper e a sessão é assinada pelo segredo ALEATÓRIO desta execução (recebido pela variável de ambiente GMN_SEED_SECRET, nunca versionado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFull } from './link-audit-evidence-fixtures';
import { sealAuditsForBrowserSeed } from './link-audit-evidence-provenance-fixtures';
import { createSessionToken, SESSION_COOKIE } from '../../src/lib/auth/session';
import { createOriginAuthenticator } from '../../src/lib/link-audit-origin';
import { browserSeedServices } from './browser-seed-ledger';

/* Semeia dados 100% FICTÍCIOS num diretório temporário e imprime o cookie de sessão assinado por segredo fictício. */
(async () => {
  const [root, email, auditId] = process.argv.slice(2) as [string, string, string];
  const secret = process.env.GMN_SEED_SECRET ?? '';
  if (secret.length < 16) throw new Error('GMN_SEED_SECRET ausente');
  for (const dir of ['evidence', 'decisions', 'anchors', 'results', 'resanchors', 'ledger']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  await writeFull(path.join(root, 'evidence'), { auditId });
  await sealAuditsForBrowserSeed(root, [auditId]); // quem tem a chave atesta a coleta legítima: sem isso a finalização fica bloqueada por desenho
  // LIVRO DE CABEÇAS: a auditoria nasce INSCRITA (a inscrição é explícita; o roteiro I7 cobre o botão). Sem isso nenhuma decisão é gravada, por desenho.
  const originKey = process.env.GMN_LINK_AUDIT_ORIGIN_KEY ?? '';
  if (originKey.length < 40) throw new Error('GMN_LINK_AUDIT_ORIGIN_KEY ausente');
  const enrolled = await browserSeedServices(root, createOriginAuthenticator(originKey)).decisions().ledgerAction({ email }, auditId, { action: 'ENROLL' }, () => new Date().toISOString());
  if (!enrolled.ok) throw new Error(`semente: inscrição ${enrolled.code}`);
  const token = await createSessionToken(email, secret);
  const intruso = await createSessionToken('intruso@x.com', secret);
  process.stdout.write(`IDS ${JSON.stringify({ main: auditId })}\nCOOKIE ${SESSION_COOKIE}=${token}\nINTRUSO ${SESSION_COOKIE}=${intruso}\n`);
})().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});