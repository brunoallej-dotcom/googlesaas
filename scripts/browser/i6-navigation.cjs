'use strict';
/*
 * Roteiro I6 — integração da listagem (Onda 5B) com a área operacional Lumos (Onda 6C), com cinco auditorias FICTÍCIAS em estados distintos
 * e as APIs locais REAIS: lista → detalhe → workspace → retorno, estados (decisão/resultado pendente, integridade, 404, histórico),
 * conflito expectedHead, finalização, segurança de acesso, mobile, contraste medido, e (correção final do I6) o endereço `?auditId=`
 * sem empresa substituta, sincronização do endereço, nome acessível, teclado, cor dos botões, menu móvel, reflow e movimento reduzido.
 * Uso: ver scripts/browser/README.md.
 */
const { createHarness } = require('./harness.cjs');

(async () => {
  const h = await createHarness({ name: 'i6', seed: 'tests/helpers/browser-seed-i6.ts', port: 3988, debugPort: 9334 });
  const { check, waitFor, evalJs, text, has, sleep, send, BASE, IDS } = h;
  const clickText = h.clickText;
  const typeInto = h.typeInto;
  const enabledButton = h.enabledButton;
  const apiCount = h.apiCalls;
  const go = h.go;
  const viewport = h.viewport;
  const shot = (label) => h.shot(label);
  const lumos = (key) => `${BASE}/auditoria-por-link/${IDS[key]}`;
  const crumb = () => evalJs(`(()=>{const a=document.querySelector('nav[aria-label="Navegação da auditoria"] a');if(!a)return false;a.click();return true})()`);
  await viewport(1440, 1500, false);

  /* ================= A. PÁGINA PRINCIPAL → WORKSPACE → RETORNO ================= */
  await go(`${BASE}/auditoria-por-link`, (t) => t.includes('Auditorias armazenadas') && /5 empresas/.test(t));
  let t = await text();
  check('lista da 5B carrega as 5 auditorias', /5 empresas com evidências armazenadas/.test(t));
  check('cada cartão tem o link "Abrir auditoria Lumos"', (await evalJs(`document.querySelectorAll('#auditorias-armazenadas a[href^="/auditoria-por-link/"]').length`)) >= 5);
  const calls = await apiCount();
  check('a listagem NÃO consulta prévia, decisões nem resultados (sem chamadas para decorar cartões)', !calls.some((c) => /\/scoring|\/decisions/.test(c)), JSON.stringify(calls));
  check('filtro da 5B continua funcionando (some sem resultado; filtra por nome)', await (async () => { const setF = (v) => evalJs(`(()=>{const el=document.getElementById('filtro-auditorias');if(!el)return 'sem-campo';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`); await setF('inexistente'); await sleep(300); const none = await has(/Nenhuma empresa corresponde ao filtro/); await setF('padaria'); await sleep(300); const some = (await has(/\d+ (de \d+ )?empresas?/)) && !(await has(/Nenhuma empresa corresponde/)); await setF(''); await sleep(200); return none && some && (await has(/5 empresas com evidências armazenadas/)); })());
  await shot('i6-01-principal-desktop');
  // seleciona a auditoria "hist" pelo cartão e abre o workspace pelo botão do detalhe
  await evalJs(`(()=>{const a=document.querySelector('a[href$="${IDS.hist}"]');a.closest('li').querySelector('button').click()})()`);
  await waitFor(async () => (await evalJs(`document.querySelector('#detalhe-auditoria-titulo')?.innerText`)) && (await has(/Abrir auditoria Lumos/)), 10000);
  check('detalhe da 5B abre ao selecionar (evidências, integridade)', await has(/Coleta de evidências/));
  await Promise.all([waitFor(async () => (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`, 15000), evalJs(`document.querySelector('#auditorias-armazenadas article a[href^="/auditoria-por-link/"]').click()`)]);
  const opened = await waitFor(async () => (await has(/Resultados finalizados/)) && !(await has(/Carregando a auditoria/)), 25000);
  check('detalhe → workspace Lumos abre no endereço da auditoria', !!opened && (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`);
  check('workspace da auditoria "hist": resultado confirmado aparece como HISTÓRICO (decisão posterior)', await waitFor(() => has(/HISTÓRICO/), 10000));
  await shot('i6-02-workspace-historico');
  check('caminho de retorno no workspace', await crumb());
  const back = await waitFor(async () => (await evalJs('location.pathname')) === '/auditoria-por-link' && (await has(/Auditorias armazenadas/)), 20000);
  check('retorno à listagem pelo caminho "Auditorias"', !!back);
  check('retorno mantém a empresa escolhida selecionada (?auditId=)', !!(await waitFor(() => evalJs(`(()=>{const a=document.querySelector('a[href$="${IDS.hist}"]');return !!a && a.closest('li').querySelector('button').getAttribute('aria-current')==='true' && location.search.includes('auditId=${IDS.hist}')})()`), 15000)));
  check('retorno leva a vista à seção de auditorias armazenadas', await evalJs(`(()=>{const r=document.getElementById('auditorias-armazenadas').getBoundingClientRect();return r.top<window.innerHeight&&r.bottom>0})()`));

  /* ================= B. ACESSO DIRETO, ATUALIZAÇÃO, ESTADOS ================= */
  await go(lumos('hist'), (x) => /Resultados finalizados/.test(x) && !/Carregando a auditoria/.test(x));
  await h.reload();
  check('atualização de página (reload) mantém a auditoria e o estado HISTÓRICO', !!(await waitFor(async () => (await has(/HISTÓRICO/)) && (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`, 25000)));
  await go(lumos('pdec'), (x) => /Decisão pendente/.test(x));
  check('decisão pendente: faixa e painel explicam que não vale e impedem registrar', (await has(/SEM recibo: ela ainda não vale/)) && (await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled===true`)));
  await shot('i6-03-decisao-pendente');
  check('decisão pendente: o servidor COMPROVOU a origem e a tela mostra o que será concluído (sem "Foi você quem o gravou")', (await has(/comprovou que gravou esta decisão em nome do seu usuário/)) && !(await has(/Foi você quem o gravou/)));
  check('decisão pendente: concluir exige a confirmação explícita (botão desabilitado até marcar a caixa) e então conclui', await (async () => { const r = await h.concludePending('Concluir a decisão'); return r.disabledBefore && r.enabledAfter && r.clicked && !!(await waitFor(() => has(/Decisão pendente concluída e confirmada/), 15000)); })());
  await go(lumos('pres'), (x) => /gravado e NÃO confirmado/.test(x));
  check('resultado pendente próprio: NÃO confirmado, origem comprovada pelo servidor, detalhes do que será concluído e a ressalva "interrompida × recibo removido"', (await has(/NÃO confirmado/)) && (await has(/comprovou que gravou este resultado em nome do seu usuário/)) && (await has(/Cobertura\s*\d+%/)) && (await has(/interrompida.*removido/)) && !(await has(/Foi você quem o gravou/)));
  await shot('i6-04-resultado-pendente');
  const concluded = await h.concludePending('Concluir a confirmação');
  check('resultado pendente: o botão só habilita com a confirmação explícita; concluir deixa o resultado confirmado e VERIFICADO (recibo gravado agora)', concluded.disabledBefore && concluded.enabledAfter && concluded.clicked && !!(await waitFor(() => has(/Confirmado e verificado/), 20000)));
  await go(lumos('integ'), (x) => /Falha de integridade|Erro de integridade/.test(x));
  t = await text();
  check('evidência sem integridade: erro de integridade visível e nenhum dado da empresa/cobertura', /Erro de integridade/.test(t) && !/Cobertura verificada/.test(t) && !/CID confirmado/.test(t));
  check('evidência sem integridade: finalizar bloqueado', await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().startsWith('Registrar resultado'))?.disabled===true`));
  await shot('i6-05-integridade');
  check('auditId inválido na URL ⇒ 404', !!(await go(`${BASE}/auditoria-por-link/curto`, (x) => /404|não foi encontrada|not found/i.test(x))));

  /* ================= C. FLUXO COMPLETO NA AUDITORIA "main" ================= */
  await go(lumos('main'), (x) => /Resultado da prévia/.test(x) && !/Carregando a auditoria/.test(x));
  check('workspace main: inconclusivo com cobertura e mínimo', (await has(/Auditoria inconclusiva — evidências insuficientes para gerar o índice Lumos\./)) && (await has(/mínimo exigido 40%/)));
  await evalJs(`document.getElementById('decisoes').open=true`);
  await evalJs(`(()=>{const li=[...document.querySelectorAll('#decisoes li')].find(e=>e.innerText.includes('Marcar S4'));li.querySelector('button').click()})()`);
  await waitFor(() => evalJs(`!!document.querySelector('#decisao-justificativa')`), 4000);
  await evalJs(`(()=>{const el=document.querySelector('#decisao-justificativa');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Modelo de negócio sem o subcritério S4, conferido pelo operador.');el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evalJs(`document.querySelector('#decisoes form button[type=submit]').click()`);
  check('registrar decisão S4 → prévia atualizada', !!(await waitFor(() => has(/Decisão registrada e confirmada/), 15000)));
  // conflito: outra pessoa grava uma decisão enquanto a confirmação está aberta
  await enabledButton('Registrar resultado');
  await clickText('Registrar resultado'); await sleep(400);
  const head = await evalJs(`fetch('/api/link-audit/decisions/${IDS.main}').then(r=>r.json()).then(j=>j.head)`);
  const other = await evalJs(`fetch('/api/link-audit/decisions/${IDS.main}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record:{kind:'NAME_EQUIVALENCE',nameA:'Padaria Exemplo Ltda',nameB:'Padaria Exemplo',justification:'Equivalência conferida por outra pessoa da equipe.'},expectedHead:${JSON.stringify(head)}})}).then(r=>r.status)`);
  check('outra aba grava decisão durante a confirmação (201)', other === 201, String(other));
  await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`); await sleep(100);
  await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`);
  check('conflito expectedHead: NADA gravado, prévia invalidada e recarregada, nova confirmação exigida', !!(await waitFor(() => has(/Nada foi gravado: a situação mudou/), 15000)));
  check('conflito: nenhum resultado foi criado (a API não lista nenhum registro)', (await evalJs(`fetch('/api/link-audit/scoring/${IDS.main}/results').then(r=>r.json()).then(j=>j.results.length)`)) === 0);
  await shot('i6-06-conflito');
  await sleep(1500);
  check('finaliza de novo com a prévia nova → confirmado e verificado', await (async () => { await enabledButton('Registrar resultado'); await clickText('Registrar resultado'); await sleep(400); await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`); await sleep(100); await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`); return !!(await waitFor(() => has(/Confirmado e verificado/), 20000)); })());
  await evalJs(`document.getElementById('resultados').open=true`);
  check('resultado verificado consultável (detalhe relido)', !!(await waitFor(() => has(/Registro técnico: guarda a constatação/), 10000)));
  await shot('i6-07-resultado-verificado');
  await crumb();
  check('retorno à listagem a partir do fluxo concluído', !!(await waitFor(async () => (await evalJs('location.pathname')) === '/auditoria-por-link' && (await has(/5 empresas/)), 20000)));

  /* ================= D. SEGURANÇA DE ACESSO ================= */
  await go(lumos('main'), (x) => /Resultado da prévia/.test(x));
  await waitFor(async () => (await apiCount()).length >= 4, 10000); await sleep(3000);
  const idle0 = (await apiCount()).length; await sleep(12000); const idle1 = (await apiCount()).length;
  check('sem polling: nenhuma requisição nova em 12 s parado na página', idle0 === idle1, `${idle0} → ${idle1}`);
  await h.clearSession();
  await clickText('Atualizar');
  check('sessão expirada no meio da página ⇒ vai ao login (nada de dados em tela)', !!(await waitFor(async () => (await evalJs('location.pathname')) === '/login', 15000)));
  await h.setSession(h.intruderSession);
  await h.navigate(lumos('main')); await sleep(2500);
  t = await text();
  check('operador NÃO autorizado: não vê a auditoria (login/negado), sem dados da empresa', ((await evalJs('location.pathname')) === '/login' || /negad|não autorizad/i.test(t)) && !/Padaria Exemplo|Resultado da prévia/.test(t), await evalJs('location.href'));
  await h.setSession(h.operatorSession);

  /* ================= E. MOBILE ================= */
  await viewport(390, 844, true);
  await go(`${BASE}/auditoria-por-link`, (x) => /5 empresas/.test(x));
  const mobileChecks = async (label) => { await h.noHorizontalScroll(label); await h.smallTargets(label); };
  await mobileChecks('mobile / principal');
  await shot('i6-08-principal-mobile');
  await evalJs(`document.querySelector('[aria-label="Abrir menu"]').click()`); await sleep(400);
  const menuOpen = await evalJs(`(()=>{const s=document.getElementById('gmn-sidebar');return !!s&&s.getBoundingClientRect().left>=0})()`);
  check('mobile: botão de menu (44 px) abre a navegação', menuOpen);
  await mobileChecks('mobile / menu aberto');
  check('mobile: navegação tem a Auditoria por Link ativa (uma vez)', (await evalJs(`[...document.querySelectorAll('#gmn-sidebar a')].filter(a=>a.innerText.trim()==='Auditoria por Link').length`)) === 1 && (await evalJs(`document.querySelector('#gmn-sidebar a[aria-current="page"]')?.innerText.trim()`)) === 'Auditoria por Link');
  await shot('i6-09-menu-mobile');
  const closeBox = await evalJs(`(()=>{const b=document.querySelector('[aria-label="Fechar menu"]').getBoundingClientRect();return Math.round(b.width)+'x'+Math.round(b.height)})()`);
  check('mobile: "Fechar menu" tem 44x44', closeBox === '44x44', closeBox);
  await evalJs(`document.querySelector('[aria-label="Fechar menu"]')?.click()`); await sleep(300);
  await go(lumos('main'), (x) => /Resultado da prévia/.test(x) && !/Carregando a auditoria/.test(x));
  await mobileChecks('mobile / workspace');
  check('mobile: faixa de estado NÃO é fixa (não cobre controles ao focar)', await evalJs(`getComputedStyle([...document.querySelectorAll('div')].find(d=>d.getAttribute('role')==='status'&&d.parentElement&&d.parentElement.className.includes('md:sticky')).parentElement).position`) === 'static');
  await shot('i6-10-workspace-mobile');
  await evalJs(`document.getElementById('finalizacao').scrollIntoView()`); await sleep(300); await shot('i6-11-workspace-mobile-finalizacao');

  /* ================= F. CONTRASTE MEDIDO NO RENDERIZADO ================= */
  await viewport(1440, 1500, false);
  for (const [label, url, ready] of [['principal', `${BASE}/auditoria-por-link`, (x) => /5 empresas/.test(x)], ['workspace main', lumos('main'), (x) => /Resultado da prévia/.test(x) && !/Carregando a auditoria/.test(x)], ['workspace pdec', lumos('pdec'), (x) => /Decisão pendente/.test(x)], ['workspace integ', lumos('integ'), (x) => /Erro de integridade/.test(x)]]) {
    await go(url, ready); await h.contrast(label);
  }

  /* ================= G. ENDEREÇO (?auditId=) × EMPRESA EXIBIDA — sem substituta silenciosa, endereço sincronizado ================= */
  await h.restartServer(); // zera o limite de leituras (30/min por operador): os blocos anteriores já consumiram boa parte
  await viewport(1440, 1500, false);
  const selectedAudit = () => evalJs(`(()=>{const b=document.querySelector('#auditorias-armazenadas li > button[aria-current="true"]');if(!b)return null;const a=b.closest('li').querySelector('a[href^="/auditoria-por-link/"]');return a?decodeURIComponent(a.getAttribute('href').split('/').pop()):null})()`);
  const search = () => evalJs('location.search');
  const historyLength = () => evalJs('history.length');
  const listReady = (x) => /Auditorias armazenadas/.test(x) && /\d+ (de \d+ )?empresas?/.test(x);
  const detailCalls = async () => (await h.apiCalls()).filter((c) => /\/api\/link-audit\/evidence\/[^?]/.test(c));
  const pickCard = (id) => evalJs(`document.querySelector('#auditorias-armazenadas li > a[href$="${id}"]').closest('li').querySelector('button').click()`);
  const GHOST = 'auditoria-vis-ghost1';

  // G1 — pedido VÁLIDO que não está na lista carregada
  await go(`${BASE}/auditoria-por-link?auditId=${GHOST}`, (x) => /A auditoria pedida não está na lista carregada/.test(x));
  t = await text();
  check('pedido fora da lista: aviso explícito com a identidade pedida', /A auditoria pedida não está na lista carregada/.test(t) && t.includes(GHOST));
  check('pedido fora da lista: NENHUMA empresa substituta selecionada', (await selectedAudit()) === null && (await evalJs(`document.querySelectorAll('#auditorias-armazenadas [aria-current="true"]').length`)) === 0);
  check('pedido fora da lista: nenhum dado de outra auditoria no detalhe', !/Coleta de evidências/.test(t) && /Selecione uma empresa/.test(t) && /Nenhuma outra empresa foi selecionada/.test(t));
  check('pedido fora da lista: nenhuma consulta de detalhe foi feita', (await detailCalls()).length === 0, JSON.stringify(await h.apiCalls()));
  check('pedido fora da lista: a identidade pedida permanece no endereço', (await search()) === `?auditId=${GHOST}`, await search());
  check('pedido fora da lista: oferece abrir a auditoria pedida (id codificado, 44 px)', (await evalJs(`document.querySelector('[data-testid="requested-audit-notice"] a')?.getAttribute('href')`)) === `/auditoria-por-link/${GHOST}` && (await evalJs(`Math.round(document.querySelector('[data-testid="requested-audit-notice"] a').getBoundingClientRect().height)`)) >= 44);
  await shot('i6-12-pedido-fora-da-lista');
  await h.contrast('aviso de pedido fora da lista');
  await h.reload();
  check('pedido fora da lista: atualizar a página repete o aviso (não troca de empresa)', !!(await waitFor(() => has(/A auditoria pedida não está na lista carregada/), 20000)) && (await selectedAudit()) === null && (await search()) === `?auditId=${GHOST}`);
  check('pedido fora da lista: "Abrir a auditoria pedida" vai ao endereço dela, sem dados de outra', await (async () => { await clickText('Abrir a auditoria Lumos pedida'); await waitFor(async () => (await evalJs('location.pathname')) === `/auditoria-por-link/${GHOST}`, 15000); await sleep(2500); const x = await text(); return (await evalJs('location.pathname')) === `/auditoria-por-link/${GHOST}` && !/Padaria Exemplo/.test(x); })());

  // G2 — o operador escolhe outra empresa: o endereço passa a ser o dela
  await go(`${BASE}/auditoria-por-link?auditId=${GHOST}`, (x) => /A auditoria pedida não está na lista carregada/.test(x));
  const entriesBefore = await historyLength();
  await pickCard(IDS.main);
  await waitFor(async () => (await selectedAudit()) === IDS.main && (await has(/Coleta de evidências/)), 15000);
  check('escolha do operador: o endereço passa a ser o da empresa exibida', (await search()) === `?auditId=${IDS.main}`, await search());
  check('escolha do operador: o aviso some e só a empresa escolhida fica selecionada', !(await has(/A auditoria pedida não está/)) && (await selectedAudit()) === IDS.main);
  check('escolha do operador: não cria entrada no histórico (replaceState)', (await historyLength()) === entriesBefore, `${entriesBefore} → ${await historyLength()}`);
  await h.reload();
  check('atualizar a página mantém a empresa exibida (endereço = exibição)', !!(await waitFor(async () => (await selectedAudit()) === IDS.main && (await has(/Coleta de evidências/)), 20000)));

  // G3 — o defeito antigo: troca de empresa, abre o workspace dela e volta pelo botão Voltar do navegador
  await pickCard(IDS.hist);
  await waitFor(async () => (await selectedAudit()) === IDS.hist, 10000);
  check('troca de empresa: o endereço acompanha a escolha', (await search()) === `?auditId=${IDS.hist}`, await search());
  await Promise.all([waitFor(async () => (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`, 15000), evalJs(`document.querySelector('#auditorias-armazenadas li > a[href$="${IDS.hist}"]').click()`)]);
  await waitFor(() => has(/Resultados finalizados/), 25000);
  await evalJs('history.back()');
  const backSame = await waitFor(async () => (await evalJs('location.pathname')) === '/auditoria-por-link' && (await selectedAudit()) === IDS.hist, 25000);
  check('botão Voltar do navegador: volta com a MESMA empresa, sem restaurar a anterior', !!backSame && (await search()) === `?auditId=${IDS.hist}`, `${await search()} / ${await selectedAudit()}`);

  // G4 — mesmo documento (fragmento): Voltar/Avançar reconciliam a exibição com o endereço (popstate)
  await go(`${BASE}/auditoria-por-link`, listReady);
  const firstId = await waitFor(() => selectedAudit(), 15000);
  check('sem pedido: vale a primeira empresa (5B) e o endereço não é alterado', !!firstId && (await search()) === '', `${firstId} ${await search()}`);
  const otherId = [IDS.main, IDS.hist, IDS.pdec].find((id) => id !== firstId);
  await evalJs(`location.hash='#auditorias-armazenadas'`);
  await sleep(300);
  await pickCard(otherId);
  await waitFor(async () => (await selectedAudit()) === otherId, 10000);
  check('mesma página com fragmento: a escolha atualiza a entrada atual (mantém o #fragmento)', (await search()) === `?auditId=${otherId}` && (await evalJs('location.hash')) === '#auditorias-armazenadas', `${await search()} ${await evalJs('location.hash')}`);
  await evalJs('history.back()');
  check('Voltar (mesmo documento): a exibição acompanha o endereço (sem pedido ⇒ primeira)', !!(await waitFor(async () => (await selectedAudit()) === firstId && (await search()) === '', 15000)), `${await search()} ${await selectedAudit()}`);
  await evalJs('history.forward()');
  check('Avançar (mesmo documento): a exibição volta à empresa do endereço', !!(await waitFor(async () => (await selectedAudit()) === otherId && (await search()) === `?auditId=${otherId}`, 15000)), `${await search()} ${await selectedAudit()}`);

  // G5 — pedido MALFORMADO, vazio ou repetido: impedimento; o texto do endereço nunca é ecoado
  await go(`${BASE}/auditoria-por-link?auditId=../../etc/passwd`, (x) => /identificador inválido/.test(x));
  t = await text();
  check('pedido malformado: aviso explícito, sem ecoar o texto do endereço', /identificador inválido/.test(t) && !/passwd/.test(t));
  check('pedido malformado: nenhuma empresa selecionada e nenhum detalhe consultado', (await selectedAudit()) === null && (await detailCalls()).length === 0);
  check('pedido malformado: não há link para abrir', (await evalJs(`document.querySelectorAll('[data-testid="requested-audit-notice"] a').length`)) === 0);
  await clickText('Escolher outra empresa na lista');
  await sleep(300);
  check('dispensar o pedido: remove o parâmetro do endereço', (await search()) === '', await search());
  check('dispensar o pedido: o foco vai ao filtro (não se perde)', (await evalJs('document.activeElement && document.activeElement.id')) === 'filtro-auditorias');
  check('dispensar o pedido: nada é selecionado no lugar (o operador escolhe)', (await selectedAudit()) === null && (await has(/Selecione uma empresa/)) && !(await has(/identificador inválido/)));
  await pickCard(IDS.pdec);
  check('depois de dispensar, a escolha do operador funciona e atualiza o endereço', !!(await waitFor(async () => (await selectedAudit()) === IDS.pdec && (await search()) === `?auditId=${IDS.pdec}`, 15000)));
  for (const [label, query] of [['vazio', '?auditId='], ['repetido', `?auditId=${IDS.main}&auditId=${IDS.hist}`]]) {
    await go(`${BASE}/auditoria-por-link${query}`, (x) => /identificador inválido/.test(x));
    check(`pedido ${label}: impedimento, sem empresa substituta`, (await has(/identificador inválido/)) && (await selectedAudit()) === null && (await detailCalls()).length === 0);
  }

  await h.restartServer(); // novo minuto de leituras (limite de 30/min por operador)
  // G6 — item ATIVO do menu: não pode deixar o endereço sem `?auditId=` com a empresa antiga na tela (e o F5 abrir OUTRA)
  await go(`${BASE}/auditoria-por-link?auditId=${IDS.hist}`, listReady);
  await waitFor(() => selectedAudit(), 10000);
  const firstCard = await evalJs(`document.querySelector('#auditorias-armazenadas li > a[href^="/auditoria-por-link/"]').getAttribute('href').split('/').pop()`);
  const notFirst = [IDS.pdec, IDS.main, IDS.hist].find((id) => id !== firstCard);
  await pickCard(notFirst);
  await waitFor(async () => (await selectedAudit()) === notFirst, 10000);
  check('item ativo do menu: é um link de documento (reinicia a tela coerente com o endereço)', await evalJs(`(()=>{const a=document.querySelector('#gmn-sidebar a[href="/auditoria-por-link"]');return !!a&&a.getAttribute('aria-current')==='page'})()`));
  const docBefore = await evalJs('performance.timeOrigin');
  await evalJs(`document.querySelector('#gmn-sidebar a[href="/auditoria-por-link"]').click()`);
  check('item ativo do menu: o clique carrega um DOCUMENTO novo (não é transição do roteador)', !!(await waitFor(async () => { const t0 = await evalJs('performance.timeOrigin'); return t0 !== undefined && t0 !== docBefore; }, 15000)));
  await waitFor(() => selectedAudit(), 15000);
  const firstAfterMenu = await evalJs(`document.querySelector('#auditorias-armazenadas li > a[href^="/auditoria-por-link/"]').getAttribute('href').split('/').pop()`);
  check('item ativo do menu: depois do clique o endereço e a empresa exibida CONCORDAM (sem pedido ⇒ primeira) e o F5 não troca de empresa', (await search()) === '' && (await selectedAudit()) === firstAfterMenu, `${await search()} / ${await selectedAudit()}`);
  await h.reload();
  check('item ativo do menu: F5 depois do clique mostra a mesma empresa', !!(await waitFor(async () => (await selectedAudit()) === firstAfterMenu, 15000)));

  await h.restartServer();
  // G7 — foco depois da escolha e da volta pelo endereço (com rede lenta, para a lista e o detalhe chegarem depois do operador agir)
  await go(`${BASE}/auditoria-por-link`, listReady);
  await waitFor(() => selectedAudit(), 10000);
  await sleep(800);
  await pickCard(IDS.pdec);
  check('escolha do operador: o foco vai ao título do detalhe da empresa escolhida', !!(await waitFor(() => evalJs(`document.activeElement&&document.activeElement.id==='detalhe-auditoria-titulo'`), 10000)));
  await send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
  await h.navigate(`${BASE}/auditoria-por-link?auditId=${IDS.hist}`);
  await waitFor(() => evalJs(`!!document.getElementById('filtro-auditorias')`), 20000);
  await evalJs(`document.getElementById('filtro-auditorias').focus()`);
  await waitFor(async () => (await has(/Coleta de evidências/)) && (await selectedAudit()) === IDS.hist, 20000);
  await sleep(600);
  check('volta pelo endereço com o operador digitando no filtro: o foco NÃO é roubado', (await evalJs('document.activeElement&&document.activeElement.id')) === 'filtro-auditorias');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await go(`${BASE}/auditoria-por-link?auditId=${IDS.hist}`, listReady);
  check('volta pelo endereço sem foco em lugar nenhum: o foco vai ao cartão da empresa escolhida', !!(await waitFor(() => evalJs(`(()=>{const a=document.activeElement;return !!a&&a.tagName==='BUTTON'&&a.getAttribute('aria-current')==='true'&&a.closest('li').querySelector('a').getAttribute('href').endsWith('${IDS.hist}')})()`), 15000)));

  await h.restartServer();
  /* ================= H. NOME ACESSÍVEL (WCAG 2.5.3) E TECLADO NA LISTA ================= */
  await go(`${BASE}/auditoria-por-link`, listReady);
  const names = await evalJs(`[...document.querySelectorAll('#auditorias-armazenadas li > a[href^="/auditoria-por-link/"]')].map(a=>({visible:a.innerText.trim(),name:a.getAttribute('aria-label')||a.innerText.trim()}))`);
  check('links dos cartões: o nome acessível CONTÉM o texto visível (WCAG 2.5.3)', names.length >= 5 && names.every((x) => x.name.toLowerCase().includes(x.visible.toLowerCase())), JSON.stringify(names.slice(0, 2)));
  await evalJs(`document.getElementById('filtro-auditorias').focus()`);
  const tabs = await h.tab(6);
  check('Tab percorre cada cartão na ordem: botão de seleção, depois o link', tabs.map((s) => (s.href ? 'link' : 'botão')).join(',') === 'botão,link,botão,link,botão,link', JSON.stringify(tabs.map((s) => `${s.tag}:${s.label.slice(0, 22)}`)));
  check('cada parada do Tab tem indicador de foco visível', tabs.every((s) => s.visible && (s.ring || !s.outline.startsWith('none'))), JSON.stringify(tabs.map((s) => s.outline + (s.ring ? '+anel' : ''))));
  const shiftTab = await h.tab(1, true);
  check('Shift+Tab volta ao botão do cartão anterior', shiftTab[0].tag === 'BUTTON' && !shiftTab[0].href, JSON.stringify(shiftTab));
  await evalJs(`document.querySelector('#auditorias-armazenadas li > a[href$="${IDS.hist}"]').focus()`);
  await Promise.all([waitFor(async () => (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`, 15000), h.key('Enter', 'Enter', 13, 0, '\r')]);
  check('Enter no link do cartão abre a auditoria Lumos (teclado)', (await evalJs('location.pathname')) === `/auditoria-por-link/${IDS.hist}`);

  /* ================= I. COR DOS BOTÕES E CAMPOS (medida no renderizado) ================= */
  const pairRatio = (selector, pseudo = '') => evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const p=(c)=>{const m=c.match(/rgba?\\(([^)]+)\\)/);const v=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return {r:v[0],g:v[1],b:v[2],a:v.length>3?v[3]:1}};const lin=(x)=>{x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)};const L=(c)=>0.2126*lin(c.r)+0.7152*lin(c.g)+0.0722*lin(c.b);const cs=getComputedStyle(el${pseudo ? `, '${pseudo}'` : ''});const own=p(getComputedStyle(el).backgroundColor);const fg=p(cs.color);const a=L(fg.a<1?{r:fg.r*fg.a+own.r*(1-fg.a),g:fg.g*fg.a+own.g*(1-fg.a),b:fg.b*fg.a+own.b*(1-fg.a)}:fg),b=L(own);return {ratio:Math.round((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)*100)/100,bg:getComputedStyle(el).backgroundColor,disabled:!!el.disabled}})()`);
  await go(`${BASE}/auditoria-por-link`, listReady);
  await typeInto('#link-audit-input', 'https://www.google.com/maps/place/Exemplo/@-16.6,-49.2,17z'); // só digita: NADA é enviado
  await sleep(300);
  const primary = await pairRatio('#entrada-do-link button[type="submit"]');
  check('botão primário habilitado: fundo #1D68DB e contraste ≥ 4,5:1 com o texto branco', !!primary && !primary.disabled && primary.bg === 'rgb(29, 104, 219)' && primary.ratio >= 4.5, JSON.stringify(primary));
  const box = await evalJs(`(()=>{const r=document.querySelector('#entrada-do-link button[type="submit"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(500);
  const hover = await pairRatio('#entrada-do-link button[type="submit"]');
  check('botão primário com o mouse em cima (hover): contraste continua ≥ 4,5:1', !!hover && hover.ratio >= 4.5, JSON.stringify(hover));
  const placeholder = await pairRatio('#filtro-auditorias', '::placeholder');
  check('placeholder do filtro: contraste ≥ 4,5:1 sobre o campo', !!placeholder && placeholder.ratio >= 4.5, JSON.stringify(placeholder));
  await shot('i6-13-botao-primario');

  /* ================= J. MENU MÓVEL: estado, foco e teclado ================= */
  await viewport(390, 844, true);
  await go(`${BASE}/auditoria-por-link`, listReady);
  const menu = () => evalJs(`(()=>{const s=document.getElementById('gmn-sidebar');const b=document.querySelector('button[aria-label="Abrir menu"]');const cs=getComputedStyle(s);const a=document.activeElement;return {expanded:b.getAttribute('aria-expanded'),visibility:cs.visibility,left:Math.round(s.getBoundingClientRect().left),active:(a&&(a.getAttribute('aria-label')||a.innerText.trim().slice(0,30)||a.tagName))||null}})()`);
  let m = await menu();
  check('menu móvel fechado: aria-expanded=false e fora da árvore de acessibilidade (visibility:hidden)', m.expanded === 'false' && m.visibility === 'hidden', JSON.stringify(m));
  await evalJs('document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)');
  const closedTabs = await h.tab(6);
  check('menu móvel fechado: nenhum item do menu recebe foco por Tab', closedTabs.every((s) => !s.inSidebar), JSON.stringify(closedTabs.map((s) => `${s.tag}:${s.label.slice(0, 18)}`)));
  await evalJs(`document.querySelector('[aria-label="Abrir menu"]').click()`);
  await sleep(500);
  m = await menu();
  check('menu aberto: aria-expanded=true, visível e com o foco em "Fechar menu"', m.expanded === 'true' && m.visibility === 'visible' && m.left >= 0 && m.active === 'Fechar menu', JSON.stringify(m));
  const inMenu = await h.tab(2);
  check('menu aberto: Tab segue pelos itens do menu', inMenu.every((s) => s.inSidebar), JSON.stringify(inMenu.map((s) => `${s.tag}:${s.label.slice(0, 18)}`)));
  await h.key('Escape', 'Escape', 27);
  await sleep(500);
  m = await menu();
  check('Esc fecha o menu e devolve o foco ao botão "Abrir menu"', m.expanded === 'false' && m.visibility === 'hidden' && m.active === 'Abrir menu', JSON.stringify(m));
  await viewport(1440, 900, false);
  await sleep(400);
  check('desktop: menu lateral sempre visível e botão "Abrir menu" oculto', await evalJs(`getComputedStyle(document.getElementById('gmn-sidebar')).visibility==='visible' && getComputedStyle(document.querySelector('button[aria-label="Abrir menu"]')).display==='none'`));

  await h.restartServer();
  /* ================= K. REFLOW (zoom equivalente a 200% e 400%): sem rolagem horizontal ================= */
  for (const [width, mobile, label] of [[640, false, 'zoom 200% (640 px)'], [320, true, 'zoom 400% (320 px, rolagem sobreposta)'], [320, false, 'zoom 400% (320 px, barra de rolagem clássica)']]) {
    await viewport(width, 800, mobile);
    for (const [name, url, ready] of [['principal', `${BASE}/auditoria-por-link`, listReady], ['workspace', lumos('main'), (x) => /Resultado da prévia/.test(x) && !/Carregando a auditoria/.test(x)]]) {
      await go(url, ready);
      await evalJs(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
      await sleep(300);
      await h.noHorizontalScroll(`${label} / ${name}`);
    }
  }
  await shot('i6-14-reflow-320');

  await h.restartServer();
  /* ================= L. MOVIMENTO REDUZIDO: a rolagem automática respeita a preferência ================= */
  await viewport(1440, 1500, false);
  await h.initScript(`(()=>{const original=Element.prototype.scrollIntoView;window.__scrolls=[];Element.prototype.scrollIntoView=function(options){window.__scrolls.push((options&&options.behavior)||'auto');return original.apply(this,arguments)}})()`);
  for (const reduce of [true, false]) {
    await h.reducedMotion(reduce);
    await go(`${BASE}/auditoria-por-link`, listReady);
    const first = await waitFor(() => selectedAudit(), 15000);
    check(`preferência de movimento ${reduce ? 'reduzido' : 'normal'} reconhecida pelo navegador`, (await evalJs(`matchMedia('(prefers-reduced-motion: reduce)').matches`)) === reduce);
    await pickCard([IDS.main, IDS.hist].find((id) => id !== first));
    await waitFor(async () => (await evalJs('window.__scrolls.length')) > 0, 10000);
    const behaviors = await evalJs('window.__scrolls');
    check(reduce ? 'movimento reduzido: a rolagem automática não anima (behavior:auto)' : 'movimento normal: a rolagem automática é suave', reduce ? behaviors.length > 0 && behaviors.every((b) => b === 'auto') : behaviors.includes('smooth'), JSON.stringify(behaviors));
  }
  await h.reducedMotion(false);

  check('nenhuma resposta 429 inesperada nas leituras de evidências (limite de 30/min respeitado pelo roteiro)', !h.rateLimited.some((u) => /\/api\/link-audit\/evidence/.test(u)), JSON.stringify(h.rateLimited.slice(0, 4)));
  await h.finish();
})().catch((error) => {
  console.error('ERRO', error);
  process.exit(3);
});
