'use strict';
/*
 * Roteiro I7 — HOMOLOGAÇÃO FINAL da Auditoria por Link (Onda 6C), num Chromium real, com seis auditorias FICTÍCIAS e as APIs locais REAIS:
 *   A. fluxo operacional completo (14 passos) numa auditoria "pronta" e retorno à listagem;
 *   D. o operador distingue os estados do produto (pronta, decisão pendente, bloqueada, INCONCLUSIVA, PONTUADA, histórico, verificado e atual);
 *   B. integridade e segurança no nível da API (autenticação, vazamento, idempotência, concorrência, adulteração de evidência/resultado/recibo);
 *   C. experiência: acessibilidade (verificador próprio), foco, diálogo, reflow, contraste e indicadores de foco medidos.
 * `I7_ONLY=A,B` (só desenvolvimento) roda um subconjunto; sem a variável, roda tudo, em ordem. Uso: ver scripts/browser/README.md.
 * Limites: Chromium headless apenas; sem leitor de tela, outros navegadores nem dispositivo físico (SKIPPED no resultado).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./harness.cjs');

const only = (process.env.I7_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (section) => only.length === 0 || only.includes(section);

(async () => {
  const h = await createHarness({ name: 'i7', seed: 'tests/helpers/browser-seed-i6.ts', seedArgs: ['with-scored'], port: 3989, debugPort: 9335 });
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
    check('1. a Auditoria por Link abre e lista as 6 auditorias fictícias', !!(await go(`${BASE}/auditoria-por-link`, listReady)) && (await evalJs(`document.querySelectorAll('#auditorias-armazenadas li > a[href^="/auditoria-por-link/"]').length`)) === 6 && (await has(/6 empresas/)));
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
    check('4. evidências verificadas: integridade OK, CID, captura de origem e hashes curtos', /Integridade das evidências OK/.test(t) && /CID confirmado\s*\d{10,}/.test(t) && /EVIDÊNCIAS VERIFICADAS USADAS/i.test(t) && /capture:c0001/.test(t) && /[0-9a-f]{6}…[0-9a-f]{4}/.test(t));
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
    await clickText('Reenviar o mesmo pedido');
    check('13d. recuperação: reenviar o MESMO pedido conclui e grava o recibo', !!(await waitFor(() => has(/Decisão pendente concluída e confirmada/), 15000)) && (fs.existsSync(decAnchors) ? fs.readdirSync(decAnchors).length : 0) > decReceiptsBefore, `recibos ${decReceiptsBefore} → ${fs.existsSync(decAnchors) ? fs.readdirSync(decAnchors).length : 0}`);
    const resAnchors = path.join(root, 'resanchors', IDS.pres);
    check('13e. resultado gravado SEM recibo: nenhum recibo no volume independente', !fs.existsSync(resAnchors) || fs.readdirSync(resAnchors).length === 0);
    await go(lumos('pres'), (x) => /gravado e NÃO confirmado/.test(x));
    check('13f. resultado pendente: aparece como NÃO confirmado e só oferece concluir (não vale como resultado)', (await has(/NÃO confirmado/)) && (await evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.includes('Concluir a confirmação'))`)));
    await clickText('Concluir a confirmação');
    check('13g. concluir a confirmação: VERIFICADO e o recibo agora existe', !!(await waitFor(() => has(/Confirmado e verificado/), 20000)) && fs.existsSync(resAnchors) && fs.readdirSync(resAnchors).length >= 1);
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
    await go(lumos('hist'), (x) => /Erro de integridade|Resultados finalizados/.test(x));
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
      check('B12. recibo REMOVIDO do volume independente: o detalhe é recusado (409) e a lista não conta o registro como confirmado (vira pendente)', noReceipt.status === 409 && noReceiptList.status === 200 && (parse(noReceiptList) || {}).results.length === 0 && !!(parse(noReceiptList) || {}).pending, `detalhe=${noReceipt.status} lista=${noReceiptList.status} ${noReceiptList.body.slice(0, 120)}`);
      fs.writeFileSync(receiptFile, receiptOriginal);
      fs.chmodSync(receiptFile, 0o444);
    } else h.skip('B12. recibo removido', 'sem recibo no volume para a auditoria "hist"');
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
