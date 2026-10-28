import type { FrontierLead, WhatsAppPresenceStatus } from '@/types/gmn';

const WA_HOSTS = new Set(['wa.me', 'wa.link', 'api.whatsapp.com', 'web.whatsapp.com']);

/** Normaliza telefones brasileiros de 10/11 dígitos, com ou sem DDI 55. */
export function brazilianPhoneE164(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const national = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;

  if (!/^[1-9]\d(?:\d{8}|9\d{8})$/.test(national)) return null;
  return `+55${national}`;
}

export function isLikelyBrazilianMobile(phone?: string | null): boolean {
  return /^\+55[1-9]\d9\d{8}$/.test(phone ?? '');
}

/** Aceita SOMENTE links HTTPS de contato reconhecidos do WhatsApp. */
export function safePublicWhatsAppUrl(raw?: string | null): string | null {
  if (!raw?.trim()) return null;

  try {
    const input = raw.trim();
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['https:', 'http:'].includes(url.protocol) || !WA_HOSTS.has(host)) return null;
    if (url.username || url.password) return null;

    if (host === 'wa.me') {
      if (!/^\/(?:\d{10,15}|message\/[a-z\d]+)\/?$/i.test(url.pathname)) return null;
    } else if (host === 'wa.link') {
      if (!/^\/[a-z\d]{3,}\/?$/i.test(url.pathname)) return null;
    } else {
      if (!/^\/send\/?$/i.test(url.pathname)) return null;
      const phone = url.searchParams.get('phone')?.replace(/\D/g, '') ?? '';
      if (!/^\d{10,15}$/.test(phone)) return null;
    }

    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

function phoneFromPublicLink(safeUrl: string | null): string | null {
  if (!safeUrl) return null;
  const url = new URL(safeUrl);
  const raw = url.hostname.endsWith('wa.me')
    ? url.pathname.replace(/^\//, '')
    : url.searchParams.get('phone');
  return brazilianPhoneE164(raw);
}

export function formatBrazilianPhone(phone: string): string {
  const normalized = brazilianPhoneE164(phone);
  if (!normalized) return phone;
  const digits = normalized.slice(3);
  const ddd = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  return subscriber.length === 9
    ? `(${ddd}) ${subscriber.slice(0, 5)}-${subscriber.slice(5)}`
    : `(${ddd}) ${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
}

export interface WhatsAppContactPresentation {
  readonly phoneText: string | null;
  readonly phoneHref: string | null;
  readonly whatsappPhoneText: string | null;
  readonly whatsappHref: string | null;
  readonly statusLabel: string;
  readonly actionLabel: string | null;
  readonly helpText: string | null;
}

/** Monta somente links seguros. Celular encontrado NÃO comprova WhatsApp ativo. */
export function presentWhatsAppContact(
  lead: Pick<FrontierLead, 'phoneRaw' | 'phoneE164' | 'whatsappUrl' | 'whatsappStatus'>
): WhatsAppContactPresentation {
  const phone = brazilianPhoneE164(lead.phoneE164) ?? brazilianPhoneE164(lead.phoneRaw);
  const publicUrl = safePublicWhatsAppUrl(lead.whatsappUrl);
  const publicPhone = phoneFromPublicLink(publicUrl);
  const likelyMobile = isLikelyBrazilianMobile(phone);
  const whatsappHref = publicUrl ?? (likelyMobile ? `https://wa.me/${phone?.slice(1)}` : null);

  const statusLabels: Record<WhatsAppPresenceStatus, string> = {
    VERIFIED_WHATSAPP: 'Link WhatsApp informado',
    LIKELY_MOBILE_WHATSAPP: 'Celular — não confirmado',
    LANDLINE_ONLY: 'Telefone fixo',
    MISSING: 'Sem número identificado',
  };

  return {
    phoneText: lead.phoneRaw?.trim() || (phone ? formatBrazilianPhone(phone) : null),
    phoneHref: phone ? `tel:${phone}` : null,
    whatsappPhoneText:
      publicPhone && publicPhone !== phone ? formatBrazilianPhone(publicPhone) : null,
    whatsappHref,
    statusLabel: statusLabels[lead.whatsappStatus],
    actionLabel: whatsappHref
      ? publicUrl && lead.whatsappStatus === 'VERIFIED_WHATSAPP'
        ? 'Abrir link WhatsApp'
        : 'Testar no WhatsApp'
      : null,
    helpText: whatsappHref
      ? 'O link não confirma que o número possui WhatsApp ativo.'
      : null,
  };
}
