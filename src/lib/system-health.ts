import { staleMinutesFromEnv } from './audit-liveness';

/** Presença (nunca o valor) das configurações relevantes para a operação. */
export function configurationPresence(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, boolean> {
  const present = (name: string): boolean => Boolean(env[name]?.trim());
  return {
    serper: present('SERPER_API_KEY'),
    supabase: present('NEXT_PUBLIC_SUPABASE_URL') && present('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseAnonKey: present('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    redisUrl: present('REDIS_URL'),
    operatorAllowlist: present('GMN_OPERATOR_EMAILS'),
    privatePdfBucket: present('SUPABASE_PRIVATE_AUDIT_BUCKET'),
    basemap: (env.GMN_PDF_BASEMAP ?? 'none') !== 'none',
    demoMode: env.GMN_DEMO_MODE === 'true',
  };
}

export type ComponentStatus = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface HealthReport {
  readonly overall: ComponentStatus;
  readonly checkedAt: string;
  readonly redis: { readonly status: ComponentStatus };
  readonly worker: { readonly status: ComponentStatus; readonly lastHeartbeat: string | null; readonly concurrency: number | null };
  readonly supabase: { readonly status: ComponentStatus };
  readonly queue: Readonly<Record<string, number>> | null;
  readonly staleAuditMinutes: number;
  readonly recentAudits: readonly { readonly id: string; readonly status: string; readonly updatedAt: string | null; readonly durationSeconds: number | null; readonly error: string | null }[];
  readonly configuration: Record<string, boolean>;
}

/** Resume o conjunto de verificações em um estado geral. */
export function overallStatus(parts: readonly ComponentStatus[]): ComponentStatus {
  if (parts.includes('DOWN')) return 'DOWN';
  if (parts.includes('DEGRADED') || parts.includes('UNKNOWN')) return 'DEGRADED';
  return 'OK';
}

export { staleMinutesFromEnv };
