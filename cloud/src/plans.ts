/**
 * Planos comerciais do Katsu (espelha src/core/license/plans.ts do app local — são
 * deployables separados, sem pacote compartilhado, por isso a regra é duplicada).
 * Trial e Prata não incluem salvamento em nuvem (sync push/pull, upload de backup).
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

export function canSaveToCloud(plan: string | null | undefined): boolean {
  return !plan || !RESTRICTED_PLANS.has(plan.toLowerCase());
}

/** Validade padrão de uma licença trial: 15 dias a partir de agora. */
export function trialValidUntil(): string {
  const d = new Date(Date.now() + 15 * 24 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' '); // formato DATETIME do MySQL
}
