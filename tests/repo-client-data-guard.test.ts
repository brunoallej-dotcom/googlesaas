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
 * Como funciona: lista os arquivos versionados com `git ls-files -s` (ignora `node_modules`), tokeniza o texto (sem
 * acentos, minúsculas, separado por não-alfanumérico; também pedaços camelCase, sequências de dígitos com e sem zeros à
 * esquerda, sequências hexadecimais longas, janelas de 8 e 9 dígitos de trechos com cara de telefone e coordenadas
 * decimais) e compara o SHA-256 com separação de domínio (`gmn.repo-guard.v1:` + token) com a lista fixa FORBIDDEN.
 * Termos de duas ou três palavras são conferidos como sequências de palavras vizinhas; termos "na mesma linha" (ex.:
 * cidade + segmento de uma campanha) acusam quando as duas palavras aparecem numa mesma linha, em qualquer ordem.
 *
 * Falha FECHADA para o que o scanner não lê: PDF, documento de escritório, arquivo compactado ou imagem versionados,
 * link simbólico, submódulo, texto que não é UTF-8 válido e qualquer binário fora dos caminhos reconhecidos (as fontes
 * em assets/fonts e os tiles vetoriais públicos em tests/fixtures/tiles) fazem o teste falhar, salvo uma exceção
 * explícita e justificada por caminho em UNREADABLE_EXCEPTIONS (hoje vazia).
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
const MAX_WORDS = 3;
const PHONE_WINDOWS = [8, 9] as const;
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';
/* Tipos que o scanner não lê como texto e que podem carregar dado de cliente (relatórios, prints, planilhas, pacotes). */
const UNREADABLE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ods', '.odt', '.odp', '.ppt', '.pptx', '.rtf',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.ico',
  '.sqlite', '.db', '.mbtiles',
]);
/* Binários reconhecidos que o scanner pula: só nestes CAMINHOS (prefixo) e com esta extensão, os únicos versionados hoje. */
const KNOWN_BINARIES: ReadonlyArray<{ readonly prefix: string; readonly extension: string; readonly reason: string }> = [
  { prefix: 'assets/fonts/', extension: '.woff', reason: 'fonte tipográfica (Inter) usada nos PDFs' },
  { prefix: 'tests/fixtures/tiles/', extension: '.pbf', reason: 'tile vetorial público (OpenStreetMap) das fixtures do mapa do PDF' },
];
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/* Exceções explícitas (caminho → justificativa) para itens que, de outra forma, fariam a trava falhar. Hoje: nenhuma. */
const UNREADABLE_EXCEPTIONS: ReadonlyMap<string, string> = new Map();

interface ForbiddenTerm {
  /** SHA-256 de `gmn.repo-guard.v1:` + termo normalizado (um token, ou duas/três palavras separadas por um espaço). */
  readonly sha256?: string;
  /** Alternativa: os hashes de duas palavras que não podem aparecer juntas na mesma linha (qualquer ordem e distância). */
  readonly sameLine?: readonly [string, string];
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
  // Outros clientes reais (auditorias históricas em PDF): só o PAR de palavras, porque cada palavra sozinha é comum.
  { sha256: 'd707d07f4094a7fbc8903ade66870b155256ccb982d5f1c3f9b24bf05dcd07be', kind: 'nome de outro cliente (duas palavras)' },
  { sha256: '59b8e733e6668d2ba5f52a2fa61742a9a8ad5f4fbcf9e757b4c16d6935b2d779', kind: 'nome de outro cliente (duas palavras)' },
  { sha256: 'fc936931818339a3c6d1991e3b0b1d1a980feb5096930cc1d6f929c92407ee07', kind: 'placeId de outro perfil' },
  { sha256: '316e613377c4056034fca7f474dabad7b5d25779b5b030ab57f5459723b22bf0', kind: 'telefone (9 dígitos do assinante)' },
  { sha256: 'dc6b501a0588a863bf81791d5ed4508673cbae5b99d12e8bd677183bf102f693', kind: 'coordenada (latitude, sem sinal)' },
  { sha256: 'f7f1cd46242003ae8b3206bc040b1b61598ce51c9116788ae3e1c618efe23999', kind: 'coordenada (longitude, sem sinal)' },
  // A regra do .gitignore que mantém a pasta privada de evidências fora do repositório precisa citar o nome dela.
  { sha256: 'b03ab0be748ebd8c8a882f1f596cdf657e537c7f8e23e0f7e00a740f5c2bf660', kind: 'pasta privada de evidências (três palavras)', allowedIn: ['.gitignore'] },
  // Clientes de prospecção das Fases 3–5 (auditorias e PDFs históricos, lead da homologação): nome distintivo + segmento,
  // nome + sobrenome, o slug do PDF e o domínio do site; cada palavra sozinha é comum e não é acusada.
  { sha256: 'fdd9a1ea1be06c391ac60189dbdbe7538e98823c0d2902f3bdf9d42ef9cd689c', kind: 'cliente de prospecção D (duas palavras)' },
  { sha256: 'bdf558a7a6743887ac0230458f7257b390e2da2b4b69c1dedc9676d0170632bf', kind: 'cliente de prospecção D (duas palavras, ordem inversa)' },
  { sha256: '5d1707087c3a360bb48010d3d94e1e6351095fa8710c78c370894229895c9437', kind: 'cliente de prospecção E (duas palavras)' },
  { sha256: '3ebc3e6e511cb172820cd24c648fdbf21f11b3a9a3f1fb0eb1c0c9b2b86e69f5', kind: 'cliente de prospecção F (duas palavras)' },
  { sha256: '7b3e65a898ebfbf766e81fbd87ea30fde0c2a21e152c58030d35de126eb1f161', kind: 'cliente de prospecção F (slug do PDF, três palavras)' },
  { sha256: 'd8f12f217fcd272288509dac6a7c29d8adf320d73eaebdd40d38b3babac4cc8b', kind: 'cliente de prospecção F (domínio do site)' },
  { sha256: '082711b106b88a817ac6ee79205ae120cf83b845fe6f8569884c16976b23a63b', kind: 'cliente de prospecção G (duas palavras)' },
  // Cidade + segmento da campanha dos clientes F e G: cada palavra sozinha é comum (a cidade é a padrão dos testes e da
  // lista do IBGE), então só a combinação na mesma linha é acusada.
  { sameLine: ['4320294e3e56b92f1bffc5507431f3ad209c035af9dd4ad6c9cbda5ec9fbc6bc', '7a5cace935306129774f182120c692fff24ef9273cf8ff781d8795cb07598c37'], kind: 'cidade + segmento da campanha (mesma linha)' },
  // Domínio de produção do responsável (23/11/2026): só o marcador <DOMINIO_PRODUCAO> no repositório; o valor real fica na VPS e no GitHub.
  { sha256: '6e50058faf0ecd99c149d3e2ff4751c77972ca37ae5b004736fb66adaf5c2223', kind: 'domínio de produção' },
];

const INDEX_BY_HASH = new Map(FORBIDDEN.flatMap((term, index) => (term.sha256 ? [[term.sha256, index] as const] : [])));
/* Palavra → [índice do termo, parte 0 ou 1] dos termos "na mesma linha". */
const SAME_LINE_PART_BY_HASH = new Map(FORBIDDEN.flatMap((term, index) => (term.sameLine ? term.sameLine.map((hash, part) => [hash, [index, part]] as const) : [])));

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly termIndex: number;
}

/** Entrada do índice do git: modo (`100644`, `120000`…) e caminho relativo à raiz. */
interface IndexEntry {
  readonly mode: string;
  readonly file: string;
}

type Verdict = { readonly kind: 'TEXT'; readonly text: string } | { readonly kind: 'SKIP'; readonly reason: string } | { readonly kind: 'UNREADABLE'; readonly reason: string };

class RepoGuardSetupError extends Error {}

const hashCache = new Map<string, string>();
function hashOf(token: string): string {
  let hash = hashCache.get(token);
  if (hash === undefined) {
    hash = createHash('sha256').update(DOMAIN + token).digest('hex');
    hashCache.set(token, hash);
  }
  return hash;
}
function forbiddenIndex(token: string): number | undefined {
  return INDEX_BY_HASH.get(hashOf(token));
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

/** Candidatos de uma linha inteira: janelas de dígitos de trechos com cara de telefone e coordenadas decimais. */
function lineCandidates(content: string): Set<string> {
  const out = new Set<string>();
  for (const match of content.match(/\+?\d[\d \t().-]{6,}\d/g) ?? []) {
    const digits = match.replace(/\D/g, '');
    for (const size of PHONE_WINDOWS) {
      for (let start = 0; start + size <= digits.length; start += 1) out.add(digits.slice(start, start + size));
    }
  }
  for (const match of content.match(/\d{1,3}[.,]\d{5,}/g) ?? []) out.add(match.replace(',', '.'));
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
  const recent: Array<{ word: string; line: number }> = [];
  stripAccents(text).split('\n').forEach((content, offset) => {
    const line = offset + 1;
    const sameLineParts = new Map<number, Set<number>>();
    for (const candidate of lineCandidates(content)) report(line, forbiddenIndex(candidate));
    for (const raw of content.split(/[^A-Za-z0-9]+/)) {
      if (!raw) continue;
      for (const candidate of candidates(raw)) report(line, forbiddenIndex(candidate));
      for (const word of camelPieces(raw)) {
        const part = SAME_LINE_PART_BY_HASH.get(hashOf(word));
        if (part) sameLineParts.set(part[0], (sameLineParts.get(part[0]) ?? new Set<number>()).add(part[1]));
        recent.push({ word, line });
        if (recent.length > MAX_WORDS) recent.shift();
        for (let size = 2; size <= recent.length; size += 1) {
          const sequence = recent.slice(-size);
          report(sequence[0]!.line, forbiddenIndex(sequence.map((entry) => entry.word).join(' ')));
        }
      }
    }
    for (const [termIndex, parts] of sameLineParts) if (parts.size === 2) report(line, termIndex);
  });
  return findings;
}

/**
 * O que fazer com um arquivo versionado. `buffer` é o conteúdo em disco (`null` se o item não é um arquivo comum no disco).
 * Tudo o que o scanner não consegue ler vira UNREADABLE (falha), salvo exceção explícita.
 */
function classify(entry: IndexEntry, buffer: Buffer | null): Verdict {
  const exception = UNREADABLE_EXCEPTIONS.get(entry.file);
  const unreadable = (reason: string): Verdict => (exception ? { kind: 'SKIP', reason: `exceção: ${exception}` } : { kind: 'UNREADABLE', reason });
  if (entry.mode === MODE_SYMLINK) return unreadable('link simbólico versionado');
  if (entry.mode === MODE_SUBMODULE) return unreadable('submódulo versionado');
  const extension = path.extname(entry.file).toLowerCase();
  if (UNREADABLE_EXTENSIONS.has(extension)) return unreadable(`arquivo ${extension} versionado (o guardião não lê PDF, documento, pacote nem imagem)`);
  if (buffer === null) return unreadable('item versionado que não é um arquivo comum no disco');
  const known = KNOWN_BINARIES.find((binary) => entry.file.startsWith(binary.prefix) && extension === binary.extension);
  if (known) return { kind: 'SKIP', reason: known.reason };
  if (buffer.includes(0)) return unreadable('binário versionado fora dos caminhos reconhecidos');
  try {
    return { kind: 'TEXT', text: UTF8.decode(buffer) };
  } catch {
    return unreadable('texto versionado que não é UTF-8 válido (o guardião não o lê)');
  }
}

/** Entradas do índice (`git ls-files -s -z`: `<modo> <objeto> <estágio>\t<caminho>`). */
function parseIndex(output: string): IndexEntry[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      return { mode: record.slice(0, record.indexOf(' ')), file: record.slice(tab + 1) };
    });
}

/** Arquivos versionados (relativos à raiz). Falha fechada: sem git ou fora de um repositório, a trava não passa. */
function listVersionedFiles(root: string): IndexEntry[] {
  let output: Buffer;
  try {
    output = execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], { maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new RepoGuardSetupError('A trava de dados de cliente precisa do `git` no PATH para listar os arquivos versionados (`git ls-files`); instale o git ou rode a partir de um checkout com git.');
    }
    throw new RepoGuardSetupError(`A trava de dados de cliente não conseguiu listar os arquivos versionados com \`git ls-files\` em ${root} (não é um repositório git?). Ela falha fechada: rode a partir de um checkout git.`);
  }
  const entries = parseIndex(output.toString('utf8')).filter((entry) => !entry.file.split('/').includes('node_modules'));
  if (entries.length === 0) throw new RepoGuardSetupError(`\`git ls-files\` não listou nenhum arquivo em ${root}; a trava falha fechada.`);
  return entries;
}

function scanRepository(root: string): { findings: Finding[]; unreadable: string[]; scanned: number } {
  const findings: Finding[] = [];
  const unreadable: string[] = [];
  let scanned = 0;
  for (const entry of listVersionedFiles(root)) {
    const full = path.join(root, entry.file);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    // Removido do disco mas ainda no índice (exclusão local não confirmada): o CI confere a árvore completa.
    if (stat === undefined && entry.mode !== MODE_SYMLINK && entry.mode !== MODE_SUBMODULE) continue;
    const buffer = stat?.isFile() ? fs.readFileSync(full) : null;
    const verdict = classify(entry, buffer);
    if (verdict.kind === 'UNREADABLE') unreadable.push(`${entry.file}: ${verdict.reason}`);
    if (verdict.kind !== 'TEXT') continue;
    scanned += 1;
    findings.push(...scanText(verdict.text, entry.file));
  }
  return { findings, unreadable, scanned };
}

/** Mensagem de falha: arquivo:linha e índice/tipo do termo; nunca o termo. */
function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line}: termo proibido #${finding.termIndex} (${FORBIDDEN[finding.termIndex]?.kind ?? '?'})`;
}

test('repositório: nenhum arquivo versionado contém dado real de cliente da lista proibida', () => {
  const { findings, unreadable, scanned } = scanRepository(ROOT);
  assert.ok(scanned > 100, `poucos arquivos de texto conferidos (${scanned}); a listagem parece incompleta`);
  assert.deepEqual(unreadable, [], 'arquivo versionado que o guardião não lê: remova-o do repositório ou registre uma exceção justificada em UNREADABLE_EXCEPTIONS');
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
const CLIENT_B = decode('RXN0w6l0aWNhIERhbmllbGUgQ2FyZG9zbw==');
const CLIENT_C = decode('RnVuZXLDoXJpYSBQYXogVW5pdmVyc2Fs');
const OTHER_PLACE = decode('Q2hJSmpZWUltV0NsWHBNUnZmdDJYV01uQ1Bj');
const PHONE = decode('KzU1IDE5IDk5ODM2LTExOTc=');
const LATITUDE = decode('LTIyLjM0NzE5NzE=');
const LONGITUDE = decode('LTQ2Ljk0NjMwNTI=');
const PRIVATE_PATH = decode('RDpcZ21uLWV2aWRlbmNpYXMtcHJpdmFkYXNcbGluay1hdWRpdA==');
const PROSPECT_D = decode('R295YXogQmFyYmVhcmlh');
const PROSPECT_E = decode('Q2zDrW5pY2EgZGUgRXN0w6l0aWNhIERyYS4gUmF5YW5lIEhhdmlsbGE=');
const PROSPECT_F = decode('RHJhLiBBbm5hIFZpdMOzcmlh');
const PROSPECT_F_PDF = decode('YXVkaXRvcmlhLWdtbi1kcmEtYW5uYS12aXQtcmlhLWRlbnRpc3RhLTg1OWI0MDIxLnBkZg==');
const PROSPECT_F_SITE = decode('aHR0cHM6Ly93d3cuZHJhYW5uYXZpdG9yaWEuY29tLmJyLw==');
const PROSPECT_G = decode('QmVsbyBSaXNv');
const CAMPAIGN = decode('Y2FtcGFuaGEgQW7DoXBvbGlzIC8gQ2zDrW5pY2EgT2RvbnRvbMOzZ2ljYQ==');

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
  assert.deepEqual(indexes(`Relatório da ${CLIENT_B} de 21/10/2026`), [6]);
  assert.deepEqual(indexes(`PDF: ${CLIENT_C.toUpperCase()} (16 unidades)`), [7]);
  assert.deepEqual(indexes(`listAuditsForLeadKeyword('${OTHER_PLACE}', 'x')`), [8]);
});

test('guardião: telefone em qualquer formatação (só dígitos), inclusive grudado em outros números', () => {
  const digits = PHONE.replace(/\D/g, '');
  const local = digits.slice(-9);
  for (const form of [PHONE, `(${digits.slice(2, 4)}) ${local.slice(0, 5)}-${local.slice(5)}`, `https://wa.me/${digits}`, digits, `${local.slice(0, 5)}-${local.slice(5)} (12 arquivos)`, `tel.: ${digits.slice(2, 4)}.${local.slice(0, 5)}.${local.slice(5)}`]) {
    assert.deepEqual(indexes(`telefone ${form}`), [9], 'telefone formatado');
  }
  assert.deepEqual(indexes(`telefone ${local.slice(0, 5)} e depois ${local.slice(5)}`), [], 'pedaços separados por texto não formam o número');
});

test('guardião: coordenadas com a precisão dos documentos, com ou sem sinal, ponto ou vírgula', () => {
  assert.deepEqual(indexes(`location: { latitude: ${LATITUDE}, longitude: ${LONGITUDE} }`), [10, 11]);
  assert.deepEqual(indexes(`lat ${LATITUDE.replace('-', '').replace('.', ',')}`), [10]);
  assert.deepEqual(indexes(`lon ${LONGITUDE}`), [11]);
  assert.deepEqual(indexes(`lat ${LATITUDE.slice(0, -2)}`), [], 'outra precisão não é o mesmo ponto');
});

test('guardião: caminho da pasta privada de evidências é acusado fora do .gitignore', () => {
  assert.deepEqual(indexes(`cd ${PRIVATE_PATH}`), [12]);
  assert.deepEqual(indexes(`base: '${PRIVATE_PATH.replace(/\\/g, '/').replace('D:', '/mnt/d')}'`), [12]);
  const rule = `/${PRIVATE_PATH.split('\\')[1]}/`;
  assert.deepEqual(indexes(rule, '.gitignore'), [], 'a regra do .gitignore fica');
  assert.deepEqual(indexes(rule, 'docs/x.md'), [12]);
  assert.deepEqual(indexes('a pasta <EVIDENCIAS_PRIVADAS> e as evidências privadas do responsável'), [], 'marcador e frase comum');
});

test('guardião: falha fechada para PDF, documento, pacote, imagem, link simbólico, submódulo e binário desconhecido', () => {
  const text = Buffer.from('texto');
  const binary = Buffer.from([0x50, 0x00, 0x01]);
  const kind = (mode: string, file: string, buffer: Buffer | null): string => classify({ mode, file }, buffer).kind;
  for (const file of ['docs/relatorio.pdf', 'docs/RELATORIO.PDF', 'docs/a.docx', 'docs/a.doc', 'docs/a.xlsx', 'docs/a.xls', 'docs/a.odt', 'docs/print.png', 'docs/pacote.zip']) {
    assert.equal(kind('100644', file, text), 'UNREADABLE', file);
  }
  assert.equal(kind(MODE_SYMLINK, 'docs/atalho.md', null), 'UNREADABLE', 'link simbólico');
  assert.equal(kind(MODE_SUBMODULE, 'vendor/x', null), 'UNREADABLE', 'submódulo');
  assert.equal(kind('100644', 'dados/x.bin', binary), 'UNREADABLE', 'binário de tipo desconhecido');
  assert.equal(kind('100644', 'docs/x.md', null), 'UNREADABLE', 'item que não é arquivo comum no disco');
  assert.equal(kind('100644', 'assets/fonts/Inter.woff', binary), 'SKIP', 'fonte no caminho reconhecido');
  assert.equal(kind('100644', 'tests/fixtures/tiles/1/2/3.pbf', binary), 'SKIP', 'tile vetorial no caminho reconhecido');
  assert.equal(kind('100644', 'docs/Inter.woff', binary), 'UNREADABLE', 'extensão reconhecida FORA do caminho permitido');
  assert.equal(kind('100644', 'tests/fixtures/x/1.pbf', binary), 'UNREADABLE', 'tile fora do caminho permitido');
  assert.equal(kind('100644', 'assets/fonts/Inter.woff2', binary), 'UNREADABLE', 'extensão não versionada hoje');
  assert.equal(kind('100644', 'assets/fonts/x.ttf', binary), 'UNREADABLE');
  assert.equal(kind('100644', 'docs/latin1.md', Buffer.from([0x61, 0xe7, 0xe3, 0x6f])), 'UNREADABLE', 'UTF-8 inválido sem NUL (Latin-1)');
  assert.equal(kind('100644', 'docs/truncado.md', Buffer.from([0x63, 0xc3])), 'UNREADABLE', 'sequência UTF-8 truncada');
  assert.equal(kind('100644', 'docs/utf8.md', Buffer.from('ação', 'utf8')), 'TEXT', 'UTF-8 válido com acento');
  assert.equal(kind('100644', 'docs/x.md', text), 'TEXT');
  assert.equal(kind('100755', 'scripts/x.sh', text), 'TEXT');
  assert.equal(UNREADABLE_EXCEPTIONS.size, 0, 'nenhuma exceção hoje; cada uma precisa de justificativa');
  assert.deepEqual(parseIndex(`100644 ${'a'.repeat(40)} 0\tdocs/a b.md\0${MODE_SYMLINK} ${'b'.repeat(40)} 0\tlink\0`), [{ mode: '100644', file: 'docs/a b.md' }, { mode: MODE_SYMLINK, file: 'link' }]);
});

test('guardião: clientes de prospecção das Fases 3–5 (nome, nome invertido, slug do PDF, site); palavras soltas livres', () => {
  assert.deepEqual(indexes(`| 4323da26 (${PROSPECT_D}) | 13.517 B |`), [13]);
  assert.deepEqual(indexes(`shortBusinessName('${PROSPECT_D.split(' ').reverse().join(' ')}')`), [14]);
  assert.deepEqual(indexes(`| 312ebf57 ${PROSPECT_E} | COMPLETED |`), [15]);
  assert.deepEqual(indexes(`auditoria-gmn-${stripAccents(PROSPECT_E).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-312ebf57.pdf`), [15]);
  assert.deepEqual(indexes(`A ${PROSPECT_F} seria bloqueada`), [16]);
  assert.deepEqual(indexes(`audits/859b4021…/${PROSPECT_F_PDF}`), [17]);
  assert.deepEqual(indexes(`URL final ${PROSPECT_F_SITE}`), [18]);
  assert.deepEqual(indexes(`**Lead:** *${PROSPECT_G}* (#16)`), [19]);
  for (const name of [PROSPECT_D, PROSPECT_E, PROSPECT_F, PROSPECT_G]) {
    for (const word of name.split(' ')) assert.deepEqual(scanText(`texto com ${word} solto`, 'docs/x.md'), [], 'palavra comum isolada');
  }
});

test('guardião: cidade + segmento da campanha na mesma linha, em qualquer ordem; cada palavra sozinha e linhas diferentes livres', () => {
  const words = stripAccents(CAMPAIGN).split(/[^A-Za-z]+/);
  const [city, , segment] = [words[1]!, words[2]!, words[3]!];
  assert.deepEqual(indexes(`- **Empresa:** (#16, ${CAMPAIGN} de 16/10/2026)`), [20]);
  assert.deepEqual(indexes(`auditoria real (${city.toUpperCase()}/GO, "Clínica ${segment}")`), [20]);
  assert.deepEqual(indexes(`${segment} em ${city}`), [20], 'ordem inversa');
  assert.deepEqual(indexes(`cidade: ${city}\nsegmento: ${segment}`), [], 'linhas diferentes');
  assert.deepEqual(indexes(`placeholder="Ex: ${city}"`), [], 'só a cidade');
  assert.deepEqual(indexes(`palavra-chave "Clínica ${segment}"`), [], 'só o segmento');
});

test('guardião: nomes de outros clientes só contam como par; cada palavra sozinha é livre', () => {
  const words = [...CLIENT_B.split(' '), ...CLIENT_C.split(' ')];
  for (const word of words) assert.deepEqual(scanText(`texto com ${word} solto`, 'docs/x.md'), [], 'palavra comum isolada');
  assert.deepEqual(indexes(words.join(' e ')), [], 'palavras separadas por outra palavra não formam o par');
});

test('guardião: aponta arquivo:linha e índice, nunca o termo; a exceção por arquivo vale só para o termo dela', () => {
  const findings = scanText(`linha 1\nlinha 2 ${NAME}\nlinha 3`, 'docs/exemplo.md');
  assert.deepEqual(findings, [{ file: 'docs/exemplo.md', line: 2, termIndex: 0 }]);
  const message = formatFinding(findings[0]!);
  assert.equal(message, 'docs/exemplo.md:2: termo proibido #0 (nome da empresa)');
  for (const term of [NAME, CID, FID_1, FID_2, PLACE, CITY, CLIENT_B, CLIENT_C, OTHER_PLACE, PHONE, LATITUDE, LONGITUDE, PRIVATE_PATH, PROSPECT_D, PROSPECT_E, PROSPECT_F, PROSPECT_G, CAMPAIGN]) assert.ok(!message.toLowerCase().includes(term.toLowerCase()));
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
