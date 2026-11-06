'use strict';
/*
 * Infraestrutura dos roteiros de navegador (Onda 6C). Sobe, em LOOPBACK e com dados 100% FICTÍCIOS:
 *   1. a semente (seed-*.ts) num diretório temporário próprio;
 *   2. o servidor de produção local (`next start`, exige `npm run build` feito) com diretórios de evidências/decisões/resultados temporários;
 *   3. um Chromium headless controlado por CDP (WebSocket nativo do Node; sem Playwright/Puppeteer).
 * A sessão é assinada por um segredo ALEATÓRIO desta execução. Nada de .env*, Redis, Supabase, Serper ou rede externa: rode sempre via
 * `scripts/run-isolated.sh` (ver scripts/browser/README.md).
 */
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { A11Y_LINT_JS } = require('./a11y-lint.cjs');
const { CONTRAST_JS } = require('./contrast.cjs');

const PROJECT = path.resolve(__dirname, '..', '..');

/** Superfícies da paleta (tailwind.config.ts): `bg`, `sidebar`, `card`, `tile`, `surface` e o início do degradê dos painéis (#121F36). */
function paletteSurfaces() {
  const config = fs.readFileSync(path.join(PROJECT, 'tailwind.config.ts'), 'utf8');
  const pick = (token) => (new RegExp(`\\b${token}:\\s*'(#[0-9A-Fa-f]{6})'`).exec(config) || [])[1];
  const found = [pick('bg'), pick('sidebar'), pick('card'), pick('tile'), pick('surface'), '#121F36'].filter(Boolean);
  if (found.length !== 6) throw new Error('paleta não encontrada em tailwind.config.ts: a medição de foco daria falso verde');
  return found;
}
/** Operadores FICTÍCIOS autorizados nas execuções (a "intrusa" não está na lista). */
const OPERATOR_EMAIL = 'ana@empresa.com';
const OTHER_OPERATOR_EMAIL = 'bia@empresa.com';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 20000, step = 150) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > ms) return null;
    await sleep(step);
  }
}

const httpGet = (port, p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });

/** Chromium: VISUAL_BROWSER, o headless-shell do cache do Playwright ou um navegador do PATH. `null` = não há (o roteiro sai com 77 = SKIPPED). */
function findBrowser() {
  if (process.env.VISUAL_BROWSER) return process.env.VISUAL_BROWSER;
  const home = process.env.HOME || os.homedir();
  const cache = path.join(home, '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(cache).sort().reverse()) {
      const candidates = [
        entry.startsWith('chromium_headless_shell-') && path.join(cache, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        entry.startsWith('chromium-') && path.join(cache, entry, 'chrome-linux', 'chrome'),
      ].filter(Boolean);
      for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* sem cache do Playwright */
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * `seed` é o caminho da semente a partir da raiz do projeto (ex.: tests/helpers/browser-seed-i6.ts).
 * @param {{ name: string, seed: string, seedArgs?: string[], port: number, debugPort: number }} options
 */
async function createHarness(options) {
  const { name, seed, seedArgs = [], port, debugPort } = options;
  if (typeof WebSocket === 'undefined') { console.error('Precisa do Node 22+ (WebSocket nativo).'); process.exit(79); }
  const strayEnv = fs.readdirSync(PROJECT).filter((f) => /^\.env/.test(f) && f !== '.env.example');
  if (strayEnv.length > 0) { console.error(`RECUSADO: há arquivos de ambiente na árvore (${strayEnv.join(', ')}); rode via scripts/run-isolated.sh, que os recusa.`); process.exit(3); }
  const out = process.env.VISUAL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-browser-out-'));
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const log = (...args) => console.log(`[${name}]`, ...args);
  const check = (label, ok, detail = '') => {
    results.push({ name: label, status: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 600) });
    log(ok ? 'OK   ' : 'FALHA', label, detail);
    return !!ok;
  };
  const skip = (label, reason) => {
    results.push({ name: label, status: 'SKIPPED', detail: reason });
    log('SKIP ', label, '—', reason);
  };

  const browser = findBrowser();
  if (!browser) {
    console.error('SKIPPED: nenhum Chromium encontrado (defina VISUAL_BROWSER).');
    process.exit(77);
  }
  if (!fs.existsSync(path.join(PROJECT, '.next', 'BUILD_ID'))) {
    console.error('Faltam o build de produção: rode `scripts/run-isolated.sh --offline-fonts npm run build` antes.');
    process.exit(78);
  }

  const newestSource = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => Math.max(latest, entry.isDirectory() ? newestSource(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).mtimeMs), 0);
  if (fs.statSync(path.join(PROJECT, '.next', 'BUILD_ID')).mtimeMs < newestSource(path.join(PROJECT, 'src'))) {
    console.error('O build (.next) é mais antigo que o código em src/: refaça `scripts/run-isolated.sh --offline-fonts npm run build` (ou use run.sh --build).');
    process.exit(78);
  }
  const secret = crypto.randomBytes(24).toString('hex');
  /** Chave de ORIGEM (comprovação de pendências), aleatória por execução: vai ao seed e ao servidor por ambiente; nunca é fixa nem gravada. */
  const originKey = `ok-run-${crypto.randomBytes(4).toString('hex')}:${crypto.randomBytes(32).toString('hex')}`; // formato estrito de produção: <id>:<64 hex>
  /** Chave do LIVRO DE CABEÇAS (Q3): exclusiva, DISTINTA da de origem, aleatória por execução; vai ao seed e ao servidor por ambiente; nunca é fixa nem gravada. */
  const ledgerKey = `lk-run-${crypto.randomBytes(4).toString('hex')}:${crypto.randomBytes(32).toString('hex')}`;
  /**
   * PROVA DE COLETA (autenticidade das evidências): o par Ed25519 é desta execução. A semente recebe a PRIVADA (faz o papel de quem atesta a coleta);
   * o servidor recebe só a PÚBLICA e a pasta de manifestos. Sem isso o servidor, por desenho, não finaliza nada.
   */
  const evidenceKeyId = `ek-run-${crypto.randomBytes(4).toString('hex')}`;
  const evidencePair = crypto.generateKeyPairSync('ed25519');
  const evidenceSigningKey = evidencePair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const evidencePublicDer = evidencePair.publicKey.export({ format: 'der', type: 'spki' });
  const evidenceTrustKeys = `${evidenceKeyId}:${evidencePublicDer.subarray(evidencePublicDer.length - 32).toString('base64url')}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gmn-browser-${name}-`));
  const children = [];
  let ws = null;
  let finished = false;
  const cleanup = () => {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* já encerrado */
      }
    }
    try {
      ws?.close();
    } catch {
      /* já fechado */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* melhor esforço */
    }
  };
  process.on('exit', cleanup);

  // ---- semente fictícia ----
  const seedOutput = execFileSync(process.execPath, ['--require', path.join(PROJECT, 'tests/register-typescript.cjs'), path.join(PROJECT, seed), root, OPERATOR_EMAIL, ...seedArgs], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GMN_SEED_SECRET: secret, GMN_LINK_AUDIT_ORIGIN_KEY: originKey, GMN_LINK_AUDIT_LEDGER_KEY: ledgerKey, GMN_SEED_EVIDENCE_SIGNING_KEY: evidenceSigningKey, GMN_SEED_EVIDENCE_KEY_ID: evidenceKeyId }, // segredos por ambiente, não pelo argv (visível em /proc)
  });
  const line = (tag) => (seedOutput.split('\n').find((l) => l.startsWith(`${tag} `)) || '').slice(tag.length + 1);
  const IDS = JSON.parse(line('IDS') || '{}');
  const splitCookie = (cookie) => [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
  const [cookieName, operatorSession] = splitCookie(line('COOKIE'));
  const [, intruderSession] = line('INTRUSO') ? splitCookie(line('INTRUSO')) : [null, null];
  const [, otherOperatorSession] = line('OUTRO') ? splitCookie(line('OUTRO')) : [null, null];

  // ---- servidor local ----
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    SUPABASE_SERVICE_ROLE_KEY: secret,
    GMN_LINK_AUDIT_ORIGIN_KEY: originKey,
    GMN_LINK_AUDIT_LEDGER_KEY: ledgerKey,
    GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR: path.join(root, 'ledger'),
    GMN_OPERATOR_EMAILS: `${OPERATOR_EMAIL},${OTHER_OPERATOR_EMAIL}`,
    GMN_LINK_AUDIT_EVIDENCE_DIR: path.join(root, 'evidence'),
    GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR: path.join(root, 'seals'),
    GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS: evidenceTrustKeys, // só a PÚBLICA
    GMN_LINK_AUDIT_DECISIONS_DIR: path.join(root, 'decisions'),
    GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR: path.join(root, 'anchors'),
    GMN_LINK_AUDIT_RESULTS_DIR: path.join(root, 'results'),
    GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR: path.join(root, 'resanchors'),
  };
  const initialServerEnv = { ...env };
  let server = null;
  let serverLog = '';
  const startServer = async () => {
    if (await httpGet(port, '/login').then(() => true, () => false)) throw new Error(`a porta ${port} já está em uso (servidor órfão de outra execução?)`);
    server = spawn(path.join(PROJECT, 'node_modules/.bin/next'), ['start', '-p', String(port), '-H', '127.0.0.1'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(server);
    server.stdout.on('data', (chunk) => (serverLog += chunk));
    server.stderr.on('data', (chunk) => (serverLog += chunk));
    return waitFor(async () => httpGet(port, '/login').then(() => true, () => false), 60000, 500);
  };
  const up = await startServer();
  check('servidor de produção local no ar (loopback isolado)', up);
  if (!up) {
    console.log(serverLog.slice(-1500));
    process.exit(2);
  }

  // ---- Chromium + CDP ----
  const chrome = spawn(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(root, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(chrome);
  await waitFor(async () => httpGet(debugPort, '/json/version').then(() => true, () => false), 15000);
  const version = JSON.parse(await httpGet(debugPort, '/json/version'));
  const targets = JSON.parse(await httpGet(debugPort, '/json/list'));
  ws = new WebSocket((targets.find((t) => t.type === 'page') || targets[0]).webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  /** URLs que o servidor respondeu com 429 (limitador): um roteiro longo pode esgotar o limite de leituras (30/min) e isso não é defeito de tela. */
  const rateLimited = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.responseReceived' && message.params.response.status === 429) rateLimited.push(message.params.response.url.replace(/^https?:\/\/[^/]+/, ''));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC ' + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 300));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timeout de 30 s em ${method}` } }); }, 30000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** Avalia na página. Exceções do JS avaliado NÃO derrubam o roteiro (a navegação destrói contextos), mas ficam em `evalErrors` e no log. */
  const evalErrors = [];
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const details = r.result?.exceptionDetails;
    if (details || r.error) {
      const reason = (details?.exception?.description || details?.text || r.error?.message || '').slice(0, 160);
      if (!/context|Cannot find|navigat|destroyed|timeout/i.test(reason)) { evalErrors.push(reason); log('aviso: erro ao avaliar na página:', reason); }
    }
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const BASE = `http://127.0.0.1:${port}`;
  const text = async () => (await evalJs('document.body ? document.body.innerText : ""')) ?? '';
  const has = async (re) => re.test(await text());
  const setSession = (value) => send('Network.setCookie', { name: cookieName, value, url: `${BASE}/`, httpOnly: true });
  const clearSession = () => send('Network.deleteCookies', { name: cookieName, url: `${BASE}/` });
  await setSession(operatorSession);

  const harness = {
    name,
    out,
    root,
    BASE,
    IDS,
    OPERATOR_EMAIL,
    results,
    consoleErrors,
    evalErrors,
    rateLimited,
    log,
    check,
    skip,
    sleep,
    waitFor,
    send,
    evalJs,
    text,
    has,
    setSession,
    clearSession,
    operatorSession,
    intruderSession,
    /** Segunda operadora FICTÍCIA, autorizada (bia@empresa.com). */
    otherOperatorSession,
    OTHER_OPERATOR_EMAIL,
    cookieName,
    chromeVersion: version.Browser,
    /** Identificador PÚBLICO da chave de origem do servidor (nunca o material). */
    originKeyId: originKey.split(':')[0],
    /** Identificador PÚBLICO da chave do livro (nunca o material) e uma chave de livro NOVA (CSPRNG, formato de produção) para a rotação. */
    ledgerKeyId: ledgerKey.split(':')[0],
    freshLedgerKey: () => `lk-rot-${crypto.randomBytes(4).toString('hex')}:${crypto.randomBytes(32).toString('hex')}`,
    /** A chave ATUAL do livro do servidor (para o roteiro compô-la numa rotação com `RETIRED_KEYS`); nunca é impressa. */
    currentLedgerKey: () => ledgerKey,
    /** Chave de origem NOVA, gerada na hora com CSPRNG (formato de produção); nunca fixa no código. */
    freshOriginKey: () => `ok-rot-${crypto.randomBytes(4).toString('hex')}:${crypto.randomBytes(32).toString('hex')}`,
    /** Altera o ambiente do servidor local (`undefined` remove a variável); vale a partir do próximo `restartServer()`. */
    setServerEnv(patch) {
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    },
    /** Devolve o ambiente do servidor ao do início da execução; vale a partir do próximo `restartServer()`. */
    resetServerEnv() {
      for (const name of Object.keys(env)) delete env[name];
      Object.assign(env, initialServerEnv);
    },
    /**
     * Reinicia SÓ o servidor local (os dados em disco e a sessão continuam): zera os limitadores em memória entre blocos longos.
     * Não use onde o roteiro verifica o próprio limite (HTTP 429).
     */
    async restartServer() {
      server.kill('SIGKILL');
      await sleep(600);
      const ok = await startServer();
      if (!ok) check('servidor reiniciado', false, serverLog.slice(-300));
      return ok;
    },
    /** Captura de tela em PNG (pasta VISUAL_OUT). */
    async shot(label, fullPage = false) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      fs.writeFileSync(path.join(out, `${label}.png`), Buffer.from(r.result.data, 'base64'));
      log('captura', `${label}.png`);
    },
    viewport: (width, height, mobile = false, deviceScaleFactor = 1) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile }),
    /** Preferência por movimento reduzido ligada/desligada para a página. */
    reducedMotion: (on) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] }),
    /** Script executado em TODO documento novo, antes dos da página. */
    initScript: (source) => send('Page.addScriptToEvaluateOnNewDocument', { source }),
    /** Navega e espera o DOCUMENTO NOVO (pela origem de tempo da página), para o `ready` nunca ser satisfeito pelo documento antigo. */
    async navigate(url) {
      const before = await evalJs('performance.timeOrigin');
      await send('Page.navigate', { url });
      return waitFor(async () => { const now = await evalJs('performance.timeOrigin'); return now !== undefined && now !== before; }, 20000, 100);
    },
    async reload() {
      const before = await evalJs('performance.timeOrigin');
      await send('Page.reload');
      return waitFor(async () => { const now = await evalJs('performance.timeOrigin'); return now !== undefined && now !== before; }, 20000, 100);
    },
    async go(url, ready, ms = 25000) {
      await harness.navigate(url);
      return waitFor(async () => ready(await text()), ms);
    },
    /** Tecla; `text` é preciso para Enter/Espaço (ativam o controle focado): '\r' e ' '. */
    key: async (key, code, vk, modifiers = 0, text = undefined) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text !== undefined ? { text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    },
    /** `Tab` (ou `Shift+Tab`) `times` vezes; devolve o descritor do elemento focado depois de cada um. */
    async tab(times = 1, shift = false) {
      const seen = [];
      for (let i = 0; i < times; i += 1) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
        seen.push(await harness.active());
      }
      return seen;
    },
    active: () =>
      evalJs(`(()=>{const el=document.activeElement;if(!el)return null;const cs=getComputedStyle(el);const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id||'',label:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').trim().slice(0,60).replace(/\\n/g,' '),href:el.getAttribute('href')||'',outline:cs.outlineStyle+' '+cs.outlineWidth,ring:cs.boxShadow!=='none',visible:r.width>0&&r.height>0,inSidebar:!!el.closest('#gmn-sidebar'),inDialog:!!el.closest('dialog')}})()`),
    clickText: (label, scope = 'document') =>
      evalJs(`(()=>{const b=[...${scope}.querySelectorAll('button,a,summary')].find(e=>e.innerText.trim().startsWith(${JSON.stringify(label)})&&!e.disabled);if(!b)return false;b.click();return true})()`),
    enabledButton: (label) => waitFor(() => evalJs(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim().startsWith(${JSON.stringify(label)})&&!b.disabled)`), 15000),
    /**
     * Conclui uma PENDÊNCIA pelo painel (com origem comprovada): confere que o botão está DESABILITADO enquanto a caixa de confirmação não é
     * marcada, marca a caixa e clica. Devolve { disabledBefore, enabledAfter, clicked }.
     */
    async concludePending(label) {
      const find = `[...document.querySelectorAll('section[aria-labelledby$="-t"] button')].find(b=>b.innerText.trim().startsWith(${JSON.stringify(label)}))`;
      const disabledBefore = await evalJs(`(${find})?.disabled===true`);
      await evalJs(`document.querySelector('section[aria-labelledby$="-t"] input[type=checkbox]').click()`);
      await sleep(200);
      const enabledAfter = await evalJs(`(${find})?.disabled===false`);
      const clicked = await evalJs(`(()=>{const b=${find};if(!b||b.disabled)return false;b.click();return true})()`);
      return { disabledBefore, enabledAfter, clicked };
    },
    /** Digita num campo do React (dispara `input`/`change` como o usuário). */
    typeInto: (selector, value) =>
      evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`),
    /** Chamadas à API feitas pela página (nomes dos recursos). */
    apiCalls: () => evalJs(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).map(e=>e.name.replace(location.origin,''))`),
    /** Sem rolagem horizontal da página. */
    async noHorizontalScroll(label) {
      const overflow = await evalJs('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      const wide =
        overflow > 2
          ? await evalJs(`(()=>{const cw=document.documentElement.clientWidth;return [...document.querySelectorAll('body *')].filter(e=>e.scrollWidth>e.clientWidth+1&&e.clientWidth>0&&getComputedStyle(e).overflowX==='visible'&&!e.closest('aside')).slice(-6).map(e=>e.tagName+'.'+String(e.className).slice(0,60)+' sw='+e.scrollWidth+' cw='+e.clientWidth+' :'+e.innerText.slice(0,28).replace(/\\n/g,' '))})()`)
          : null;
      return check(`${label}: sem rolagem horizontal`, overflow <= 2, `excesso=${overflow}${wide ? ' ' + JSON.stringify(wide) : ''}`);
    },
    /** Alvos interativos visíveis menores que `min` px (ícones sem texto também na largura). */
    async smallTargets(label, min = 43.5) {
      const small = await evalJs(
        `(()=>{const vw=innerWidth;return [...document.querySelectorAll('button,a,summary,select,textarea,input:not([type=hidden])')].filter(e=>e.offsetParent!==null&&!e.closest('[aria-hidden=true]')&&!e.closest('.sr-only')&&getComputedStyle(e).visibility!=='hidden').map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.right>0&&x.r.left<vw&&x.r.height>0&&(x.r.height<${min}||(!x.e.innerText.trim()&&x.r.width<${min}))).map(x=>(x.e.getAttribute('aria-label')||x.e.innerText||x.e.tagName).slice(0,40).replace(/\\n/g,' ')+' '+Math.round(x.r.width)+'x'+Math.round(x.r.height))})()`,
      );
      return check(`${label}: alvos interativos ≥ 44 px`, small.length === 0, JSON.stringify(small.slice(0, 8)));
    },
    /** Contraste AA medido no renderizado (abre todos os <details> antes). */
    async contrast(label) {
      await evalJs(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
      await sleep(400);
      const c = await evalJs(CONTRAST_JS);
      return check(`contraste (AA) no renderizado — ${label}: ${c.checked} textos`, c.failureCount === 0, JSON.stringify(c.failures.slice(0, 6)));
    },
    /**
     * Verificador PRÓPRIO e reduzido de acessibilidade (não é o axe-core; ver a11y-lint.cjs). `contentOnly`: só falha por problemas do
     * conteúdo da página; os do menu/cabeçalho (dashboard em geral) são registrados à parte, com seu próprio resultado.
     */
    async a11yLint(label) {
      const r = await evalJs(A11Y_LINT_JS);
      const mine = r.issues.filter((i) => i.scope === 'conteúdo' || i.scope === 'documento');
      const shell = r.issues.filter((i) => i.scope === 'menu' || i.scope === 'cabeçalho');
      check(`acessibilidade (verificador próprio) — ${label}: ${r.checked} controles, conteúdo da página`, mine.length === 0, JSON.stringify(mine.slice(0, 6)));
      check(`acessibilidade (verificador próprio) — ${label}: menu e cabeçalho do dashboard`, shell.length === 0, JSON.stringify(shell.slice(0, 6)));
      return r;
    },
    /**
     * Indicador de foco: dá `count` Tab a partir do topo e, em cada parada, mede o contraste do anel (box-shadow) ou contorno do foco
     * contra CADA superfície da paleta (pior caso). Campos com `focus:border-gmn-accent` contam também a borda opaca de foco.
     * Devolve [{ label, kind, ratio, className }] (kind: 'anel' | 'contorno' | 'borda' | 'nenhum').
     */
    async focusIndicators(count) {
      const surfaces = paletteSurfaces();
      await evalJs('document.activeElement&&document.activeElement.blur();window.scrollTo(0,0)');
      const out = [];
      for (let i = 0; i < count; i += 1) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const measured = await evalJs(`(()=>{
          const el=document.activeElement;if(!el||el===document.body)return null;
          const hex=(h)=>({r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16),a:1});
          const surfaces=${JSON.stringify(surfaces)}.map(hex);
          const parse=(c)=>{const m=c.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const v=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return {r:v[0],g:v[1],b:v[2],a:v.length>3?v[3]:1}};
          const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});
          const lin=(x)=>{x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)};
          const L=(c)=>0.2126*lin(c.r)+0.7152*lin(c.g)+0.0722*lin(c.b);
          const ratio=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
          const worst=(color)=>Math.min(...surfaces.map((s)=>ratio(color.a<1?over(color,s):color,s)));
          const cs=getComputedStyle(el);
          const label=(el.getAttribute('aria-label')||el.innerText||el.id||el.tagName).trim().slice(0,40).replace(/\\n/g,' ');
          let kind='nenhum',value=0;
          if(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>0){const c=parse(cs.outlineColor);if(c){kind='contorno';value=cs.outlineStyle==='auto'?21:worst(c)}}
          const shadows=[...cs.boxShadow.matchAll(/(rgba?\\([^)]*\\))\\s+(-?\\d+(?:\\.\\d+)?px)\\s+(-?\\d+(?:\\.\\d+)?px)\\s+(\\d+(?:\\.\\d+)?px)\\s+(\\d+(?:\\.\\d+)?px)/g)];
          for(const m of shadows){if(parseFloat(m[4])===0&&parseFloat(m[5])>0){const c=parse(m[1]);if(c&&c.a>0){const r=worst(c);if(r>value){kind='anel';value=r}}}}
          if(/\\bfocus:border-gmn-accent\\b/.test(String(el.className))){const c=parse(cs.borderTopColor);if(c){const r=worst(c);if(r>value){kind='borda';value=r}}}
          return {label,kind,ratio:Math.round(value*100)/100,className:String(el.className).slice(0,90)};
        })()`);
        if (measured) out.push(measured);
      }
      return out;
    },
    async finish() {
      finished = true;
      check('sem erros de console/exceções na página', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
      const failed = results.filter((r) => r.status === 'FAIL');
      const skipped = results.filter((r) => r.status === 'SKIPPED');
      const passed = results.filter((r) => r.status === 'PASS');
      fs.writeFileSync(
        path.join(out, `resultado-${name}.json`),
        JSON.stringify({ script: name, executedAt: new Date().toISOString(), chromium: version.Browser, node: process.version, pass: passed.length, fail: failed.length, skipped: skipped.length, results }, null, 2),
      );
      log(`resumo: ${passed.length}/${passed.length + failed.length} verificações aprovadas, ${failed.length} reprovadas, ${skipped.length} não executadas (SKIPPED)`);
      cleanup();
      process.exit(failed.length ? 1 : 0);
    },
  };
  process.on('exit', () => {
    if (!finished) log('encerrado sem concluir (exceção ou saída antecipada)');
  });
  return harness;
}

module.exports = { createHarness, PROJECT, OPERATOR_EMAIL };
