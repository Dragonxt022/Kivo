/**
 * Planos comerciais do Kivo (espelha src/core/license/plans.ts do app local — são
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

/**
 * Catálogo comercial usado pelo autoatendimento dentro do app. O valor é sempre o do
 * servidor (o desktop não manda preço), então o cliente não consegue alterar a cobrança.
 */
export interface CommercialPlan {
  key: 'prata' | 'ouro' | 'diamante';
  label: string;
  priceCents: number;
  extendsDays: number;
  maxDevices: number;
  description: string;
}

export const COMMERCIAL_PLANS: CommercialPlan[] = [
  { key: 'prata', label: 'Prata', priceCents: 15000, extendsDays: 30, maxDevices: 1, description: 'PDV, estoque, financeiro e relatórios.' },
  { key: 'ouro', label: 'Ouro', priceCents: 20000, extendsDays: 30, maxDevices: 3, description: 'Tudo do Prata + nuvem, backup e cardápio online.' },
  { key: 'diamante', label: 'Diamante', priceCents: 25000, extendsDays: 30, maxDevices: 10, description: 'Operação completa + Kivo Web e mesas/cozinha.' },
];

export function commercialPlan(key: string | null | undefined): CommercialPlan | null {
  return COMMERCIAL_PLANS.find((p) => p.key === key) ?? null;
}

const RESTRICTED_PLANS = new Set<string>(['trial', 'prata']);

export function canSaveToCloud(plan: string | null | undefined): boolean {
  return !plan || !RESTRICTED_PLANS.has(plan.toLowerCase());
}

/**
 * Kivo Web (painel e orçamento pelo celular) é exclusivo do Diamante. Ao contrário de
 * `canSaveToCloud`, que libera tudo que não for trial/prata, aqui só o Diamante explícito
 * entra — é recurso novo, sem base antiga para proteger com fail-open.
 * Espelha `canUseWebApp` de src/core/license/plans.ts.
 */
export function canUseWebApp(plan: string | null | undefined): boolean {
  return (plan ?? '').toLowerCase() === 'diamante';
}

/** Validade padrão de uma licença trial: 15 dias a partir de agora. */
export function trialValidUntil(): string {
  const d = new Date(Date.now() + 15 * 24 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' '); // formato DATETIME do MySQL
}
