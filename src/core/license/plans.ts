import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Planos comerciais do Kivo. Atualização automática passou a valer para TODOS os planos —
 * inclusive trial e Prata — porque ela carrega correções de segurança e é obrigatória.
 *
 * O catálogo DE planos (quais existem, preço, o que cada um inclui) é gerenciado no
 * painel do cloud (tabela `plans`) e NÃO vive aqui: o desktop nunca é a fonte
 * da verdade sobre o que está à venda. O que o desktop precisa saber — se o plano da
 * empresa inclui sync/nuvem, Kivo Web e pedido por QR — chega no `/api/license/validate`
 * (campo `planFeatures`) e é guardado localmente em `setPlanFeatures`. Enquanto a nuvem
 * não mandar esse campo (cloud antiga, ou instalação sem online ainda), valem as regras
 * fixas por chave abaixo, que eram o modelo anterior.
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

/**
 * Funcionalidades que o plano pode liberar — espelham os checkboxes do painel do cloud:
 *  - `cloud_sync`: sync/backup em nuvem (engine de sync, upload de backup, reset com envio).
 *  - `web_app`: Kivo Web (painel/orçamento pelo celular, concessões de acesso).
 *  - `qr_order`: cardápio online + pedido pela mesa via QR Code.
 */
export interface PlanFeatures {
  cloud_sync: boolean;
  web_app: boolean;
  qr_order: boolean;
}

/** Chave no `settings` com o último mapa plano→funcionalidades recebido do cloud. */
const SETTING_PLAN_FEATURES = 'license.plano_features';

/** Chave e nome comercial do plano contratado (`<plano>|<nome>`), do validate. */
const SETTING_PLAN_LABEL = 'license.plano_label';

let storedPlanLabel: { plan: string; label: string } | null | undefined;

function loadPlanLabel(): { plan: string; label: string } | null {
  if (storedPlanLabel === undefined) {
    try {
      const raw = (settingsRepository.get(SETTING_PLAN_LABEL) ?? '').trim();
      const sep = raw.indexOf('|');
      storedPlanLabel = raw && sep > 0 ? { plan: raw.slice(0, sep), label: raw.slice(sep + 1) } : null;
    } catch {
      storedPlanLabel = null;
    }
  }
  return storedPlanLabel;
}

/**
 * Guarda o nome comercial do plano contratado no último validate. Com planos gerenciados
 * no painel, a chave crua do plano não diz nada ao lojista — o cloud manda `planLabel`.
 */
export function setPlanLabel(plan: string | null | undefined, label: string | null | undefined): void {
  const key = (plan ?? '').toLowerCase();
  if (!key || !label || !label.trim()) return;
  storedPlanLabel = { plan: key, label: label.trim() };
  try {
    settingsRepository.set(SETTING_PLAN_LABEL, `${key}|${label.trim()}`);
  } catch {
    // sem persistência o app volta a mostrar a chave crua na próxima sessão
  }
}

let featuresByPlan: Record<string, PlanFeatures> | null | undefined;

function loadPlanFeatures(): Record<string, PlanFeatures> {
  if (featuresByPlan === undefined) {
    try {
      const raw = (settingsRepository.get(SETTING_PLAN_FEATURES) ?? '').trim();
      featuresByPlan = raw ? (JSON.parse(raw) as Record<string, PlanFeatures>) : null;
    } catch {
      featuresByPlan = null;
    }
  }
  return featuresByPlan ?? {};
}

/**
 * Guarda o mapa plano→funcionalidades descem do cloud. `undefined` = nuvem antiga que
 * não manda o campo: preserva o mapa atual em vez de apagar. Normaliza os valores para
 * booleano de verdade (o endpoint manda booleanos, mas defensivamente aceita 1/'1').
 */
export function setPlanFeatures(map: Record<string, PlanFeatures> | null | undefined): void {
  if (map === undefined) return;
  if (map == null) {
    featuresByPlan = null;
    try {
      settingsRepository.set(SETTING_PLAN_FEATURES, '');
    } catch {
      // falha de escrita não pode derrubar a validação da licença
    }
    return;
  }
  const clean: Record<string, PlanFeatures> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!value || typeof value !== 'object') continue;
    clean[key.toLowerCase()] = {
      cloud_sync: value.cloud_sync === true || (value.cloud_sync as unknown) === 1,
      web_app: value.web_app === true || (value.web_app as unknown) === 1,
      qr_order: value.qr_order === true || (value.qr_order as unknown) === 1,
    };
  }
  featuresByPlan = Object.keys(clean).length ? clean : null;
  try {
    settingsRepository.set(SETTING_PLAN_FEATURES, featuresByPlan ? JSON.stringify(featuresByPlan) : '');
  } catch (e) {
    // A tela continua com as regras fixas em memória; o problema aparece na próxima sessão.
    console.error('[plans] não foi possível guardar as funcionalidades de plano:', e);
  }
}

/** Funcionalidades do plano quando o cloud já as publicou; null = usar a regra fixa. */
export function planFeaturesFor(plan: string | null): PlanFeatures | null {
  return loadPlanFeatures()[(plan ?? '').toLowerCase()] ?? null;
}

/**
 * Atualização obrigatória em qualquer plano: o pacote traz correções de segurança e não
 * faz sentido um cliente em teste ficar preso numa versão vulnerável. Mantido como função
 * porque a tela de licença e os testes ainda consultam `canAutoUpdate`.
 */
export function canAutoUpdate(_plan?: string | null): boolean {
  return true;
}

export function canSaveToCloud(plan: string | null): boolean {
  const features = planFeaturesFor(plan);
  if (features) return features.cloud_sync;
  return !plan || !RESTRICTED_PLANS.has(plan.toLowerCase());
}

/**
 * Kivo Web (acompanhar a loja e fazer orçamento pelo celular). Com plano vindo do cloud,
 * a decisão é a funcionalidade marcada no painel; com chave legado (sem registro), a
 * regra antiga — só o plano explicitamente Diamante entra. Vale junto com a capability
 * `app.online`.
 */
export function canUseWebApp(plan: string | null): boolean {
  const features = planFeaturesFor(plan);
  if (features) return features.web_app;
  return (plan ?? '').toLowerCase() === 'diamante';
}

/**
 * Pedido pela mesa via QR: com plano do cloud segue o que o painel marcou; na regra fixa,
 * Diamante ou Trial (o teste libera o recurso por 15 dias). O trial NÃO tem sync geral,
 * então o menu público é publicado por uma rota própria (ver core/menu/publisher.ts) —
 * este gate não abre backup/sync para o teste.
 */
export function canUseQrOrder(plan: string | null): boolean {
  const features = planFeaturesFor(plan);
  if (features) return features.qr_order;
  const p = (plan ?? '').toLowerCase();
  return p === 'diamante' || p === 'trial';
}

export function planLabel(plan: string | null): string {
  if (!plan) return '—';
  const key = plan.toLowerCase();
  const stored = loadPlanLabel();
  if (stored && stored.plan === key) return stored.label;
  return PLAN_LABELS[plan as PlanTier] ?? plan;
}
