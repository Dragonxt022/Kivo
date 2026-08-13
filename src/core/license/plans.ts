/**
 * Planos comerciais do Kivo. Trial e Prata não incluem atualização automática nem
 * salvamento em nuvem (sync/backup); Ouro e Diamante incluem os dois. O Kivo Web (celular)
 * é só do Diamante — ver `canUseWebApp`.
 *
 * A capability `app.online`, antes reservada para isto, não chegou a ser usada: capabilities
 * nascem desligadas (loader.ts), então ela seria um terceiro interruptor que faria o recurso
 * parecer quebrado para quem acabou de assinar Diamante. O controle real são dois, e ambos
 * significam algo: o plano, e a concessão por usuário (core/remote/service.ts).
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

/**
 * Kivo Web (acompanhar a loja e fazer orçamento pelo celular) é exclusivo do Diamante.
 *
 * Diferente de `canAutoUpdate`/`canSaveToCloud`, que liberam tudo que NÃO for trial/prata,
 * aqui a regra é a inversa — só o plano explicitamente Diamante entra. É recurso novo, sem
 * base instalada para preservar, então não há motivo para o fail-open que protege empresas
 * com `plan` antigo. Vale junto com a capability `app.online`.
 */
export function canUseWebApp(plan: string | null): boolean {
  return (plan ?? '').toLowerCase() === 'diamante';
}

export function planLabel(plan: string | null): string {
  return plan ? (PLAN_LABELS[plan as PlanTier] ?? plan) : '—';
}
