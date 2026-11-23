import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AUDIT_ID_PATTERN } from '../src/lib/link-audit-decisions';
import { LEDGER_AUDIT_ID_PATTERN } from '../src/lib/link-audit-ledger';

/*
 * ISOLAMENTO ESTÁTICO do livro de cabeças: o modelo é puro; só o armazenamento toca o disco (e só pelas primitivas atômicas); só o serviço coordena;
 * o relógio e o ambiente nunca são lidos fora do que está declarado; a 6B só fala com o livro pela porta (nunca o importa).
 */
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-ledger');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
const files = fs.readdirSync(LIB).sort();
const code = (name: string): string => strip(fs.readFileSync(path.join(LIB, name), 'utf8'));
const imports = (source: string): string[] => [...strip(source).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

test('o módulo tem exatamente os arquivos esperados (arquivo novo exige revisão deliberada)', () => {
  // G1.b.1: `guard-alarm.ts` (porta PURA dos alarmes da guarda, GE-E6), revisado deliberadamente
  // G1.b.2a: `guard-pseudonym.ts` (pseudônimo HMAC, D-G0-5), `guard-postgres.ts` (adaptador real, cliente injetado) e `guard-pg.ts` (o ÚNICO que importa `pg`)
  assert.deepEqual(files, ['config.ts', 'guard-alarm.ts', 'guard-pg.ts', 'guard-postgres.ts', 'guard-pseudonym.ts', 'guard.ts', 'index.ts', 'model.ts', 'observed.ts', 'service.ts', 'store.ts', 'types.ts']);
});

test('imports: lista fechada por arquivo (zod, node:path/crypto onde cabe, módulos neutros e a PORTA da 6B — nunca o restante das decisões, o motor, o coletor ou a rede)', () => {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    'types.ts': ['zod', '../link-audit-origin', '../link-audit-decisions/ledger-port'],
    'model.ts': ['../link-audit-origin', './types'],
    // node:crypto só para o SHA-256 de mão única das impressões digitais de chave (G1.a, PG-L01): nunca para gerar ou expor material
    // G1.b.2a: lê também a configuração da guarda (destino e chave do pseudônimo); `./guard-pg` só como TIPO (o `pg` não é carregado por aqui)
    'config.ts': ['node:crypto', 'node:path', '../link-audit-origin', './guard-pseudonym', './guard-pg'],
    // G1.b.1: zod valida as respostas da guarda na fronteira (regra 5: fora do esquema ⇒ indisponível)
    'guard.ts': ['node:path', 'zod', '../link-audit-storage', '../link-audit/snapshot-store', './types'],
    'guard-alarm.ts': [],
    // G1.b.2a: o pseudônimo só usa node:crypto (HKDF + HMAC); o adaptador não fala com a rede (recebe a conexão); só o conector importa `pg`
    'guard-pseudonym.ts': ['node:crypto'],
    'guard-postgres.ts': ['zod', './guard', './guard-pseudonym', './types'],
    'guard-pg.ts': ['pg', './guard', './guard-postgres', './guard-pseudonym'],
    'store.ts': ['node:crypto', 'node:path', '../link-audit-storage', '../link-audit/snapshot-store', './types'],
    'observed.ts': [],
    'service.ts': ['node:path', '../link-audit-decisions/ledger-port', '../link-audit-origin', '../link-audit-storage', '../link-audit/snapshot-store', './guard', './guard-alarm', './model', './observed', './store', './types'],
    'index.ts': ['./service', './guard', './guard-alarm', './guard-pg', './guard-postgres', './guard-pseudonym', './config', './model', './observed', './store', './types'],
  };
  for (const name of files) {
    for (const specifier of imports(fs.readFileSync(path.join(LIB, name), 'utf8'))) assert.ok((allowed[name] ?? []).includes(specifier), `${name} importa "${specifier}"`);
  }
});

test('G1.b.2a: `pg` só em guard-pg.ts em TODO o src/; nenhum caminho de TLS sem verificação (rejectUnauthorized false, no-verify, sslmode fraco) no livro', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
  const importers = walk(path.join(ROOT, 'src')).filter((file) => imports(fs.readFileSync(file, 'utf8')).some((specifier) => specifier === 'pg' || specifier.startsWith('pg/') || specifier === 'pg-native'));
  assert.deepEqual(importers.map((file) => path.relative(ROOT, file)), ['src/lib/link-audit-ledger/guard-pg.ts']);
  for (const name of files) {
    const text = code(name);
    assert.ok(!/rejectUnauthorized\s*:\s*false|no-verify|sslmode=(?:disable|allow|prefer|require)\b|NODE_TLS_REJECT_UNAUTHORIZED/.test(text), `${name}: TLS sem verificação`);
    assert.ok(!/connectionString/.test(text), `${name}: string de conexão interpretada pelo pg`);
  }
  assert.match(code('guard-pg.ts'), /rejectUnauthorized: true, ca: target\.caPem/);
});

test('PUREZA: o modelo e os tipos não tocam disco, rede, relógio, aleatoriedade, ambiente nem log', () => {
  for (const name of ['model.ts', 'types.ts', 'guard-alarm.ts']) {
    const text = code(name);
    for (const [pattern, label] of [
      [/node:(?:fs|http|https|net|dns|child_process|os|worker_threads|crypto)\b/, 'módulo do Node'],
      [/\bfetch\s*\(|XMLHttpRequest|WebSocket/, 'rede'],
      [/Date\b/, 'relógio'],
      [/Math\.random|randomBytes|randomUUID|getRandomValues/, 'aleatoriedade'],
      [/process\./, 'process'],
      [/console\./, 'log'],
      [/\bsetTimeout\b|\bsetInterval\b/, 'temporizador'],
    ] as const) assert.ok(!pattern.test(text), `${name} usa ${label}`);
  }
});

test('só o armazenamento e a guarda tocam o disco, e nunca fora das primitivas atômicas: nenhum apagar, renomear, truncar ou sobrescrever', () => {
  for (const name of files) {
    const text = code(name);
    assert.ok(!/writeFile|appendFile|createWriteStream|\.unlink\s*\(|\.rename\s*\(|\.rm\s*\(|\.rmdir\s*\(|\.truncate\s*\(|\.copyFile\s*\(|\.chmod\s*\(|\.symlink\s*\(/.test(text), `${name} altera ou apaga arquivos diretamente`);
    if (!['store.ts', 'guard.ts', 'service.ts'].includes(name)) assert.ok(!/\bops\./.test(text), `${name} usa operações de disco`);
  }
  const used = (name: string): string[] => [...new Set([...code(name).matchAll(/\bops\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1] as string))].sort();
  // `syncDirectory` (R7-04): só sincroniza (fsync) a pasta do livro e o diretório-pai; não cria, altera nem apaga arquivo
  assert.deepEqual(used('store.ts'), ['readdir', 'syncDirectory']);
  assert.deepEqual(used('guard.ts'), ['readdir']);
  assert.deepEqual(used('service.ts'), ['realpath'], 'o serviço só consulta o caminho real das pastas (configuração)');
  assert.ok(/publishExclusive\(/.test(code('store.ts')) && /atomicOnly\(/.test(code('store.ts')), 'só publica por link() exclusivo, sem caminho não atômico');
});

test('relógio e ambiente: o serviço nunca lê o relógio (só interpreta a hora recebida); só config.ts lê o ambiente, uma vez, no ponto declarado; aleatoriedade só no armazenamento', () => {
  assert.ok(!/Date\.now|new Date\(|performance\.now|hrtime/.test(code('service.ts')), 'o serviço recebe a hora de quem chama');
  for (const name of files) {
    const text = code(name);
    const env = (text.match(/process\.env/g) ?? []).length;
    assert.equal(env, name === 'config.ts' ? 1 : 0, `${name}: uso de process.env`);
    assert.equal(/randomBytes|randomUUID/.test(text), name === 'store.ts', `${name}: aleatoriedade`);
    assert.ok(!/console\./.test(text), `${name} escreve no console`);
  }
  // R7-09: o ÚNICO ponto que lê o relógio monotônico é `observed.ts` (referência de idade independente da hora gravada); nenhum outro arquivo do livro o lê
  for (const name of files) assert.equal(/performance\.now|hrtime/.test(code(name)), name === 'observed.ts', `${name}: relógio monotônico`);
  assert.match(code('config.ts'), /ledgerConfigFromProcess\s*=\s*\(now\?: \(\) => Date\): LedgerConfig => ledgerConfigFromEnv\(process\.env, now\)/);
});

test('nenhum segredo nem valor fixo: sem literal hexadecimal de 64 caracteres, sem chave embutida; mensagens de erro não citam material', () => {
  for (const name of files) {
    const text = fs.readFileSync(path.join(LIB, name), 'utf8');
    assert.ok(!/['"`][0-9a-f]{64}['"`]/.test(text), `${name} tem um literal de 64 hexadecimais`);
    assert.ok(!/createHmac\(\s*['"][^'"]+['"]\s*,\s*['"`][^'"`]{4,}['"`]/.test(text), `${name} embute chave`);
    assert.ok(!/throw new Error\([^)]*(secret|tag|material)/i.test(code(name)), `${name}: mensagem de erro cita material`);
  }
});

test('o padrão de auditId do livro é IGUAL ao das decisões (um auditId aceito por um é aceito pelo outro, e só ele)', () => {
  assert.equal(LEDGER_AUDIT_ID_PATTERN.source, AUDIT_ID_PATTERN.source);
});

test('o livro nunca é opcional por esquecimento: a 6B só o conhece pela porta, e nada além do serviço dispensa-o', () => {
  const decisions = path.join(ROOT, 'src', 'lib', 'link-audit-decisions');
  for (const name of fs.readdirSync(decisions)) {
    for (const specifier of imports(fs.readFileSync(path.join(decisions, name), 'utf8'))) assert.ok(!/link-audit-ledger/.test(specifier), `${name} importa o módulo do livro ("${specifier}")`);
  }
  const service = fs.readFileSync(path.join(decisions, 'service.ts'), 'utf8');
  assert.match(service, /readonly ledger: LedgerSource;/, '`ledger` é obrigatório na construção');
});

test('R6-12: a obrigatoriedade do livro não depende de convenção — `appendEntry` (única porta de escrita das decisões) só é chamado pelo serviço, e TODA chamada do serviço passa o livro (`ledger:`) em `WriteOptions`', () => {
  const walkSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkSrc(path.join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
  const callers = walkSrc(path.join(ROOT, 'src')).filter((file) => /\bappendEntry\s*(<[^>]*>)?\s*\(/.test(strip(fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(callers.map((file) => path.relative(ROOT, file)).sort(), ['src/lib/link-audit-decisions/service.ts', 'src/lib/link-audit-decisions/store.ts'], 'só a definição (store) e o serviço');
  const service = strip(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit-decisions', 'service.ts'), 'utf8'));
  const calls = [...service.matchAll(/appendEntry<ServiceFailure>\(/g)];
  assert.equal(calls.length, 3, 'criação, revogação e ação do livro');
  // cada chamada recebe as opções de escrita COM o livro, que vem de `writeWitness` (R7-05/R7-06): criação e revogação o repassam por `w.ledger` (só `null` quando o código dispensa o
  // livro pelo símbolo), a ação do livro (RECOVER) o EXIGE (`as NonNullable`); e `writeWitness` o monta SEMPRE com a porta quando ela existe
  const withLedger = [...service.matchAll(/\.\.\.storeOptions, now: clock, (?:\.\.\.\(w\.ledger \? \{ ledger: w\.ledger \} : \{\}\)|ledger: w\.ledger as NonNullable<typeof w\.ledger>) \}/g)];
  assert.equal(withLedger.length, 3, 'toda gravação passa o livro');
  assert.match(service, /ledger: ledgerPort\s*\? \{\s*port: ledgerPort,/, '`writeWitness` monta o livro com a porta quando ela existe');
  assert.match(service, /const ledgerPort = options\.ledger === LEDGER_NOT_REQUIRED \? null : options\.ledger;/, 'o livro só é dispensado pelo símbolo de código, nunca por configuração');
});

