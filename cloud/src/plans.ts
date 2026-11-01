import { getPool } from './db';

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
 *
 * `basePriceCents` é o preço de tabela configurado no painel; `priceCents` é o valor
 * efetivamente cobrado (promocional quando a promoção está valendo). A tela mostra os
 * dois quando `promoted` é true.
 */
export interface CommercialPlan {
  key: 'prata' | 'ouro' | 'diamante';
  label: string;
  basePriceCents: number;
  priceCents: number;
  originalPriceCents: number;
  promoPriceCents: number | null;
  promoLabel: string | null;
  promoUntil: string | null;
  promoted: boolean;
  extendsDays: number;
  maxDevices: number;
  description: string;
}

interface PlanDefinition {
  key: 'prata' | 'ouro' | 'diamante';
  label: string;
  basePriceCents: number;
  extendsDays: number;
  maxDevices: number;
  description: string;
}

const PLAN_DEFINITIONS: PlanDefinition[] = [
  { key: 'prata', label: 'Prata', basePriceCents: 15000, extendsDays: 30, maxDevices: 1, description: 'PDV, estoque, financeiro e relatórios.' },
  { key: 'ouro', label: 'Ouro', basePriceCents: 20000, extendsDays: 30, maxDevices: 3, description: 'Tudo do Prata + nuvem, backup e cardápio online.' },
  { key: 'diamante', label: 'Diamante', basePriceCents: 25000, extendsDays: 30, maxDevices: 10, description: 'Operação completa + Kivo Web e mesas/cozinha.' },
];

export interface PlanPriceConfig {
  priceCents: number;
  promoPriceCents: number | null;
  promoLabel: string | null;
  promoUntil: string | null;
}

export type PlanPricingConfig = Record<CommercialPlan['key'], PlanPriceConfig>;

const SETTING_KEY = 'plan_pricing';

function defaultPricing(): PlanPricingConfig {
  return {
    prata: { priceCents: 15000, promoPriceCents: null, promoLabel: null, promoUntil: null },
    ouro: { priceCents: 20000, promoPriceCents: null, promoLabel: null, promoUntil: null },
    diamante: { priceCents: 25000, promoPriceCents: null, promoLabel: null, promoUntil: null },
  };
}

let pricing: PlanPricingConfig = defaultPricing();
let catalog: CommercialPlan[] = buildCatalog();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildCatalog(): CommercialPlan[] {
  const hoje = todayIso();
  return PLAN_DEFINITIONS.map((def) => {
    const cfg = pricing[def.key] ?? defaultPricing()[def.key];
    const base = Math.max(1, Math.round(Number(cfg.priceCents) || def.basePriceCents));
    const promo = cfg.promoPriceCents != null ? Math.round(Number(cfg.promoPriceCents)) : null;
    const promoValida = promo != null && promo > 0 && promo < base && (!cfg.promoUntil || cfg.promoUntil >= hoje);
    return {
      key: def.key,
      label: def.label,
      basePriceCents: base,
      priceCents: promoValida ? promo : base,
      originalPriceCents: base,
      promoPriceCents: promo,
      promoLabel: cfg.promoLabel || (promoValida ? 'Promoção' : null),
      promoUntil: cfg.promoUntil,
      promoted: promoValida,
      extendsDays: def.extendsDays,
      maxDevices: def.maxDevices,
      description: def.description,
    };
  });
}

/** Catálogo vigente (cache em memória; recarregado no boot e ao salvar no painel). */
export function getCommercialPlans(): CommercialPlan[] {
  return catalog;
}

export function commercialPlan(key: string | null | undefined): CommercialPlan | null {
  return catalog.find((p) => p.key === key) ?? null;
}

/** Configuração crua para a tela de preços do painel. */
export function getPlanPricing(): PlanPricingConfig {
  return JSON.parse(JSON.stringify(pricing)) as PlanPricingConfig;
}

export function getPlanDefinitions(): PlanDefinition[] {
  return PLAN_DEFINITIONS;
}

/** Lê o JSON de `app_settings` e revalida o catálogo. */
export async function loadPlanPricing(): Promise<void> {
  const defaults = defaultPricing();
  try {
    const [rows] = await getPool().query(
      "SELECT setting_value FROM app_settings WHERE setting_key = ?",
      [SETTING_KEY],
    );
    const raw = (rows as { setting_value: string | null }[])[0]?.setting_value;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlanPricingConfig>;
      for (const def of PLAN_DEFINITIONS) {
        const p = parsed[def.key];
        if (!p) continue;
        defaults[def.key] = {
          priceCents: Number(p.priceCents) > 0 ? Math.round(Number(p.priceCents)) : defaults[def.key].priceCents,
          promoPriceCents: p.promoPriceCents != null && Number(p.promoPriceCents) > 0 ? Math.round(Number(p.promoPriceCents)) : null,
          promoLabel: p.promoLabel ? String(p.promoLabel).trim().slice(0, 60) || null : null,
          promoUntil: p.promoUntil ? String(p.promoUntil).slice(0, 10) : null,
        };
      }
    }
    pricing = defaults;
  } catch (e) {
    pricing = defaultPricing();
    console.error('[plans] falha ao carregar preços; usando tabela padrão:', (e as Error).message);
  }
  catalog = buildCatalog();
}

function toCents(input: unknown): number {
  const n = Number(input);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toPromoCents(input: unknown): number | null {
  if (input == null || String(input).trim() === '') return null;
  const v = toCents(input);
  return v > 0 ? v : null;
}

/**
 * Salva a tabela de preços vinda do painel. O preço base nunca pode ser zero; a promoção,
 * quando preenchida, precisa ser menor que o base. Datas vazias = promoção sem prazo.
 * Os valores já chegam em centavos (o route converte o formulário).
 */
export async function savePlanPricing(input: PlanPricingConfig): Promise<void> {
  const next = defaultPricing();
  for (const def of PLAN_DEFINITIONS) {
    const p = input[def.key];
    const base = toCents(p?.priceCents);
    if (base <= 0) throw new Error(`Informe o preço do plano ${def.label}.`);
    const promo = toPromoCents(p?.promoPriceCents);
    if (promo != null && promo >= base) {
      throw new Error(`O preço promocional do ${def.label} precisa ser menor que o preço normal.`);
    }
    const promoUntil = p?.promoUntil ? String(p.promoUntil).slice(0, 10) : null;
    if (promoUntil && !/^\d{4}-\d{2}-\d{2}$/.test(promoUntil)) {
      throw new Error(`Data de promoção inválida para ${def.label}.`);
    }
    next[def.key] = {
      priceCents: base,
      promoPriceCents: promo,
      promoLabel: p?.promoLabel ? String(p.promoLabel).trim().slice(0, 60) || null : null,
      promoUntil,
    };
  }
  await getPool().query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [SETTING_KEY, JSON.stringify(next)],
  );
  pricing = next;
  catalog = buildCatalog();
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
