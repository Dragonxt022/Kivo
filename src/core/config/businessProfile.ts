import { settingsRepository } from '../repositories/SettingsRepository';
import type { ModuleMenuItem } from '../modules/types';

/**
 * Perfil operacional do negócio.
 *
 * O plano (licença) decide o que a instalação PODE acessar; o perfil decidir o que ela
 * DEVERIA mostrar. Um consultório pode ter o plano completo e ainda assim não usar mesas,
 * cozinha ou PDV — sem isso, a visão geral e o menu ficam poluídos com o vocabulário de
 * varejo/food.
 *
 * O perfil vem do ramo respondido no assistente de boas-vindas (`onboarding.business_type`).
 * A empresa pode sobrepor o padrão gravando a lista de módulos visíveis (ver
 * `saveVisibleModules`): depois disso, o que vale é a escolha da empresa — igual à ordem dos
 * cards, que também passa a mandar quando é salva.
 *
 * Módulo de SISTEMA (`alwaysEnabled`) nunca é ocultado: o Painel precisa existir em toda
 * instalação, e a tela inicial também.
 */

export const BUSINESS_TYPE_KEY = 'onboarding.business_type';
/** Lista (JSON) de `moduleId` que a empresa escolheu MOSTRAR. Ausente = usar o padrão do ramo. */
export const VISIBLE_MODULES_KEY = 'interface.modulos_visiveis';

export type BusinessProfile = 'odontologia' | 'varejo' | 'food' | 'servicos' | 'generico';

/** Ramo → perfil operacional. Casa por palavra-chave, como `priorityForBusinessType`. */
export function profileForBusinessType(tipo: string): BusinessProfile {
  const t = String(tipo ?? '').toLowerCase();
  if (/odonto|dent|clinic|sa[uú]de|consult[oó]rio/.test(t)) return 'odontologia';
  if (/restaurante|lanchonete|\bbar\b|pizza|food|delivery|a[cç]a[ií]|caf[eé]|doceria|sorvet|padaria|cozinha|bistr/.test(t)) return 'food';
  if (/merc|supermerc|emporio|emp[oó]rio|hortifruti|a[cç]ougue|farmacia|farm[áa]cia|drogaria|perfum|loja|varejo|moda|roupa|cal[cç]ado|presente|papelaria|\bpet\b|material/.test(t)) return 'varejo';
  if (/oficina|assist[eê]ncia|servic|sal[aã]o|barbearia|est[eé]tica/.test(t)) return 'servicos';
  return 'generico';
}

/**
 * Módulos escondidos por padrão em cada perfil. A lista é de `moduleId` (o que o manifesto
 * declara e o `collectMenu` propaga). Conservadora de propósito: esconde só o que é
 * claramente de outro ramo; o resto a empresa liga/desliga na tela de personalização.
 */
const HIDDEN_BY_PROFILE: Record<BusinessProfile, string[]> = {
  odontologia: ['comandas', 'foodservice'],
  food: ['odonto'],
  varejo: ['odonto'],
  servicos: ['odonto', 'comandas', 'foodservice'],
  generico: [],
};

export function getBusinessProfile(): BusinessProfile {
  try {
    return profileForBusinessType(settingsRepository.get(BUSINESS_TYPE_KEY) ?? '');
  } catch {
    return 'generico';
  }
}

/** Override da empresa: null quando ela nunca personalizou (aí vale o padrão do ramo). */
export function getVisibleModulesOverride(): string[] | null {
  try {
    const raw = settingsRepository.get(VISIBLE_MODULES_KEY);
    if (raw === null || raw === undefined) return null;
    const valor: unknown = JSON.parse(raw);
    if (!Array.isArray(valor)) return null;
    return valor.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
}

export function saveVisibleModules(ids: string[]): void {
  settingsRepository.set(VISIBLE_MODULES_KEY, JSON.stringify(ids.slice(0, 200)));
}

/**
 * Ids de módulo que devem ficar OCULTOS dado o conjunto de módulos instalados.
 * Só considera ids que existem de fato — assim um módulo desinstalado não polui a lista.
 */
export function hiddenModuleIds(allModuleIds: string[]): string[] {
  const todos = new Set(allModuleIds);
  const override = getVisibleModulesOverride();
  if (override) {
    const visiveis = new Set(override);
    return allModuleIds.filter((id) => !visiveis.has(id));
  }
  return HIDDEN_BY_PROFILE[getBusinessProfile()].filter((id) => todos.has(id));
}

/** Um item de menu é relevante se o módulo dele não está oculto (itens sem módulo passam). */
export function isModuleMenuItemVisible(item: ModuleMenuItem, hidden: Set<string>): boolean {
  if (!item.moduleId) return true;
  if (item.alwaysEnabled) return true;
  return !hidden.has(item.moduleId);
}
