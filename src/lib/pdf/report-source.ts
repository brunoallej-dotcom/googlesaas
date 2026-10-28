import type { FrontierLead } from '@/types/gmn';
import type { ReportSourceData } from './report-types';

export type ReportSourceResult =
  | { readonly ok: true; readonly source: ReportSourceData }
  | { readonly ok: false; readonly missing: readonly string[] };

const REQUIRED_PAYLOADS = ['reputation', 'vitrine', 'battlefield', 'rivals', 'judge', 'strategist'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Monta os dados do relatório a partir do estado persistido de uma auditoria (formato de
 * `normalizeAuditRow`). Se faltar algum resultado, devolve a lista do que falta em vez de
 * inventar valores: o relatório não é gerado com dados parciais disfarçados.
 */
export function reportSourceFromAuditState(
  state: Record<string, unknown>,
  lead: FrontierLead
): ReportSourceResult {
  const missing = REQUIRED_PAYLOADS.filter((key) => !isObject(state[key]));
  const battlefield = state.battlefield;
  if (isObject(battlefield) && !Array.isArray(battlefield.points)) missing.push('battlefield.points' as never);
  if (missing.length > 0) return { ok: false, missing };

  const judge = state.judge as ReportSourceData['judge'];
  if (!Array.isArray(judge.checklist21Items) || judge.checklist21Items.length === 0) {
    return { ok: false, missing: ['judge.checklist21Items'] };
  }

  return {
    ok: true,
    source: {
      auditId: String(state.auditId),
      lead,
      reputation: state.reputation as ReportSourceData['reputation'],
      vitrine: state.vitrine as ReportSourceData['vitrine'],
      battlefield: state.battlefield as ReportSourceData['battlefield'],
      rivals: state.rivals as ReportSourceData['rivals'],
      judge,
      strategist: state.strategist as ReportSourceData['strategist'],
    },
  };
}

/** O que está configurado no ambiente de geração: base para declarar provedores sem inventar. */
export function detectProviderEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): {
  readonly serperConfigured: boolean;
  readonly dataForSeoConfigured: boolean;
} {
  const serperKey = env.SERPER_API_KEY?.trim() ?? '';
  const login = env.DATAFORSEO_LOGIN ?? '';
  return {
    serperConfigured: serperKey.length > 10 && !serperKey.includes('cole-sua-api-key'),
    dataForSeoConfigured: Boolean(login && env.DATAFORSEO_PASSWORD && !login.includes('your-dataforseo-login')),
  };
}
