import { getPool } from './db';

/**
 * Planos comerciais do Kuruk. A origem da verdade é a tabela `plans` no banco
 * (migration 0054): cadastrar/editar/pausar planos e marcar as funcionalidades de
 * cada um é operação do painel, sem precisar de release. O estado fica em memória
 * (mesmo padrão do antigo cache de preços) e é recarregado no boot e a cada gravação.
 *
 * O app desktop (src/core/license/plans.ts) NÃO lê a tabela — é um deployable
 * separado. Ele recebe as funcionalidades do próprio plano no `/api/license/validate`
 * (campo `planFeatures`); planos que não vieram do banco (empresas antigas com `plan`
 * livre/legado) mantêm a regra antiga, por chave, como fallback nos dois lados.
 */

/**
 * Chaves reservadas: `trial` não é plano de venda (gerado no /request-trial) e as
 * três originais têm imagem padrão dedicada em /public/img/planos. Nenhuma pode ser
 * usada por um plano novo, e o `trial` não vira linha da tabela `plans`.
 */
const RESERVED_KEYS = new Set(['trial', 'prata', 'ouro', 'diamante']);

/** Exibidos com imagem padrão dedicada (`plano_<key>.jpg`). */
const BUILTIN_SEAL_KEYS = new Set(['prata', 'ouro', 'diamante']);

export const PLAN_TIERS = ['trial', 'prata', 'ouro', 'diamante'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const PLAN_LABELS: Record<PlanTier, string> = {
  trial: 'Teste (15 dias)',
  prata: 'Prata',
  ouro: 'Ouro',
  diamante: 'Diamante',
};

/** Funcionalidades controláveis por plano (checkboxes no painel, gating real no app/cloud). */
export const FEATURE_KEYS = ['cloud_sync', 'web_app', 'qr_order'] as const;
export type PlanFeatureKey = (typeof FEATURE_KEYS)[number];

export interface PlanFeatures {
  cloud_sync: boolean;
  web_app: boolean;
  qr_order: boolean;
}

/** Metadados das funcionalidades — usados pelo painel para renderizar os checkboxes. */
export const PLAN_FEATURES: { key: PlanFeatureKey; label: string; hint: string }[] = [
  { key: 'cloud_sync', label: 'Backup e sync em nuvem', hint: 'Sincronização, backup online e cardápio salvo no servidor.' },
  { key: 'web_app', label: 'Kuruk Web (celular)', hint: 'Acesso pelo celular: painel web, orçamentos e concessões de acesso.' },
  { key: 'qr_order', label: 'Cardápio online e pedido pela mesa (QR)', hint: 'Publica o cardápio público e permite pedido pelo QR Code da mesa.' },
];

export const TRIAL_FEATURES: PlanFeatures = { cloud_sync: false, web_app: false, qr_order: true };

export interface CommercialPlan {
  key: string;
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
  features: PlanFeatures;
  active: boolean;
  /** Caminho relativo do selo (personalizado ou a imagem padrão do próprio cloud). */
  sealPath: string;
}

export interface PlanDefinition {
  key: string;
  label: string;
  description: string;
  priceCents: number;
  extendsDays: number;
  maxDevices: number;
  features: PlanFeatures;
  position: number;
  active: boolean;
}

export interface PlanPromoConfig {
  promoPriceCents: number | null;
  promoLabel: string | null;
  promoUntil: string | null;
  /** Nome do arquivo em `storage/plan-seals/`; null = usa a imagem padrão do plano. */
  sealFile: string | null;
}

const SETTING_PROMOS_KEY = 'plan_pricing';

/**
 * Regra antiga, vira fallback só para empresas de tabela antiga (uma empresa cuja
 * coluna `companies.plan` tem um valor que não existe na `plans`). Por conta disso o
 * padrão é fail-open (tudo que NÃO for trial/prata salva na nuvem) e o Kuruk Web
 * continua fail-closed (só o Diamante explícito).
 */
export function legacyFeaturesFor(key: string): PlanFeatures {
  const restricted = key === 'trial' || key === 'prata';
  return {
    cloud_sync: !restricted,
    web_app: key === 'diamante',
    qr_order: key === 'diamante' || key === 'trial',
  };
}

/**
 * Estado em memória: começa com o catálogo legado (fallback) e é substituído no boot
 * por `loadPlanCatalog()`. Assim o servidor sobe funcionando mesmo que o banco demore
 * ou a migration ainda não tenha rodado — do jeito antigo, hard-coded.
 */
function legacyDefinitions(): PlanDefinition[] {
  const defs = [
    { key: 'prata', label: 'Prata', description: 'PDV, estoque, financeiro e relatórios.', priceCents: 15000, extendsDays: 30, maxDevices: 1, position: 1, active: true },
    { key: 'ouro', label: 'Ouro', description: 'Tudo do Prata + nuvem, backup e cardápio online.', priceCents: 20000, extendsDays: 30, maxDevices: 3, position: 2, active: true },
    { key: 'diamante', label: 'Diamante', description: 'Operação completa + Kuruk Web e mesas/cozinha.', priceCents: 25000, extendsDays: 30, maxDevices: 10, position: 3, active: true },
  ];
  return defs.map((d) => ({ ...d, features: legacyFeaturesFor(d.key) }));
}

const EMPTY_PROMO: PlanPromoConfig = { promoPriceCents: null, promoLabel: null, promoUntil: null, sealFile: null };

let definitions: PlanDefinition[] = legacyDefinitions();
let promos: Record<string, PlanPromoConfig> = {};
let catalog: CommercialPlan[] = buildCatalog();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Selo personalizado quando existe; senão a imagem padrão dedicada ou a genérica. */
function sealPathFor(key: string, file: string | null | undefined): string {
  return file
    ? `/planos/selos/${encodeURIComponent(String(file))}`
    : BUILTIN_SEAL_KEYS.has(key)
      ? `/img/planos/plano_${key}.jpg`
      : '/img/planos/plano_default.jpg';
}

/** JSON da coluna `features` pode chegar como objeto (driver parseia) ou string. */
function normalizeFeatures(raw: unknown): PlanFeatures {
  const src = (typeof raw === 'string' ? safeParseJson(raw) : raw) as Record<string, unknown> | null;
  const out = { cloud_sync: false, web_app: false, qr_order: false } as PlanFeatures;
  if (!src) return out;
  for (const k of FEATURE_KEYS) {
    const v = src[k];
    out[k] = v === true || v === 1 || v === '1' || v === 'true';
  }
  return out;
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Monta o catálogo de venda (só ativos) a partir das definições + promoções. */
function buildCatalog(): CommercialPlan[] {
  const hoje = todayIso();
  return definitions
    .filter((d) => d.active)
    .map((def) => {
      const cfg = promos[def.key] ?? EMPTY_PROMO;
      const base = def.priceCents;
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
        features: { ...def.features },
        active: def.active,
        sealPath: sealPathFor(def.key, cfg.sealFile),
      };
    });
}

function refreshCatalog(): void {
  catalog = buildCatalog();
}

/**
 * Carrega a tabela `plans` + promoções/selos de `app_settings` e refaz o catálogo.
 * Em caso de erro (banco fora, migration pendente) preserva o estado em memória —
 * na inicialização isso significa o catálogo legado, nunca vazio.
 */
export async function loadPlanCatalog(): Promise<void> {
  const nextDefinitions: PlanDefinition[] = [];
  const nextPromos: Record<string, PlanPromoConfig> = {};
  try {
    const [rows] = await getPool().query(
      `SELECT plan_key, label, description, price_cents, extends_days, max_devices, features, position, active
       FROM plans ORDER BY position, created_at, plan_key`,
    );
    for (const row of rows as {
      plan_key: string; label: string; description: string | null; price_cents: number;
      extends_days: number; max_devices: number; features: unknown; position: number; active: number;
    }[]) {
      nextDefinitions.push({
        key: String(row.plan_key),
        label: row.label,
        description: row.description ?? '',
        priceCents: Math.max(1, Math.round(Number(row.price_cents) || 0)),
        extendsDays: Math.max(1, Math.round(Number(row.extends_days) || 30)),
        maxDevices: Math.max(1, Math.round(Number(row.max_devices) || 1)),
        features: normalizeFeatures(row.features),
        position: Math.round(Number(row.position) || 0),
        active: !!row.active,
      });
      nextPromos[String(row.plan_key)] = { ...EMPTY_PROMO };
    }
    const [settingRows] = await getPool().query(
      'SELECT setting_value FROM app_settings WHERE setting_key = ?',
      [SETTING_PROMOS_KEY],
    );
    const raw = (settingRows as { setting_value: string | null }[])[0]?.setting_value;
    if (raw) {
      // Formatos anteriores gravavam `priceCents` aqui; hoje o preço vive na tabela
      // `plans` e o app_settings guarda apenas promoção e selo do dia (por chave).
      const parsed = safeParseJson(raw) as Record<string, Partial<PlanPromoConfig> & { priceCents?: unknown }> | null;
      if (parsed) {
        for (const key of Object.keys(parsed)) {
          const p = parsed[key];
          const entry = nextPromos[key] ?? { ...EMPTY_PROMO };
          entry.promoPriceCents = p?.promoPriceCents != null && Number(p.promoPriceCents) > 0 ? Math.round(Number(p.promoPriceCents)) : null;
          entry.promoLabel = p?.promoLabel ? String(p.promoLabel).trim().slice(0, 60) || null : null;
          entry.promoUntil = p?.promoUntil ? String(p.promoUntil).slice(0, 10) : null;
          entry.sealFile = p?.sealFile ? String(p.sealFile) : null;
          nextPromos[key] = entry;
        }
      }
    }
  } catch (e) {
    console.error('[plans] falha ao carregar planos; mantendo o catálogo atual:', (e as Error).message);
    return;
  }
  definitions = nextDefinitions;
  promos = nextPromos;
  refreshCatalog();
}

/** Catálogo de VENDA vigente (só planos ativos; cache em memória). */
export function getCommercialPlans(): CommercialPlan[] {
  return catalog;
}

/**
 * Resolve QUALQUER plano conhecido, inclusive pausado. Usado onde o plano já foi
 * contratado (baixa de cobrança, renovação de assinatura, selo na tela de licença):
 * uma cobrança em aberto de um plano que acabou de ser pausado tem que continuar
 * baixando. Para validar uma compra nova use `sellablePlan`.
 */
export function commercialPlan(key: string | null | undefined): CommercialPlan | null {
  const keyNormalizado = (key ?? '').toLowerCase();
  const def = definitions.find((p) => p.key === keyNormalizado);
  if (!def) return null;
  return refreshSingle(def);
}

/** Monta a versão comercial de UMA definição (mesma lógica de buildCatalog). */
function refreshSingle(def: PlanDefinition): CommercialPlan {
  const cfg = promos[def.key] ?? EMPTY_PROMO;
  const base = def.priceCents;
  const promo = cfg.promoPriceCents != null ? Math.round(Number(cfg.promoPriceCents)) : null;
  const promoValida = promo != null && promo > 0 && promo < base && (!cfg.promoUntil || cfg.promoUntil >= todayIso());
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
    features: { ...def.features },
    active: def.active,
    sealPath: sealPathFor(def.key, cfg.sealFile),
  };
}

/** Plano disponível para venda (ativo). Exigido na compra/assinatura nova. */
export function sellablePlan(key: string | null | undefined): CommercialPlan | null {
  const plan = commercialPlan(key);
  return plan && plan.active ? plan : null;
}

/** Todas as definições (ativas e pausadas), ordenadas — o painel lista assim. */
export function getPlanDefinitions(): PlanDefinition[] {
  return JSON.parse(JSON.stringify(definitions)) as PlanDefinition[];
}

/** Promoções/selos atuais, por chave (cópia — para o formulário do painel). */
export function getPlanPromos(): Record<string, PlanPromoConfig> {
  return JSON.parse(JSON.stringify(promos)) as Record<string, PlanPromoConfig>;
}

/**
 * Seletores de plano para as telas do painel (empresas, contratos): trial primeiro,
 * depois todos os planos cadastrados. Rótulo de plano pausado recebe o sufixo.
 */
export function planSelectorData(): { planTiers: string[]; planLabels: Record<string, string> } {
  const labels: Record<string, string> = { ...PLAN_LABELS };
  const tiers: string[] = ['trial'];
  for (const d of definitions) {
    if (tiers.includes(d.key)) continue;
    tiers.push(d.key);
    labels[d.key] = d.active ? d.label : `${d.label} (pausado)`;
  }
  return { planTiers: tiers, planLabels: labels };
}

/**
 * Funcionalidades efetivas de um plano — consultado por canSaveToCloud/canUseWebApp/
 * canUseQrOrder e enviado ao desktop no validate. Empresa com chave desconhecida
 * (formato antigo, sem registro na `plans`) mantém a regra antiga por chave: é o que
 * protege instalações com `plan` livre que nunca passaram por este modelo.
 */
export function planFeaturesFor(plan: string | null | undefined): PlanFeatures {
  const key = (plan ?? '').toLowerCase();
  if (key === 'trial') return { ...TRIAL_FEATURES };
  const def = definitions.find((d) => d.key === key);
  return def ? { ...def.features } : legacyFeaturesFor(key);
}

export function canSaveToCloud(plan: string | null | undefined): boolean {
  return planFeaturesFor(plan).cloud_sync;
}

export function canUseWebApp(plan: string | null | undefined): boolean {
  return planFeaturesFor(plan).web_app;
}

/**
 * Pedido pela mesa via QR (trial incluído). O trial NÃO tem sync geral, então o menu
 * público é publicado por uma rota própria (core/menu/publisher no desktop) sem
 * ganhar backup/sync: `TRIAL_FEATURES.qr_order` é true, mas o roteador de sync
 * continua barrado pelo `cloud_sync = false`.
 */
export function canUseQrOrder(plan: string | null | undefined): boolean {
  return planFeaturesFor(plan).qr_order;
}

/* ------------------------------------------------------------------ */
/* Gravação (painel)                                                    */
/* ------------------------------------------------------------------ */

interface PlanInput {
  label?: unknown;
  description?: unknown;
  priceCents?: unknown;
  extendsDays?: unknown;
  maxDevices?: unknown;
  features?: unknown;
  active?: unknown;
}

interface ValidatedPlan {
  label: string;
  description: string;
  priceCents: number;
  extendsDays: number;
  maxDevices: number;
  features: PlanFeatures;
}

function validateBindings(input: PlanInput): ValidatedPlan {
  const label = String(input.label ?? '').trim();
  if (label.length < 2 || label.length > 60) throw new Error('Informe um nome de plano com 2 a 60 caracteres.');
  const description = String(input.description ?? '').trim().slice(0, 255);
  const priceCents = Math.round(Number(input.priceCents));
  if (!Number.isFinite(priceCents) || priceCents <= 0) throw new Error('O preço do plano precisa ser maior que zero.');
  const extendsDays = Math.round(Number(input.extendsDays ?? 30));
  if (!Number.isFinite(extendsDays) || extendsDays < 1 || extendsDays > 3650) {
    throw new Error('Os dias de licença por pagamento precisam estar entre 1 e 3650.');
  }
  const maxDevices = Math.round(Number(input.maxDevices ?? 1));
  if (!Number.isFinite(maxDevices) || maxDevices < 1 || maxDevices > 999) {
    throw new Error('O limite de dispositivos precisa estar entre 1 e 999.');
  }
  return { label, description, priceCents, extendsDays, maxDevices, features: normalizeFeatures(input.features) };
}

/** Cadastra um plano novo e o deixa à venda imediatamente (ativo). */
export async function createPlan(input: PlanInput & { key?: unknown }): Promise<PlanDefinition> {
  const key = String(input.key ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!/^[a-z][a-z0-9_-]{1,29}$/.test(key)) {
    throw new Error('A chave do plano precisa ter 2 a 30 caracteres (letras minúsculas, números, hífen ou _) e começar por letra.');
  }
  if (RESERVED_KEYS.has(key)) throw new Error(`A chave "${key}" é reservada. Escolha outra.`);
  if (definitions.some((d) => d.key === key)) throw new Error('Já existe um plano com esta chave.');
  const v = validateBindings(input);

  const position = definitions.reduce((max, d) => Math.max(max, d.position), 0) + 1;
  await getPool().query(
    `INSERT INTO plans
       (plan_key, label, description, price_cents, extends_days, max_devices, features, position, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [key, v.label, v.description, v.priceCents, v.extendsDays, v.maxDevices, JSON.stringify(v.features), position],
  );
  const def: PlanDefinition = {
    key,
    label: v.label,
    description: v.description,
    priceCents: v.priceCents,
    extendsDays: v.extendsDays,
    maxDevices: v.maxDevices,
    features: { ...v.features },
    position,
    active: true,
  };
  definitions.push(def);
  promos[key] = { ...EMPTY_PROMO };
  refreshCatalog();
  return { ...def, features: { ...def.features } };
}

/**
 * Edita os dados de um plano (nome, descrição, preço, dispositivos, dias e
 * funcionalidades). A chave NUNCA muda: cobranças e assinaturas referenciam a chave.
 * Passar `active` troca o estado de venda no mesmo commit.
 */
export async function updatePlan(key: string, input: PlanInput): Promise<PlanDefinition> {
  const def = definitions.find((d) => d.key === key);
  if (!def) throw new Error('Plano não encontrado.');
  const v = validateBindings(input);
  await getPool().query(
    `UPDATE plans
     SET label = ?, description = ?, price_cents = ?, extends_days = ?, max_devices = ?, features = ?
     WHERE plan_key = ?`,
    [v.label, v.description, v.priceCents, v.extendsDays, v.maxDevices, JSON.stringify(v.features), key],
  );
  def.label = v.label;
  def.description = v.description;
  def.priceCents = v.priceCents;
  def.extendsDays = v.extendsDays;
  def.maxDevices = v.maxDevices;
  def.features = { ...v.features };
  refreshCatalog();
  return { ...def, features: { ...def.features } };
}

/** Ativa/pausa a venda de um plano sem tocar em quem já o contratou. */
export async function setPlanActive(key: string, active: boolean): Promise<void> {
  const def = definitions.find((d) => d.key === key);
  if (!def) throw new Error('Plano não encontrado.');
  await getPool().query('UPDATE plans SET active = ? WHERE plan_key = ?', [active ? 1 : 0, key]);
  def.active = active;
  refreshCatalog();
}

/** Lê a config crua de promoção/selo de uma chave (cópia). */
function promoOf(key: string): PlanPromoConfig {
  return promos[key] ? { ...promos[key] } : { ...EMPTY_PROMO };
}

/**
 * Salva as promoções vindas do formulário do painel. A promoção, quando preenchida,
 * precisa ser menor que o preço atual da tabela `plans`. Datas vazias = sem prazo.
 */
export async function savePlanPromos(
  input: Record<string, Partial<PlanPromoConfig> & { priceCents?: unknown }>,
): Promise<void> {
  for (const def of definitions) {
    const p = input[def.key];
    if (!p) continue;
    const promo = p.promoPriceCents != null && Number(p.promoPriceCents) > 0 ? Math.round(Number(p.promoPriceCents)) : null;
    if (promo != null && promo >= def.priceCents) {
      throw new Error(`O preço promocional do ${def.label} precisa ser menor que o preço normal.`);
    }
    const promoUntil = p?.promoUntil ? String(p.promoUntil).slice(0, 10) : null;
    if (promoUntil && !/^\d{4}-\d{2}-\d{2}$/.test(promoUntil)) {
      throw new Error(`Data de promoção inválida para ${def.label}.`);
    }
    const next = promoOf(def.key);
    next.promoPriceCents = promo;
    next.promoLabel = p?.promoLabel ? String(p.promoLabel).trim().slice(0, 60) || null : null;
    next.promoUntil = promoUntil;
    promos[def.key] = next;
  }
  await persistPromos();
}

/** Troca só o selo de um plano, sem tocar em preços/promoção. */
export async function savePlanSeal(key: string, file: string | null): Promise<void> {
  if (!definitions.some((d) => d.key === key)) throw new Error('Plano inválido.');
  const next = promoOf(key);
  next.sealFile = file;
  promos[key] = next;
  await persistPromos();
}

async function persistPromos(): Promise<void> {
  await getPool().query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [SETTING_PROMOS_KEY, JSON.stringify(promos)],
  );
  refreshCatalog();
}

/** Validade padrão de uma licença trial: 15 dias a partir de agora. */
export function trialValidUntil(): string {
  const d = new Date(Date.now() + 15 * 24 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' '); // formato DATETIME do MySQL
}
