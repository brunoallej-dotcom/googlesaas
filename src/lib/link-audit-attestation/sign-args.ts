import { auditId as auditIdSchema, shortLabel } from './schemas';
import { isTrustKeyringText, SIGN_KEY_ID_PATTERN } from './sign-chain';
import { MAX_SEAL_SEQ, type SignRefusal } from './sign-core';
import { parseKeySource, type KeySource } from './sign-key';

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
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['audit', 'package', 'approval', 'dossier', 'risk-acceptance', 'seals-dir', 'expect-seq', 'key-id', 'key-source', 'custodian', 'trust-keys']);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['first', 'json']);
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
  return { auditId, ...paths, ...seq, ...key, custodian, json: flags.has('json') };
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
 */
export interface RuntimeFacts {
  /** `process.execArgv` (injetável). */
  readonly execArgv: readonly string[];
  /** Os NOMES do ambiente (nunca os valores). */
  readonly envNames: readonly string[];
  /** A raiz do projeto: o carregador aceito é o do `node_modules` dela. */
  readonly projectRoot: string;
  /** Caminho real (só metadados; o da custódia da chave, `KeyFileOps.realpath`). */
  readonly realpath: (target: string) => Promise<string>;
}

const PERMISSION_FLAGS: ReadonlySet<string> = new Set(['--permission', '--experimental-permission', '--disable-sigusr1']);
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

/** `execArgv` só com a lista permitida (cabeçalho acima). */
async function execArgvAllowed(facts: RuntimeFacts): Promise<boolean> {
  const tokens = facts.execArgv;
  let loaderSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (PERMISSION_FLAGS.has(token) || PERMISSION_PATHS.test(token)) continue;
    if (!PRELOAD_CJS.test(token) || loaderSeen || !PRELOAD_ESM.test(tokens[index + 2] ?? '')) return false;
    if (!(await isProjectLoader(tokens[index + 1], tokens[index + 3], facts))) return false;
    loaderSeen = true;
    index += 3;
  }
  return true;
}

/**
 * Barreira do runtime (revisão da W4.5, T-008), no CLI do `sign` e do `close-key` logo depois da barreira de ambiente do §8.1 e antes do analisador:
 * nada é lido, o terminal não é tocado e a frase nunca é pedida. Recusa `SIGN_RUNTIME_UNSAFE` (código 3) citando só NOMES de variáveis. Nunca lança.
 */
export async function runtimeRefusal(facts: RuntimeFacts): Promise<SignRefusal | null> {
  try {
    const nodeNames = facts.envNames.filter((name) => NODE_ENV_NAME.test(name) && !HARMLESS_NODE_ENV.has(name));
    if (nodeNames.length > 0) {
      const shown = nodeNames.filter((name) => ECHOABLE_ENV_NAME.test(name)).slice(0, MAX_ECHOED_ENV_NAMES);
      return runtimeUnsafe(`Há configuração do Node no ambiente (${shown.join(', ')}${nodeNames.length > shown.length ? ', …' : ''}; só os nomes são lidos)`);
    }
    return (await execArgvAllowed(facts)) ? null : EXEC_ARGV_UNSAFE;
  } catch {
    return EXEC_ARGV_UNSAFE;
  }
}
