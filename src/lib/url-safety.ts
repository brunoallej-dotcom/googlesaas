import dns from 'node:dns';
import net from 'node:net';

/**
 * Proteção contra SSRF para qualquer consulta a sites externos.
 *
 * - Só http/https, sem credenciais embutidas e apenas nas portas 80/443.
 * - Nomes e endereços internos, de nuvem (metadados) e reservados são recusados.
 * - O nome é resolvido ANTES da conexão e o endereço validado é o único usado (o chamador o fixa
 *   na conexão), o que impede "DNS rebinding". Se qualquer resposta DNS for não pública, recusa.
 * - A mesma validação vale para cada redirecionamento.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet'];
const ALLOWED_PORTS = new Set(['', '80', '443']);

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isPublicIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return false;
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local e metadados de nuvem
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reservado e broadcast
  return true;
}

/** Expande um IPv6 para 8 grupos de 16 bits; `null` se inválido. */
function expandIPv6(ip: string): number[] | null {
  let address = ip.split('%')[0] ?? ip;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    address = `${address.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const parsed = groups.map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return parsed.length === 8 && parsed.every((n) => !Number.isNaN(n)) ? parsed : null;
}

function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((n) => n === 0)) return false; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  // IPv4 mapeado (::ffff:a.b.c.d) e compatível (::a.b.c.d): vale a regra do IPv4 embutido.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isPublicIPv4(embeddedIPv4(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b) return isPublicIPv4(embeddedIPv4(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 (ULA, inclui fd00::/8)
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (obsoleto)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentação
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard
  return true;
}

export function isPublicIpAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPublicIPv4(ip);
  if (family === 6) return isPublicIPv6(ip);
  return false;
}

export interface SafeUrl {
  readonly url: URL;
  readonly hostname: string;
}

/** Valida a forma da URL (sem rede). A URL é normalizada pelo parser WHATWG. */
export function assertSafeUrlShape(raw: string): SafeUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('URL inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Somente http e https são permitidos.');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs com credenciais embutidas não são permitidas.');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError('Porta não permitida (somente 80 e 443).');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new UnsafeUrlError('URL sem nome de host.');
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeUrlError('Host interno não permitido.');
  }
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new UnsafeUrlError('Endereço IP não público.');
  } else if (!hostname.includes('.')) {
    throw new UnsafeUrlError('Host sem domínio completo não permitido.');
  }
  return { url, hostname };
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

/**
 * Resolve o host e devolve um endereço público para fixar na conexão.
 * Qualquer resposta DNS não pública invalida o host inteiro (evita respostas mistas).
 */
export async function resolvePublicAddress(
  hostname: string,
  resolver: HostResolver = systemResolver
): Promise<ResolvedAddress> {
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new UnsafeUrlError('Endereço IP não público.');
    return { address: hostname, family: net.isIP(hostname) === 6 ? 6 : 4 };
  }
  let records: readonly ResolvedAddress[];
  try {
    records = await resolver(hostname);
  } catch (error: unknown) {
    throw new UnsafeUrlError(`Não foi possível resolver o domínio (${error instanceof Error ? error.message : 'erro DNS'}).`);
  }
  if (records.length === 0) throw new UnsafeUrlError('Domínio sem endereço.');
  if (records.some((record) => !isPublicIpAddress(record.address))) {
    throw new UnsafeUrlError('O domínio resolve para endereço não público.');
  }
  return records[0] as ResolvedAddress;
}
