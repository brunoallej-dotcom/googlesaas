import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * P9.2 — o núcleo do canal de manifestos `src/lib/link-audit-seals-channel/` é PURO e ISOLADO (spec `ci-deploy-and-seal-delivery.md` §5.4:
 * "módulo puro novo, com disco só pela porta FsOps"; o mesmo núcleo vai ao receptor de manifestos, P9.3b): lista fechada de arquivos e de
 * imports, nenhum `node:fs`, rede, processo filho, ambiente, relógio ou aleatoriedade. O script `link-audit-seals-check.ts` só entrega o
 * adaptador de disco padrão.
 */

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src', 'lib', 'link-audit-seals-channel');
const SCRIPT = path.join(ROOT, 'scripts', 'link-audit-seals-check.ts');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** Todas as formas de dependência: `import/export ... from`, `import 'x'`, `import('x')` e `require('x')`. */
const importsOf = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};

const VERIFIER = '../link-audit-evidence/provenance-core';
const PORT = '../link-audit/fs-ops';
const SIGN_CHAIN = '../link-audit-attestation/sign-chain';
/** Cada arquivo e o que ele pode importar. Um arquivo novo, ou um import novo, precisa de decisão (e de entrar aqui). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  // gramática do §5.2: só texto (node:path para montar o caminho do checkout) e o MAX_CHAIN_SEALS do verificador
  'paths.ts': new Set(['node:path', VERIFIER]),
  // códigos fixos: só o TIPO das razões do verificador
  'codes.ts': new Set([VERIFIER]),
  // entradas do workflow: só bytes, nenhum import
  'changes.ts': new Set([]),
  // a lista (reaproveitada pelo receptor de deploy, P9.3a): parser do verificador, prefixo de ensaio, padrão de id
  'trust-list.ts': new Set([VERIFIER, '../link-audit-evidence/simulated', './paths']),
  // S-01 a S-08: porta de disco, formato estrito do verificador, forma canônica do `sign` (serializeSealFile), SHA-256 dos bytes
  'files.ts': new Set(['node:crypto', PORT, SIGN_CHAIN, VERIFIER, './changes', './codes', './paths', './trust-list']),
  // S-09/S-10: a leitura da cadeia do `sign` (readSealChain: verificador v2 real, lista com estado, fechos, [2])
  'chains.ts': new Set(['node:path', PORT, SIGN_CHAIN, VERIFIER, './codes', './paths']),
  // S-11: formato e assinatura do fecho pelo verificador, cabeças na cadeia do repositório
  'closures.ts': new Set(['node:path', PORT, SIGN_CHAIN, VERIFIER, './codes', './files', './paths']),
  // S-12/S-13 e a lista do commit
  'trust-rules.ts': new Set([PORT, VERIFIER, './closures', './codes', './files', './paths', './trust-list']),
  // revisão do PR #68 (correção 5): o teto único de leitura da execução, uma porta embrulhada (só tipos da porta)
  'budget.ts': new Set([PORT]),
  'check.ts': new Set([PORT, VERIFIER, './budget', './chains', './changes', './closures', './codes', './files', './paths', './trust-rules', './trust-list']),
  'summary.ts': new Set(['./check', './codes', './paths']),
  // P9.5: o modo árvore do `seals-verify` (S-03 a S-08 sobre todos os arquivos do ambiente), com as mesmas peças do job `seals`
  'tree.ts': new Set(['./budget', './changes', './check', './codes', './files', './paths']),
  // o comando: zod na fronteira, a porta de disco (o script entrega o adaptador), node:path
  'cli.ts': new Set(['node:path', 'zod', PORT, './changes', './check', './codes', './paths', './summary', './tree', './trust-list', './trust-rules']),
  'index.ts': new Set(['./cli', './check', './codes', './paths', './tree', './trust-list']),
};

test('isolamento: lista fechada de arquivos do núcleo do canal e de imports por arquivo', () => {
  const files = fs.readdirSync(DIR).sort();
  assert.deepEqual(files, Object.keys(ALLOWED).sort(), 'um arquivo novo no módulo precisa de decisão');
  for (const file of files) {
    const used = new Set(importsOf(fs.readFileSync(path.join(DIR, file), 'utf8')));
    const allowed = ALLOWED[file] ?? new Set<string>();
    for (const specifier of used) assert.ok(allowed.has(specifier), `${file} importa ${specifier}`);
  }
});

test('isolamento: nenhum disco direto, rede, processo filho, ambiente, relógio ou aleatoriedade no núcleo; o script só entrega o adaptador', () => {
  for (const file of fs.readdirSync(DIR)) {
    const code = strip(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.ok(!/node:fs\b|nodeFsOps|node-fs-ops/.test(code), `${file}: disco só pela porta`);
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process|worker_threads)\b|XMLHttpRequest|WebSocket/.test(code), `${file}: sem rede nem processo filho`);
    assert.ok(!/process\.(?:env|argv|exit|cwd)|Date\.now|new Date\s*\(|Math\.random|performance\.now/.test(code), `${file}: sem ambiente, relógio ou aleatoriedade`);
    assert.ok(!/\b(?:writeExclusive|link|unlink|chmod|mkdir|syncDirectory)\s*\(/.test(code), `${file}: nada é escrito`);
  }
  assert.deepEqual(new Set(importsOf(fs.readFileSync(SCRIPT, 'utf8'))), new Set(['../src/lib/link-audit/node-fs-ops', '../src/lib/link-audit-seals-channel/cli']));
  const consumers = [...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })].filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith(path.join('lib', 'link-audit-seals-channel')));
  // P9.3a: o receptor de deploy reaproveita SÓ o módulo da lista (parser, regra de ambiente, transição) e o tipo do ambiente; nada do app
  const DEPLOY_RECEIVER_IMPORTS: ReadonlySet<string> = new Set(['../link-audit-seals-channel/trust-list', '../link-audit-seals-channel/paths']);
  // P9.3b: o receptor de manifestos reaproveita a gramática (tipo do ambiente), as regras por arquivo (S-05 a S-08), a lista, a cadeia (S-10), o
  // fecho (S-11) e os conjuntos fechados de razões e motivos; nunca o comando, o check inteiro, o resumo nem o teto da execução do CI
  const SEAL_RECEIVER_IMPORTS: ReadonlySet<string> = new Set(['codes', 'paths', 'trust-list', 'files', 'chains', 'closures'].map((file) => `../link-audit-seals-channel/${file}`));
  for (const rel of consumers) {
    const source = fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
    if (rel.startsWith(path.join('lib', 'deploy-receiver') + path.sep)) {
      for (const specifier of importsOf(source).filter((spec) => spec.includes('link-audit-seals-channel'))) assert.ok(DEPLOY_RECEIVER_IMPORTS.has(specifier), `${rel} importa ${specifier}`);
      continue;
    }
    if (rel.startsWith(path.join('lib', 'seal-receiver') + path.sep)) {
      for (const specifier of importsOf(source).filter((spec) => spec.includes('link-audit-seals-channel'))) assert.ok(SEAL_RECEIVER_IMPORTS.has(specifier), `${rel} importa ${specifier}`);
      continue;
    }
    assert.ok(!/link-audit-seals-channel/.test(strip(source)), `${rel} não importa o canal (nenhum consumidor no app)`);
  }
});
