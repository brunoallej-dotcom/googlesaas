import type { ChainInfoLine, ClosureLine, ManifestLine, SealsCheckReport, TrustListLine } from './check';
import type { SealsRefusal } from './codes';
import { AUDIT_ID_CHANNEL_PATTERN, CHANNEL_ENVIRONMENTS, TRUST_LIST_FILE, type ChannelEnvironment } from './paths';

/*
 * P9.2 — o RESUMO público do job `seals` (`$GITHUB_STEP_SUMMARY`; spec §5.4 S-14 e §5.9): uma linha por arquivo novo, numa tabela por tipo e
 * por ambiente. Só campos públicos: caminho na gramática, `sha256sum` dos bytes, `seq`, `sealSha256`, ids de chave, cabeças
 * `auditId:seq:<12 hex>` e códigos fixos. Nunca conteúdo de arquivo, caminho fora da gramática nem caminho de disco.
 */

export const SUMMARY_TITLE = '### seals (append-only, v2)';
/** Prefixo do `sealSha256` de cada cabeça na linha do fecho (§5.9). */
export const HEAD_PREFIX_HEX = 12;
/** Teto de linhas da tabela de recusas (o código fixo é sempre o da primeira; o total vai no texto). */
export const MAX_REFUSAL_ROWS = 200;
const UNKNOWN = '—';
const OUT_OF_PATTERN = '<fora do padrão>';

export const MANIFEST_HEADER = ['| manifesto: caminho relativo | sha256 dos bytes | `seq` | `sealSha256` |', '|---|---|---|---|'] as const;
export const CLOSURE_HEADER = ['| fecho: caminho relativo | sha256 dos bytes | `retiredKeyId` | `signerKeyId` | cabeças (todas) |', '|---|---|---|---|---|'] as const;
const TRUST_HEADER = ['| lista: caminho relativo | sha256 dos bytes | itens | avisos |', '|---|---|---|---|'] as const;
const CHAIN_HEADER = ['| cadeia (só informação, lista nova) | veredito | `headSeq` |', '|---|---|---|'] as const;
const REFUSAL_HEADER = ['| regra | código | caminho | detalhe |', '|---|---|---|---|'] as const;
const NOTICE_TEXT: Readonly<Record<TrustListLine['notices'][number]['notice'], string>> = {
  RETIRED_WITHOUT_PIN: 'aposentada sem hash fixado: as posições desta chave deixam de autenticar até a fixação',
};

const code = (value: string | number | null): string => (value === null ? UNKNOWN : `\`${value}\``);

/** Linha do manifesto (§5.9): caminho relativo à pasta de manifestos do ambiente, `sha256sum` dos bytes, `seq` e `sealSha256`. */
export const manifestSummaryLine = (line: ManifestLine): string => `| ${code(line.relativePath)} | ${code(line.bytesSha256)} | ${code(line.seq)} | ${code(line.sealSha256)} |`;

/** Uma cabeça como `auditId:seq:<12 hex>`; um `auditId` fora do padrão opaco nunca é ecoado. */
export const headLabel = (head: { readonly auditId: string; readonly seq: number; readonly sealSha256: string }): string =>
  `\`${AUDIT_ID_CHANNEL_PATTERN.test(head.auditId) ? head.auditId : OUT_OF_PATTERN}:${head.seq}:${head.sealSha256.slice(0, HEAD_PREFIX_HEX)}\``;

/** Linha do fecho (§5.9): caminho, `sha256sum` dos bytes, `retiredKeyId`, `signerKeyId` e TODAS as cabeças. */
export function closureSummaryLine(line: ClosureLine): string {
  const heads = line.heads === null ? UNKNOWN : line.heads.length === 0 ? 'nenhuma' : line.heads.map(headLabel).join(', ');
  return `| ${code(line.relativePath)} | ${code(line.bytesSha256)} | ${code(line.retiredKeyId)} | ${code(line.signerKeyId)} | ${heads} |`;
}

const noticeCell = (line: TrustListLine): string => (line.notices.length === 0 ? UNKNOWN : line.notices.map((item) => `\`${item.keyId}\`: ${NOTICE_TEXT[item.notice]}`).join('; '));
const trustLine = (line: TrustListLine): string => `| ${code(TRUST_LIST_FILE)} | ${code(line.bytesSha256)} | ${code(line.items)} | ${noticeCell(line)} |`;
const chainLine = (line: ChainInfoLine): string => `| ${code(line.auditId)} | ${code(line.verdict)} | ${code(line.headSeq)} |`;
const refusalLine = (item: SealsRefusal): string => `| ${item.rule} | ${code(item.code)} | ${code(item.path)} | ${code(item.detail)} |`;

function table(title: string, header: readonly string[], rows: readonly string[]): string[] {
  return rows.length === 0 ? [] : ['', title, '', ...header, ...rows];
}

function environmentSection(report: SealsCheckReport, env: ChannelEnvironment): string[] {
  return [
    ...table(`#### ${env}: manifestos`, MANIFEST_HEADER, report.manifests.filter((line) => line.env === env).map(manifestSummaryLine)),
    ...table(`#### ${env}: fechos`, CLOSURE_HEADER, report.closures.filter((line) => line.env === env).map(closureSummaryLine)),
    ...table(`#### ${env}: lista de confiança`, TRUST_HEADER, report.trustLists.filter((line) => line.env === env).map(trustLine)),
    ...table(`#### ${env}: cadeias sob a lista nova`, CHAIN_HEADER, report.chains.filter((line) => line.env === env).map(chainLine)),
  ];
}

/** O código fixo da primeira recusa (ordem das regras), ou `null` se nada foi recusado. */
export const firstRefusalCode = (report: SealsCheckReport): string | null => report.refusals[0]?.code ?? null;

/** Título e textos do resumo; o modo árvore do `seals-verify` (P9.5) passa os seus, o job `seals` usa os padrões. */
export interface SummaryOptions {
  readonly title?: string;
  /** O texto quando não há nada sob o escopo verificado. */
  readonly emptyText?: string;
  /** As regras aplicadas, para o texto da recusa (`S-01 a S-13` no job `seals`). */
  readonly rules?: string;
}

/** O resumo completo em Markdown (linhas). */
export function summaryLines(report: SealsCheckReport, options: SummaryOptions = {}): string[] {
  const title = options.title ?? SUMMARY_TITLE;
  if (!report.touched) return [title, '', options.emptyText ?? 'Nada mudou sob `link-audit-seals/`: nada a verificar.'];
  const first = firstRefusalCode(report);
  const result = first === null ? 'Resultado: `OK`' : `Resultado: \`ERRO ${first}\` (${report.refusals.length} recusa(s); o código é o da primeira, na ordem das regras ${options.rules ?? 'S-01 a S-13'})`;
  const shown = report.refusals.slice(0, MAX_REFUSAL_ROWS).map(refusalLine);
  const hidden = report.refusals.length - shown.length;
  return [
    title,
    '',
    result,
    ...(report.incomplete ? ['', 'Verificação INCOMPLETA: uma etapa falhou de forma inesperada (falha fechada; as recusas abaixo valem).'] : []),
    ...table('#### Recusas', REFUSAL_HEADER, shown),
    ...(hidden > 0 ? ['', `… e mais ${hidden} recusa(s) não listadas.`] : []),
    ...CHANNEL_ENVIRONMENTS.flatMap((env) => environmentSection(report, env)),
    ...(report.chainsTruncated ? ['', 'Informação das cadeias TRUNCADA: o teto de leitura informativo acabou (nada é recusado por isso).'] : []),
  ];
}
