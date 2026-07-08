/**
 * Planos comerciais do Katsu. Trial e Prata não incluem atualização automática nem
 * salvamento em nuvem (sync/backup); Ouro e Diamante incluem os dois. `app.online` fica
 * reservado para uma futura versão web do Diamante — sem produto associado ainda.
 *
 * Diferente de `isModuleEntitled` (fail-open quando não configurado — feito para módulos
 * de negócio), aqui o padrão é liberar tudo que NÃO for explicitamente trial/prata: isso
 * evita quebrar empresas com `plan` livre/antigo que nunca passaram por este novo modelo.
 */

export const PLAN_TIERS = ['trial', 'prata', 'ouro', 'diamante'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const PLAN_LABELS: Record<PlanTier, string> = {
  trial: 'Teste (15 dias)',
  prata: 'Prata',
  ouro: 'Ouro',
  diamante: 'Diamante',
};

const RESTRICTED_PLANS = new Set<string>(['trial', 'prata']);

export function canAutoUpdate(plan: string | null): boolean {
  return !plan || !RESTRICTED_PLANS.has(plan.toLowerCase());
}

export function canSaveToCloud(plan: string | null): boolean {
  return !plan || !RESTRICTED_PLANS.has(plan.toLowerCase());
}

export function planLabel(plan: string | null): string {
  return plan ? (PLAN_LABELS[plan as PlanTier] ?? plan) : '—';
}
