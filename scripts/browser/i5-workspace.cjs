'use strict';
/*
 * Roteiro I5 — área operacional Lumos (/auditoria-por-link/[auditId]) com uma auditoria FICTÍCIA e as APIs locais REAIS:
 * estado inicial (inconclusivo), decisão humana S4 pelo formulário (foco, Escape, restauração de foco), finalização com confirmação
 * (diálogo, foco, Escape), resultado verificado, HTTP 429 real do limitador (sem reenvio automático), resultado histórico após decisão
 * externa, foco não coberto pela faixa fixa, teclado, mobile, 404 e sessão ausente. Uso: ver scripts/browser/README.md.
 */
const { createHarness } = require('./harness.cjs');

(async () => {
  const h = await createHarness({ name: 'i5', seed: 'tests/helpers/browser-seed-i5.ts', seedArgs: ['auditoria-visual-0001'], port: 3987, debugPort: 9333 });
  const { check, waitFor, evalJs, text, sleep, send, log, BASE } = h;
  const AUDIT = h.IDS.main;
  const click = h.clickText;
  const shot = (label) => h.shot(label);
  const setViewport = (width, height, mobile) => h.viewport(width, height, mobile);
  const url = `${BASE}/auditoria-por-link/${AUDIT}`;
  const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
  const openS4 = () => evalJs(`(()=>{const li=[...document.querySelectorAll('#decisoes li')].find(e=>e.innerText.includes('Marcar S4'));const b=li&&li.querySelector('button');if(!b||b.disabled)return false;b.focus();b.click();return true})()`);
  const typeInto = h.typeInto;
  // o botão "Registrar decisão" da matriz de critérios (C2) tem o mesmo texto: o envio é SEMPRE o botão do formulário aberto
  const submitDecisionForm = () => evalJs(`(()=>{const b=document.querySelector('#decisoes form button[type="submit"]');if(!b||b.disabled)return false;b.click();return true})()`);

  /* ---- desktop: estado inicial real (INCONCLUSIVO) ---- */
  await setViewport(1440, 2200, false);
  await h.navigate(url);
  const loaded = await waitFor(async () => (await text()).includes('Resultado da prévia') && !(await text()).includes('Carregando a auditoria'), 25000);
  check('página carrega e deixa o estado de carregamento', loaded);
  let t = await text();
  check('frase inconclusiva aprovada visível', t.includes('Auditoria inconclusiva — evidências insuficientes para gerar o índice Lumos.'));
  check('cobertura 11% e mínimo 40% visíveis', /11%/.test(t) && /40%/.test(t));
  check('botão de registrar habilitado (API permitiu)', await evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.includes('Registrar resultado')&&!b.disabled)`));
  check('nenhuma nota/índice numérico no registro técnico', !/Índice Lumos\s*\d/.test(t));
  await shot('01-desktop-inconclusivo');

  /* ---- registrar decisão S4 pelo formulário ---- */
  await evalJs(`document.getElementById('decisoes').open=true`);
  check('abre o formulário S4', await openS4());
  check('formulário com rótulos', !!(await waitFor(() => evalJs(`!!document.querySelector('label[for=decisao-justificativa]')`), 3000)));
  check('FOCO: ao abrir, vai para o primeiro campo (justificativa do S4)', !!(await waitFor(() => evalJs(`document.activeElement && document.activeElement.id==='decisao-justificativa'`), 3000)));
  await key('Escape', 'Escape', 27);
  check('ESCAPE fecha o formulário', !!(await waitFor(() => evalJs(`!document.querySelector('#decisao-justificativa')`), 3000)));
  check('FOCO: volta ao botão que abriu o formulário', await evalJs(`(()=>{const a=document.activeElement;return !!a && a.tagName==='BUTTON' && !!a.closest('li') && a.closest('li').innerText.includes('Marcar S4')})()`));
  check('reabre o formulário S4', await openS4());
  await waitFor(() => evalJs(`!!document.querySelector('#decisao-justificativa')`), 3000);
  await submitDecisionForm();
  await sleep(300);
  t = await text();
  check('validação local mostra erro de justificativa curta', /pelo menos 20 caracteres/.test(t));
  await typeInto('#decisao-justificativa', 'Modelo de negócio sem o subcritério S4, conferido pelo operador.');
  await sleep(100);
  await shot('02-desktop-formulario');
  await submitDecisionForm();
  const decided = await waitFor(async () => (await text()).includes('Decisão registrada e confirmada'), 15000);
  check('decisão registrada e confirmada (com recibo)', decided);
  await sleep(500);
  t = await text();
  check('lista de decisões mostra op-0001 vigente', /op-0001/.test(t));

  /* ---- finalizar: confirmação explícita ---- */
  const opener = await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim().startsWith('Registrar resultado')&&!e.disabled);if(!b)return false;b.focus();return true})()`);
  check('abre a confirmação', opener && await click('Registrar resultado'));
  await sleep(400);
  check('FOCO: dentro do diálogo ao abrir', await evalJs(`document.querySelector('dialog').contains(document.activeElement)`));
  await key('Escape', 'Escape', 27);
  await sleep(300);
  check('ESCAPE fecha o diálogo', await evalJs(`document.querySelector('dialog').open === false`));
  check('FOCO: volta ao botão que iniciou a confirmação', await evalJs(`document.activeElement && document.activeElement.innerText && document.activeElement.innerText.includes('Registrar resultado')`));
  await click('Registrar resultado');
  await sleep(400);
  const dialogOpen = await evalJs(`document.querySelector('dialog')?.open === true`);
  check('diálogo modal nativo aberto', dialogOpen);
  check('confirmar desabilitado até o aceite', await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar'))?.disabled === true`));
  await shot('03-desktop-confirmacao');
  await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`);
  await sleep(150);
  check('aceite habilita o botão', await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar'))?.disabled === false`));
  await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`);
  const finalized = await waitFor(async () => /Confirmado e verificado/.test(await text()), 20000);
  check('resultado confirmado e VERIFICADO pela releitura', finalized);
  t = await text();
  check('histórico mostra s0001 confirmado', /s0001/.test(t) && /Confirmado/.test(t));
  await evalJs(`document.getElementById('resultados').open=true`);
  await shot('04-desktop-resultado-confirmado');

  /* ---- outra decisão (outra pessoa/aba) torna o resultado histórico ---- */
  const head = await evalJs(`fetch('/api/link-audit/decisions/${AUDIT}').then(r=>r.json()).then(j=>j.head)`);
  const create = await evalJs(`fetch('/api/link-audit/decisions/${AUDIT}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record:{kind:'NAME_EQUIVALENCE',nameA:'Padaria Exemplo Ltda',nameB:'Padaria Exemplo',justification:'Equivalência conferida por outra pessoa da equipe.'},expectedHead:${JSON.stringify(head)}})}).then(r=>r.status)`);
  check('decisão externa gravada (201)', create === 201, String(create));
  await sleep(5200);
  await click('Atualizar');
  const historical = await waitFor(async () => /HISTÓRICO/.test(await text()), 15000);
  check('resultado aparece como HISTÓRICO depois de decisão nova', historical);
  await shot('05-desktop-historico');

  /* ---- obstrução do foco pela faixa fixa (desktop) ---- */
  await evalJs(`window.scrollTo(0,0); document.body.focus()`);
  let obstructed = 0, visited = 0;
  for (let i = 0; i < 70; i++) {
    await key('Tab', 'Tab', 9);
    const r = await evalJs(`(()=>{const el=document.activeElement;const strip=document.querySelector('[class*="md:sticky"]');if(!el||!strip||strip.contains(el)||el===document.body)return null;const a=el.getBoundingClientRect(),b=strip.getBoundingClientRect();const hit=a.height>0&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top&&getComputedStyle(strip).position==='sticky';return hit?((el.getAttribute('aria-label')||el.innerText||el.tagName).slice(0,40)+' top='+Math.round(a.top)+' stripBottom='+Math.round(b.bottom)+' scrollY='+Math.round(scrollY)):false})()`);
    if (r === null) continue; visited++; if (r) { obstructed++; log('coberto:', r); }
  }
  check('FOCO: nenhum controle focado fica coberto pela faixa de estado fixa (70 Tab)', visited > 20 && obstructed === 0, `visitados=${visited} cobertos=${obstructed}`);

  /* ---- 429 REAL do limitador (6/min por operador): a interface não reenvia sozinha ---- */
  await evalJs(`document.getElementById('resultados').scrollIntoView()`);
  const burned = await evalJs(`(async()=>{const out=[];for(let i=0;i<6;i++){const r=await fetch('/api/link-audit/scoring/${AUDIT}/finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});out.push(r.status)}return out})()`);
  check('limitador do servidor esgotado por requisições de teste', burned.includes(429), JSON.stringify(burned));
  await click('Atualizar');
  await sleep(300);
  const posts0 = await evalJs(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/finalize')).length`);
  await sleep(5500);
  await click('Atualizar');
  await waitFor(async () => (await text()).includes('Resultado da prévia'), 5000);
  const canOpen = await waitFor(() => evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim().startsWith('Registrar resultado')&&!b.disabled)`), 15000);
  check('botão de registrar disponível para exercitar o 429', !!canOpen);
  await click('Registrar resultado'); await sleep(300);
  await evalJs(`document.querySelector('dialog input[type=checkbox]').click()`); await sleep(100);
  await evalJs(`[...document.querySelectorAll('dialog button')].find(b=>b.innerText.includes('Confirmar e registrar')).click()`);
  const limitedUi = await waitFor(async () => (await text()).includes('Limite de requisições atingido.'), 10000);
  check('429 REAL: a tela mostra o aviso próprio de limite', !!limitedUi);
  t = await text();
  check('429: diz que nada foi gravado e que não é pendência de recibo', /Nada foi gravado por esta tentativa/.test(t) && /não é um resultado confirmado nem uma pendência de recibo/.test(t));
  check('429: tempo vindo do cabeçalho Retry-After do servidor', /O servidor pediu para aguardar \d+ s/.test(t));
  check('429: reenvio desabilitado durante o prazo e sem mensagem de sucesso', await evalJs(`[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Reenviar o mesmo pedido'))?.disabled === true`) && (await evalJs(`(()=>{const boxes=[...document.querySelectorAll('[role="status"],[role="alert"]')].filter(e=>e.innerText.includes('Limite de requisições atingido.'));return boxes.length>0&&boxes.every(e=>!/Confirmado e verificado/.test(e.innerText))})()`)));
  const posts1 = await evalJs(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/finalize')).length`);
  await sleep(4000);
  const posts2 = await evalJs(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/finalize')).length`);
  check('429: nenhum reenvio automático (nenhum POST novo depois do 429)', posts2 === posts1, `antes=${posts0} no 429=${posts1} depois=${posts2}`);
  await shot('05b-desktop-429');

  /* ---- teclado e foco visível ---- */
  await evalJs(`document.body.focus()`);
  for (let i = 0; i < 6; i++) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }), await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const focus = await evalJs(`(()=>{const el=document.activeElement;const cs=getComputedStyle(el);return {tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,40),outline:cs.outlineStyle+' '+cs.outlineWidth,shadow:cs.boxShadow!=='none'}})()`);
  check('Tab alcança elementos interativos com foco visível', focus && focus.tag !== 'BODY' && (focus.outline.startsWith('auto') || !focus.outline.startsWith('none') || focus.shadow), JSON.stringify(focus));

  /* ---- mobile ---- */
  await setViewport(390, 844, true);
  await h.navigate(url);
  await waitFor(async () => (await text()).includes('Resultado da prévia') && !(await text()).includes('Carregando a auditoria'), 25000);
  const overflow = await evalJs(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check('mobile sem rolagem horizontal da página', overflow <= 2, 'excesso=' + overflow);
  const smallList = await evalJs(`[...document.querySelectorAll('button,a,summary')].filter(e=>e.offsetParent!==null).map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.height>0&&(x.r.height<40||x.r.width<40)).map(x=>(x.e.getAttribute('aria-label')||x.e.innerText||x.e.tagName).slice(0,40)+' '+Math.round(x.r.width)+'x'+Math.round(x.r.height))`);
  check('mobile: alvos interativos ≥ 40 px', smallList.length === 0, JSON.stringify(smallList));
  await shot('06-mobile-topo');
  await evalJs(`document.getElementById('criterios').open=true; document.getElementById('criterios').scrollIntoView()`);
  await sleep(300);
  check('mobile: matriz em cartões (tabela oculta)', await evalJs(`getComputedStyle(document.querySelector('#criterios table')).display==='none' || document.querySelector('#criterios table').offsetParent===null`));
  await shot('07-mobile-criterios');

  /* ---- rota inválida e sem sessão ---- */
  await h.navigate(`${BASE}/auditoria-por-link/x`);
  await sleep(1500);
  check('id inválido ⇒ página 404', /404|não foi encontrada|not found/i.test(await text()));
  await h.clearSession();
  await h.navigate(url);
  await sleep(2000);
  check('sem sessão ⇒ redireciona para o login', (await evalJs('location.pathname')) === '/login', await evalJs('location.href'));

  await h.finish();
})().catch((error) => {
  console.error('ERRO', error);
  process.exit(3);
});
