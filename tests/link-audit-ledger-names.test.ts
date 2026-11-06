import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ANA, BIA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * M38 — ENTRADAS SUSPEITAS NA PASTA DO LIVRO (nomes inesperados, arquivos especiais, links simbólicos, formatos malformados). Quem escreve só na pasta do livro NÃO tem
 * a chave: pode plantar, apagar e renomear, mas nunca assinar. Invariantes exigidos de CADA caso:
 *   1. nunca a leitura silenciosa de "histórico vazio" (nem ENROLLMENT_PENDING, nem cabeça nova) quando a auditoria tem histórico;
 *   2. nunca avanço da cabeça do livro, nunca escrita em NENHUMA pasta (nem decisão, nem recibo, nem registro novo), nunca bypass da autorização;
 *   3. nunca travamento do processo (cada chamada tem prazo);
 *   4. ameaça à integridade ⇒ falha fechada (HISTORY_UNRESOLVED, zero decisões vigentes, nada finalizável).
 */
registerCleanup();

const within = <T>(ms: number, promise: Promise<T>, label: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`TRAVOU: ${label} (> ${ms} ms)`)), ms))]);

/** Estado de uma pasta SEM nunca abrir arquivo especial (um FIFO travaria a leitura): nome, tipo e, para arquivo comum, o hash. */
function treeState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const info = fs.lstatSync(full);
      const key = `${prefix}${name}`;
      if (info.isDirectory()) walk(full, `${key}/`);
      else if (info.isSymbolicLink()) out[key] = `symlink->${fs.readlinkSync(full)}`;
      else if (info.isFile()) out[key] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      else out[key] = `especial:${info.isFIFO() ? 'fifo' : 'outro'}`;
    }
  };
  walk(dir, '');
  return out;
}
const allTrees = (w: LedgerWorld) => ({ ledger: treeState(w.ledgerDir), decisions: treeState(w.decisionsDir), anchors: treeState(w.anchorDir) });
const auditLedgerDir = (w: LedgerWorld): string => path.join(w.ledgerDir, w.auditId);

/** Auditoria protegida com UMA decisão (livro com GENESIS, INTENT, CONFIRMED). */
async function protectedWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  return w;
}
const serviceOf = (w: LedgerWorld) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });

/** Aplica os invariantes 1–4 a uma auditoria com histórico cuja pasta do livro foi adulterada. */
async function assertFailsClosed(w: LedgerWorld, label: string, expectedStates: readonly string[] = ['HISTORY_UNRESOLVED'], expectedReason: string | null = null): Promise<void> {
  const service = serviceOf(w);
  const before = allTrees(w);
  const view = await within(8000, service.list(BIA, w.auditId, clock()).then((r) => must(Promise.resolve(r))), `${label}: leitura`);
  assert.ok(expectedStates.includes(view.ledger.state), `${label}: estado ${view.ledger.state}/${view.ledger.reason}`);
  assert.deepEqual([view.decisions.length, view.operatorRecords.length, view.finalizable], [0, 0, false], `${label}: nada vigente, nada ao motor, nada finalizável`);
  if (expectedReason !== null) assert.equal(view.ledger.reason, expectedReason, `${label}: o rótulo diz INTEGRIDADE, não "indisponível" (R7-07)`);
  assert.notEqual(view.ledger.state, 'ENROLLMENT_PENDING', `${label}: NUNCA "histórico vazio"`);
  assert.notEqual(view.ledger.state, 'PROTECTED', `${label}: nunca protegida`);
  const write = await within(8000, service.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: view.head }, clock()), `${label}: escrita`);
  assert.ok(!write.ok, `${label}: escrita recusada`);
  const revoke = await within(8000, service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: view.head }, clock()), `${label}: revogação`);
  assert.ok(!revoke.ok, `${label}: revogação recusada`);
  for (const action of ['RECOVER', 'ENROLL', 'ADOPT', 'RESTORE_ACK'] as const) {
    const done = await within(8000, service.ledgerAction(ANA, w.auditId, { action }, clock()), `${label}: ${action}`);
    assert.ok(!done.ok, `${label}: ${action} recusado`);
  }
  assert.deepEqual(allTrees(w), before, `${label}: NENHUM arquivo mudou (nem o livro, nem as decisões, nem os recibos)`);
}

/** Formatos hostis no lugar de um registro: o rótulo é UNTRUSTED (integridade), nunca UNAVAILABLE (que induziria a esperar em vez de investigar). */
const HOSTILE_SHAPE_LABELS = new Set(['FIFO como l000004.json', 'link simbólico para um registro válido como l000004.json', 'link simbólico para fora da pasta como l000004.json', 'diretório chamado l000004.json', 'arquivo grande (5 KiB) como l000004.json']);
const spec = (name: string, build: (w: LedgerWorld, dir: string) => void) => [name, build] as const;

/* ------------------------------------------------------------------ nomes que PARECEM registro: falha fechada */
const SUSPICIOUS_NAMES = [
  'l000004.json.bak',
  'l000003.json~',
  'L000004.json',
  'l0000004.json', // 7 dígitos
  'l4.json',
  'l000004.JSON',
  'l000004.json ', // espaço no fim
  'l000004.json\n', // quebra de linha no fim
  'l000004.json.', // ponto no fim
  'l000004.jsonx',
  'l000004',
  'l00000a.json',
  // R7-07: só parecem registro depois de normalizar (largura total, dígitos de outro alfabeto, letra "ℓ", ligadura): nunca ignorados em silêncio
  'l٠٠٠٠٠٤.json',
  'l۰۰۰۰۰۴.json',
  'l０００００４.json',
  'ｌ000004.json',
  'ℓ000004.json',
];
test('M38: nome que PARECE um registro do livro (backup, caixa, dígitos, espaço, quebra de linha) falha fechado — a pasta não é lida como íntegra nem como vazia', async () => {
  for (const name of SUSPICIOUS_NAMES) {
    const w = await protectedWorld();
    fs.writeFileSync(path.join(auditLedgerDir(w), name), 'qualquer coisa');
    await assertFailsClosed(w, `nome suspeito ${JSON.stringify(name)}`);
  }
});

/* ------------------------------------------------------------------ arquivos especiais e links, sob nome VÁLIDO de registro */
const SPECIAL: ReadonlyArray<readonly [string, (w: LedgerWorld, dir: string) => void]> = [
  spec('FIFO como l000004.json', (_w, dir) => void execFileSync('mkfifo', [path.join(dir, 'l000004.json')])),
  spec('link simbólico para um registro válido como l000004.json', (_w, dir) => fs.symlinkSync(path.join(dir, 'l000001.json'), path.join(dir, 'l000004.json'))),
  spec('link simbólico para fora da pasta como l000004.json', (_w, dir) => fs.symlinkSync('/etc/hostname', path.join(dir, 'l000004.json'))),
  spec('link simbólico PENDENTE (alvo inexistente) como l000004.json', (_w, dir) => fs.symlinkSync(path.join(dir, 'nao-existe'), path.join(dir, 'l000004.json'))),
  spec('diretório chamado l000004.json', (_w, dir) => fs.mkdirSync(path.join(dir, 'l000004.json'))),
  spec('link simbólico SUBSTITUINDO o registro l000003.json por uma cópia idêntica', (w, dir) => {
    const copy = path.join(tmpDir('lad-copy-'), 'copia.json');
    fs.copyFileSync(path.join(dir, 'l000003.json'), copy);
    fs.rmSync(path.join(dir, 'l000003.json'));
    fs.symlinkSync(copy, path.join(dir, 'l000003.json'));
    void w;
  }),
  spec('hard link: l000004.json é o MESMO arquivo que l000003.json', (_w, dir) => fs.linkSync(path.join(dir, 'l000003.json'), path.join(dir, 'l000004.json'))),
  spec('arquivo grande (5 KiB) como l000004.json', (_w, dir) => fs.writeFileSync(path.join(dir, 'l000004.json'), 'x'.repeat(5 * 1024))),
  spec('arquivo VAZIO como l000004.json', (_w, dir) => fs.writeFileSync(path.join(dir, 'l000004.json'), '')),
  spec('JSON malformado como l000004.json', (_w, dir) => fs.writeFileSync(path.join(dir, 'l000004.json'), '{"schemaVersion":1,')),
  spec('JSON válido mas fora do contrato como l000004.json', (_w, dir) => fs.writeFileSync(path.join(dir, 'l000004.json'), JSON.stringify({ schemaVersion: 1, ledgerSeq: 4, kind: 'outra-coisa' }))),
  spec('registro VÁLIDO de outra posição com o nome l000004.json (sequência interna ≠ nome)', (_w, dir) => fs.copyFileSync(path.join(dir, 'l000001.json'), path.join(dir, 'l000004.json'))),
  spec('registro REAL de outra auditoria transplantado como l000004.json', (_w, dir) => {
    // a cabeça do outro livro: GENESIS real de OUTRA auditoria, renomeado para a próxima posição
    const otherDir = path.join(path.dirname(dir), 'auditoria-outra-9999');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.copyFileSync(path.join(dir, 'l000001.json'), path.join(otherDir, 'l000004.json'));
    fs.copyFileSync(path.join(otherDir, 'l000004.json'), path.join(dir, 'l000004.json'));
  }),
  spec('LACUNA: l000002.json removido', (_w, dir) => fs.rmSync(path.join(dir, 'l000002.json'))),
  spec('registro do MEIO adulterado (um byte)', (_w, dir) => {
    const file = path.join(dir, 'l000002.json');
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"INTENT"', '"INTEnT"'));
  }),
  spec('pasta da AUDITORIA trocada por link simbólico para uma cópia íntegra', (w, dir) => {
    const copy = path.join(tmpDir('lad-dircopy-'), 'copia');
    fs.cpSync(dir, copy, { recursive: true });
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(copy, dir);
    void w;
  }),
  spec('pasta da auditoria substituída por ARQUIVO comum', (_w, dir) => {
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, 'não sou um diretório');
  }),
];
test('M38: arquivo especial, link simbólico, hard link, formato malformado, registro transplantado, lacuna e adulteração sob nome válido falham fechado, sem travar e sem mudar nada', async () => {
  for (const [label, build] of SPECIAL) {
    const w = await protectedWorld();
    build(w, auditLedgerDir(w));
    await assertFailsClosed(w, label, ['HISTORY_UNRESOLVED'], HOSTILE_SHAPE_LABELS.has(label) ? 'UNTRUSTED' : null);
  }
});

test('M38: o excesso de arquivos (mais registros do que o limite) falha fechado antes de ler qualquer um', async () => {
  const w = await protectedWorld();
  const dir = auditLedgerDir(w);
  for (let n = 4; n <= 4002; n += 1) fs.writeFileSync(path.join(dir, `l${String(n).padStart(6, '0')}.json`), '');
  await assertFailsClosed(w, 'mais de 4000 nomes');
});

/* ------------------------------------------------------------------ "histórico vazio" NUNCA é deduzido de uma pasta estranha */
test('M38: com HISTÓRICO nas decisões, uma pasta do livro sem registros (vazia, só lixo benigno ou só nomes suspeitos) NUNCA vira inscrição pendente nem GENESIS novo', async () => {
  const cases: Array<[string, (dir: string) => void, readonly string[]]> = [
    ['pasta removida', (dir) => fs.rmSync(dir, { recursive: true }), ['LEGACY_READ_ONLY']],
    ['pasta vazia', (dir) => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n)); }, ['LEGACY_READ_ONLY']],
    ['só lixo benigno', (dir) => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n)); fs.writeFileSync(path.join(dir, 'README.txt'), 'x'); fs.writeFileSync(path.join(dir, '.tmp-l000001.json-aaaa'), 'x'); }, ['LEGACY_READ_ONLY']],
    ['só nome suspeito', (dir) => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n)); fs.writeFileSync(path.join(dir, 'l000001.json.bak'), 'x'); }, ['HISTORY_UNRESOLVED']],
  ];
  for (const [label, build, states] of cases) {
    const w = await protectedWorld();
    build(auditLedgerDir(w));
    await assertFailsClosed(w, label, states);
    assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).filter((n) => /^d\d{4}\.json$/.test(n)).length, 1, `${label}: a decisão continua lá, não vigente`);
  }
});

/* ------------------------------------------------------------------ auditoria VAZIA com pasta estranha */
test('M38: auditoria realmente VAZIA — lixo benigno na pasta do livro não impede a inscrição (e nada é apagado); nome suspeito, arquivo especial ou link a IMPEDEM', async () => {
  // benigno: inscreve normalmente e o lixo permanece intacto
  const benign = await ledgerWorld({ enroll: false });
  fs.mkdirSync(auditLedgerDir(benign), { recursive: true });
  const junk = ['README.txt', '.hidden', 'x000001.json', 'ledger-000001.json', '000001.json', 'l.json', '.tmp-l000001.json-0011', 'l-000001.json', 'l 000001.json', '.l000001.json'];
  for (const name of junk) fs.writeFileSync(path.join(auditLedgerDir(benign), name), 'lixo');
  const junkBefore = Object.fromEntries(Object.entries(treeState(auditLedgerDir(benign))));
  const enrolled = await benign.rawProtected.ledgerAction(ANA, benign.auditId, { action: 'ENROLL' }, clock());
  assert.ok(enrolled.ok, `lixo benigno não bloqueia a inscrição: ${JSON.stringify(enrolled).slice(0, 160)}`);
  const after = treeState(auditLedgerDir(benign));
  for (const name of junk) assert.equal(after[name], junkBefore[name], `${name}: intacto`);
  assert.deepEqual(await ledgerEvents(benign), ['GENESIS']);

  // hostil: a inscrição é recusada e NADA é gravado
  const hostile: Array<[string, (dir: string) => void]> = [
    ['nome suspeito', (dir) => fs.writeFileSync(path.join(dir, 'l000001.json.bak'), 'x')],
    ['FIFO com nome de registro', (dir) => void execFileSync('mkfifo', [path.join(dir, 'l000001.json')])],
    ['link simbólico com nome de registro', (dir) => fs.symlinkSync('/etc/hostname', path.join(dir, 'l000001.json'))],
    ['arquivo com nome de registro (conteúdo inválido)', (dir) => fs.writeFileSync(path.join(dir, 'l000001.json'), 'x')],
  ];
  for (const [label, build] of hostile) {
    const w = await ledgerWorld({ enroll: false });
    fs.mkdirSync(auditLedgerDir(w), { recursive: true });
    build(auditLedgerDir(w));
    const before = allTrees(w);
    const view = await within(8000, serviceOf(w).list(BIA, w.auditId, clock()), label);
    assert.ok(view.ok);
    assert.notEqual(view.value.ledger.state, 'ENROLLMENT_PENDING', `${label}: não é "vazia"`);
    const enroll = await within(8000, serviceOf(w).ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock()), label);
    assert.ok(!enroll.ok, `${label}: inscrição recusada`);
    assert.deepEqual(allTrees(w), before, `${label}: nada gravado, nada apagado`);
  }
});

/* ------------------------------------------------------------------ nomes INOFENSIVOS: ignorados de propósito, sem consequência */
test('M38: nomes que não parecem registro (README, ocultos, outro prefixo, separadores, temporário órfão) são IGNORADOS — a auditoria segue protegida, a cabeça não muda e a próxima escrita funciona sem tocá-los', async () => {
  const w = await protectedWorld();
  const dir = auditLedgerDir(w);
  const junk = ['README.txt', '.hidden', 'x000004.json', 'ledger-000004.json', '000004.json', 'l.json', '.tmp-l000004.json-0011', 'l-000004.json', 'l 000004.json', '.l000004.json'];
  for (const name of junk) fs.writeFileSync(path.join(dir, name), 'lixo');
  const service = serviceOf(w);
  const head = (await must(service.list(BIA, w.auditId, clock()))).ledger.head;
  assert.deepEqual(head?.ledgerSeq, 3, 'a cabeça é a do último registro REAL: o lixo não a avança');
  const view = await must(service.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.decisions.length], ['PROTECTED', 1]);
  const before = treeState(dir);
  await must(service.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: view.head }, clock()));
  const after = treeState(dir);
  for (const name of junk) assert.equal(after[name], before[name], `${name}: intacto`);
  assert.deepEqual((await ledgerEvents(w)).slice(0, 3), ['GENESIS', 'INTENT', 'CONFIRMED']);
});
