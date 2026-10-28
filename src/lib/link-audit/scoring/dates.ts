/**
 * Datas do motor de pontuação: aritmética civil pura (sem `Date`, sem relógio, sem fuso). Um dia é o número de dias
 * desde 1970-01-01 no calendário gregoriano proléptico. O texto "YYYY-MM-DD" (ou o início de um ISO com offset) é
 * interpretado como escrito.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** "YYYY-MM-DD" válido (1900–2200) -> dia numérico; caso contrário `null`. */
export function parseDay(text: string): number | null {
  const match = DAY.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return daysFromCivil(year, month, day);
}

/** Aceita "YYYY-MM-DD" ou um ISO com hora e offset (usa a data como escrita). */
export function parseDayFromIso(text: string): number | null {
  const dt = DATETIME.exec(text);
  return parseDay(dt ? (dt[1] ?? '') : text);
}

export type RelativeUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
const UNIT_DAYS: Readonly<Record<RelativeUnit, number>> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

/**
 * Convenção (PROPOSTA D3B-12) para texto relativo ("há 3 meses"): a expressão cobre [n·u, n·u + u − 1] dias.
 * Só pontua se os dois limites caem na mesma faixa.
 */
export function relativeAgeBounds(amount: number, unit: RelativeUnit): { readonly lo: number; readonly hi: number } {
  const u = UNIT_DAYS[unit];
  return { lo: amount * u, hi: amount * u + (u - 1) };
}

/** Dia numérico -> "YYYY-MM-DD" (inverso de `parseDay`). */
export function formatDay(day: number): string {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
