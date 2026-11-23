import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * Trava contra dados reais de cliente em arquivos versionados. O repositório é PÚBLICO; por decisão escrita do
 * responsável (23/11/2026), os arquivos atuais foram saneados (rótulos opacos como AUD-001), o histórico NÃO foi
 * reescrito e esta trava roda no job `test` do CI para impedir que os dados voltem.
 *
 * Como funciona: lista os arquivos versionados com `git ls-files`, ignora binários e `node_modules`, tokeniza o texto
 * (sem acentos, minúsculas, separado por não-alfanumérico; também pedaços camelCase, sequências de dígitos com e sem
 * zeros à esquerda e sequências hexadecimais longas) e compara o SHA-256 com separação de domínio
 * (`gmn.repo-guard.v1:` + token) com a lista fixa FORBIDDEN. Termos de duas palavras são conferidos como pares de
 * palavras vizinhas.
 *
 * Os hashes NÃO escondem os termos: são termos de baixa entropia e o histórico público já os contém. O objetivo é
 * apenas não deixá-los em claro neste arquivo e impedir que voltem a qualquer arquivo versionado. A falha aponta
 * arquivo:linha e o índice do termo, nunca o termo; a correspondência índice → termo fica no dossiê offline do
 * responsável. Para acrescentar um termo: calcule o hash FORA da árvore e inclua só o hash (nunca o termo em claro).
 * Política completa: docs/security/README.md ("Dados reais de cliente no repositório").
 */

const DOMAIN = 'gmn.repo-guard.v1:';
const ROOT = path.join(__dirname, '..');
const MIN_HEX_RUN = 8;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.pbf', '.mbtiles', '.sqlite']);

interface ForbiddenTerm {
  /** SHA-256 de `gmn.repo-guard.v1:` + termo normalizado (um token, ou duas palavras separadas por um espaço). */
  readonly sha256: string;
  /** Tipo do termo, sem revelá-lo. */
  readonly kind: string;
  /** Arquivos versionados em que o termo é legítimo (dado público sem relação com o cliente). */
  readonly allowedIn?: readonly string[];
}

/* A ordem é estável: o índice aparece na mensagem de falha. Só acrescente no fim. */
const FORBIDDEN: readonly ForbiddenTerm[] = [
  { sha256: '2eef7c850fd1c1bdc3a06110d8c352a6c1e5d24016ec8d378ace9c63e37967bc', kind: 'nome da empresa' },
  { sha256: '9e993621d30e2b399381c3ee2b216b0076ee552f47c682688f43eceb7fb3f97b', kind: 'CID' },
  { sha256: 'ec13a80a77866b4a2cc63cad678f3e70afbee043f26b4d6677ba292b237727fd', kind: '1ª metade do FID' },
  { sha256: '059b5ff074b52e5f0c42d86bebb143dbc76bef73d008a2c4dbbde1c0686ba8e2', kind: '2ª metade do FID' },
  { sha256: '206b958203c9adaa980692e9d5f82eb706cfcc7ab2d6f04719d3811189cb5a61', kind: 'placeId' },
  // A lista pública de municípios do IBGE contém a cidade legitimamente, sem nenhuma relação com o cliente.
  { sha256: 'dfd059736e27b95446824247609b4a5997f38cf3162627a79107fcac59c480c4', kind: 'cidade (duas palavras)', allowedIn: ['src/data/municipios.json'] },
];

const INDEX_BY_HASH = new Map(FORBIDDEN.map((term, index) => [term.sha256, index]));

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly termIndex: number;
}

class RepoGuardSetupError extends Error {}

const hashCache = new Map<string, number | undefined>();
function forbiddenIndex(token: string): number | undefined {
  if (hashCache.has(token)) return hashCache.get(token);
  const index = INDEX_BY_HASH.get(createHash('sha256').update(DOMAIN + token).digest('hex'));
  hashCache.set(token, index);
  return index;
}

/** Remove acentos (NFD sem marcas combinantes) preservando a caixa, para ainda separar camelCase. */
function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '');
}

/** Pedaços camelCase de um token (`fooBarBAZQux` → foo, Bar, BAZ, Qux), em minúsculas. */
function camelPieces(raw: string): string[] {
  return raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((piece) => piece.toLowerCase());
}

/** Tudo o que é comparado para um token: ele inteiro, os pedaços camelCase, os dígitos e os hexadecimais longos. */
function candidates(raw: string): Set<string> {
  const token = raw.toLowerCase();
  const out = new Set<string>([token, ...camelPieces(raw)]);
  for (const digits of token.match(/[0-9]+/g) ?? []) {
    out.add(digits);
    const trimmed = digits.replace(/^0+/, '');
    if (trimmed) out.add(trimmed);
  }
  for (const hex of token.match(new RegExp(`[0-9a-f]{${MIN_HEX_RUN},}`, 'g')) ?? []) out.add(hex);
  return out;
}

/** Procura os termos proibidos num texto. `file` é o caminho relativo à raiz (usado nas exceções `allowedIn`). */
function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const report = (line: number, termIndex: number | undefined): void => {
    if (termIndex === undefined || FORBIDDEN[termIndex]?.allowedIn?.includes(file)) return;
    const key = `${line}:${termIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ file, line, termIndex });
    }
  };
  let previous: { word: string; line: number } | null = null;
  stripAccents(text).split('\n').forEach((content, offset) => {
    const line = offset + 1;
    for (const raw of content.split(/[^A-Za-z0-9]+/)) {
      if (!raw) continue;
      for (const candidate of candidates(raw)) report(line, forbiddenIndex(candidate));
      for (const word of camelPieces(raw)) {
        if (previous) report(previous.line, forbiddenIndex(`${previous.word} ${word}`));
        previous = { word, line };
      }
    }
  });
  return findings;
}

function isBinary(file: string, buffer: Buffer): boolean {
  return BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()) || buffer.includes(0);
}

/** Arquivos versionados (relativos à raiz). Falha fechada: sem git ou fora de um repositório, a trava não passa. */
function listVersionedFiles(root: string): string[] {
  let output: Buffer;
  try {
    output = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new RepoGuardSetupError('A trava de dados de cliente precisa do `git` no PATH para listar os arquivos versionados (`git ls-files`); instale o git ou rode a partir de um checkout com git.');
    }
    throw new RepoGuardSetupError(`A trava de dados de cliente não conseguiu listar os arquivos versionados com \`git ls-files\` em ${root} (não é um repositório git?). Ela falha fechada: rode a partir de um checkout git.`);
  }
  const files = output.toString('utf8').split('\0').filter((file) => file !== '' && !file.split('/').includes('node_modules'));
  if (files.length === 0) throw new RepoGuardSetupError(`\`git ls-files\` não listou nenhum arquivo em ${root}; a trava falha fechada.`);
  return files;
}

function scanRepository(root: string): { findings: Finding[]; scanned: number } {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const file of listVersionedFiles(root)) {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const buffer = fs.readFileSync(full);
    if (isBinary(file, buffer)) continue;
    scanned += 1;
    findings.push(...scanText(buffer.toString('utf8'), file));
  }
  return { findings, scanned };
}

/** Mensagem de falha: arquivo:linha e índice/tipo do termo; nunca o termo. */
function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line}: termo proibido #${finding.termIndex} (${FORBIDDEN[finding.termIndex]?.kind ?? '?'})`;
}

test('repositório: nenhum arquivo versionado contém dado real de cliente da lista proibida', () => {
  const { findings, scanned } = scanRepository(ROOT);
  assert.ok(scanned > 100, `poucos arquivos de texto conferidos (${scanned}); a listagem parece incompleta`);
  assert.deepEqual(
    findings.map(formatFinding),
    [],
    'dado real de cliente em arquivo versionado: troque pelo rótulo opaco (ex.: AUD-001, <CID>, <FID>, <PLACE_ID>) — veja docs/security/README.md',
  );
});

/* ------------------------------------------------------------------ teste do próprio guardião (texto sintético) */

/* Os termos são montados em tempo de execução (base64) para não ficarem em claro neste arquivo. */
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
const NAME = decode('dHV2YXBsYXN0');
const CID = decode('NDE5MzQ5MTEzMTcyNzczNDE0Mg==');
const FID_1 = decode('OTRjODU3OWU0NjI0NjBlMw==');
const FID_2 = decode('M2EzMjQ1Zjc1YjYxZTU3ZQ==');
const PLACE = decode('Q2hJSjQyQWtScDVYeUpRUmZ1VmhXX2RGTWpv');
const CITY = decode('TW9naSBHdWHDp3U=');

const indexes = (text: string, file = 'docs/x.md'): number[] => [...new Set(scanText(text, file).map((f) => f.termIndex))].sort();

test('guardião: acusa cada termo proibido em formas variadas (caixa, acento, URL, identificador, zeros à esquerda)', () => {
  assert.deepEqual(indexes(`Relatório da ${NAME.toUpperCase()} COMÉRCIO`), [0]);
  assert.deepEqual(indexes(`https://www.${NAME}.com.br/contato`), [0]);
  assert.deepEqual(indexes(`const ${NAME}Base = process.env.GMN_TEST_${NAME.toUpperCase()}_BASE;`), [0]);
  assert.deepEqual(indexes(`audit: '${NAME}_20261022_x'`), [0]);
  assert.deepEqual(indexes(`effectiveLink: ?cid=0${CID}`), [1]);
  assert.deepEqual(indexes(`big: ${CID}n`), [1]);
  assert.deepEqual(indexes(`data=!4m2!3m1!1s0x0:0x${FID_2}`), [3]);
  assert.deepEqual(indexes(`fid 0x${FID_1.toUpperCase()}:0x${FID_2}`), [2, 3]);
  assert.deepEqual(indexes(`placeId: '${PLACE}'`), [4]);
  assert.deepEqual(indexes(`cidade: ${CITY.toUpperCase()}/SP`), [5]);
  assert.deepEqual(indexes(`cidade: ${CITY.split(' ').join('\n')}`), [5], 'par de palavras em linhas vizinhas');
  assert.deepEqual(indexes(`x ${stripAccents(CITY).replace(' ', '_').toLowerCase()} y`), [5]);
});

test('guardião: aponta arquivo:linha e índice, nunca o termo; a exceção por arquivo vale só para o termo dela', () => {
  const findings = scanText(`linha 1\nlinha 2 ${NAME}\nlinha 3`, 'docs/exemplo.md');
  assert.deepEqual(findings, [{ file: 'docs/exemplo.md', line: 2, termIndex: 0 }]);
  const message = formatFinding(findings[0]!);
  assert.equal(message, 'docs/exemplo.md:2: termo proibido #0 (nome da empresa)');
  for (const term of [NAME, CID, FID_1, FID_2, PLACE, CITY]) assert.ok(!message.toLowerCase().includes(term.toLowerCase()));
  assert.deepEqual(indexes(`"nome": "${CITY}"`, 'src/data/municipios.json'), [], 'lista pública de municípios');
  assert.deepEqual(indexes(`"nome": "${CITY}" ${NAME}`, 'src/data/municipios.json'), [0], 'a exceção não cobre outros termos');
});

test('guardião: texto limpo (rótulos opacos e valores sintéticos) não é acusado', () => {
  const clean = [
    'A AUD-001 foi auditada com a autorização aud-001-autorizacao-01 (aud_001_autorizacao_01).',
    'CID <CID>, FID <FID>, placeId <PLACE_ID>, cidade do interior de SP.',
    'Sintéticos: 0x94d1e2f3a4b5c6d7:0x5b7d9e2c4a6f8e1d ↔ 6592599342604848669; ChIJ_AUD001_ficticio_placeId.',
    'Cidade Fictícia Açu/SP; Mogi das Cruzes; Embu-Guaçu; Padaria Exemplo.',
  ].join('\n');
  assert.deepEqual(scanText(clean, 'docs/limpo.md'), []);
  assert.deepEqual(scanText('', 'vazio.txt'), []);
});

test('guardião: falha fechada quando a pasta não é um repositório git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-'));
  try {
    assert.throws(() => listVersionedFiles(dir), RepoGuardSetupError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
