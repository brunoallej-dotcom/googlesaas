'use strict';
/*
 * Roteiro I7 — HOMOLOGAÇÃO FINAL da Auditoria por Link (Onda 6C), num Chromium real, com seis auditorias FICTÍCIAS e as APIs locais REAIS:
 *   A. fluxo operacional completo (14 passos) numa auditoria "pronta" e retorno à listagem;
 *   D. o operador distingue os estados do produto (pronta, decisão pendente, bloqueada, INCONCLUSIVA, PONTUADA, histórico, verificado e atual);
 *   B. integridade e segurança no nível da API (autenticação, vazamento, idempotência, concorrência, adulteração de evidência/resultado/recibo);
 *   L. LIVRO DE CABEÇAS (decisões Q1–Q7): inscrição explícita, modo restrito, ações administrativas bloqueadas, chave ausente/rotacionada/revogada, livro removido;
 *   C. experiência: acessibilidade (verificador próprio), foco, diálogo, reflow, contraste e indicadores de foco medidos.
 * `I7_ONLY=A,B` (só desenvolvimento) roda um subconjunto; sem a variável, roda tudo, em ordem. Uso: ver scripts/browser/README.md.
 * Limites: Chromium headless apenas; sem leitor de tela, outros navegadores nem dispositivo físico (SKIPPED no resultado).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./harness.cjs');

const only = (process.env.I7_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (section) => only.length === 0 || only.includes(section);

(async () => {
  const h = await createHarness({ name: 'i7', seed: 'tests/helpers/browser-seed-i6.ts', seedArgs: ['with-scored,with-forged,with-ledger'], port: 3989, debugPort: 9335 });
  const { check, waitFor, evalJs, text, has, sleep, send, BASE, IDS, root } = h;
  const go = h.go;
  const clickText = h.clickText;
  const typeInto = h.typeInto;
  const enabledButton = h.enabledButton;
  const lumos = (key) => `${BASE}/auditoria-por-link/${IDS[key]}`;
  /** `ready`, `listReady` são funções; os demais, expressões regulares. */
  const matches = (re, x) => (typeof re === 'function' ? re(x) : re.test(x));
  const ready = (x) => /Resultado da prévia/.test(x) && !/Carregando a auditoria/.test(x);
  const listReady = (x) => /Auditorias armazenadas/.test(x) && /\d+ (de \d+ )?empresas?/.test(x);
  const openAll = async () => { await evalJs(`document.querySelectorAll('details').forEach(d=>d.open=true)`); await sleep(250); };
  const crumb = () => evalJs(`(()=>{const a=document.querySelector('nav[aria-label="Navegação da auditoria"] a');if(!a)return false;a.click();return true})()`);
  const selectedAudit = () => evalJs(`(()=>{const b=document.querySelector('#auditorias-armazenadas li > button[aria-current="true"]');if(!b)return null;const a=b.closest('li').querySelector('a[href^="/auditoria-por-link/"]');return a?decodeURIComponent(a.getAttribute('href').split('/').pop()):null})()`);
  const cardText = (id) => evalJs(`(()=>{const a=document.querySelector('#auditorias-armazenadas li > a[href$="${id}"]');return a?a.closest('li').querySelector('button').innerText.replace(/\\s+/g,' ').trim():null})()`);
  const submitDecisionForm = () => evalJs(`(()=>{const b=document.querySelector('#decisoes form button[type="submit"]');if(!b||b.disabled)return false;b.click();return true})()`);
  const openOption = (needle) => evalJs(`(()=>{const li=[...document.querySelectorAll('#decisoes li')].find(e=>e.innerText.includes(${JSON.stringify(needle)}));const b=li&&li.querySelector('button');if(!b||b.disabled)return false;b.focus();b.click();return true})()`);

  /** fetch na página (cookie da sessão atual, mesma origem). `omit` = sem credenciais. */
  const api = (p, init = {}, omit = false) =>
    evalJs(`(async()=>{const r=await fetch(${JSON.stringify(p)},${JSON.stringify({ ...init, ...(omit ? { credentials: 'omit' } : {}) })});const t=await r.text();return {status:r.status,cache:r.headers.get('cache-control'),nosniff:r.headers.get('x-content-type-options'),ctype:r.headers.get('content-type'),retry:r.headers.get('retry-after'),body:t}})()`);
  const post = (p, body, omit = false) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, omit);
  const parse = (res) => { try { return JSON.parse(res.body); } catch { return null; } };
  const previewOf = async (id) => parse(await api(`/api/link-audit/scoring/${id}`));
  const resultsOf = async (id) => parse(await api(`/api/link-audit/scoring/${id}/results`));
  const decisionsOf = async (id) => parse(await api(`/api/link-audit/decisions/${id}`));
  /** Registros selados e cabeça da cadeia (sem os campos "atuais", que mudam quando alguém decide). */
  const chainOf = (res) => (res && Array.isArray(res.results) ? JSON.stringify({ runs: res.results.map((r) => [r.seq, r.contentSha256]), head: res.head, pending: res.pending }) : null);
  const latestRun = (res) => (res && Array.isArray(res.results) && res.results.length > 0 ? [...res.results].sort((a, b) => a.seq - b.seq)[res.results.length - 1] : null);
  const finalizeBody = (preview) => ({ expectedHead: preview.finalization.expectedHead, expectedInputSha256: preview.finalization.expectedInputSha256 });
  const coverageNow = async () => { const m = /Cobertura verificada\s*(\d+)%/.exec(await text()); return m ? Number(m[1]) : null; };
  const noIndex = (t) => !/Índice Lumos\s*\d|\b\d{1,3}\s*\/\s*100\b|\bnota\s*\d/i.test(t);
  const dumpKeys = (label, value) => h.log(`forma (${label}):`, JSON.stringify(value, (k, v) => (typeof v === 'string' && v.length > 24 ? v.slice(0, 24) + '…' : v)).slice(0, 700));
  const registerS4 = async (justification) => {
    await evalJs(`document.getElementById('decisoes').open=true`);
    if (!(await openOption('Marcar S4'))) return false;
    await waitFor(() => evalJs(`!!document.querySelector('#decisao-justificativa')`), 4000);
    await typeInto('#decisao-justificativa', justification);
    await sleep(100);
    await submitDecisionForm();
    return !!(await waitFor(() => has(/Decisão registrada e confirmada/), 15000));
  };
  const finalizeViaUi = async () => {
    await enabledButton('Registrar resultado');
    await clickText('Registrar resultado');
    await sleep(400);
    await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`);
    await sleep(100);
    await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`);
  };

  await h.viewport(1440, 1500, false);
  let mainBefore = null;
  let mainFinal = null;

  /* ============================================================ A. FLUXO OPERACIONAL COMPLETO ============================================================ */
  if (want('A')) {
    h.log('---- A. fluxo operacional (14 passos)');
    // 1. abrir a Auditoria por Link
    check('1. a Auditoria por Link abre e lista as 12 auditorias fictícias (10 de antes + a por inscrever e a legada do livro)', !!(await go(`${BASE}/auditoria-por-link`, listReady)) && (await evalJs(`document.querySelectorAll('#auditorias-armazenadas li > a[href^="/auditoria-por-link/"]').length`)) === 12 && (await has(/12 empresas/)));
    // 2. selecionar uma auditoria
    const cardBefore = await cardText(IDS.main);
    await evalJs(`document.querySelector('#auditorias-armazenadas li > a[href$="${IDS.main}"]').closest('li').querySelector('button').click()`);
    check('2. selecionar a auditoria: detalhe da coleta (5B) abre, endereço acompanha', !!(await waitFor(async () => (await selectedAudit()) === IDS.main && (await has(/Coleta de evidências/)), 15000)) && (await evalJs('location.search')) === `?auditId=${IDS.main}`);
    // 3. abrir o workspace Lumos
    await Promise.all([waitFor(async () => (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.main}`, 15000), evalJs(`document.querySelector('#auditorias-armazenadas article a[href^="/auditoria-por-link/"]').click()`)]);
    check('3. abrir o workspace Lumos pelo detalhe', !!(await waitFor(async () => ready(await text()), 25000)) && (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.main}`);
    await openAll();
    // 4. evidências verificadas
    let t = await text();
    check('4. evidências: integridade local verificada (SHA-256) e origem da coleta autenticada, CID, captura de origem e hashes curtos', /Integridade local verificada \(SHA-256\)/.test(t) && /CID confirmado\s*\d{10,}/.test(t) && /EVIDÊNCIAS USADAS \(INTEGRIDADE LOCAL VERIFICADA POR SHA-256\)/i.test(t) && /Origem da coleta autenticada/.test(t) && /origem autenticada/.test(t) && /capture:c0001/.test(t) && /[0-9a-f]{6}…[0-9a-f]{4}/.test(t));
    // 5. prévia calculada pelo motor
    mainBefore = await previewOf(IDS.main);
    dumpKeys('prévia', mainBefore && { keys: Object.keys(mainBefore), fin: mainBefore.finalization, blockers: (mainBefore.blockers || []).length });
    const cov0 = await coverageNow();
    check('5. prévia do motor: inconclusiva, cobertura abaixo do mínimo de 40% (e do teto documentado de 17%), sem índice', /Auditoria inconclusiva — evidências insuficientes para gerar o índice Lumos\./.test(t) && cov0 !== null && cov0 <= 17 && /mínimo exigido\s*40%/.test(t) && /Cobertura mínima: não atendido/.test(t) && noIndex(t), `cobertura=${cov0}`);
    check('5b. prévia (API): definitiva=false, finalização permitida, sem resultado anterior', mainBefore && mainBefore.definitive === false && mainBefore.finalization.allowed === true && !mainBefore.finalization.latest, JSON.stringify(mainBefore && mainBefore.finalization).slice(0, 200));
    check('5c. estado "pronta para avaliação": nenhum resultado, botão de registrar habilitado, sem histórico nem pendência', /Nenhum resultado registrado ainda/.test(t) && !/HISTÓRICO/.test(t) && !/Decisão pendente/.test(t) && !/NÃO confirmado/.test(t) && (await evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim().startsWith('Registrar resultado')&&!b.disabled)`)));
    await h.shot('i7-01-pronta');
    // 6. decisão humana autorizada
    check('6. registrar decisão humana (S4 não aplicável) com justificativa: confirmada com recibo', await registerS4('Modelo de negócio sem o subcritério S4, conferido pelo operador na homologação.'));
    // 7. prévia atualizada
    await sleep(600);
    const afterDecision = await previewOf(IDS.main);
    t = await text();
    check('7. prévia atualizada depois da decisão: hash da entrada e head das decisões mudaram; a decisão aparece como aplicada', afterDecision && afterDecision.finalization.expectedInputSha256 !== mainBefore.finalization.expectedInputSha256 && JSON.stringify(afterDecision.finalization.expectedHead) !== JSON.stringify(mainBefore.finalization.expectedHead) && /op-\d{4}/.test(t), `${(mainBefore.finalization.expectedInputSha256 || '').slice(0, 8)} → ${((afterDecision && afterDecision.finalization.expectedInputSha256) || '').slice(0, 8)}`);
    const opId = (/op-\d{4}/.exec(t) || [])[0];
    await h.shot('i7-02-decisao-registrada');
    // 8. revogar a decisão e verificar o efeito
    const revokeOpened = await evalJs(`(()=>{const b=document.querySelector('button[aria-label^="Revogar a decisão"]');if(!b||b.disabled)return false;b.click();return true})()`);
    await waitFor(() => evalJs(`!!document.querySelector('#revogacao-motivo')`), 4000);
    await typeInto('#revogacao-motivo', 'Registro de teste revogado na homologação para verificar o efeito sobre a prévia.');
    await sleep(100);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('form button[type="submit"]')].find(x=>x.innerText.includes('Confirmar revogação'));if(b)b.click()})()`);
    const revoked = await waitFor(async () => { const d = await decisionsOf(IDS.main); return d && Array.isArray(d.decisions) && d.decisions.length === 0 ? true : false; }, 15000);
    await sleep(800);
    const afterRevoke = await previewOf(IDS.main);
    check('8. revogar a decisão: ação aceita e a decisão deixa de valer', revokeOpened && !!revoked && !!afterRevoke, `decisão=${opId}`);
    check('8b. revogação restaura a ENTRADA do motor (mesmo hash da prévia sem decisão) e o histórico guarda a decisão e a revogação', afterRevoke && afterRevoke.finalization.expectedInputSha256 === mainBefore.finalization.expectedInputSha256 && JSON.stringify(afterRevoke.finalization.expectedHead) !== JSON.stringify(mainBefore.finalization.expectedHead) && (await has(/revogou op-\d{4}/)), `hash ${((afterRevoke && afterRevoke.finalization.expectedInputSha256) || '').slice(0, 8)}`);
    // 9. elegibilidade para finalização
    const eligible = await previewOf(IDS.main);
    check('9. elegível para finalização: API permite e a tela habilita o registro', eligible && eligible.finalization.allowed === true && (await enabledButton('Registrar resultado')) && /pode ser registrada/.test(await text()));
    // 10. finalizar INCONCLUSIVA
    await finalizeViaUi();
    check('10. finalizar a auditoria INCONCLUSIVA: confirmada com recibo e VERIFICADA pela releitura', !!(await waitFor(() => has(/Confirmado e verificado/), 20000)));
    await openAll();
    // 11. resultado selado e recibo
    const results1 = await resultsOf(IDS.main);
    dumpKeys('resultados', results1 && { keys: Object.keys(results1), first: Array.isArray(results1.results) ? results1.results[0] : null });
    t = await text();
    const runFile = path.join(root, 'results', IDS.main, 's0001.json');
    const receiptDir = path.join(root, 'resanchors', IDS.main);
    check('11. resultado selado consultável (s0001) e recibo independente gravado em outro volume', fs.existsSync(runFile) && fs.existsSync(receiptDir) && fs.readdirSync(receiptDir).length >= 1 && /s0001/.test(t) && /Confirmado e verificado/.test(t), `recibos=${fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).join(',') : 'nenhum'}`);
    check('11b. resultado INCONCLUSIVO selado: sem índice nem nota, com cobertura e mínimo', noIndex(t) && /inconclus/i.test(t));
    const latest1 = latestRun(await resultsOf(IDS.main));
    dumpKeys('registro mais recente', latest1 && Object.keys(latest1));
    check('11c. verificado e atual: stale=false e decisionsChanged=false na API; a tela não marca HISTÓRICO', latest1 && latest1.stale === false && latest1.decisionsChanged === false && !/HISTÓRICO/.test(t), JSON.stringify(latest1 && { stale: latest1.stale, decisionsChanged: latest1.decisionsChanged }));
    await h.shot('i7-03-resultado-verificado');
    mainFinal = await resultsOf(IDS.main);
    // 12. histórico depois de uma nova decisão
    check('12. nova decisão depois do resultado: registrada', await registerS4('Segunda constatação do modelo de negócio, registrada depois do resultado para gerar histórico.'));
    await sleep(800);
    await openAll();
    t = await text();
    const driftState = await resultsOf(IDS.main);
    const drifted = latestRun(driftState);
    check('12b. o resultado anterior passa a HISTÓRICO: a API marca stale/decisionsChanged e a tela avisa', /HISTÓRICO/.test(t) && /s0001/.test(t) && drifted && (drifted.stale === true || drifted.decisionsChanged === true) && drifted.decisionsChanged === true, JSON.stringify(drifted && { seq: drifted.seq, stale: drifted.stale, decisionsChanged: drifted.decisionsChanged }));
    await h.shot('i7-04-historico');
    await finalizeViaUi();
    check('12c. novo resultado (s0002) confirmado; o s0001 permanece no histórico', !!(await waitFor(async () => /s0002/.test(await text()) && /Confirmado e verificado/.test(await text()), 20000)) && fs.existsSync(path.join(root, 'results', IDS.main, 's0002.json')));
    mainFinal = await resultsOf(IDS.main);
  }

  /* ============================================================ A (13/14) CONFLITO, SESSÃO, PENDÊNCIAS, RETORNO ============================================================ */
  if (want('A')) {
    h.log('---- A 13/14. conflitos, expiração de sessão, pendências e retorno');
    await h.restartServer();
    // 13a. conflito expectedHead: OUTRA operadora grava uma decisão enquanto a confirmação está aberta
    await go(lumos('main'), ready);
    check('13a-0. nova decisão (substitui a S4) para que haja uma prévia nova a registrar', await registerS4('Terceira constatação do modelo de negócio, para abrir uma prévia nova antes do conflito.'));
    await sleep(800);
    await enabledButton('Registrar resultado');
    await clickText('Registrar resultado');
    await sleep(400);
    const resultsBeforeConflict = await resultsOf(IDS.main);
    const head = (await decisionsOf(IDS.main)).head;
    await h.setSession(h.otherOperatorSession);
    const other = await post(`/api/link-audit/decisions/${IDS.main}`, { record: { kind: 'NAME_EQUIVALENCE', nameA: 'Padaria Exemplo Ltda', nameB: 'Padaria Exemplo', justification: 'Equivalência conferida por outra pessoa da equipe.' }, expectedHead: head });
    await h.setSession(h.operatorSession);
    await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`);
    await sleep(100);
    await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`);
    const conflicted = await waitFor(() => has(/Nada foi gravado: a situação mudou/), 15000);
    const resultsAfterConflict = await resultsOf(IDS.main);
    check('13a. conflito de expectedHead: outra operadora decidiu durante a confirmação ⇒ NADA gravado (mesma cadeia de resultados) e nova confirmação exigida', other.status === 201 && !!conflicted && chainOf(resultsBeforeConflict) === chainOf(resultsAfterConflict), `POST outra operadora=${other.status}`);
    // 13b. sessão expira no meio da página
    await h.clearSession();
    await clickText('Atualizar');
    check('13b. sessão expirada no meio da página ⇒ vai ao login com retorno (nada de dados em tela)', !!(await waitFor(async () => (await evalJs('location.pathname')) === '/login', 15000)) && /next=/.test(await evalJs('location.search')) && !/Padaria Exemplo/.test(await text()), await evalJs('location.href'));
    await h.setSession(h.operatorSession);
    // 13c. pendências: decisão sem recibo e resultado sem recibo
    const decAnchors = path.join(root, 'anchors', IDS.pdec);
    const decReceiptsBefore = fs.existsSync(decAnchors) ? fs.readdirSync(decAnchors).length : 0;
    await go(lumos('pdec'), (x) => /Decisão pendente/.test(x));
    await waitFor(() => has(/Nenhum resultado registrado ainda/), 10000);
    check('D2. DECISÃO PENDENTE: faixa própria, a decisão NÃO vale, sem resultado e registro bloqueado', (await has(/Decisão pendente/)) && (await has(/Nenhum resultado registrado ainda/)) && (await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled===true`)));
    check('13c. decisão pendente: não vale (sem recibo), o registro do resultado fica bloqueado', (await has(/SEM recibo: ela ainda não vale/)) && (await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled===true`)));
    const decisionConclusion = await h.concludePending('Concluir a decisão');
    check('13d. recuperação: com a origem COMPROVADA e a confirmação explícita, a decisão pendente conclui e grava o recibo', decisionConclusion.disabledBefore && decisionConclusion.enabledAfter && decisionConclusion.clicked && !!(await waitFor(() => has(/Decisão pendente concluída e confirmada/), 15000)) && (fs.existsSync(decAnchors) ? fs.readdirSync(decAnchors).length : 0) > decReceiptsBefore, `recibos ${decReceiptsBefore} → ${fs.existsSync(decAnchors) ? fs.readdirSync(decAnchors).length : 0}`);
    const resAnchors = path.join(root, 'resanchors', IDS.pres);
    check('13e. resultado gravado SEM recibo: nenhum recibo no volume independente', !fs.existsSync(resAnchors) || fs.readdirSync(resAnchors).length === 0);
    await go(lumos('pres'), (x) => /gravado e NÃO confirmado/.test(x));
    check('13f. resultado pendente: aparece como NÃO confirmado e só oferece concluir (não vale como resultado)', (await has(/NÃO confirmado/)) && (await evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.includes('Concluir a confirmação'))`)));
    const runConclusion = await h.concludePending('Concluir a confirmação');
    check('13g. concluir a confirmação (com a caixa marcada): VERIFICADO e o recibo agora existe', runConclusion.disabledBefore && runConclusion.enabledAfter && runConclusion.clicked && !!(await waitFor(() => has(/Confirmado e verificado/), 20000)) && fs.existsSync(resAnchors) && fs.readdirSync(resAnchors).length >= 1);
    // 14. retorno à listagem sem trocar a identidade
    await go(lumos('main'), ready);
    const cardOnList = await cardText(IDS.main);
    await crumb();
    const backOk = await waitFor(async () => (await evalJs('location.pathname')) === '/auditoria-por-link' && (await selectedAudit()) === IDS.main, 25000);
    check('14. retorno à listagem: a MESMA empresa fica selecionada (?auditId=) e o cartão é o da empresa original', !!backOk && (await evalJs('location.search')) === `?auditId=${IDS.main}` && (await cardText(IDS.main)) !== null);
  }

  /* ============================================================ D. ESTADOS DO PRODUTO ============================================================ */
  if (want('D')) {
    h.log('---- D. o operador distingue os estados do produto');
    await h.restartServer();
    const states = [];
    const visit = async (key, readyRe) => { const ok = await go(lumos(key), (x) => readyRe.test(x)); await openAll(); await sleep(300); return { ok: !!ok, t: await text() }; };
    // bloqueada por integridade
    let v = await visit('integ', /Erro de integridade/);
    check('D1. BLOQUEADA (evidência sem integridade): erro de integridade, sem dados da empresa nem cobertura, registro desabilitado', v.ok && !/Cobertura verificada/.test(v.t) && !/CID confirmado/.test(v.t) && (await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled===true`)));
    // PONTUADA (fixture rica) — o resultado selado mostra índice; a prévia ATUAL continua sem índice e o resultado aparece como histórico
    v = await visit('scored', /Resultados finalizados/);
    const strip = await evalJs(`(()=>{const s=document.querySelector('[role="status"]');return s?s.innerText:''})()`);
    const resultsPanel = await evalJs(`(()=>{const r=document.getElementById('resultados');return r?r.innerText:''})()`);
    const previewPanel = v.t.slice(v.t.indexOf('Resultado da prévia'), v.t.indexOf('Critérios Lumos') > 0 ? v.t.indexOf('Critérios Lumos') : undefined);
    check('D3. PONTUADA (fixture rica válida): a lista mostra "Pontuado", o nível e a cobertura do registro', v.ok && /Pontuado/.test(resultsPanel) && /Publicável/.test(resultsPanel) && /cobertura\s*\d+%/.test(resultsPanel) && /Entrada mudou \(stale\)/.test(resultsPanel), resultsPanel.replace(/\s+/g, ' ').slice(0, 200));
    await evalJs(`(()=>{const b=[...document.querySelectorAll('#resultados button')].find(x=>x.innerText.includes('Ver detalhe'));if(b)b.click()})()`);
    await sleep(2500);
    const scoredDetail = await evalJs(`document.getElementById('resultados').innerText`);
    check('D3b. PONTUADA: só o DETALHE do registro selado mostra o Índice Lumos (valor entregue pela API) e o nível; a tela diz que não recalcula', /Índice Lumos\s*\n*\s*\d+(\.\d+)?/.test(scoredDetail) && /PUBLICÁVEL/.test(scoredDetail) && /a página não recalcula índice nem pontos/.test(scoredDetail), scoredDetail.replace(/\s+/g, ' ').slice(250, 420));
    check('D4. a faixa de estado e a prévia ATUAL de uma auditoria com resultado PONTUADO antigo NÃO mostram índice (index:null) e avisam HISTÓRICO (e os trechos medidos não estão vazios)', strip.length > 20 && previewPanel.length > 50 && noIndex(strip) && noIndex(previewPanel) && /HISTÓRICO/.test(v.t), strip.replace(/\s+/g, ' ').slice(0, 200));
    await h.shot('i7-05-pontuada-historico');
    // histórico desatualizado (inconclusivo + decisão posterior)
    v = await visit('hist', /Resultados finalizados/);
    check('D5. HISTÓRICO DESATUALIZADO (inconclusivo + decisão posterior): marcado HISTÓRICO, sem índice', v.ok && /HISTÓRICO/.test(v.t) && noIndex(v.t));
    // verificado e atual
    v = await visit('main', /Resultados finalizados/);
    check('D6. HISTÓRICO DESATUALIZADO em "main": o s0002 confirmado continua listado, mas marcado como histórico porque as decisões mudaram depois dele', v.ok && /s0002/.test(v.t) && /Confirmado/.test(v.t) && /HISTÓRICO/.test(v.t) && noIndex(v.t));
    const latestMain = latestRun(await resultsOf(IDS.main));
    dumpKeys('registro mais recente de main', latestMain && { seq: latestMain.seq, stale: latestMain.stale, decisionsChanged: latestMain.decisionsChanged });
    const inconclusive = [];
    for (const key of ['hist', 'pres']) { const w = await visit(key, /Resultados finalizados|NÃO confirmado/); inconclusive.push(w.ok && w.t.length > 300 && /inconclus/i.test(w.t) && noIndex(w.t)); }
    check('D7. INCONCLUSIVA: nenhum índice nas telas inconclusivas de "hist" e "pres" (texto não vazio, com a frase de inconclusão)', inconclusive.every(Boolean), JSON.stringify(inconclusive));
    await go(lumos('main'), (x) => /Resultados finalizados/.test(x));
    // verificado e atual de verdade: finaliza de novo main (a decisão de outra pessoa do passo 13a já está na prévia)
    await finalizeViaUi();
    await waitFor(async () => /s0003/.test(await text()), 20000);
    await sleep(500);
    const atual = latestRun(await resultsOf(IDS.main));
    check('D8. VERIFICADO E ATUAL: depois de registrar de novo, stale=false e decisionsChanged=false e a tela não marca HISTÓRICO', atual && atual.stale === false && atual.decisionsChanged === false && !/HISTÓRICO/.test(await text()), JSON.stringify(atual && { stale: atual.stale, decisionsChanged: atual.decisionsChanged }));
    // a coleta de hoje: teto de 17% < 40%
    const outcomes = [];
    for (const key of ['main', 'hist', 'pres']) { const p = await previewOf(IDS[key]); outcomes.push(p && p.outcomePreview); }
    dumpKeys('outcomePreview', outcomes[0]);
    check('D9. coleta atual (D5 não implementada): TODAS as prévias reais são INCONCLUSIVO, cobertura ≤ 17% (teto documentado) e abaixo do mínimo de 40%', outcomes.every((o) => o && o.outcome === 'INCONCLUSIVO' && o.coveragePercent <= 17 && o.minimumCoveragePercent === 40 && o.level === null), JSON.stringify(outcomes.map((o) => o && [o.outcome, o.coveragePercent])));
  }

  /* ============================================================ B. INTEGRIDADE E SEGURANÇA (API REAL) ============================================================ */
  if (want('B')) {
    h.log('---- B. integridade e segurança (API)');
    await h.restartServer();
    await go(lumos('main'), ready);
    const id = IDS.main;
    const routes = [
      ['GET', `/api/link-audit/evidence`], ['GET', `/api/link-audit/evidence/${id}`], ['GET', `/api/link-audit/decisions/${id}`], ['GET', `/api/link-audit/scoring/${id}`],
      ['GET', `/api/link-audit/scoring/${id}/results`], ['GET', `/api/link-audit/scoring/${id}/results/1`], ['POST', `/api/link-audit/scoring/${id}/finalize`], ['POST', `/api/link-audit/decisions/${id}`], ['POST', `/api/link-audit/decisions/${id}/revocations`],
    ];
    // B1 sem sessão e com operador não autorizado
    const noSession = [];
    for (const [method, route] of routes) { const r = method === 'GET' ? await api(route, {}, true) : await post(route, {}, true); noSession.push(`${method} ${route.replace(id, ':id')} → ${r.status}`); if (r.status !== 401) noSession.push('!'); }
    check('B1. sem sessão: TODAS as rotas respondem 401 e nada de dados', !noSession.includes('!'), noSession.join(' | ').slice(0, 500));
    await h.setSession(h.intruderSession);
    const intruder = [];
    for (const [method, route] of routes) { const r = method === 'GET' ? await api(route) : await post(route, {}); intruder.push(`${method} ${r.status}`); if (r.status !== 403 || /Padaria|capture:c0001|CID/.test(r.body)) intruder.push('!'); }
    check('B2. operador com sessão válida mas NÃO autorizado: TODAS as rotas respondem 403 e nada de dados', !intruder.includes('!') && intruder.every((x) => x === 'GET 403' || x === 'POST 403'), intruder.join(' | '));
    await h.setSession(h.operatorSession);
    // B3 cabeçalhos e vazamentos
    const sample = [];
    for (const route of [`/api/link-audit/scoring/${id}`, `/api/link-audit/scoring/${id}/results`, `/api/link-audit/scoring/${id}/results/1`, `/api/link-audit/decisions/${id}`, `/api/link-audit/evidence/${id}`]) sample.push([route, await api(route)]);
    check('B3. respostas autenticadas: 200, JSON, Cache-Control: no-store e nosniff', sample.every(([, r]) => r.status === 200 && /json/.test(r.ctype || '') && /no-store/.test(r.cache || '') && /nosniff/.test(r.nosniff || '')), sample.map(([p, r]) => `${r.status}/${r.cache}/${r.nosniff}`).join(' | ').slice(0, 300));
    const resultsBody = sample.filter(([p]) => /scoring/.test(p)).map(([, r]) => r.body).join('\n');
    const forbidden = [/bia@empresa\.com/i, /operatorRecords/, /"input"\s*:/, /"recordedBy"\s*:\s*"[^"]*@/, /conferido pelo operador na homologação/, /Equivalência conferida por outra pessoa/, /stack/i, /\/tmp\//, /gmn-browser/, /\/home\//];
    const leaks = [];
    for (const [route, r] of sample.filter(([p]) => /scoring/.test(p))) for (const re of forbidden) { const m = re.exec(r.body); if (m) leaks.push(`${route.replace(id, ':id')} ${re}: …${r.body.slice(Math.max(0, m.index - 70), m.index + 90).replace(/\s+/g, ' ')}…`); }
    check('B4. resultados e prévia NÃO vazam: e-mail de OUTRO operador, justificativas das decisões, entrada bruta, autor de decisão, caminhos do servidor nem stack (só `finalizedBy`, por contrato)', leaks.length === 0, leaks.slice(0, 2).join(' || '));
    const bad = await api(`/api/link-audit/scoring/${encodeURIComponent('../../etc/passwd')}`);
    const missing = await api(`/api/link-audit/scoring/auditoria-inexistente-9`);
    check('B5. identificador malformado ⇒ 400 sem ecoar a entrada; auditoria inexistente ⇒ 404 genérico, sem caminho do servidor', bad.status === 400 && !/passwd/.test(bad.body) && missing.status === 404 && !/\/tmp\/|gmn-browser|ENOENT/.test(missing.body), `${bad.status}/${missing.status}`);
    // B5b cabeçalhos de segurança das PÁGINAS e nenhuma requisição de terceiros a partir do navegador
    const pageHeaders = await evalJs(`(async()=>{const out={};for(const p of ['/auditoria-por-link','/auditoria-por-link/${id}']){const r=await fetch(p);out[p]={status:r.status,nosniff:r.headers.get('x-content-type-options'),frame:r.headers.get('x-frame-options'),referrer:r.headers.get('referrer-policy'),csp:r.headers.get('content-security-policy')||r.headers.get('content-security-policy-report-only'),cache:r.headers.get('cache-control')}}return out})()`);
    check('B5b. páginas da Auditoria por Link: nosniff, X-Frame-Options DENY, Referrer-Policy e CSP presentes', Object.values(pageHeaders).every((x) => x.status === 200 && /nosniff/.test(x.nosniff || '') && /DENY/i.test(x.frame || '') && !!x.referrer && !!x.csp), JSON.stringify(pageHeaders).slice(0, 360));
    await go(lumos('main'), ready);
    const hosts = await evalJs(`[...new Set(performance.getEntriesByType('resource').map(e=>new URL(e.name).origin))]`);
    check('B5c. o navegador só fala com a PRÓPRIA origem na Auditoria por Link (nenhum Google/Serper/Supabase/terceiro)', Array.isArray(hosts) && hosts.length === 1 && hosts[0] === BASE, JSON.stringify(hosts));
    // B6 entradas inválidas e conflitos não gravam nada (servidor reiniciado: o limitador de finalização, 6/min, não pode mascarar a lógica com 429)
    await h.restartServer();
    const before = await resultsOf(id);
    const prev = await previewOf(id);
    const body = finalizeBody(prev);
    const wrongHash = await post(`/api/link-audit/scoring/${id}/finalize`, { ...body, expectedInputSha256: 'f'.repeat(64) });
    const wrongHead = await post(`/api/link-audit/scoring/${id}/finalize`, { ...body, expectedHead: { seq: 999, sha256: 'a'.repeat(64) } });
    const malformed = await post(`/api/link-audit/scoring/${id}/finalize`, { expectedHead: 'x' });
    const extra = await post(`/api/link-audit/scoring/${id}/finalize`, { ...body, input: { evil: true } });
    const afterBad = await resultsOf(id);
    check('B6. finalizar com hash errado (409), head velho (409), corpo malformado (400) e campo extra (400): NADA gravado', [wrongHash.status, wrongHead.status, malformed.status, extra.status].join() === '409,409,400,400' && chainOf(before) === chainOf(afterBad), `${wrongHash.status}/${wrongHead.status}/${malformed.status}/${extra.status}`);
    const decisionsBefore = JSON.stringify(await decisionsOf(id));
    const staleDecision = await post(`/api/link-audit/decisions/${id}`, { record: { kind: 'NAME_EQUIVALENCE', nameA: 'A', nameB: 'B', justification: 'Justificativa suficientemente longa para o teste de conflito.' }, expectedHead: { seq: 999, sha256: 'b'.repeat(64) } });
    check('B7. decisão com expectedHead velho ⇒ 409 e nada gravado', staleDecision.status === 409 && JSON.stringify(await decisionsOf(id)) === decisionsBefore, String(staleDecision.status));
    // B8 idempotência e concorrência: a prévia atual de main já foi registrada (D8) ⇒ reenviar o MESMO corpo é replay
    await h.restartServer();
    const seqBefore = Array.isArray(before && before.results) ? before.results.length : null;
    const replay = await post(`/api/link-audit/scoring/${id}/finalize`, body);
    const afterReplay = await resultsOf(id);
    dumpKeys('replay', { status: replay.status, body: (parse(replay) || {}).replayed, keys: Object.keys(parse(replay) || {}) });
    check('B8. idempotência: reenviar o MESMO corpo de uma prévia já registrada devolve o registro existente (replayed) e NÃO cria outro', (replay.status === 200 || replay.status === 201) && (parse(replay) || {}).replayed === true && chainOf(before) === chainOf(afterReplay), `status=${replay.status}`);
    // nova decisão ⇒ prévia nova; duas finalizações simultâneas com o mesmo corpo ⇒ exatamente um registro novo
    await h.restartServer();
    const head2 = (await decisionsOf(id)).head;
    const raceDecision = await post(`/api/link-audit/decisions/${id}`, { record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Juízo de teste para exercitar a concorrência da finalização.' }, expectedHead: head2 });
    const prev2 = await previewOf(id);
    check('B8b. uma decisão nova (C2) muda a prévia: hash da entrada diferente e finalização permitida', raceDecision.status === 201 && prev2.finalization.expectedInputSha256 !== prev.finalization.expectedInputSha256 && prev2.finalization.allowed === true, `POST=${raceDecision.status}`);
    const body2 = finalizeBody(prev2);
    const racers = await evalJs(`(async()=>{const go=()=>fetch('/api/link-audit/scoring/${id}/finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body2))}}).then(async r=>({status:r.status,body:await r.text()}));return Promise.all([go(),go(),go()])})()`);
    const afterRace = await resultsOf(id);
    const created = (Array.isArray(afterRace && afterRace.results) ? afterRace.results.length : -1) - (seqBefore ?? 0);
    const okCount = racers.filter((r) => r.status === 200 || r.status === 201).length;
    dumpKeys('corrida', racers.map((r) => ({ s: r.status, replayed: (() => { try { return JSON.parse(r.body).replayed; } catch { return null; } })() })));
    check('B9. concorrência: 3 finalizações SIMULTÂNEAS do mesmo corpo criam exatamente 1 registro (as outras são replay ou conflito), sem 429 nem 5xx', created === 1 && racers.every((r) => [200, 201, 409].includes(r.status)) && okCount >= 1, `novos=${created} status=${racers.map((r) => r.status).join(',')}`);
    const createdBody = (() => { const r = racers.find((x) => x.status === 201); try { return r ? JSON.parse(r.body) : null; } catch { return null; } })();
    const replayedBodies = racers.filter((x) => x.status === 200).map((x) => { try { return JSON.parse(x.body); } catch { return null; } });
    check('B9b. a resposta de criação traz definitive=true, replayed=false, anchored=true, stateChangedAfterFinalization=false e recoveredPending=false; as outras vêm replayed=true com o MESMO head', !!createdBody && createdBody.definitive === true && createdBody.replayed === false && createdBody.anchored === true && createdBody.stateChangedAfterFinalization === false && createdBody.recoveredPending === false && replayedBodies.length >= 1 && replayedBodies.every((b) => b && b.replayed === true && JSON.stringify(b.head) === JSON.stringify(createdBody.head)), JSON.stringify(createdBody && { r: createdBody.replayed, a: createdBody.anchored, s: createdBody.stateChangedAfterFinalization, h: createdBody.head && createdBody.head.seq }));
    await h.restartServer();
    // B10 evidência adulterada DEPOIS de finalizar: o resultado selado continua consultável e a prévia nova é bloqueada
    const realBody = finalizeBody(await previewOf(IDS.hist)); // corpo VÁLIDO, tomado antes de adulterar
    const capture = path.join(root, 'evidence', IDS.hist, 'c0001.capture.json');
    const original = fs.readFileSync(capture, 'utf8');
    fs.chmodSync(capture, 0o644);
    fs.writeFileSync(capture, original.replace('Padaria', 'Padarya'));
    await sleep(200);
    const tamperedPreview = await api(`/api/link-audit/scoring/${IDS.hist}`);
    const tamperedResults = await resultsOf(IDS.hist);
    const finalizeAfterTamper = await post(`/api/link-audit/scoring/${IDS.hist}/finalize`, realBody);
    const resultsAfterTamper = await resultsOf(IDS.hist);
    check('B10. evidência adulterada DEPOIS do resultado: a prévia é recusada (409) e o resultado selado segue consultável (200)', tamperedPreview.status === 409 && !!tamperedResults && Array.isArray(tamperedResults.results) && tamperedResults.results.length === 1, `prévia=${tamperedPreview.status} resultados=${tamperedResults ? 'ok' : 'erro'} finalizar=${finalizeAfterTamper.status}`);
    dumpKeys('resultados com evidência adulterada', tamperedResults && { stale: tamperedResults.stale, n: (tamperedResults.results || []).length });
    check('B10b. com a evidência adulterada, finalizar com o corpo VÁLIDO de antes é recusado por integridade (409) e nenhum registro novo aparece', finalizeAfterTamper.status === 409 && chainOf(tamperedResults) === chainOf(resultsAfterTamper), `finalizar=${finalizeAfterTamper.status}`);
    // a condição verificada é o PRÓPRIO erro de integridade: "Resultados finalizados" (título da lista) aparece antes de a prévia falhar e não prova nada sobre o erro
    await go(lumos('hist'), (x) => /Erro de integridade/.test(x));
    await openAll();
    check('B10c. na tela: erro de integridade visível e registro desabilitado; o resultado selado anterior continua listado', (await has(/Erro de integridade/)) && (await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled!==false`)));
    fs.writeFileSync(capture, original);
    fs.chmodSync(capture, 0o444);
    // B11 resultado adulterado em disco e recibo removido
    await h.restartServer();
    const runFile = path.join(root, 'results', IDS.hist, 's0001.json');
    const runOriginal = fs.readFileSync(runFile, 'utf8');
    fs.chmodSync(runFile, 0o644);
    fs.writeFileSync(runFile, runOriginal.replace('"outcome"', '"outcomf"'));
    const tamperedRun = await api(`/api/link-audit/scoring/${IDS.hist}/results/1`);
    const tamperedList = await api(`/api/link-audit/scoring/${IDS.hist}/results`);
    const finalizeOnBrokenChain = await post(`/api/link-audit/scoring/${IDS.hist}/finalize`, realBody);
    check('B11. resultado ADULTERADO em disco: detalhe e lista são recusados (409) e finalizar (com o corpo válido) sobre a cadeia quebrada é recusado (409)', tamperedRun.status === 409 && tamperedList.status === 409 && finalizeOnBrokenChain.status === 409, `detalhe=${tamperedRun.status} lista=${tamperedList.status} finalizar=${finalizeOnBrokenChain.status}`);
    fs.writeFileSync(runFile, runOriginal);
    fs.chmodSync(runFile, 0o444);
    const restored = await api(`/api/link-audit/scoring/${IDS.hist}/results/1`);
    check('B11b. restaurado o arquivo, o resultado volta a ser entregue e verificado', restored.status === 200 && /"definitive":true/.test(restored.body));
    // recibo removido ⇒ o resultado NÃO vale como confirmado
    const receipt = path.join(root, 'resanchors', IDS.hist);
    const receiptFiles = fs.existsSync(receipt) ? fs.readdirSync(receipt) : [];
    if (receiptFiles.length > 0) {
      const receiptFile = path.join(receipt, receiptFiles[0]);
      const receiptOriginal = fs.readFileSync(receiptFile);
      fs.chmodSync(receiptFile, 0o644);
      fs.rmSync(receiptFile);
      const noReceipt = await api(`/api/link-audit/scoring/${IDS.hist}/results/1`);
      const noReceiptList = await api(`/api/link-audit/scoring/${IDS.hist}/results`);
      const noReceiptPending = (parse(noReceiptList) || {}).pending || {};
      check('B12. recibo REMOVIDO do volume independente (MINOR-2): o detalhe é recusado (409) e a lista NÃO o conta como confirmado: vira pendente com origem COMPROVADA (a limitação — gravação interrompida × recibo removido — é indistinguível e fica dita na tela)', noReceipt.status === 409 && noReceiptList.status === 200 && (parse(noReceiptList) || {}).results.length === 0 && noReceiptPending.origin === 'PROVEN', `detalhe=${noReceipt.status} lista=${noReceiptList.status} ${noReceiptList.body.slice(0, 120)}`);
      fs.writeFileSync(receiptFile, receiptOriginal);
      fs.chmodSync(receiptFile, 0o444);
    } else h.skip('B12. recibo removido', 'sem recibo no volume para a auditoria "hist"');

    // B13 — O ATAQUE ORIGINAL (MAJOR-1): pendências FORJADAS por quem só escreve numa pasta de dados, citando o operador autorizado como autor
    await h.restartServer();
    await go(lumos('forgedDec'), (x) => /Decisão pendente/.test(x));
    const forgedDecPanel = await evalJs(`(()=>{const s=document.querySelector('section[aria-labelledby$="-t"]');return s?s.innerText:''})()`);
    check('B13a. decisão FORJADA (UI): a tela diz que a origem NÃO foi comprovada, não mostra autor nem conteúdo do arquivo e NÃO oferece botão nem caixa', /A origem NÃO foi comprovada pelo servidor/.test(forgedDecPanel) && /Não pode ser concluído por esta tela/.test(forgedDecPanel) && !/ana@empresa\.com|Padaria Exemplo/.test(forgedDecPanel) && (await evalJs(`document.querySelectorAll('section[aria-labelledby$="-t"] button, section[aria-labelledby$="-t"] input').length`)) === 0, forgedDecPanel.replace(/\s+/g, ' ').slice(0, 160));
    const forgedFile = JSON.parse(fs.readFileSync(path.join(root, 'decisions', IDS.forgedDec, 'd0001.json'), 'utf8'));
    const decReceipts = path.join(root, 'anchors', IDS.forgedDec);
    const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort().join() : '');
    const decReceiptsBefore2 = listing(decReceipts);
    const decisionsFileBefore = fs.readFileSync(path.join(root, 'decisions', IDS.forgedDec, 'd0001.json'), 'utf8');
    const attackDecision = await post(`/api/link-audit/decisions/${IDS.forgedDec}`, { record: forgedFile.record, expectedHead: null }); // a PRÓPRIA ana reenvia a operação do arquivo
    const attackDecisionBody = parse(attackDecision) || {};
    const forgedDecList = (await decisionsOf(IDS.forgedDec)) || {};
    check('B13b. decisão FORJADA (API): a própria "ana" reenvia a operação do arquivo ⇒ 409 (PENDING_ORIGIN_UNPROVEN pela 6B ou DECISIONS_HISTORY_UNRESOLVED pelo livro, que recusa ANTES por a forja não casar com a INTENT); nenhum recibo; o arquivo intacto; continua pendente, sem decisão vigente e bloqueando', attackDecision.status === 409 && ['PENDING_ORIGIN_UNPROVEN', 'DECISIONS_HISTORY_UNRESOLVED'].includes(attackDecisionBody.code) && listing(decReceipts) === decReceiptsBefore2 && fs.readFileSync(path.join(root, 'decisions', IDS.forgedDec, 'd0001.json'), 'utf8') === decisionsFileBefore && (forgedDecList.decisions || []).length === 0 && forgedDecList.finalizable === false && (forgedDecList.pending || {}).origin === 'UNPROVEN' && (forgedDecList.pending || {}).record === null && (forgedDecList.pending || {}).recordedBy === null, `status=${attackDecision.status} ${attackDecisionBody.code} livro=${((forgedDecList.ledger || {}).state)}/${((forgedDecList.ledger || {}).reason)}`);
    await go(lumos('forgedRun'), (x) => /NÃO confirmado/.test(x));
    const forgedRunPanel = await evalJs(`(()=>{const s=document.querySelector('section[aria-labelledby$="-t"]');return s?s.innerText:''})()`);
    check('B13c. resultado FORJADO (UI): origem NÃO comprovada, sem botão, sem desfecho/cobertura/autor do arquivo', /A origem NÃO foi comprovada pelo servidor/.test(forgedRunPanel) && /Não pode ser concluído por esta tela/.test(forgedRunPanel) && !/Cobertura|Inconclusivo|Pontuado|ana@empresa\.com|Foi você/.test(forgedRunPanel) && (await evalJs(`document.querySelectorAll('section[aria-labelledby$="-t"] button, section[aria-labelledby$="-t"] input').length`)) === 0, forgedRunPanel.replace(/\s+/g, ' ').slice(0, 160));
    const forgedRunList = (await resultsOf(IDS.forgedRun)) || {};
    const runReceipts = path.join(root, 'resanchors', IDS.forgedRun);
    const runReceiptsBefore = listing(runReceipts);
    const attackRun = await post(`/api/link-audit/scoring/${IDS.forgedRun}/finalize`, { expectedHead: (forgedRunList.pending || {}).decisionsHead ?? null, expectedInputSha256: (forgedRunList.pending || {}).inputSha256 }); // o pedido que a interface montava a partir do servidor
    const attackRunBody = parse(attackRun) || {};
    const forgedRunAfter = (await resultsOf(IDS.forgedRun)) || {};
    check('B13d. resultado FORJADO (API): a própria "ana" conclui com o pedido montado do servidor ⇒ 409 RESULT_PENDING_ORIGIN_UNPROVEN; nenhum recibo; nenhum resultado confirmado; o detalhe não é entregue', attackRun.status === 409 && attackRunBody.code === 'RESULT_PENDING_ORIGIN_UNPROVEN' && listing(runReceipts) === runReceiptsBefore && (forgedRunList.pending || {}).origin === 'UNPROVEN' && (forgedRunList.pending || {}).outcome === null && (forgedRunAfter.results || []).length === 0 && (await api(`/api/link-audit/scoring/${IDS.forgedRun}/results/1`)).status === 409, `status=${attackRun.status} ${attackRunBody.code}`);

    // B14 — MINOR-1 no nível HTTP: um FIFO no lugar do próximo arquivo de resultados NÃO trava o servidor (409 de integridade) e as demais auditorias seguem respondendo
    const fifo = path.join(root, 'results', IDS.hist, 's0002.json');
    execFileSync('mkfifo', [fifo]);
    try {
      const started = Date.now();
      const viaFifo = await evalJs(`(async()=>{const c=new AbortController();setTimeout(()=>c.abort(),8000);try{const r=await fetch('/api/link-audit/scoring/${IDS.hist}/results',{signal:c.signal});return {status:r.status}}catch(e){return {status:'abortado'}}})()`);
      const during = await api(`/api/link-audit/scoring/${IDS.main}/results`);
      check('B14. FIFO no lugar de um arquivo de resultados: a consulta responde 409 (integridade) em menos de 8 s, sem travar, e outra auditoria segue respondendo 200', viaFifo.status === 409 && Date.now() - started < 8000 && during.status === 200, `fifo=${viaFifo.status} outra=${during.status} ${Date.now() - started} ms`);
    } finally {
      fs.rmSync(fifo, { force: true });
    }
    check('B14b. removido o FIFO, a auditoria volta a ser lida normalmente', (await api(`/api/link-audit/scoring/${IDS.hist}/results`)).status === 200);

    // B15 — PROVA DE COLETA (R2-MINOR-1): integridade ≠ autenticidade. A auditoria `unsealed` tem evidência ÍNTEGRA mas SEM manifesto assinado.
    await h.restartServer();
    const sealedPreview = await previewOf(IDS.main);
    const unsealedPreview = await previewOf(IDS.unsealed);
    check('B15a. coleta ATESTADA (manifesto assinado por chave de confiança): autenticidade comprovada e finalização permitida pela API', !!sealedPreview && sealedPreview.evidence.provenance.status === 'AUTHENTICATED' && sealedPreview.finalization.allowed === true, JSON.stringify(sealedPreview && sealedPreview.evidence.provenance));
    check('B15b. coleta SEM manifesto (integridade OK): a prévia é consultável, a integridade é OK, mas a autenticidade é NÃO comprovada e a finalização NÃO é permitida', !!unsealedPreview && unsealedPreview.evidence.integrity.status === 'OK' && unsealedPreview.evidence.provenance.status === 'UNAUTHENTICATED' && unsealedPreview.evidence.provenance.reason === 'NO_SEAL' && unsealedPreview.finalization.allowed === false && unsealedPreview.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN'), JSON.stringify(unsealedPreview && unsealedPreview.evidence.provenance));
    const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
    const unsealedResults = path.join(root, 'results', IDS.unsealed);
    const unsealedReceipts = path.join(root, 'resanchors', IDS.unsealed);
    // o pedido que a interface montaria a partir do servidor (cabeça e hash da própria prévia): a recusa tem de ser pela PROVA, não por visão desatualizada
    const forcedFinalize = await post(`/api/link-audit/scoring/${IDS.unsealed}/finalize`, { expectedHead: unsealedPreview ? unsealedPreview.finalization.expectedHead : null, expectedInputSha256: (unsealedPreview && unsealedPreview.finalization.expectedInputSha256) || 'a'.repeat(64) });
    const forcedBody = parse(forcedFinalize) || {};
    check('B15c. finalizar a coleta sem manifesto pela API é recusado (409 NOT_FINALIZABLE com o bloqueio de proveniência) e nada é gravado (nem resultado, nem recibo)', forcedFinalize.status === 409 && forcedBody.code === 'NOT_FINALIZABLE' && (forcedBody.blockers || []).some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN') && filesIn(unsealedResults) === 0 && filesIn(unsealedReceipts) === 0, `${forcedFinalize.status} ${forcedFinalize.body.slice(0, 160)}`);
    // ESTADO FINAL, não placeholder: o rótulo "Origem da coleta (autenticidade)" existe desde que a EVIDÊNCIA chega (com "—"); as insígnias e o motivo só existem quando a PRÉVIA
    // termina de carregar. Esperar o rótulo lia a tela no meio do carregamento. A espera é pelo fim do carregamento da prévia (sucesso ou erro), nunca por tempo fixo.
    await go(lumos('unsealed'), (x) => /Origem da coleta/.test(x) && !/Carregando (a prévia|as evidências da prévia)/.test(x) && /Integridade local verificada|Evidência incompleta|Evidência adulterada/.test(x));
    const unsealedText = await text();
    check('B15d. na tela: a origem da coleta aparece como NÃO comprovada (distinta da integridade OK), diz que SHA-256 não mostra quem coletou e o registro fica desabilitado', /Integridade local verificada \(SHA-256\)/.test(unsealedText) && /NÃO comprovada/.test(unsealedText) && /não mostra quem o coletou/.test(unsealedText) && !(await enabledButton('Registrar resultado')), JSON.stringify({ integ: /Integridade local verificada \(SHA-256\)/.test(unsealedText), nao: /NÃO comprovada/.test(unsealedText), quem: /não mostra quem o coletou/.test(unsealedText), trecho: unsealedText.replace(/\s+/g, ' ').slice(0, 200) }));
    await h.shot('i7-B15-coleta-sem-prova');

    // B16 — R3-MINOR-2: a revogação confirmada NUNCA é reativada por recibo removido nem por quarentena da pendente (testemunha = resultado selado em outras pastas)
    await h.restartServer();
    const revId = IDS.revoked;
    const decisionsOf2 = async () => parse(await api(`/api/link-audit/decisions/${revId}`)) || {};
    const decFile = path.join(root, 'decisions', revId, 'd0002.json');
    const decReceipt = path.join(root, 'anchors', revId, 'a0002.json');
    const quarantineDir = path.join(root, 'quarentena-revogacao');
    await go(lumos('revoked'), ready);
    const ok0 = await decisionsOf2();
    check('B16a. revogação confirmada + resultado selado: testemunha CONSISTENTE, nenhuma decisão vigente, finalizável pelo lado das decisões', (ok0.witness || {}).status === 'CONSISTENT' && (ok0.decisions || []).length === 0 && ok0.finalizable === true, JSON.stringify(ok0.witness));
    fs.chmodSync(decReceipt, 0o644);
    fs.rmSync(decReceipt);
    const lost = await decisionsOf2();
    check('B16b. recibo da REVOGAÇÃO removido: RECEIPT_LOST_WITNESSED, a decisão revogada NÃO volta a valer (EM DÚVIDA), nada finalizável', (lost.witness || {}).status === 'RECEIPT_LOST_WITNESSED' && (lost.decisions || []).length === 0 && (lost.operatorRecords || []).length === 0 && lost.finalizable === false && JSON.stringify(lost.ambiguousDecisionIds) === '["op-0001"]', JSON.stringify([lost.witness, lost.ambiguousDecisionIds]));
    await go(lumos('revoked'), ready);
    check('B16c. na tela: o incidente de integridade é dito (inclusive a quem não é o autor), sem botão de finalizar', (await has(/Incidente de integridade/)) && (await has(/Em dúvida: op-0001/)) && !(await enabledButton('Registrar resultado')));
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.renameSync(decFile, path.join(quarantineDir, 'd0002.json')); // o operador "resolve" mandando a pendente para a quarentena (o procedimento antigo)
    const regressed = await decisionsOf2();
    check('B16d. pendência MOVIDA para a quarentena: histórico NÃO resolvido (HISTORY_REGRESSED), ZERO decisões vigentes, motor sem decisões, nada finalizável', (regressed.witness || {}).status === 'HISTORY_REGRESSED' && (regressed.decisions || []).length === 0 && (regressed.operatorRecords || []).length === 0 && regressed.finalizable === false, JSON.stringify(regressed.witness));
    const prevView = await previewOf(revId);
    check('B16e. a prévia aponta o bloqueio DECISIONS_HISTORY_UNRESOLVED, não aplica nenhuma decisão e não permite finalizar', !!prevView && prevView.finalization.allowed === false && (prevView.decisions.applied || []).length === 0 && prevView.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED'), JSON.stringify(prevView && prevView.blockers.map((b) => b.code)));
    const writeTry = await post(`/api/link-audit/decisions/${revId}`, { record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Conferido no painel do perfil pelo operador.' }, expectedHead: regressed.head });
    check('B16f. nenhuma decisão nova é aceita com o histórico não resolvido (409 DECISIONS_HISTORY_UNRESOLVED) e nada é gravado', writeTry.status === 409 && (parse(writeTry) || {}).code === 'DECISIONS_HISTORY_UNRESOLVED' && !fs.existsSync(decFile), `${writeTry.status} ${writeTry.body.slice(0, 120)}`);
    await go(lumos('revoked'), ready);
    check('B16g. na tela: aviso de integridade NÃO resolvida a todos, sem decisão vigente e sem botão de finalizar', (await has(/Integridade do histórico de decisões NÃO resolvida/)) && !(await enabledButton('Registrar resultado')));
    await h.shot('i7-B16-historico-nao-resolvido');
    fs.renameSync(path.join(quarantineDir, 'd0002.json'), decFile); // restauração PARCIAL: só o arquivo
    const half = await decisionsOf2();
    check('B16h. restauração parcial (arquivo sem recibo): volta a RECEIPT_LOST_WITNESSED, ainda sem decisão vigente', (half.witness || {}).status === 'RECEIPT_LOST_WITNESSED' && (half.decisions || []).length === 0, JSON.stringify(half.witness));
    const concluded = await post(`/api/link-audit/decisions/${revId}/revocations`, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito.', expectedHead: half.head });
    const done = await decisionsOf2();
    check('B16i. o AUTOR (origem comprovada) conclui a recuperação: recibo recriado, testemunha CONSISTENTE, decisão REVOGADA, nada reativado', (concluded.status === 200 || concluded.status === 201) && (done.witness || {}).status === 'CONSISTENT' && (done.decisions || []).length === 0 && (done.allDecisions || []).every((d) => d.status === 'REVOKED') && done.finalizable === true, `${concluded.status} ${JSON.stringify(done.witness)}`);

    // B17 — R4-MINOR-1: a ROTAÇÃO da chave não faz o sistema esquecer a testemunha (recibos removidos + quarentena + chave rotacionada ⇒ NÃO resolvido);
    //       INFO-1: dependência da testemunha ausente NÃO é "sem inconsistência". Chaves geradas na hora; nada fixo.
    const receiptsDir = path.join(root, 'resanchors', revId);
    const resultReceipt = path.join(receiptsDir, 'a0001.json');
    const backupDir = path.join(root, 'backup-r4');
    fs.mkdirSync(backupDir, { recursive: true });
    const keep = [[resultReceipt, 'a0001-resultado.json'], [decReceipt, 'a0002-decisao.json'], [decFile, 'd0002.json']];
    for (const [file, name] of keep) fs.copyFileSync(file, path.join(backupDir, name));
    for (const file of [resultReceipt, decReceipt]) { fs.chmodSync(file, 0o644); fs.rmSync(file); }
    fs.renameSync(decFile, path.join(quarantineDir, 'd0002.json'));
    h.setServerEnv({ GMN_LINK_AUDIT_ORIGIN_KEY: h.freshOriginKey(), GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS: h.originKeyId });
    await h.restartServer();
    const rotated = await decisionsOf2();
    check('B17a. chave ROTACIONADA (a antiga revogada) + os DOIS recibos removidos + d0002 em quarentena: histórico NÃO resolvido (UNTRUSTED), ZERO decisões vigentes, motor vazio, nada finalizável', (rotated.witness || {}).status === 'UNTRUSTED' && (rotated.decisions || []).length === 0 && (rotated.operatorRecords || []).length === 0 && rotated.finalizable === false && (rotated.allDecisions || []).every((d) => d.status !== 'ACTIVE'), JSON.stringify(rotated.witness));
    const rotatedPreview = await previewOf(revId);
    check('B17b. a prévia aponta DECISIONS_HISTORY_UNRESOLVED (motivo UNTRUSTED), não aplica nenhuma decisão e não permite finalizar', !!rotatedPreview && rotatedPreview.finalization.allowed === false && (rotatedPreview.decisions.applied || []).length === 0 && rotatedPreview.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.reasonCode === 'UNTRUSTED'), JSON.stringify(rotatedPreview && rotatedPreview.blockers.map((b) => b.code)));
    const rotatedWrite = await post(`/api/link-audit/decisions/${revId}`, { record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Conferido no painel do perfil pelo operador.' }, expectedHead: rotated.head });
    check('B17c. nenhuma escrita é aceita (409 DECISIONS_HISTORY_UNRESOLVED) e nada é gravado', rotatedWrite.status === 409 && (parse(rotatedWrite) || {}).code === 'DECISIONS_HISTORY_UNRESOLVED' && !fs.existsSync(decFile), `${rotatedWrite.status} ${rotatedWrite.body.slice(0, 120)}`);
    await go(lumos('revoked'), ready);
    check('B17d. na tela: aviso de integridade NÃO resolvida com o motivo "testemunha NÃO é confiável", sem botão de finalizar', (await has(/Integridade do histórico de decisões NÃO resolvida/)) && (await has(/NÃO é confiável/)) && !(await enabledButton('Registrar resultado')));
    await h.shot('i7-B17-rotacao-testemunha-nao-confiavel');
    // recuperação LEGÍTIMA: a partir do backup independente (fora do sistema), com a configuração original
    for (const [file, name] of keep) fs.copyFileSync(path.join(backupDir, name), file);
    fs.chmodSync(decFile, 0o444);
    h.resetServerEnv();
    await h.restartServer();
    const afterRestore = await decisionsOf2();
    check('B17e. restaurado o par do backup e a configuração original: testemunha CONSISTENTE, decisão revogada, nada reativado', (afterRestore.witness || {}).status === 'CONSISTENT' && (afterRestore.decisions || []).length === 0 && (afterRestore.allDecisions || []).every((d) => d.status === 'REVOKED'), JSON.stringify(afterRestore.witness));
    // INFO-1: a pasta de recibos dos resultados NÃO está configurada
    const mainBefore17 = await decisionsOf(IDS.main);
    const effectiveBefore = ((mainBefore17 || {}).decisions || []).length;
    check('B17f0. precondição: a auditoria principal TEM decisão vigente com a configuração íntegra (senão "zero vigentes" não provaria nada)', effectiveBefore > 0 && ((mainBefore17 || {}).witness || {}).status !== 'NOT_CONFIGURED', JSON.stringify({ vigentes: effectiveBefore, witness: (mainBefore17 || {}).witness }));
    h.setServerEnv({ GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR: undefined });
    await h.restartServer();
    const mainView = await decisionsOf(IDS.main);
    check('B17f. SEM a pasta de recibos dos resultados: NOT_CONFIGURED, ZERO decisões vigentes (inclusive as que existem), nada finalizável', ((mainView || {}).witness || {}).status === 'NOT_CONFIGURED' && ((mainView || {}).decisions || []).length === 0 && (mainView || {}).finalizable === false, JSON.stringify((mainView || {}).witness));
    const mainPreview = await previewOf(IDS.main);
    check('B17g. SEM a testemunha configurada, a prévia não é finalizável e diz por quê', !!mainPreview && mainPreview.finalization.allowed === false && mainPreview.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.reasonCode === 'NOT_CONFIGURED'), JSON.stringify(mainPreview && mainPreview.blockers.map((b) => b.code)));
    await go(lumos('main'), ready);
    check('B17h. na tela: "não está configurada neste servidor", nenhuma decisão vigente enviada ao motor, sem botão de finalizar', (await has(/não está configurada neste servidor/)) && !(await enabledButton('Registrar resultado')));
    await h.shot('i7-B17-testemunha-nao-configurada');
    h.resetServerEnv();
    await h.restartServer();
    const back = await decisionsOf(IDS.main);
    check('B17i. configuração restaurada: a testemunha volta a ser lida, as mesmas decisões voltam a ser vigentes e continuam finalizáveis (nenhum estado preso)', ((back || {}).witness || {}).status !== 'NOT_CONFIGURED' && ((back || {}).decisions || []).length === effectiveBefore && (back || {}).finalizable === (mainBefore17 || {}).finalizable, JSON.stringify({ vigentes: ((back || {}).decisions || []).length, esperado: effectiveBefore, witness: (back || {}).witness, finalizable: (back || {}).finalizable }));
  }

  /* ============================================================ L. LIVRO DE CABEÇAS (Q1–Q7) ============================================================ */
  if (want('L')) {
    h.log('---- L. livro de cabeças: estados por auditoria, inscrição, modo restrito, administrativas bloqueadas, chaves, livro removido');
    h.resetServerEnv();
    await h.restartServer();
    await go(`${BASE}/auditoria-por-link`, listReady); // as chamadas de API abaixo usam o fetch da página (cookie da sessão)
    const ledgerDirOf = (id) => path.join(root, 'ledger', id);
    const ledgerEvents = (id) => (fs.existsSync(ledgerDirOf(id)) ? fs.readdirSync(ledgerDirOf(id)).filter((n) => /^l\d{6}\.json$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(ledgerDirOf(id), n), 'utf8'))) : []);
    const dirListing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort().join() : '');
    const judgement = { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Conferido no painel do perfil pelo operador.' };
    const unId = IDS.unenrolled;
    const lgId = IDS.legacy;

    // L1–L5 — auditoria NOVA: inscrição EXPLÍCITA (nunca implícita)
    const un0 = (await decisionsOf(unId)) || {};
    check('L1. auditoria nova SEM inscrição: ENROLLMENT_PENDING, nenhuma decisão vigente, não finalizável, livro ainda inexistente', (un0.ledger || {}).state === 'ENROLLMENT_PENDING' && (un0.decisions || []).length === 0 && un0.finalizable === false && !fs.existsSync(ledgerDirOf(unId)), JSON.stringify(un0.ledger));
    const unWrite = await post(`/api/link-audit/decisions/${unId}`, { record: judgement, expectedHead: null });
    check('L2. gravar SEM inscrever ⇒ 409 LEDGER_ENROLLMENT_REQUIRED; NADA gravado (nem decisão, nem recibo, nem livro)', unWrite.status === 409 && (parse(unWrite) || {}).code === 'LEDGER_ENROLLMENT_REQUIRED' && !fs.existsSync(path.join(root, 'decisions', unId)) && !fs.existsSync(path.join(root, 'anchors', unId)) && !fs.existsSync(ledgerDirOf(unId)), `${unWrite.status} ${(parse(unWrite) || {}).code}`);
    await go(lumos('unenrolled'), ready);
    await openAll();
    check('L3. na tela: aviso de inscrição pendente, "nenhuma decisão é gravada" e o botão de inscrever HABILITADO', (await has(/Auditoria ainda NÃO inscrita no livro de cabeças/)) && (await has(/nenhuma decisão é gravada/)) && !!(await enabledButton('Inscrever esta auditoria no livro')));
    await h.shot('i7-L3-inscricao-pendente');
    await h.clickText('Inscrever esta auditoria no livro');
    const protectedShown = await waitFor(() => has(/Protegida pelo livro de cabeças/), 15000);
    const unEnrolled = (await decisionsOf(unId)) || {};
    check('L4. depois de inscrever: PROTECTED; a tela declara que a guarda externa NÃO está configurada (nada afirma proteção contra rollback coordenado)', !!protectedShown && (unEnrolled.ledger || {}).state === 'PROTECTED' && (unEnrolled.ledger || {}).externalGuard === 'NOT_CONFIGURED' && (await has(/Guarda externa NÃO configurada/)) && !(await has(/proteção contra rollback coordenado garantida/i)), JSON.stringify(unEnrolled.ledger));
    check('L4b. o livro tem exatamente o GENESIS (autenticado, chave do livro) — nenhuma cabeça vazia fabricada', ledgerEvents(unId).map((r) => r.event).join() === 'GENESIS' && ledgerEvents(unId)[0].origin && ledgerEvents(unId)[0].origin.kid === h.ledgerKeyId, ledgerEvents(unId).map((r) => r.event).join());
    await h.shot('i7-L4-protegida');
    const registered = await registerS4('Não se aplica: a empresa não vende produtos físicos, conferido no perfil público.');
    const unAfter = (await decisionsOf(unId)) || {};
    check('L5. depois de inscrita a decisão é gravada pela tela (confirmada) e o livro registra GENESIS → INTENT → CONFIRMED, com a cabeça das decisões', !!registered && (unAfter.decisions || []).length === 1 && ledgerEvents(unId).map((r) => r.event).join() === 'GENESIS,INTENT,CONFIRMED' && (unAfter.ledger || {}).confirmedDecisions === 1, `${ledgerEvents(unId).map((r) => r.event).join()} ${JSON.stringify(unAfter.ledger)}`);
    const again = await post(`/api/link-audit/decisions/${unId}/ledger`, { action: 'ENROLL' });
    check('L5b. inscrever DE NOVO uma auditoria já protegida é recusado e não grava', again.status >= 400 && ledgerEvents(unId).length === 3, `${again.status} ${(parse(again) || {}).code}`);

    // L6–L10 — auditoria LEGADA (histórico anterior ao livro): modo restrito, SEM adoção automática
    const decDirBefore = dirListing(path.join(root, 'decisions', lgId));
    const anchDirBefore = dirListing(path.join(root, 'anchors', lgId));
    const lg = (await decisionsOf(lgId)) || {};
    check('L6. histórico ANTERIOR ao livro: LEGACY_READ_ONLY; ZERO decisões vigentes (mesmo havendo uma no arquivo); não finalizável; integridade NÃO resolvida', (lg.ledger || {}).state === 'LEGACY_READ_ONLY' && (lg.decisions || []).length === 0 && (lg.operatorRecords || []).length === 0 && lg.finalizable === false && !fs.existsSync(ledgerDirOf(lgId)), JSON.stringify(lg.ledger));
    const lgWrite = await post(`/api/link-audit/decisions/${lgId}`, { record: judgement, expectedHead: lg.head });
    check('L7. gravar na legada ⇒ 409 LEDGER_LEGACY_READ_ONLY; nada gravado; nenhum livro criado', lgWrite.status === 409 && (parse(lgWrite) || {}).code === 'LEDGER_LEGACY_READ_ONLY' && dirListing(path.join(root, 'decisions', lgId)) === decDirBefore && dirListing(path.join(root, 'anchors', lgId)) === anchDirBefore && !fs.existsSync(ledgerDirOf(lgId)), `${lgWrite.status} ${(parse(lgWrite) || {}).code}`);
    const lgPreview = await previewOf(lgId);
    check('L8. a prévia da legada não aplica nenhuma decisão e não permite finalizar (DECISIONS_HISTORY_UNRESOLVED)', !!lgPreview && lgPreview.finalization.allowed === false && (lgPreview.decisions.applied || []).length === 0 && lgPreview.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.severity === 'BLOCKING'), JSON.stringify(lgPreview && lgPreview.blockers.map((b) => [b.code, b.reasonCode])));
    await go(lumos('legacy'), ready);
    await openAll();
    check('L9. na tela: MODO RESTRITO, "nenhuma decisão é considerada vigente nem enviada ao motor", SEM botão de inscrever/adotar/restaurar', (await has(/MODO RESTRITO/)) && (await has(/nenhuma decisão é considerada vigente nem enviada ao motor/)) && !(await evalJs(`[...document.querySelectorAll('button')].some(b=>/Inscrever|Adotar|Restaurar|Recuperar/.test(b.innerText))`)));
    await h.shot('i7-L9-legada-modo-restrito');
    const adminResults = [];
    for (const action of ['ADOPT', 'RESTORE_ACK', 'QUARANTINE_ACK']) {
      const r = await post(`/api/link-audit/decisions/${lgId}/ledger`, { action });
      adminResults.push(`${action}:${r.status}:${(parse(r) || {}).code}`);
    }
    const enrollLegacy = await post(`/api/link-audit/decisions/${lgId}/ledger`, { action: 'ENROLL' });
    check('L10. ADOPT, RESTORE_ACK e QUARANTINE_ACK ⇒ 403 ADMIN_APPROVAL_UNAVAILABLE (sem autorização fictícia); ENROLL na legada recusado; nada criado', adminResults.every((x) => /:403:ADMIN_APPROVAL_UNAVAILABLE$/.test(x)) && enrollLegacy.status >= 400 && !fs.existsSync(ledgerDirOf(lgId)) && dirListing(path.join(root, 'decisions', lgId)) === decDirBefore, `${adminResults.join(' ')} ENROLL:${enrollLegacy.status}`);

    // L11–L12 — chave do livro AUSENTE: falha fechada, nada vigente, nada gravado; configuração restaurada ⇒ tudo volta
    const mainBefore = (await decisionsOf(IDS.main)) || {};
    const mainEffective = (mainBefore.decisions || []).length;
    const mainListing = dirListing(path.join(root, 'decisions', IDS.main));
    check('L11a. precondição: a auditoria principal está PROTECTED e tem decisão vigente (senão "zero vigentes" não provaria nada)', (mainBefore.ledger || {}).state === 'PROTECTED' && mainEffective > 0, JSON.stringify({ ledger: mainBefore.ledger, vigentes: mainEffective }));
    h.setServerEnv({ GMN_LINK_AUDIT_LEDGER_KEY: undefined });
    await h.restartServer();
    const noKey = (await decisionsOf(IDS.main)) || {};
    const noKeyWrite = await post(`/api/link-audit/decisions/${IDS.main}`, { record: judgement, expectedHead: noKey.head });
    check('L11. SEM a chave do livro: HISTORY_UNRESOLVED/NOT_CONFIGURED, ZERO decisões vigentes (inclusive as que existem), não finalizável; gravar ⇒ 503 LEDGER_NOT_CONFIGURED e nada gravado', (noKey.ledger || {}).state === 'HISTORY_UNRESOLVED' && (noKey.ledger || {}).reason === 'NOT_CONFIGURED' && (noKey.decisions || []).length === 0 && noKey.finalizable === false && noKeyWrite.status === 503 && (parse(noKeyWrite) || {}).code === 'LEDGER_NOT_CONFIGURED' && dirListing(path.join(root, 'decisions', IDS.main)) === mainListing, `${JSON.stringify(noKey.ledger)} ${noKeyWrite.status}`);
    await go(lumos('main'), ready);
    check('L11b. na tela: "não está configurado neste servidor", nenhuma decisão enviada ao motor, sem botão de finalizar', (await has(/não está configurado neste servidor/)) && !(await enabledButton('Registrar resultado')));
    await h.shot('i7-L11-livro-nao-configurado');
    h.resetServerEnv();
    await h.restartServer();
    const mainBack = (await decisionsOf(IDS.main)) || {};
    check('L12. configuração restaurada: PROTECTED de novo, as MESMAS decisões voltam a valer (nenhum estado preso)', (mainBack.ledger || {}).state === 'PROTECTED' && (mainBack.decisions || []).length === mainEffective, JSON.stringify(mainBack.ledger));

    // L13 — LIVRO REMOVIDO com resultado que o cita: nunca vira "cabeça vazia"
    const histId = IDS.hist;
    const histBefore = (await decisionsOf(histId)) || {};
    const histLedger = ledgerDirOf(histId);
    const histAway = path.join(root, 'ledger-away');
    fs.mkdirSync(histAway, { recursive: true });
    check('L13a. precondição: a auditoria com resultado selado está PROTECTED e o resultado carrega a cabeça do livro (formato v2)', (histBefore.ledger || {}).state === 'PROTECTED' && JSON.parse(fs.readFileSync(path.join(root, 'results', histId, 's0001.json'), 'utf8')).schemaVersion === 2 && !!JSON.parse(fs.readFileSync(path.join(root, 'results', histId, 's0001.json'), 'utf8')).ledgerHead, JSON.stringify(histBefore.ledger));
    fs.renameSync(histLedger, path.join(histAway, histId));
    const histGone = (await decisionsOf(histId)) || {};
    const histWrite = await post(`/api/link-audit/decisions/${histId}`, { record: judgement, expectedHead: histGone.head });
    check('L13. livro REMOVIDO e citado por um resultado: HISTORY_UNRESOLVED/LEDGER_REMOVED_WITNESSED, ZERO vigentes, não finalizável, escrita recusada, livro NÃO recriado', (histGone.ledger || {}).state === 'HISTORY_UNRESOLVED' && (histGone.ledger || {}).reason === 'LEDGER_REMOVED_WITNESSED' && (histGone.decisions || []).length === 0 && histGone.finalizable === false && histWrite.status === 409 && !fs.existsSync(histLedger), `${JSON.stringify(histGone.ledger)} ${histWrite.status}`);
    const histEnroll = await post(`/api/link-audit/decisions/${histId}/ledger`, { action: 'ENROLL' });
    check('L13b. NÃO existe reinscrição: ENROLL recusado e o livro continua ausente', histEnroll.status >= 400 && !fs.existsSync(histLedger), `${histEnroll.status} ${(parse(histEnroll) || {}).code}`);
    fs.renameSync(path.join(histAway, histId), histLedger); // restauração a partir do backup independente (fora do sistema)
    const histRestored = (await decisionsOf(histId)) || {};
    check('L13c. restaurado o livro a partir do backup: PROTECTED de novo, nada foi apagado', (histRestored.ledger || {}).state === 'PROTECTED' && (histRestored.decisions || []).length === (histBefore.decisions || []).length, JSON.stringify(histRestored.ledger));

    // L14–L16 — ROTAÇÃO da chave do livro (planejada) e REVOGAÇÃO por comprometimento (id próprio; independente da chave de origem)
    const oldLedgerKey = h.currentLedgerKey();
    const newLedgerKey = h.freshLedgerKey();
    const until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    h.setServerEnv({ GMN_LINK_AUDIT_LEDGER_KEY: newLedgerKey, GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS: `${oldLedgerKey}:${until}` });
    await h.restartServer();
    const rotatedView = (await decisionsOf(unId)) || {};
    const rotatedWrite = await post(`/api/link-audit/decisions/${unId}`, { record: { kind: 'NAME_EQUIVALENCE', nameA: 'Padaria Exemplo Ltda', nameB: 'Padaria Exemplo', justification: 'Mesmo estabelecimento, conferido no perfil público.' }, expectedHead: rotatedView.head });
    const rotatedEvents = ledgerEvents(unId);
    check('L14. ROTAÇÃO planejada: a auditoria segue PROTECTED com a chave antiga só verificando; a próxima escrita grava um CHECKPOINT assinado pela chave NOVA e depois as etapas da operação', (rotatedView.ledger || {}).state === 'PROTECTED' && rotatedWrite.status === 201 && rotatedEvents.some((r) => r.event === 'CHECKPOINT' && r.origin.kid === newLedgerKey.split(':')[0]) && rotatedEvents[rotatedEvents.length - 1].origin.kid === newLedgerKey.split(':')[0], `${rotatedWrite.status} ${rotatedEvents.map((r) => r.event + ':' + r.origin.kid.slice(0, 7)).join(' ')}`);
    h.setServerEnv({ GMN_LINK_AUDIT_LEDGER_KEY: newLedgerKey, GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS: undefined, GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS: oldLedgerKey.split(':')[0] });
    await h.restartServer();
    const revokedView = (await decisionsOf(unId)) || {};
    const revokedWrite = await post(`/api/link-audit/decisions/${unId}`, { record: judgement, expectedHead: revokedView.head });
    check('L15. chave COMPROMETIDA (id revogado, material removido): KEY_REVOKED mesmo com CHECKPOINT; ZERO decisões vigentes; escrita recusada; nada novo no livro', (revokedView.ledger || {}).state === 'HISTORY_UNRESOLVED' && (revokedView.ledger || {}).reason === 'KEY_REVOKED' && (revokedView.decisions || []).length === 0 && revokedWrite.status === 409 && ledgerEvents(unId).length === rotatedEvents.length, `${JSON.stringify(revokedView.ledger)} ${revokedWrite.status}`);
    await go(lumos('unenrolled'), (x) => /integridade do histórico NÃO resolvida/i.test(x));
    check('L15b. na tela: aviso de integridade NÃO resolvida com "chave REVOGADA por comprometimento", sem botão de recuperar nem de adotar', (await has(/chave REVOGADA por comprometimento/)) && !(await evalJs(`[...document.querySelectorAll('button')].some(b=>/Recuperar|Adotar|Restaurar|Inscrever/.test(b.innerText))`)));
    await h.shot('i7-L15-chave-revogada');
    h.resetServerEnv();
    await h.restartServer();
    const reverted = (await decisionsOf(unId)) || {};
    check('L16. voltar à configuração ORIGINAL depois de gravar com a chave rotacionada NÃO silencia nada: os registros da chave nova são desconhecidos ⇒ HISTORY_UNRESOLVED (alto, nunca "tudo bem")', (reverted.ledger || {}).state === 'HISTORY_UNRESOLVED' && (reverted.decisions || []).length === 0, JSON.stringify(reverted.ledger));
    const finalOriginal = (await decisionsOf(IDS.main)) || {};
    check('L17. as demais auditorias seguem intactas na configuração original (principal PROTECTED com as mesmas decisões)', (finalOriginal.ledger || {}).state === 'PROTECTED' && (finalOriginal.decisions || []).length === mainEffective, JSON.stringify(finalOriginal.ledger));
  }

  /* ============================================================ C. EXPERIÊNCIA DO USUÁRIO ============================================================ */
  if (want('C')) {
    h.log('---- C. experiência (desktop e mobile)');
    await h.restartServer();
    await h.viewport(1440, 1500, false);
    // C1 acessibilidade em página: lista e cada estado do workspace
    await go(`${BASE}/auditoria-por-link`, listReady);
    await h.a11yLint('listagem');
    for (const [key, re, label] of [['main', ready, 'workspace pronta/atual'], ['pdec', /Decisão pendente/, 'decisão pendente'], ['integ', /Erro de integridade/, 'bloqueada (integridade)'], ['scored', /Resultados finalizados/, 'PONTUADA/histórico'], ['pres', /NÃO confirmado/, 'resultado pendente']]) {
      await go(lumos(key), (x) => matches(re, x));
      await openAll();
      await h.a11yLint(`workspace — ${label}`);
    }
    // C2 diálogo de confirmação: nome, foco contido (modal nativo), Esc devolve o foco
    await go(lumos('main'), ready);
    await sleep(500);
    const canOpen = await enabledButton('Registrar resultado');
    if (canOpen) {
      await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim().startsWith('Registrar resultado')&&!e.disabled);b.focus();b.click()})()`);
      await sleep(500);
      check('C2. diálogo de confirmação: modal, com nome acessível e o foco dentro', await evalJs(`(()=>{const d=document.querySelector('dialog');return !!d&&d.open&&!!(d.getAttribute('aria-labelledby')||d.getAttribute('aria-label'))&&d.contains(document.activeElement)})()`));
      const stops = await h.tab(14);
      // num <dialog> modal, o Tab que passa do último controle vai à interface do navegador (aqui: o próprio documento) e volta; NUNCA ao conteúdo atrás
      const visitedInside = new Set(stops.filter((s) => s && s.inDialog).map((s) => `${s.tag}:${s.label}`));
      const focusableInDialog = await evalJs(`[...document.querySelector('dialog').querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(e=>!e.disabled&&e.tabIndex>=0).length`);
      check('C3. diálogo modal: 14 Tab seguidos só passam por controles do diálogo (ou pelo documento), NUNCA pelo conteúdo atrás; TODOS os controles focáveis do diálogo são alcançados', stops.every((s) => s && (s.inDialog || s.tag === 'HTML' || s.tag === 'BODY')) && focusableInDialog >= 2 && visitedInside.size >= focusableInDialog, `focáveis=${focusableInDialog} visitados=${JSON.stringify([...visitedInside])}`);
      await h.a11yLint('diálogo de confirmação aberto');
      await h.contrast('diálogo de confirmação aberto');
      await h.shot('i7-06-dialogo');
      await h.key('Escape', 'Escape', 27);
      await sleep(400);
      check('C4. Esc fecha o diálogo e o foco volta ao botão que o abriu', (await evalJs(`document.querySelector('dialog').open===false`)) && (await evalJs(`document.activeElement&&document.activeElement.innerText.includes('Registrar resultado')`)));
    } else h.skip('C2-C4. diálogo de confirmação', 'botão de registrar indisponível');
    // C5 movimento: nenhuma animação contínua num estado estável (WCAG 2.2.2); com movimento reduzido também
    for (const reduce of [false, true]) {
      await h.reducedMotion(reduce);
      await go(lumos('main'), ready);
      await sleep(1200);
      const running = await evalJs(`document.getAnimations().filter(a=>a.playState==='running').map(a=>(a.effect&&a.effect.target?a.effect.target.tagName+'.'+String(a.effect.target.className).slice(0,40):'?')+' '+(a.animationName||a.transitionProperty||''))`);
      check(`C5. estado estável ${reduce ? 'com movimento reduzido' : 'normal'}: nenhuma animação contínua em execução`, running.length === 0, JSON.stringify(running.slice(0, 4)));
    }
    await h.reducedMotion(false);
    // C6 contraste medido em cada estado e indicador de foco medido
    for (const [key, re, label] of [['main', ready, 'pronta'], ['hist', /Resultados finalizados/, 'histórico'], ['scored', /Resultados finalizados/, 'PONTUADA/histórico'], ['pdec', /Decisão pendente/, 'decisão pendente'], ['integ', /Erro de integridade/, 'bloqueada'], ['pres', /NÃO confirmado/, 'resultado pendente']]) {
      await go(lumos(key), (x) => matches(re, x));
      await h.contrast(`workspace ${label}`);
    }
    await go(`${BASE}/auditoria-por-link`, listReady);
    await h.contrast('listagem');
    // C7 indicador de foco: 3:1 contra a pior superfície da paleta (WCAG 1.4.11 / 2.4.7), em cada parada de Tab
    for (const [label, url, re, stopsCount] of [['listagem', `${BASE}/auditoria-por-link`, listReady, 14], ['workspace main', lumos('main'), ready, 28]]) {
      await go(url, (x) => matches(re, x));
      await openAll();
      const indicators = await h.focusIndicators(stopsCount);
      const weak = indicators.filter((i) => i.kind === 'nenhum' || i.ratio < 3);
      check(`C7. indicador de foco ≥ 3:1 (pior superfície) em cada parada de Tab — ${label}: ${indicators.length} paradas`, indicators.length > 5 && weak.length === 0, JSON.stringify(weak.slice(0, 6)));
    }
  }

  /* ============================================================ C (mobile e reflow) ============================================================ */
  if (want('C')) {
    h.log('---- C. mobile e reflow');
    await h.restartServer();
    await h.viewport(390, 844, true);
    for (const [key, re, label] of [['main', ready, 'pronta'], ['scored', /Resultados finalizados/, 'PONTUADA/histórico'], ['pdec', /Decisão pendente/, 'decisão pendente'], ['integ', /Erro de integridade/, 'bloqueada'], ['pres', /NÃO confirmado/, 'resultado pendente'], ['hist', /Resultados finalizados/, 'histórico']]) {
      await go(lumos(key), (x) => matches(re, x));
      await openAll();
      await h.noHorizontalScroll(`mobile 390 / ${label}`);
      await h.smallTargets(`mobile 390 / ${label}`);
    }
    await go(`${BASE}/auditoria-por-link`, listReady);
    await h.noHorizontalScroll('mobile 390 / listagem');
    await h.smallTargets('mobile 390 / listagem');
    await go(lumos('main'), ready);
    await sleep(400);
    if (await enabledButton('Registrar resultado')) {
      await evalJs(`[...document.querySelectorAll('button')].find(e=>e.innerText.trim().startsWith('Registrar resultado')&&!e.disabled).click()`);
      await sleep(500);
      await h.noHorizontalScroll('mobile 390 / diálogo de confirmação');
      const dialogBox = await evalJs(`(()=>{const d=document.querySelector('dialog');const r=d.getBoundingClientRect();const btns=[...d.querySelectorAll('button')].map(b=>{const x=b.getBoundingClientRect();return {t:b.innerText.slice(0,20),h:Math.round(x.height),inView:x.left>=0&&x.right<=innerWidth}});return {w:Math.round(r.width),inW:Math.round(r.right)<=innerWidth,btns}})()`);
      check('mobile 390: diálogo cabe na tela e os botões têm 44 px e ficam alcançáveis', dialogBox.inW && dialogBox.btns.every((b) => b.h >= 43.5 && b.inView), JSON.stringify(dialogBox).slice(0, 300));
      await h.shot('i7-07-dialogo-mobile');
      await h.key('Escape', 'Escape', 27);
    }
    for (const [width, mobile, label] of [[640, false, 'zoom 200% (640 px)'], [320, true, 'zoom 400% (320 px)']]) {
      await h.viewport(width, 800, mobile);
      for (const [key, re] of [['main', ready], ['scored', /Resultados finalizados/], ['pdec', /Decisão pendente/], ['integ', /Erro de integridade/], ['pres', /NÃO confirmado/], ['hist', /Resultados finalizados/]]) {
        await go(lumos(key), (x) => matches(re, x));
        await openAll();
        await h.noHorizontalScroll(`${label} / ${key}`);
      }
    }
    await h.shot('i7-08-reflow-320');
    h.skip('leitor de tela real (NVDA/JAWS/VoiceOver)', 'não disponível neste ambiente: acessibilidade COMPLETA não é declarada');
    h.skip('Firefox, Safari e dispositivo físico', 'apenas Chromium headless foi exercitado');
    h.skip('axe-core / verificadores automáticos de terceiros', 'não instalados e sem rede: usado apenas o verificador próprio e reduzido (a11y-lint.cjs)');
  }

  await check('sem resposta 429 inesperada nas leituras', !h.rateLimited.some((u) => !/finalize/.test(u)), JSON.stringify(h.rateLimited.slice(0, 4)));
  await h.finish();
})().catch((error) => {
  console.error('ERRO', error);
  process.exit(3);
});
