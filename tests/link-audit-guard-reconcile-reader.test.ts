import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GUARD_READER_ROLE } from '../src/lib/link-audit-ledger/config';
import ts from 'typescript';
import { GUARD_LATEST_SQL, GUARD_PUBLISH_SQL } from '../src/lib/link-audit-ledger/guard-postgres';
import { MAX_GUARD_HEADS, READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL, READER_ROLE, READER_ROWS_SQL, readGuard } from '../src/lib/link-audit-guard-reconcile/reader';
import type { GuardRow } from '../src/lib/link-audit-guard-reconcile/model';
import { PSEUDONYMS_A, type SimulatedHeadRow } from './helpers/link-audit-guard-db-fixtures';
import { manualTimer, READER_IDENTITY, simulatedReaderDb, WRITER_IDENTITY } from './helpers/link-audit-guard-reconcile-fixtures';

/*
 * G1.b.2b — LEITURA DA GUARDA pela reconciliação (GE-E5): SOMENTE LEITURA, uma conexão (sem pool), sempre encerrada, com prazo total. Antes de ler
 * qualquer cabeça, a sessão prova que é do papel de LEITURA (`gmn_guard_reader`), que a sessão é somente leitura por padrão (o ajuste do papel na
 * migração 004) e que NÃO pode executar a função de publicação: com a credencial do escritor nada é lido. As leituras correm numa transação
 * `read only` (repeatable read: as cabeças e as linhas do registro anterior são do mesmo instante). SQL fixo, dados só por parâmetro.
 */
const A = 'auditoria-leitor-a1';
const B = 'auditoria-leitor-b1';
const refA = PSEUDONYMS_A.current(A).auditRef;
const refB = PSEUDONYMS_A.current(B).auditRef;
const H = (c: string): string => c.repeat(64);
const ROWS = (): SimulatedHeadRow[] => [
  { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') },
  { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 4, sha256: H('4') },
  { audit_ref: refB, key_id: 'gk-test-a', ledger_seq: 2, sha256: H('2') },
];
const asRow = (row: SimulatedHeadRow): GuardRow => ({ auditRef: row.audit_ref, keyId: row.key_id, ledgerSeq: row.ledger_seq, sha256: row.sha256 });

test('G1.b.2b leitor: identidade conferida ANTES de ler; cabeças (a maior de cada pseudônimo) e as linhas do registro anterior lidas numa transação read only; SQL fixo; uma conexão, encerrada', async () => {
  const db = simulatedReaderDb(ROWS());
  const previous = [asRow({ audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') }), asRow({ audit_ref: refB, key_id: 'gk-test-a', ledger_seq: 3, sha256: H('3') })];
  const read = await readGuard(db.connect, previous);
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.value.role, 'gmn_guard_reader');
  assert.deepEqual(read.value.heads, [ROWS()[1], ROWS()[2]].map((row) => asRow(row as SimulatedHeadRow)).sort((x, y) => (x.auditRef < y.auditRef ? -1 : 1)));
  assert.deepEqual(read.value.previousNow, [asRow(ROWS()[0] as SimulatedHeadRow)], 'a posição 3 de B não existe na guarda');
  assert.deepEqual(db.queries.map((query) => query.text), [READER_IDENTITY_SQL, READER_BEGIN_SQL, READER_HEADS_SQL, READER_ROWS_SQL, READER_END_SQL]);
  assert.deepEqual(db.queries[2]?.values, [MAX_GUARD_HEADS + 1]);
  assert.deepEqual(db.queries[3]?.values, [[refA, refB], ['1', '3']]);
  assert.ok(!db.queries.some((query) => query.text === GUARD_PUBLISH_SQL || /publish_head\(\$/.test(query.text) || /\b(insert|update|delete|truncate)\b/i.test(query.text)), 'nada de escrita');
  assert.deepEqual([db.state.connects, db.state.ends, db.state.open], [1, 1, 0]);
  assert.match(READER_BEGIN_SQL, /read only/);
});

test('G1.b.2b leitor: sem registro anterior, a consulta das linhas antigas nem é feita', async () => {
  const db = simulatedReaderDb(ROWS());
  const read = await readGuard(db.connect, []);
  assert.ok(read.ok && read.value.previousNow.length === 0);
  assert.ok(!db.queries.some((query) => query.text === READER_ROWS_SQL));
});

test('G1.b.2b leitor: credencial do ESCRITOR (outro papel, sessão gravável, EXECUTE na publicação) ⇒ recusada sem ler NENHUMA cabeça; cada sinal sozinho também recusa', async () => {
  for (const [identity, code] of [
    [WRITER_IDENTITY, 'NOT_READER_ROLE'],
    [{ ...READER_IDENTITY, role_name: 'postgres' }, 'NOT_READER_ROLE'],
    [{ ...READER_IDENTITY, default_read_only: 'off' }, 'SESSION_NOT_READ_ONLY'],
    [{ ...READER_IDENTITY, can_publish: true }, 'READER_CAN_PUBLISH'],
  ] as const) {
    const db = simulatedReaderDb(ROWS(), identity);
    assert.deepEqual(await readGuard(db.connect, []), { ok: false, code }, JSON.stringify(identity));
    assert.deepEqual(db.queries.map((query) => query.text), [READER_IDENTITY_SQL], 'nada além da identidade');
    assert.equal(db.state.open, 0);
  }
});

test('G1.b.2b leitor: conexão recusada, consulta com erro ou resposta fora do esquema ⇒ GUARD_UNAVAILABLE / GUARD_RESPONSE_INVALID (nunca "guarda vazia"); conexão sempre encerrada', async () => {
  const refused = simulatedReaderDb(ROWS());
  refused.state.failConnect = true;
  assert.deepEqual(await readGuard(refused.connect, []), { ok: false, code: 'GUARD_UNAVAILABLE' });
  for (const text of [READER_IDENTITY_SQL, READER_BEGIN_SQL, READER_HEADS_SQL]) {
    const db = simulatedReaderDb(ROWS());
    db.state.failOn = text;
    assert.deepEqual(await readGuard(db.connect, []), { ok: false, code: 'GUARD_UNAVAILABLE' }, text);
    assert.equal(db.state.open, 0);
  }
  const rewrites: Array<(text: string, rows: readonly unknown[]) => readonly unknown[]> = [
    (text, rows) => (text === READER_HEADS_SQL ? rows.map((row) => ({ ...(row as object), ledger_seq: 0 })) : rows),
    (text, rows) => (text === READER_HEADS_SQL ? rows.map((row) => ({ ...(row as object), extra: 1 })) : rows),
    (text, rows) => (text === READER_IDENTITY_SQL ? [] : rows),
    (text, rows) => (text === READER_IDENTITY_SQL ? [{ ...(rows[0] as object), can_publish: 'f' }] : rows),
    (text, rows) => (text === READER_ROWS_SQL ? [{ audit_ref: H('9'), key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') }] : rows), // linha não pedida
  ];
  for (const rewrite of rewrites) {
    const db = simulatedReaderDb(ROWS());
    db.state.rewrite = rewrite;
    assert.deepEqual(await readGuard(db.connect, [asRow(ROWS()[0] as SimulatedHeadRow)]), { ok: false, code: 'GUARD_RESPONSE_INVALID' });
    assert.equal(db.state.open, 0);
  }
});

test('G1.b.2b leitor (coerência com a G1.b.2a, revisão do PR #61): DUAS linhas na posição máxima do mesmo pseudônimo (restrição única ausente ou alterada no provedor) ⇒ GUARD_DUPLICATE_HEAD, nunca um hash escolhido; idem para a posição exata de uma linha do registro anterior', async () => {
  const duplicated = [...ROWS(), { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 4, sha256: H('9') }];
  const db = simulatedReaderDb(duplicated);
  assert.deepEqual(await readGuard(db.connect, []), { ok: false, code: 'GUARD_DUPLICATE_HEAD' });
  assert.equal(db.state.open, 0);
  // a mesma linha repetida byte a byte também conta (o leitor não "deduplica")
  const same = simulatedReaderDb([...ROWS(), { ...(ROWS()[1] as SimulatedHeadRow) }]);
  assert.deepEqual(await readGuard(same.connect, []), { ok: false, code: 'GUARD_DUPLICATE_HEAD' });
  // abaixo da posição máxima, a duplicata aparece na conferência do registro anterior
  const below = simulatedReaderDb([...ROWS(), { audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 1, sha256: H('8') }]);
  assert.deepEqual(await readGuard(below.connect, [asRow(ROWS()[0] as SimulatedHeadRow)]), { ok: false, code: 'GUARD_DUPLICATE_HEAD' });
});

test(`G1.b.2b leitor: mais de ${MAX_GUARD_HEADS} pseudônimos ⇒ TOO_MANY_GUARD_HEADS (nunca uma leitura truncada em silêncio)`, async () => {
  const db = simulatedReaderDb([]);
  db.state.rewrite = (text, rows) => (text === READER_HEADS_SQL ? Array.from({ length: MAX_GUARD_HEADS + 1 }, (_, index) => ({ audit_ref: index.toString(16).padStart(64, '0'), key_id: 'gk-test-a', ledger_seq: 1, sha256: H('1') })) : rows);
  assert.deepEqual(await readGuard(db.connect, []), { ok: false, code: 'TOO_MANY_GUARD_HEADS' });
});

test('G1.b.2b leitor: PRAZO total esgotado (consulta que não responde) ⇒ GUARD_UNAVAILABLE e a conexão é encerrada; conexão que abre depois do prazo é encerrada sem consultar', async () => {
  const db = simulatedReaderDb(ROWS());
  db.state.hangOn = READER_HEADS_SQL;
  const clock = manualTimer();
  const pending = readGuard(db.connect, [], { timer: clock.timer });
  await new Promise((resolve) => setImmediate(resolve));
  clock.fire();
  assert.deepEqual(await pending, { ok: false, code: 'GUARD_UNAVAILABLE' });
  assert.equal(db.state.open, 0);

  let release: (value: void) => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = simulatedReaderDb(ROWS());
  const lateConnect = async () => {
    await gate;
    return slow.connect();
  };
  const late = manualTimer();
  const lateRead = readGuard(lateConnect, [], { timer: late.timer });
  late.fire();
  assert.deepEqual(await lateRead, { ok: false, code: 'GUARD_UNAVAILABLE' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([slow.state.connects, slow.state.open, slow.queries.length], [1, 0, 0]);
});

test('G1.b.2b leitor × migração 004 (estático): o SQL fixo do leitor cita só o esquema, a tabela, as colunas e a assinatura da função que a migração cria; o papel é o que ela cria com SELECT e sessão somente leitura; nada de `unnest` qualificado com vários argumentos', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'proposed', '004_link_audit_guard.sql'), 'utf8');
  assert.equal(READER_ROLE, GUARD_READER_ROLE);
  assert.match(migration, /create role gmn_guard_reader login/);
  assert.match(migration, /alter role gmn_guard_reader set default_transaction_read_only = on;/);
  assert.match(migration, /grant select on table gmn_link_audit_guard\.ledger_heads to gmn_guard_writer, gmn_guard_reader;/);
  assert.match(migration, /create or replace function gmn_link_audit_guard\.publish_head\(p_audit_ref text, p_key_id text, p_ledger_seq integer, p_sha256 text\)/);
  assert.match(READER_IDENTITY_SQL, /'gmn_link_audit_guard\.publish_head\(text, text, integer, text\)', 'EXECUTE'/);
  for (const column of ['audit_ref', 'key_id', 'ledger_seq', 'sha256']) assert.match(migration, new RegExp(`\\n  ${column} (text|integer) not null`), column);
  for (const sql of [READER_HEADS_SQL, READER_ROWS_SQL]) {
    assert.match(sql, /from gmn_link_audit_guard\.ledger_heads h /);
    assert.match(sql, /^select (distinct on \(h\.audit_ref\) )?h\.audit_ref, h\.key_id, h\.ledger_seq, h\.sha256 from /);
  }
  assert.ok(!/pg_catalog\.unnest\([^)]*,/.test(READER_ROWS_SQL), 'a forma unnest(a, b) só existe sem o esquema (o Postgres real recusa a qualificada)');
  // coerência com a G1.b.2a (revisão do PR #61): TODAS as linhas na posição máxima, sem `distinct on`, pelo MESMO predicado do `latest` do adaptador
  const maxPredicate = 'h.ledger_seq = (select pg_catalog.max(m.ledger_seq) from gmn_link_audit_guard.ledger_heads m where m.audit_ref = h.audit_ref)';
  for (const sql of [READER_HEADS_SQL, GUARD_LATEST_SQL]) {
    assert.ok(!/distinct on/i.test(sql), 'nunca distinct on (escolheria um hash)');
    assert.ok(sql.includes(maxPredicate), sql);
  }
  assert.match(migration, /constraint ledger_heads_audit_ref_ledger_seq_key unique \(audit_ref, ledger_seq\)/);
  // o teste local roda a reconciliação de verdade (obrigatória) e o workflow da migração dispara quando ela muda
  const harness = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'proposed', 'local-test', 'guard-run.sh'), 'utf8');
  assert.match(harness, /guard-reconcile-run\.ts "\$SOCK"/);
  assert.match(harness, /reconciliação real: verificações a menos/);
  assert.ok(!/pulad/.test(harness), 'nenhuma etapa pulada');
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'guard-migration.yml'), 'utf8');
  for (const filter of ["'src/lib/link-audit-guard-reconcile/**'", "'scripts/link-audit-guard-reconcile.ts'", "'src/lib/link-audit-ledger/**'", "'tests/helpers/link-audit-guard-reconcile-fixtures.ts'"]) {
    assert.equal(workflow.split(`- ${filter}`).length - 1, 2, `${filter} em pull_request e em push`);
  }
  assert.match(workflow, /supabase\/proposed\/local-test\/guard-reconcile-run\.ts/);
  assert.match(READER_ROWS_SQL, /rows from \(pg_catalog\.unnest\(\$1::text\[\]\), pg_catalog\.unnest\(\$2::text\[\]\)\)/);
});

/* ============================================================================ CI: gatilhos do guard-migration.yml (revisões do PR #64) */

const REPO = path.join(__dirname, '..');
/** Os executores do teste local e o CLI da reconciliação, mais ESTE arquivo de teste (a trava também precisa disparar o workflow). */
const CLOSURE_ENTRIES = ['supabase/proposed/local-test/guard-reconcile-run.ts', 'supabase/proposed/local-test/guard-adapter-run.ts', 'scripts/link-audit-guard-reconcile.ts', 'tests/link-audit-guard-reconcile-reader.test.ts'];
/**
 * `import(`/`require(` cujo argumento NÃO é uma string literal (nem um template sem interpolação) num arquivo do fecho: o scanner não conseguiria
 * segui-lo e um arquivo executado ficaria sem gatilho. Exceções explícitas e justificadas (arquivo → motivo): hoje NENHUMA.
 */
const DYNAMIC_IMPORT_EXCEPTIONS: ReadonlyMap<string, string> = new Map();
/**
 * Referências de módulo de UM arquivo pela ÁRVORE SINTÁTICA do TypeScript (comentários e strings nunca confundem): `import`/`export … from`,
 * `import x = require(…)`, `import('…')` de tipo e as chamadas `import(…)`/`require(…)`. Chamada cujo argumento não é string literal (nem template
 * sem interpolação) vai para `dynamic`, com o trecho.
 */
function moduleRefs(file: string, source: string): { readonly specs: string[]; readonly dynamic: string[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs: string[] = [];
  const dynamic: string[] = [];
  const literal = (node: ts.Node | undefined): string | null => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null) specs.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== null) specs.push(spec);
      else dynamic.push(node.getText(sf).slice(0, 60));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literal(node.argument.literal);
      if (spec !== null) specs.push(spec);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const spec = node.arguments.length === 1 ? literal(node.arguments[0]) : null;
      if (spec !== null) specs.push(spec);
      else dynamic.push(node.getText(sf).slice(0, 60));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specs, dynamic };
}
/** Chamadas `import(`/`require(` com argumento que não é literal: devolve os trechos ofensores. */
const dynamicImportViolations = (source: string): string[] => moduleRefs('trecho.ts', source).dynamic;
/** Fecho transitivo REAL dos imports a partir das entradas: os arquivos e, por arquivo, os imports dinâmicos não literais. */
function importClosure(): { readonly files: string[]; readonly dynamic: ReadonlyArray<{ readonly file: string; readonly snippet: string }> } {
  const resolveSpec = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? path.join(REPO, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    if (base === null) return null; // pacote (node:*, pg, zod, typescript): vem do lockfile
    const found = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    assert.ok(found, `import não resolvido: ${spec} em ${path.relative(REPO, from)}`);
    return found as string;
  };
  const seen = new Set<string>();
  const dynamic: Array<{ file: string; snippet: string }> = [];
  const queue = CLOSURE_ENTRIES.map((entry) => path.join(REPO, entry));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const refs = moduleRefs(file, fs.readFileSync(file, 'utf8'));
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    for (const snippet of refs.dynamic) dynamic.push({ file: rel, snippet });
    for (const spec of refs.specs) {
      const target = resolveSpec(file, spec);
      if (target) queue.push(target);
    }
  }
  return { files: [...seen].map((file) => path.relative(REPO, file).split(path.sep).join('/')).sort(), dynamic };
}

test('G1.b.2b CI (revisão do PR #64): o `guard-migration.yml` dispara para TODO arquivo que o teste local e o CLI da reconciliação executam — fecho transitivo REAL dos imports dos executores e DESTE teste, mais o carregador TS, o lockfile e a migração; o próprio teste está nos gatilhos e no resumo de hashes', () => {
  const closure = importClosure();
  assert.ok(closure.files.includes('tests/link-audit-guard-reconcile-reader.test.ts'), 'o próprio teste da trava entra no fecho');
  const executed = [...closure.files, 'tests/register-typescript.cjs', 'package-lock.json', 'supabase/proposed/004_link_audit_guard.sql', 'supabase/proposed/004_link_audit_guard.rollback.sql', 'supabase/proposed/local-test/guard-run.sh'];
  const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'guard-migration.yml'), 'utf8');
  const filtersOf = (event: string): string[] => {
    const block = new RegExp(`\\n  ${event}:\\n(?: {4}.*\\n)*? {4}paths:\\n((?: {6}- '[^']+'\\n)+)`).exec(workflow)?.[1] ?? '';
    return [...block.matchAll(/- '([^']+)'/g)].map((match) => match[1] as string);
  };
  const pr = filtersOf('pull_request');
  assert.ok(pr.length > 0);
  assert.deepEqual(filtersOf('push'), pr, 'os mesmos caminhos em pull_request e em push');
  const asRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  const uncovered = executed.filter((file) => !pr.some((glob) => asRegExp(glob).test(file)));
  assert.deepEqual(uncovered, [], 'arquivos executados sem gatilho no workflow');
  for (const folder of ["'src/lib/link-audit-ledger/**'", "'src/lib/link-audit-guard-reconcile/**'", "'package-lock.json'", "'tests/register-typescript.cjs'", "'tests/link-audit-guard-reconcile-reader.test.ts'"]) assert.ok(workflow.includes(`- ${folder}`), folder);
  const summary = /sha256sum ([\s\S]*?)\n\s*echo '```'/.exec(workflow)?.[1] ?? '';
  assert.match(summary, /tests\/link-audit-guard-reconcile-reader\.test\.ts/, 'o teste da trava no resumo de hashes do job');
});

test('G1.b.2b CI (revisão final do PR #64): nenhum `import(`/`require(` NÃO literal (variável ou template com interpolação) no fecho — o scanner falharia em segui-lo; exceções só explícitas e justificadas', () => {
  // o detector em si: pega a forma dinâmica e aceita as literais
  assert.deepEqual(dynamicImportViolations("const nome = './x';\nvoid import(nome);").length, 1, 'import(variável)');
  assert.deepEqual(dynamicImportViolations("const m = require(caminho);").length, 1, 'require(variável)');
  assert.deepEqual(dynamicImportViolations('void import(`./mod-${qual}`);').length, 1, 'template com interpolação');
  assert.deepEqual(dynamicImportViolations("void import('./a'); require(\"./b\"); void import(`./c`); type T = import('pg').Client;"), [], 'literais aceitos');
  assert.deepEqual(dynamicImportViolations("// import(nome) num comentário\n/* require(x) */\nconst texto = 'import(nome)'; const glob = 'src/**';"), [], 'comentários e strings não contam');
  const closure = importClosure();
  const unexplained = closure.dynamic.filter((item) => !DYNAMIC_IMPORT_EXCEPTIONS.has(item.file)).map((item) => `${item.file}: ${item.snippet}`);
  assert.deepEqual(unexplained, [], 'import/require não literal no fecho (o arquivo é citado)');
  for (const file of DYNAMIC_IMPORT_EXCEPTIONS.keys()) assert.ok(closure.files.includes(file), `exceção para um arquivo fora do fecho: ${file}`);
});
