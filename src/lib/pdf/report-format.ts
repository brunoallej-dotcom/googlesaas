const TZ = 'America/Sao_Paulo';

const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(digits: number): Intl.NumberFormat {
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: digits });
    numberFormats.set(digits, format);
  }
  return format;
}

export function formatNumber(value: number, digits = 1): string {
  return numberFormat(digits).format(value);
}

/** Nota com uma casa decimal fixa (4,9 / 5,0), como no dashboard. */
export function formatRating(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatNumber(value, digits)}%` : '—';
}

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TZ,
});

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: TZ,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Não disponível';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Não disponível' : dateTimeFormat.format(date).replace(',', ' ·');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Não disponível';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Não disponível' : dateFormat.format(date);
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
