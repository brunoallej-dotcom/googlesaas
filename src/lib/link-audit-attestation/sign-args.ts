import path from 'node:path';
import { auditId as auditIdSchema, shortLabel } from './schemas';
import { isTrustKeyringText, SIGN_KEY_ID_PATTERN } from './sign-chain';
import { keyModeRefusal, MAX_SEAL_SEQ, type SignRefusal } from './sign-core';
import { bothForms, isInside, parseKeySource, type KeySource } from './sign-key';

/*
 * P1 W4.4 — os ARGUMENTOS do `sign` (spec §5.2 "analisador próprio e estrito", §5.5 sintaxe e tabela, passo 1; §8, §8.1; IA-15; RS-11). Antes de
 * qualquer outra análise, duas barreiras de higiene (passo 1): nenhuma opção com nome de segredo (senha, chave, PIN…) nem material de chave em
 * qualquer argumento ⇒ `SECRET_VIA_ARGV_FORBIDDEN`; nenhuma variável de ambiente com nome de segredo ⇒ `SECRET_VIA_ENV_FORBIDDEN` (só os NOMES são
 * olhados). Depois o analisador estrito: opção desconhecida, repetida ou sem valor, argumento posicional e formato inválido ⇒ USAGE (código 1).
 * Nenhuma mensagem ecoa o VALOR de uma opção (pode ser caminho, rótulo ou segredo colado por engano). W4.5: o analisador do `close-key`
 * (`parseCloseKeyArgs`), com as mesmas barreiras e as mesmas regras de `--key-id`, `--key-source` e `--trust-keys`.
 */

export interface SignArgs {
  readonly auditId: string;
  readonly packagePath: string;
  readonly approvalPath: string;
  readonly dossierPath: string;
  /** `--risk-acceptance` (opcional, W4.4): o arquivo do aceite formal de risco do passo 9; `null` se não indicado. */
  readonly riskAcceptancePath: string | null;
  readonly sealsDir: string;
  readonly expectSeq: number;
  readonly first: boolean;
  readonly keyId: string;
  readonly keySource: KeySource;
  readonly custodian: string;
  readonly trustKeys: string;
  readonly json: boolean;
  /** `--simulated` (W5.2b, spec §5.7): só para o pacote da coleta SIMULADA do ensaio; opção própria, nunca variável de ambiente. */
  readonly simulated: boolean;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['audit', 'package', 'approval', 'dossier', 'risk-acceptance', 'seals-dir', 'expect-seq', 'key-id', 'key-source', 'custodian', 'trust-keys']);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['first', 'json', 'simulated']);
const CLOSE_VALUE_FLAGS: ReadonlySet<string> = new Set(['retired-key-id', 'seals-dir', 'receipts-dir', 'key-id', 'key-source', 'custodian', 'trust-keys']);
const CLOSE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json']);
/** As únicas opções com "key" no nome que o `sign` e o `close-key` aceitam: nenhuma recebe segredo (rótulos públicos, caminho e lista de PÚBLICAS). */
const KEY_NAMED_FLAGS: ReadonlySet<string> = new Set(['key-id', 'key-source', 'trust-keys', 'retired-key-id']);
/** Nome de opção que sugere segredo (§8.1, IA-15). Mais largo de propósito: uma opção desconhecida com esse nome é recusa de segredo, não de uso. */
const SECRET_FLAG_NAME = /pass|senha|secret|segredo|pin|token|priv|chave|key|pwd|credential|credencia|seed|semente|mnemonic/i;
/** Material de chave reconhecível em QUALQUER argumento: armadura PEM, PKCS#8 Ed25519 em base64/base64url ou em hex. */
const KEY_MATERIAL: readonly RegExp[] = [/-----BEGIN/i, /PRIVATE KEY/i, /MC4CAQAwBQYDK2VwBCIEI/, /302e020100300506032b657004220420/i];
/**
 * §8.1: variável cujo nome case com um padrão FIXO ⇒ recusa. `GMN_*` com KEY/PASS/PIN/SECRET/TOKEN (inclusive a lista de públicas do servidor: a
 * estação do custodiante não tem ambiente do projeto), qualquer nome com PASSPHRASE/PASSWORD/PASSWD/SENHA e nomes do próprio fluxo (LINK_AUDIT,
 * SEAL, SIGN, ATTEST) com KEY/PASS/PIN/SECRET. Barreira de higiene, não prova de ausência.
 */
const SECRET_ENV_NAME: readonly RegExp[] = [
  /^GMN_.*(?:KEY|PASS|PIN|SECRET|TOKEN)/i,
  /PASSPHRASE|PASSWORD|PASSWD|SENHA/i,
  /^(?:LINK_AUDIT|SEAL|SIGN|ATTEST)\w*(?:KEY|PASS|PIN|SECRET)/i,
  // revisão da W4.4: nomes GENÉRICOS de segredo em qualquer posição (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, PRIVATE_KEY, SERVICE_API_KEY…)
  /SECRET|PRIVATE_?KEY|CREDENTIAL|API_?KEY|TOKEN/i,
];
/** Só nomes com cara de variável são citados na mensagem (para o custodiante limpar o ambiente); nunca valores. */
const ECHOABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ECHOED_ENV_NAMES = 3;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
/** Só o NOME da opção desconhecida é ecoado, e só se tiver a forma simples (como no `export`). */
const ECHOABLE_FLAG = /^--[a-z][a-z-]*$/;
const MAX_ECHOED_FLAG = 20;

const NOTHING = 'Nada foi lido, assinado nem gravado.';
const usage = (message: string): SignRefusal => ({ ok: false, code: 'USAGE', message });
const secretArgv = (message: string): SignRefusal => ({ ok: false, code: 'SECRET_VIA_ARGV_FORBIDDEN', message: `${message} ${NOTHING}` });

const ARGV_SECRET_NAME = secretArgv('Opção com nome de segredo (senha, frase, chave, PIN, token): segredo NUNCA por argumento (fica no histórico do shell e em /proc). A frase da chave é pedida só no terminal, sem eco; se um segredo foi digitado aqui, trate-o como exposto.');
const ARGV_KEY_MATERIAL = secretArgv('Um argumento parece conter material de chave privada (PEM ou PKCS#8): segredo NUNCA por argumento. Trate essa chave como exposta.');
const ARGV_KEY_SOURCE = secretArgv('--key-source aceita só file:<caminho> (chave PKCS#8 cifrada) ou external:<id> (id público: minúsculas, dígitos e "-", 4 a 32 caracteres); o valor recebido não é ecoado. Se ele era um segredo (frase, chave, PIN), trate-o como exposto (histórico do shell, /proc) e troque-o.');

/** Passo 1 (RS-11): opção com nome de segredo ou material de chave em qualquer argumento ⇒ recusa, antes de qualquer outra análise. */
export function secretArgvRefusal(tokens: readonly string[]): SignRefusal | null {
  for (const token of tokens) {
    if (KEY_MATERIAL.some((pattern) => pattern.test(token))) return ARGV_KEY_MATERIAL;
    if (!token.startsWith('--')) continue;
    const name = (token.slice(2).split('=')[0] ?? '').toLowerCase();
    if (!KEY_NAMED_FLAGS.has(name) && SECRET_FLAG_NAME.test(name)) return ARGV_SECRET_NAME;
  }
  return null;
}

/** §8.1 (IA-15): recebe só os NOMES das variáveis de ambiente; algum com nome de segredo ⇒ recusa, citando até 3 nomes (nunca valores). */
export function secretEnvRefusal(names: readonly string[]): SignRefusal | null {
  const found = names.filter((name) => SECRET_ENV_NAME.some((pattern) => pattern.test(name)));
  if (found.length === 0) return null;
  const shown = found.filter((name) => ECHOABLE_ENV_NAME.test(name)).slice(0, MAX_ECHOED_ENV_NAMES);
  const list = shown.length > 0 ? ` (${shown.join(', ')}${found.length > shown.length ? ', …' : ''})` : '';
  return {
    ok: false,
    code: 'SECRET_VIA_ENV_FORBIDDEN',
    message: `Há variável de ambiente com nome de segredo${list}: o sign recusa rodar com ela (§8.1). Abra um shell limpo (ou remova-a com unset) e rode de novo; segredo nunca por ambiente. ${NOTHING}`,
  };
}

function unknownFlag(token: string): SignRefusal {
  const flag = token.split('=')[0] ?? '';
  return usage(ECHOABLE_FLAG.test(flag) ? `Opção desconhecida: ${flag.slice(0, MAX_ECHOED_FLAG)}` : 'Opção desconhecida.');
}

/** Tokens → valores e sinalizadores, sem validar o conteúdo (flag desconhecida, repetida ou sem valor ⇒ USAGE). */
function tokenize(tokens: readonly string[], valueFlags: ReadonlySet<string> = VALUE_FLAGS, booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS): { readonly values: ReadonlyMap<string, string>; readonly flags: ReadonlySet<string> } | SignRefusal {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (!token.startsWith('--')) return usage(`Argumento inesperado na posição ${index + 2} (as opções começam com --).`);
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      if (flags.has(name)) return usage(`Opção repetida: --${name}.`);
      flags.add(name);
      continue;
    }
    if (!valueFlags.has(name)) return unknownFlag(token);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) return usage(`A opção --${name} exige um valor.`);
    if (values.has(name)) return usage(`Opção repetida: --${name}.`);
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

const isPath = (value: string | undefined): value is string => value !== undefined && value.length > 0 && !value.includes('\0');

/** Caminhos obrigatórios (e o opcional do aceite de risco). */
function pathArgs(values: ReadonlyMap<string, string>): Pick<SignArgs, 'packagePath' | 'approvalPath' | 'dossierPath' | 'riskAcceptancePath' | 'sealsDir'> | SignRefusal {
  const [packagePath, approvalPath, dossierPath, sealsDir] = ['package', 'approval', 'dossier', 'seals-dir'].map((name) => values.get(name));
  if (!isPath(packagePath)) return usage('Informe --package <pacote.json> (o pacote que o conferente recebeu).');
  if (!isPath(approvalPath)) return usage('Informe --approval <approval.json>.');
  if (!isPath(dossierPath)) return usage('Informe --dossier <arquivo> (o dossiê de aprovação congelado).');
  if (!isPath(sealsDir)) return usage('Informe --seals-dir <pasta de manifestos da estação>.');
  const risk = values.get('risk-acceptance');
  if (risk !== undefined && !isPath(risk)) return usage('--risk-acceptance inválido (caminho do arquivo do aceite formal de risco).');
  return { packagePath, approvalPath, dossierPath, riskAcceptancePath: risk ?? null, sealsDir };
}

/** `--expect-seq` (1 a 256, do registro externo) e `--first` (só com 1; o "se" com a pasta vazia é recusa da cadeia, §7.1). */
function seqArgs(values: ReadonlyMap<string, string>, flags: ReadonlySet<string>): Pick<SignArgs, 'expectSeq' | 'first'> | SignRefusal {
  const raw = values.get('expect-seq');
  if (raw === undefined) return usage('Informe --expect-seq <N> (o seq esperado, tirado do registro externo do dossiê/cofre, nunca da pasta).');
  const expectSeq = POSITIVE_INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!(expectSeq >= 1 && expectSeq <= MAX_SEAL_SEQ)) return usage(`--expect-seq deve ser um inteiro de 1 a ${MAX_SEAL_SEQ}.`);
  const first = flags.has('first');
  if (first && expectSeq !== 1) return usage('--first só vale com --expect-seq 1 (primeiro manifesto da auditoria).');
  return { expectSeq, first };
}

/** `--key-id`, `--key-source`, `--trust-keys`: formatos; `--key-source` fora de `file:`/`external:` é recusa de SEGREDO (pode ser o material). */
function keyArgs(values: ReadonlyMap<string, string>): Pick<SignArgs, 'keyId' | 'keySource' | 'trustKeys'> | SignRefusal {
  const keyId = values.get('key-id');
  if (keyId === undefined || !SIGN_KEY_ID_PATTERN.test(keyId)) return usage('Informe --key-id válido (minúsculas, dígitos e "-", 4 a 32 caracteres, começando por letra ou dígito).');
  const rawSource = values.get('key-source');
  if (rawSource === undefined) return usage('Informe --key-source file:<caminho> (chave PKCS#8 cifrada; a frase é pedida no terminal).');
  const keySource = parseKeySource(rawSource);
  if (keySource === 'BAD_FILE_PATH') return usage('--key-source file:<caminho> exige um caminho.');
  // revisão da W4.4: `external:` só com id público estrito (o mesmo padrão do `--key-id`); qualquer outro sufixo pode ser segredo colado
  if (keySource === null || (keySource.kind === 'external' && !SIGN_KEY_ID_PATTERN.test(keySource.id))) return ARGV_KEY_SOURCE;
  const trustKeys = values.get('trust-keys');
  if (trustKeys === undefined || !isTrustKeyringText(trustKeys)) return usage('Informe --trust-keys com a lista de chaves PÚBLICAS com estado (<id>:<pública base64url>[:active|:retired[:<hash>]|:revoked], separadas por vírgula).');
  return { keyId, keySource, trustKeys };
}

/** Analisador ESTRITO do `sign` (depois das barreiras de segredo): devolve os argumentos ou a recusa (USAGE ou segredo em `--key-source`). */
export function parseSignArgs(tokens: readonly string[]): SignArgs | SignRefusal {
  const parsed = tokenize(tokens);
  if ('ok' in parsed) return parsed;
  const { values, flags } = parsed;
  const auditId = values.get('audit');
  if (auditId === undefined || !auditIdSchema.safeParse(auditId).success) return usage('Informe --audit <auditId> válido (8 a 64 caracteres: minúsculas, números, _ e -).');
  const paths = pathArgs(values);
  if ('ok' in paths) return paths;
  const seq = seqArgs(values, flags);
  if ('ok' in seq) return seq;
  const key = keyArgs(values);
  if ('ok' in key) return key;
  const custodian = values.get('custodian');
  if (custodian === undefined || !shortLabel.safeParse(custodian).success) return usage('Informe --custodian <rótulo curto> (iniciais ou ID; sem e-mail nem telefone).');
  // W5.2b (revisão do PR #62): o modo da chave confere com --simulated ANTES de qualquer leitura (chave `ensaio-…` ⇔ --simulated)
  const keyMode = keyModeRefusal(key.keyId, flags.has('simulated'));
  if (keyMode) return keyMode;
  return { auditId, ...paths, ...seq, ...key, custodian, json: flags.has('json'), simulated: flags.has('simulated') };
}

/* ------------------------------------------------------------------------------------------------------------------- close-key (W4.5) */

export interface CloseKeyArgs {
  readonly retiredKeyId: string;
  readonly sealsDir: string;
  readonly receiptsDir: string;
  readonly keyId: string;
  readonly keySource: KeySource;
  readonly custodian: string;
  readonly trustKeys: string;
  readonly json: boolean;
}

/**
 * Analisador ESTRITO do `close-key` (depois das MESMAS barreiras de segredo do `sign`): `--retired-key-id` (R) e `--key-id` (S) no padrão de id de
 * chave e diferentes (uma chave nunca fecha a si mesma), `--seals-dir`, `--receipts-dir`, `--key-source file:`, `--custodian` e `--trust-keys` como
 * no `sign`. Devolve os argumentos ou a recusa (USAGE, ou segredo em `--key-source`).
 */
export function parseCloseKeyArgs(tokens: readonly string[]): CloseKeyArgs | SignRefusal {
  const parsed = tokenize(tokens, CLOSE_VALUE_FLAGS, CLOSE_BOOLEAN_FLAGS);
  if ('ok' in parsed) return parsed;
  const { values, flags } = parsed;
  const retiredKeyId = values.get('retired-key-id');
  if (retiredKeyId === undefined || !SIGN_KEY_ID_PATTERN.test(retiredKeyId)) return usage('Informe --retired-key-id válido (o id da chave a aposentar: minúsculas, dígitos e "-", 4 a 32 caracteres).');
  const [sealsDir, receiptsDir] = ['seals-dir', 'receipts-dir'].map((name) => values.get(name));
  if (!isPath(sealsDir)) return usage('Informe --seals-dir <pasta de manifestos da estação> (a cópia do servidor).');
  if (!isPath(receiptsDir)) return usage('Informe --receipts-dir <pasta de recibos> (o registro externo das assinaturas).');
  const key = keyArgs(values);
  if ('ok' in key) return key;
  if (key.keyId === retiredKeyId) return usage('--key-id igual a --retired-key-id: uma chave nunca fecha a si mesma; o fecho é assinado por uma chave ATIVA diferente.');
  const custodian = values.get('custodian');
  if (custodian === undefined || !shortLabel.safeParse(custodian).success) return usage('Informe --custodian <rótulo curto> (iniciais ou ID; sem e-mail nem telefone).');
  return { retiredKeyId, sealsDir, receiptsDir, ...key, custodian, json: flags.has('json') };
}

/* ------------------------------------------------------------------------------------------------------------------- runtime do Node (W4.5, T-008) */

/**
 * Revisão da W4.5 (MAJOR; modelo de ameaças T-008): opções do NODE que despejam a memória (onde estará a frase da chave) ou abrem um depurador
 * (`--heapsnapshot-signal`, `--heapsnapshot-near-heap-limit`, `--heap-prof`, `--cpu-prof`, `--diagnostic-dir`, `--report-*`, `--inspect*`, pré-carga
 * extra por `--require`/`--import`, `--expose-gc`, `--env-file`…) chegam por `NODE_OPTIONS` ou por `process.execArgv`. Lista PERMITIDA explícita;
 * tudo o mais é recusa:
 *  - o carregador do `npm run link-audit:seal` (conferido num processo real: o `tsx` põe EXATAMENTE `--require <…>/tsx/dist/preflight.cjs --import
 *    file://<…>/tsx/dist/loader.mjs` em `execArgv`, e nada em `NODE_OPTIONS`), uma vez, nesta ordem, com os dois arquivos sendo, pelo caminho
 *    real, os do `node_modules` do PRÓPRIO projeto;
 *  - o modelo de permissões do artefato único da W4.6 (`node --permission --allow-fs-read=… artefato.js`): `--permission` (ou o antigo
 *    `--experimental-permission`), `--allow-fs-read=<…>`, `--allow-fs-write=<…>` (só na forma com `=`) e `--disable-sigusr1` (que só restringe).
 * O ambiente é olhado só pelos NOMES (como a barreira do §8.1): `NODE_OPTIONS` (mesmo vazio) e qualquer outro `NODE_*` (NODE_DEBUG, NODE_V8_COVERAGE,
 * NODE_PATH…) são recusa; `NODE_ENV` não muda nada no comando e passa. Inspector: sem importar `node:inspector` (fora da lista RS-14), ele só liga
 * na partida por essas opções; `process.debugPort` existe sempre (9229) e não indica nada. Limite declarado: outro processo do MESMO usuário pode
 * ligá-lo depois (SIGUSR1) ou ler a memória (`/proc/<pid>/mem`); isso está fora da garantia (estação dedicada, W5).
 *
 * W4.6 (confirmação da revisão da W4.5, critério ii): uma pré-carga roda ANTES do comando e pode limpar `process.env` e `process.execArgv`. A barreira
 * confere também o bloco ORIGINAL do exec (`/proc/self/cmdline` e `/proc/self/environ`), que isso não altera: na linha original, só as opções do node
 * ANTES do script (o script e os argumentos do comando nunca são decodificados), com a mesma lista permitida; no ambiente original, só os NOMES
 * (nenhum valor é decodificado), com as regras do §8.1 e do `NODE_*`. Bloco ilegível ⇒ recusa (falha fechada). No ARTEFATO ÚNICO, além disso: sem o
 * carregador do `tsx`; `--permission` (ou `--experimental-permission`) e `--disable-sigusr1` obrigatórios em `execArgv` e na linha original; ambiente
 * VAZIO (`env -i`) no original e em `process.env`. Limite declarado: código que roda antes da barreira (pré-carga, `LD_PRELOAD`) pode até reescrever a
 * memória do processo; a barreira pega a configuração que ficou no bloco do exec, não uma estação comprometida (W5).
 */

/** O bloco original do exec (Linux: `/proc/self/cmdline` e `/proc/self/environ`, registros terminados por NUL); estrutural, sem disco aqui. */
export interface ExecBlockReader {
  cmdline(): Promise<Uint8Array>;
  environ(): Promise<Uint8Array>;
}

export interface RuntimeFacts {
  /** `process.execArgv` (injetável). */
  readonly execArgv: readonly string[];
  /** Os NOMES do ambiente (nunca os valores). */
  readonly envNames: readonly string[];
  /** A raiz do projeto: o carregador aceito é o do `node_modules` dela. */
  readonly projectRoot: string;
  /** Caminho real (só metadados; o da custódia da chave, `KeyFileOps.realpath`). */
  readonly realpath: (target: string) => Promise<string>;
  /** W4.6: o bloco ORIGINAL do exec (padrão do CLI: `/proc/self`, `sign-runtime.ts`). */
  readonly execBlock: ExecBlockReader;
  /** W4.6: rodando como o ARTEFATO ÚNICO (sem carregador; modelo de permissões, `--disable-sigusr1` e ambiente vazio obrigatórios). */
  readonly artifact: boolean;
}

const PERMISSION_FLAGS: ReadonlySet<string> = new Set(['--permission', '--experimental-permission', '--disable-sigusr1']);
/** W4.6: o artefato exige o modelo de permissões (um dos dois nomes) e o inspector desligado para SIGUSR1. */
const PERMISSION_MODEL_FLAGS: ReadonlySet<string> = new Set(['--permission', '--experimental-permission']);
const DISABLE_SIGUSR1 = '--disable-sigusr1';
/** As duas opções do par do carregador. Por expressão (`r[e]quire`): a guarda textual de carregamento dinâmico do teste de isolamento recusa a palavra solta. */
const PRELOAD_CJS = /^--r[e]quire$/;
const PRELOAD_ESM = /^--import$/;
const PERMISSION_PATHS = /^--allow-fs-(?:read|write)=.+$/;
const NODE_ENV_NAME = /^NODE_/;
const HARMLESS_NODE_ENV: ReadonlySet<string> = new Set(['NODE_ENV']);
const FILE_URL_PREFIX = 'file://';
const RUNTIME_NOTHING = 'Nada foi lido, assinado nem gravado.';
const runtimeUnsafe = (why: string): SignRefusal => ({
  ok: false,
  code: 'SIGN_RUNTIME_UNSAFE',
  message: `${why}: elas podem despejar a memória do processo (onde estaria a frase da chave) ou abrir um depurador (T-008). Rode o comando num shell limpo, pelo npm run link-audit:seal (ou pelo artefato da W4.6), sem NODE_OPTIONS e sem opções extras do node. ${RUNTIME_NOTHING}`,
});
const EXEC_ARGV_UNSAFE = runtimeUnsafe('O Node foi iniciado com opções além do carregador do projeto e do modelo de permissões (diagnóstico, depuração, perfil ou pré-carga); os valores não são ecoados');
const ARTIFACT_LINE = 'rode o artefato pela linha fixada no runbook: env -i <node por caminho absoluto> --disable-sigusr1 --permission --allow-fs-read=… --allow-fs-write=… <artefato> <subcomando>';
const EXEC_BLOCK_UNREADABLE: SignRefusal = {
  ok: false,
  code: 'SIGN_RUNTIME_UNSAFE',
  message: `Não foi possível ler o bloco ORIGINAL do exec (/proc/self/cmdline e /proc/self/environ): sem ele a barreira do runtime não é provada (sistema sem /proc, fora do Linux, ou sob --permission sem --allow-fs-read para esses dois arquivos). ${RUNTIME_NOTHING}`,
};
const ARTIFACT_NO_PERMISSION: SignRefusal = {
  ok: false,
  code: 'SIGN_RUNTIME_UNSAFE',
  message: `O artefato único só roda sob o modelo de permissões do Node (--permission, com --allow-fs-read/--allow-fs-write estreitos) e com --disable-sigusr1, nas opções do node e na linha original do exec: ${ARTIFACT_LINE}. ${RUNTIME_NOTHING}`,
};
const artifactEnvNotEmpty = (names: readonly string[]): SignRefusal => {
  const shown = names.filter((name) => ECHOABLE_ENV_NAME.test(name)).slice(0, MAX_ECHOED_ENV_NAMES);
  const list = shown.length > 0 ? ` (${shown.join(', ')}${names.length > shown.length ? ', …' : ''}; só os nomes são lidos)` : '';
  return { ok: false, code: 'SIGN_RUNTIME_UNSAFE', message: `O artefato único só roda com o ambiente VAZIO (env -i); há variáveis no ambiente${list}: ${ARTIFACT_LINE}. ${RUNTIME_NOTHING}` };
};

/** Caminho de uma URL `file://` absoluta, sem `node:url` (fora da lista RS-14); outra forma ⇒ `null`. */
function fileUrlPath(url: string): string | null {
  if (!url.startsWith(FILE_URL_PREFIX)) return null;
  try {
    const decoded = decodeURIComponent(url.slice(FILE_URL_PREFIX.length));
    return decoded.startsWith('/') && !decoded.includes('\0') ? decoded : null;
  } catch {
    return null;
  }
}

/** O par do carregador do `tsx` aponta, pelo caminho REAL, para os arquivos do `node_modules` do PRÓPRIO projeto. Qualquer falha ⇒ `false`. */
async function isProjectLoader(preflight: string | undefined, loaderUrl: string | undefined, facts: RuntimeFacts): Promise<boolean> {
  const loader = loaderUrl === undefined ? null : fileUrlPath(loaderUrl);
  if (preflight === undefined || loader === null || !preflight.startsWith('/')) return false;
  const dist = `${facts.projectRoot.replace(/\/+$/, '')}/node_modules/tsx/dist`;
  try {
    const [given, expected, givenLoader, expectedLoader] = await Promise.all([facts.realpath(preflight), facts.realpath(`${dist}/preflight.cjs`), facts.realpath(loader), facts.realpath(`${dist}/loader.mjs`)]);
    return given === expected && givenLoader === expectedLoader;
  } catch {
    return false;
  }
}

/** Opções do node (as de `execArgv` ou as da linha original) só com a lista permitida (cabeçalho acima); no artefato, sem o carregador. */
async function execArgvAllowed(tokens: readonly string[], facts: RuntimeFacts): Promise<boolean> {
  let loaderSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (PERMISSION_FLAGS.has(token) || PERMISSION_PATHS.test(token)) continue;
    if (facts.artifact || !PRELOAD_CJS.test(token) || loaderSeen || !PRELOAD_ESM.test(tokens[index + 2] ?? '')) return false;
    if (!(await isProjectLoader(tokens[index + 1], tokens[index + 3], facts))) return false;
    loaderSeen = true;
    index += 3;
  }
  return true;
}

/** `NODE_*` (salvo `NODE_ENV`) entre os nomes ⇒ recusa citando até 3 nomes. */
function nodeEnvRefusal(names: readonly string[], where: string): SignRefusal | null {
  const nodeNames = names.filter((name) => NODE_ENV_NAME.test(name) && !HARMLESS_NODE_ENV.has(name));
  if (nodeNames.length === 0) return null;
  const shown = nodeNames.filter((name) => ECHOABLE_ENV_NAME.test(name)).slice(0, MAX_ECHOED_ENV_NAMES);
  return runtimeUnsafe(`Há configuração do Node no ambiente${where} (${shown.join(', ')}${nodeNames.length > shown.length ? ', …' : ''}; só os nomes são lidos)`);
}

const NUL_BYTE = 0;
const EQUALS_BYTE = 0x3d;
const DASH_BYTE = 0x2d;
const LATIN1 = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8');

/** Os registros (subarrays, sem copiar nem decodificar) de um bloco terminado por NUL; um último registro sem NUL também conta. */
function nulRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== NUL_BYTE) continue;
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

/** Só os NOMES do ambiente original: os bytes antes do primeiro `=` de cada registro (o registro inteiro, se não houver `=`). Valores nunca. */
export function environNames(bytes: Uint8Array): string[] {
  return nulRecords(bytes)
    .filter((record) => record.length > 0)
    .map((record) => {
      const equals = record.indexOf(EQUALS_BYTE);
      return LATIN1.decode(equals < 0 ? record : record.subarray(0, equals));
    });
}

/**
 * As opções do node na linha ORIGINAL: os registros depois do programa e ANTES do script (o primeiro registro que não começa com `-`). O script e
 * os argumentos do comando nunca são decodificados. Os valores do par do carregador (`--require <arquivo>`, `--import <url>`) vão junto para a
 * conferência; qualquer outra opção com valor separado é recusada pela lista permitida. `null` = bloco vazio ou sem o nome do programa.
 */
export function cmdlineNodeOptions(bytes: Uint8Array): string[] | null {
  const records = nulRecords(bytes);
  if (records.length === 0 || (records[0] as Uint8Array).length === 0) return null;
  const options: string[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] as Uint8Array;
    if (record[0] !== DASH_BYTE) break;
    const token = UTF8.decode(record);
    options.push(token);
    const value = records[index + 1];
    if ((PRELOAD_CJS.test(token) || PRELOAD_ESM.test(token)) && value !== undefined) {
      options.push(UTF8.decode(value));
      index += 1;
    }
  }
  return options;
}

/** O bloco original lido e interpretado: opções do node antes do script e nomes do ambiente; qualquer falha ⇒ `null` (recusa fechada). */
async function originalExec(reader: ExecBlockReader): Promise<{ readonly options: readonly string[]; readonly envNames: readonly string[] } | null> {
  try {
    const [cmdline, environ] = await Promise.all([reader.cmdline(), reader.environ()]);
    const options = cmdline instanceof Uint8Array && environ instanceof Uint8Array ? cmdlineNodeOptions(cmdline) : null;
    return options === null ? null : { options, envNames: environNames(environ) };
  } catch {
    return null;
  }
}

/** No artefato, o modelo de permissões e `--disable-sigusr1` estão nas opções (de `execArgv` ou da linha original). */
const hasArtifactFlags = (tokens: readonly string[]): boolean => tokens.some((token) => PERMISSION_MODEL_FLAGS.has(token)) && tokens.includes(DISABLE_SIGUSR1);

/** O bloco original (W4.6): ambiente original (§8.1, `NODE_*`), opções da linha original e, no artefato, linha e ambiente do runbook. */
async function originalExecRefusal(facts: RuntimeFacts): Promise<SignRefusal | null> {
  const original = await originalExec(facts.execBlock);
  if (original === null) return EXEC_BLOCK_UNREADABLE;
  const envRefusal = secretEnvRefusal(original.envNames) ?? nodeEnvRefusal(original.envNames, ' ORIGINAL do processo (/proc/self/environ)');
  if (envRefusal) return envRefusal;
  if (!(await execArgvAllowed(original.options, facts))) return EXEC_ARGV_UNSAFE;
  if (!facts.artifact) return null;
  if (!hasArtifactFlags(facts.execArgv) || !hasArtifactFlags(original.options)) return ARTIFACT_NO_PERMISSION;
  const names = [...new Set([...original.envNames, ...facts.envNames])];
  return names.length > 0 ? artifactEnvNotEmpty(names) : null;
}

/* ------------------------------------------------------------------------------------------------------------------- grants do artefato (W4.6) */

const GRANT = /^--allow-fs-(read|write)=(.*)$/;
const CLOSURES_SUBDIR = '_closures';
/** Revisão independente da W4.6 (3): leituras rasas (`/home`, `/etc`, `/usr`…) dão a subárvore inteira; só estas são aceitas com um componente. */
const SHALLOW_READS_ALLOWED: ReadonlySet<string> = new Set(['/tmp']);
const MIN_READ_DEPTH = 2;
const GIT_NAME = '.git';
const grantsRefusal = (why: string): SignRefusal => ({
  ok: false,
  code: 'SIGN_RUNTIME_UNSAFE',
  message: `O artefato único só aceita grants estreitos do modelo de permissões: ${why}. Rode pela linha fixada no runbook. ${RUNTIME_NOTHING}`,
});
const GRANT_SHAPE = grantsRefusal('cada --allow-fs-read/--allow-fs-write é um caminho absoluto, normalizado, sem vírgula, diferente de / e sem * (única exceção: --allow-fs-read=/ como o único grant de leitura do close-key)');
const GRANT_ROOT_NOT_ALONE = grantsRefusal('no close-key, --allow-fs-read=/ só vale como o ÚNICO grant de leitura (o / é prefixo de texto de qualquer outro caminho, e o Node nega o grant mais curto)');
const GRANT_WRITE_OUTSIDE = grantsRefusal('--allow-fs-write só na raiz real de --seals-dir ou dentro dela (no close-key, só em <seals-dir>/_closures)');
const GRANT_CLOSURES_ABSENT = grantsRefusal('no close-key, <seals-dir>/_closures tem de existir antes da execução (mkdir -p da linha do runbook): o Node só concede a subárvore de uma pasta que já existe, e o fecho não poderia ser gravado nela');
const GRANT_WRITE_ABSENT = grantsRefusal('cada --allow-fs-write tem de existir antes da execução (no sign, conceda a raiz de --seals-dir, como na linha do runbook): o Node só concede a subárvore de uma pasta que já existe, e o manifesto não poderia ser gravado nela');
const GRANT_READ_SHALLOW = grantsRefusal('leitura com pelo menos dois componentes (/a/b), salvo /tmp e os .git que a custódia da chave consulta');
const GRANT_ROOT_UNPROVEN = grantsRefusal('o caminho real de --seals-dir não pôde ser resolvido para conferir os grants de escrita');
const GRANT_NOT_REAL = grantsRefusal('cada caminho concedido tem de existir e ser o próprio caminho real (nenhum componente é link simbólico), salvo /proc/self/*, as raízes temporárias e os .git da custódia, que podem não existir');
/**
 * Confirmação da revisão da W4.6 (3): caminhos concedidos LITERALMENTE, sem conferir o caminho real. `/proc/self/*` são links do próprio kernel (o
 * Node confere o texto do caminho); `/tmp`, `/var/tmp` e `/dev/shm` são as raízes que a custódia resolve (podem faltar ou ser link numa
 * distribuição), concedidas só para leitura.
 */
const LITERAL_READ_GRANTS: ReadonlySet<string> = new Set(['/proc/self/cmdline', '/proc/self/environ', '/proc/self/fd', '/tmp', '/var/tmp', '/dev/shm']);
const ABSENT = 'ENOENT';
const PERMISSION_DENIED = 'ERR_ACCESS_DENIED';
const SEALS_IN_TEMP = grantsRefusal('a pasta de manifestos (--seals-dir) e os grants de escrita nunca ficam numa pasta temporária (/tmp, /var/tmp, /dev/shm ou TMPDIR/TMP/TEMP), nem dentro dela nem contendo uma, pelo caminho dado ou real');
const TEMP_ROOTS_UNPROVEN = grantsRefusal('o caminho real das pastas temporárias não pôde ser resolvido (a linha do runbook concede leitura a /tmp, /var/tmp e /dev/shm)');
const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);
const errnoOf = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined);

/** Portas de disco da conferência dos grants (injetáveis nos testes): `realpath` e `lstat` (metadados, sem seguir link). */
interface GrantFs {
  readonly realpath: (target: string) => Promise<string>;
  readonly lstat: (target: string) => Promise<unknown>;
}

/**
 * Revisão do PR #59 (wk2): o `.git` da custódia só conta como AUSENTE se o `lstat` dele também der ENOENT. O `realpath` de um link simbólico
 * PENDENTE dá ENOENT como se nada existisse; o `lstat` mostra o link, e ele é recusado aqui (a custódia da chave o recusaria só depois de ler as
 * entradas e da confirmação). Sob `--permission`, o `lstat` do próprio caminho concedido é permitido.
 */
async function gitTrulyAbsent(target: string, lstat: GrantFs['lstat']): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    return errnoOf(error) === ABSENT;
  }
}

/**
 * O grant é o próprio caminho real? Existe e `realpath` devolve o mesmo texto (nenhum componente é link). Caminho que não existe só passa (falha
 * fechada para todo o resto): na leitura, um `.git` da custódia (ela consulta a AUSÊNCIA) que nem como link pendente existe (`gitTrulyAbsent`); na
 * escrita, um caminho cuja pasta existente mais próxima acima seja o próprio caminho real (`ABSENT_WRITE`), que `artifactGrantsRefusal` recusa
 * depois, nos dois subcomandos (W5.2a).
 */
type RealCheck = 'LITERAL' | 'VERIFIED' | 'ABSENT_GIT' | 'ABSENT_WRITE' | 'NOT_REAL';
async function isOwnRealPath(grant: { readonly kind: 'read' | 'write'; readonly value: string }, { realpath, lstat }: GrantFs): Promise<RealCheck> {
  if (grant.kind === 'read' && LITERAL_READ_GRANTS.has(grant.value)) return 'LITERAL';
  try {
    return (await realpath(grant.value)) === grant.value ? 'VERIFIED' : 'NOT_REAL';
  } catch (error) {
    if (errnoOf(error) !== ABSENT) return 'NOT_REAL';
    if (grant.kind === 'read') return path.basename(grant.value) === GIT_NAME && (await gitTrulyAbsent(grant.value, lstat)) ? 'ABSENT_GIT' : 'NOT_REAL';
  }
  for (let dir = path.dirname(grant.value); ; dir = path.dirname(dir)) {
    try {
      return (await realpath(dir)) === dir ? 'ABSENT_WRITE' : 'NOT_REAL';
    } catch (error) {
      if (errnoOf(error) !== ABSENT || path.dirname(dir) === dir) return 'NOT_REAL';
    }
  }
}

/**
 * Segunda confirmação da revisão da W4.6 (b): o pai de um `.git` AUSENTE tem de existir e ser o próprio caminho real. Prova direta: `realpath(pai)
 * = pai`. Sob `--permission`, o pai (uma pasta acima da chave, como `/home` ou `/`) não é concedido e a leitura dele é negada; aí a prova é ele ser
 * a própria pasta ou uma pasta acima de um grant já conferido como o próprio caminho real e existente (se esse grant não tem nenhum componente que
 * seja link, as pastas acima dele também não têm, e existem). Qualquer outra falha (pai inexistente, link, erro) ⇒ recusa.
 */
async function hasRealParent(git: string, verified: readonly string[], realpath: (target: string) => Promise<string>): Promise<boolean> {
  const parent = path.dirname(git);
  try {
    return (await realpath(parent)) === parent;
  } catch (error) {
    return errnoOf(error) === PERMISSION_DENIED && verified.some((real) => isInside(real, parent));
  }
}

/** Um grant aceitável na forma: absoluto, normalizado (sem `..`, sem barra final), sem vírgula (lista) e sem `*` (curinga), diferente de `/`. */
const isNarrowPath = (value: string): boolean => value.length > 1 && path.isAbsolute(value) && path.resolve(value) === value && !/[,*\0]/.test(value);
const depthOf = (value: string): number => value.split('/').filter(Boolean).length;
const FS_ROOT = '/';
type Grant = { readonly kind: 'read' | 'write'; readonly value: string };
const isRootRead = (grant: Grant): boolean => grant.kind === 'read' && grant.value === FS_ROOT;

/**
 * Forma dos grants. W5.2a (decisão do manager sob a D15, linha do `close-key` no runbook): `--allow-fs-read=/` é aceito SÓ no `close-key` e SÓ como o
 * único grant de leitura (o mesmo texto repetido, como em `execArgv` e na linha original, conta como um). A conferência das pastas ACIMA dos recibos
 * e da cópia do servidor faz `lstat` até `/`, e o Node concede a subárvore inteira de um grant; `/` é prefixo de texto de qualquer outro caminho, e o
 * Node nega o grant mais curto quando um é prefixo de outro, por isso nada mais de leitura. `/` como escrita, `/` no `sign` ou `*` ⇒ recusa de forma.
 */
function grantsShapeRefusal(subcommand: 'sign' | 'close-key', grants: readonly Grant[]): SignRefusal | null {
  const reads = new Set(grants.filter((grant) => grant.kind === 'read').map((grant) => grant.value));
  const rootAlone = subcommand === 'close-key' && reads.size === 1 && reads.has(FS_ROOT);
  const malformed = grants.filter((grant) => !isNarrowPath(grant.value) && !(rootAlone && isRootRead(grant)));
  if (malformed.length === 0) return null;
  return subcommand === 'close-key' && malformed.every(isRootRead) ? GRANT_ROOT_NOT_ALONE : GRANT_SHAPE;
}

/**
 * Revisão independente da W4.6 (3), só no ARTEFATO, depois do analisador: os grants de `execArgv` E da linha original do exec. Critério simples que
 * falha fechado: forma estreita (`grantsShapeRefusal`; no `close-key`, `/` como único grant de leitura, W5.2a); cada grant é o próprio caminho real
 * (`isOwnRealPath`, confirmação da revisão); escrita só na raiz REAL de `--seals-dir` ou dentro dela (`close-key`: só `_closures`), e todo grant de
 * escrita tem de EXISTIR (W5.2a, decisão do manager, nos dois subcomandos): para um caminho inexistente o Node concede só o próprio caminho, não a
 * subárvore, e o manifesto ou o fecho não seria gravado dentro dele (a recusa viria tarde, depois da confirmação e da frase); leitura no `sign`
 * com pelo menos dois componentes, salvo `/tmp` (raiz temporária da custódia) e caminhos que terminam em `.git` (os `lstat` da custódia da chave).
 * Limite declarado (W5.2a, D15.3): a leitura larga do `close-key` não amplia a escrita; a estação é dedicada e sem rede.
 */
export async function artifactGrantsRefusal(input: { readonly subcommand: 'sign' | 'close-key'; readonly sealsDir: string; readonly execArgv: readonly string[]; readonly execBlock: ExecBlockReader; readonly realpath: (target: string) => Promise<string>; readonly lstat: (target: string) => Promise<unknown>; readonly tempRoots: readonly string[] }): Promise<SignRefusal | null> {
  const original = await originalExec(input.execBlock);
  if (original === null) return EXEC_BLOCK_UNREADABLE;
  const grants = [...input.execArgv, ...original.options].flatMap((token): Grant[] => {
    const match = GRANT.exec(token);
    return match ? [{ kind: match[1] as Grant['kind'], value: match[2] as string }] : [];
  });
  const shape = grantsShapeRefusal(input.subcommand, grants);
  if (shape) return shape;
  let root: string;
  try {
    root = await input.realpath(path.resolve(input.sealsDir));
  } catch {
    return GRANT_ROOT_UNPROVEN;
  }
  // segunda confirmação (a): manifesto nunca em pasta temporária (as raízes da custódia, pelo caminho dado e pelo real), nem a raiz contendo uma
  const temps = await bothForms({ realpath: input.realpath }, input.tempRoots);
  if (temps === null) return TEMP_ROOTS_UNPROVEN;
  if (temps.some((temp) => overlaps(root, temp))) return SEALS_IN_TEMP;
  const verified: string[] = [];
  const absentGit: string[] = [];
  let absentWrite = false;
  for (const grant of grants) {
    const check = await isOwnRealPath(grant, input);
    if (check === 'NOT_REAL') return GRANT_NOT_REAL;
    if (check === 'VERIFIED') verified.push(grant.value);
    if (check === 'ABSENT_GIT') absentGit.push(grant.value);
    if (check === 'ABSENT_WRITE') absentWrite = true;
  }
  for (const git of absentGit) if (!(await hasRealParent(git, verified, input.realpath))) return GRANT_NOT_REAL;
  // a comparação é entre caminhos REAIS: cada grant já é o próprio caminho real, e a raiz vem do realpath de --seals-dir
  const writable = input.subcommand === 'sign' ? root : path.join(root, CLOSURES_SUBDIR);
  if (grants.some((grant) => grant.kind === 'write' && !isInside(grant.value, writable))) return GRANT_WRITE_OUTSIDE;
  if (grants.some((grant) => grant.kind === 'write' && temps.some((temp) => overlaps(grant.value, temp)))) return SEALS_IN_TEMP;
  if (absentWrite) return input.subcommand === 'close-key' ? GRANT_CLOSURES_ABSENT : GRANT_WRITE_ABSENT;
  if (input.subcommand === 'close-key') return null;
  const shallow = (value: string): boolean => depthOf(value) < MIN_READ_DEPTH && !SHALLOW_READS_ALLOWED.has(value) && path.basename(value) !== GIT_NAME;
  return grants.some((grant) => grant.kind === 'read' && shallow(grant.value)) ? GRANT_READ_SHALLOW : null;
}

/**
 * Barreira do runtime (revisão da W4.5, T-008), no CLI do `sign` e do `close-key` logo depois da barreira de ambiente do §8.1 e antes do analisador:
 * nada é lido, o terminal não é tocado e a frase nunca é pedida. Recusa `SIGN_RUNTIME_UNSAFE` (código 3) citando só NOMES de variáveis. Nunca lança.
 * W4.6: confere também o bloco ORIGINAL do exec e, no artefato único, a linha e o ambiente do runbook (cabeçalho acima).
 */
export async function runtimeRefusal(facts: RuntimeFacts): Promise<SignRefusal | null> {
  try {
    const current = nodeEnvRefusal(facts.envNames, '');
    if (current) return current;
    if (!(await execArgvAllowed(facts.execArgv, facts))) return EXEC_ARGV_UNSAFE;
    return await originalExecRefusal(facts);
  } catch {
    return EXEC_ARGV_UNSAFE;
  }
}
