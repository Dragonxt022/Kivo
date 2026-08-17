import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';
import { listCapabilities, setCapabilityEnabled } from '../capabilities/service';
import { isModuleEntitled, getLicenseCredentials } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import { storeTableRepository } from '../../modules/comandas/repositories/StoreTableRepository';
import { productRepository } from '../../modules/commercial/repositories/ProductRepository';
import { categoryRepository } from '../../modules/commercial/repositories/CategoryRepository';
import { complementGroupRepository, complementItemRepository, productComplementGroupRepository } from '../../modules/commercial/repositories/ComplementRepository';
import { productAttributeRepository, productAttributeValueRepository, productVariantValueRepository } from '../../modules/commercial/repositories/AttributeRepository';
import { paymentMethodRepository } from '../../modules/finance/repositories/PaymentMethodRepository';

const COMPLETED_KEY = 'onboarding.completed';
const DEMO_DATA_KEY = 'onboarding.demo_data_created';
const USAGE_KEY = 'onboarding.usage';
const BUSINESS_TYPE_KEY = 'onboarding.business_type';
const EMPLOYEE_RANGE_KEY = 'onboarding.employee_range';
/** Mesma chave usada pela tela de Configurações → Empresa: é o nome que sai no cupom. */
const COMPANY_NAME_KEY = 'empresa.nome';

export type OnboardingUsage = 'balcao' | 'mesas' | 'ambos';

/**
 * Ramo do comércio. Os três primeiros são os originais e não podem sumir — instalações
 * antigas já têm um deles gravado em `onboarding.business_type`, e são eles que decidem
 * quais produtos de exemplo o assistente cria.
 *
 * Os demais entraram para a lista servir de pesquisa: com só três opções, quase toda loja
 * caía em "outro" e o dado não dizia nada sobre quem usa o Kivo.
 */
export type OnboardingBusinessType =
  | 'restaurante'
  | 'roupas'
  | 'outro'
  | 'padaria'
  | 'mercado'
  | 'conveniencia'
  | 'adega'
  | 'farmacia'
  | 'petshop'
  | 'servicos';

/**
 * Faixas de porte. Não se sobrepõem de propósito: como o objetivo é pesquisa, faixas
 * cumulativas (1 a 5 / 1 a 50 / 1 a 100) deixariam quem tem 3 funcionários podendo marcar
 * três opções diferentes, e o número agregado não significaria nada.
 */
export type OnboardingEmployeeRange = '1-5' | '6-50' | '51-100' | '100+';

export const EMPLOYEE_RANGES: OnboardingEmployeeRange[] = ['1-5', '6-50', '51-100', '100+'];

export interface ProvisionInput {
  usage: OnboardingUsage;
  businessType: OnboardingBusinessType;
  activePaymentMethodIds: number[];
  createDemoData: boolean;
  resetDemoData?: boolean;
  /** Nome do negócio — vai para `empresa.nome` e sobe para a nuvem. */
  businessName?: string;
  employeeRange?: OnboardingEmployeeRange;
  /**
   * Recursos que devem ficar ligados ao final. `undefined` (cliente antigo, chamada
   * direta na API) cai na recomendação derivada das respostas — nunca em "nada ligado".
   */
  activeFeatureKeys?: string[];
}

export interface ProvisionResult {
  tablesCreated: number;
  productsCreated: number;
  paymentMethodsActive: string[];
  featuresEnabled: string[];
  featuresDisabled: string[];
}

/**
 * Recursos que o assistente de boas-vindas controla, com o texto que o lojista lê e a
 * regra que decide se vêm marcados.
 *
 * A lista é curada de propósito, e não "todas as capabilities": o assistente LIGA E
 * DESLIGA o que está aqui, então só pode conter recurso cuja decisão caiba nas três
 * perguntas que ele faz. Fiscal (NFC-e) e cardápio online ficam de fora porque dependem
 * de certificado/nuvem configurados — desligá-los sem querer, num passo sobre mesas e
 * complementos, quebraria uma loja que já emite nota.
 *
 * `recommend` vazio ou ausente significa "aparece, mas desmarcado": o recurso existe e o
 * lojista pode querer, só não dá para inferir isso das respostas.
 */
export interface WizardFeature {
  key: string;
  label: string;
  hint: string;
  recommend?: { usage?: OnboardingUsage[]; businessType?: OnboardingBusinessType[] };
}

const WIZARD_FEATURES: WizardFeature[] = [
  {
    key: 'comandas.mesas',
    label: 'Mesas e comandas',
    hint: 'Abre uma comanda por mesa e só vira venda no fechamento.',
    recommend: { usage: ['mesas', 'ambos'] },
  },
  {
    key: 'foodservice.cozinha',
    label: 'Painel da cozinha (KDS)',
    hint: 'Manda o pedido para uma tela na cozinha em vez de papel.',
    recommend: { usage: ['mesas', 'ambos'], businessType: ['restaurante', 'padaria'] },
  },
  {
    key: 'commercial.complementos',
    label: 'Complementos e opcionais',
    hint: 'Bacon extra, escolha do sabor, ponto da carne — perguntado na hora da venda.',
    recommend: { businessType: ['restaurante', 'padaria'] },
  },
  {
    key: 'commercial.variantes',
    label: 'Grade de variações',
    hint: 'Um produto com tamanho e cor, cada combinação com seu preço e estoque.',
    recommend: { businessType: ['roupas'] },
  },
  {
    key: 'commercial.kits',
    label: 'Kits e combos',
    hint: 'Vende vários produtos como um item só, baixando o estoque de cada um.',
    recommend: { businessType: ['restaurante', 'padaria', 'mercado'] },
  },
  {
    key: 'commercial.producao',
    label: 'Ficha técnica',
    hint: 'O que é produzido consome os insumos do estoque automaticamente na venda.',
    recommend: { businessType: ['padaria'] },
  },
];

/** Uma feature é recomendada quando TODAS as regras declaradas batem com as respostas. */
function isRecommended(f: WizardFeature, usage: OnboardingUsage, businessType: OnboardingBusinessType): boolean {
  const rules = f.recommend;
  if (!rules || (!rules.usage && !rules.businessType)) return false;
  if (rules.usage && !rules.usage.includes(usage)) return false;
  if (rules.businessType && !rules.businessType.includes(businessType)) return false;
  return true;
}

export interface WizardFeatureView extends WizardFeature {
  /** Estado atual no banco — o assistente reaberto mostra o que está ligado hoje. */
  enabled: boolean;
}

/**
 * Só o que existe de fato: capability registrada por um módulo carregado E cujo módulo
 * está no plano contratado. Oferecer um recurso fora do plano seria prometer uma tela
 * que o `requireModuleEntitlement` devolve 403 depois.
 */
export function listFeaturesForWizard(): WizardFeatureView[] {
  const existing = new Map(listCapabilities().map((c) => [c.key, c]));
  return WIZARD_FEATURES.flatMap((f) => {
    const cap = existing.get(f.key);
    if (!cap || !isModuleEntitled(cap.module)) return [];
    return [{ ...f, enabled: cap.enabled === 1 }];
  });
}

/**
 * Liga e DESLIGA os recursos do assistente de uma vez.
 *
 * Desligar é tão importante quanto ligar: quem responde "só balcão, loja de roupas" não
 * deve encontrar mesas e complementos ocupando o menu. Como o conjunto tocado é fechado
 * (WIZARD_FEATURES), nenhum recurso fora dele é mexido.
 */
function applyFeatures(
  req: Request,
  selected: string[] | undefined,
  usage: OnboardingUsage,
  businessType: OnboardingBusinessType,
): { enabled: string[]; disabled: string[]; active: Set<string> } {
  const available = listFeaturesForWizard();
  const wanted = new Set(
    selected ?? available.filter((f) => isRecommended(f, usage, businessType)).map((f) => f.key),
  );

  const enabled: string[] = [];
  const disabled: string[] = [];
  const active = new Set<string>();
  for (const f of available) {
    const shouldBeOn = wanted.has(f.key);
    if (shouldBeOn === f.enabled) {
      if (shouldBeOn) active.add(f.key);
      continue;
    }
    try {
      setCapabilityEnabled(req, f.key, shouldBeOn);
      (shouldBeOn ? enabled : disabled).push(f.label);
      if (shouldBeOn) active.add(f.key);
    } catch (e) {
      console.error(`[onboarding] não deu pra ${shouldBeOn ? 'ligar' : 'desligar'} a capability ${f.key}:`, e);
      if (f.enabled) active.add(f.key);
    }
  }
  return { enabled, disabled, active };
}

/**
 * Manda o perfil respondido no assistente para o cloud/ (`PUT /api/license/business-profile`).
 *
 * Best-effort em todos os sentidos: sem licença ativada não há empresa lá para atualizar, e
 * qualquer erro de rede morre no console. Nada aqui pode impedir o lojista de terminar o
 * assistente — o perfil é pesquisa nossa, não requisito dele.
 */
async function enviarPerfilParaNuvem(perfil: {
  name: string | null;
  businessType: string;
  employeeRange: string | null;
}): Promise<void> {
  try {
    const { companyUuid, licenseKey } = getLicenseCredentials();
    if (!companyUuid || !licenseKey) return;
    const base = getCloudServerUrl();
    if (!base) return;
    const res = await fetch(`${base}/api/license/business-profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Kivo-Company': companyUuid,
        'X-Kivo-License-Key': licenseKey,
      },
      body: JSON.stringify(perfil),
    });
    if (!res.ok) {
      console.error(`[onboarding] perfil do negócio não subiu para a nuvem: ${res.status}`);
    }
  } catch (e) {
    console.error('[onboarding] perfil do negócio não subiu para a nuvem:', e);
  }
}

export interface OnboardingStatus {
  completed: boolean;
  demoDataCreated: boolean;
  /** Respostas já gravadas — o assistente reaberto abre com elas preenchidas em vez de em branco. */
  businessName: string;
  businessType: string | null;
  employeeRange: string | null;
  usage: string | null;
}

export function getOnboardingStatus(): OnboardingStatus {
  return {
    completed: settingsRepository.getBool(COMPLETED_KEY, false),
    demoDataCreated: settingsRepository.getBool(DEMO_DATA_KEY, false),
    businessName: settingsRepository.get(COMPANY_NAME_KEY) ?? '',
    businessType: settingsRepository.get(BUSINESS_TYPE_KEY) ?? null,
    employeeRange: settingsRepository.get(EMPLOYEE_RANGE_KEY) ?? null,
    usage: settingsRepository.get(USAGE_KEY) ?? null,
  };
}

export function markOnboardingCompleted(): void {
  settingsRepository.set(COMPLETED_KEY, '1');
}

export function resetDemoData(): void {
  settingsRepository.set(DEMO_DATA_KEY, '0');
}

export function listPaymentMethodsForWizard() {
  return paymentMethodRepository.listAll();
}

function applyPaymentMethods(activeIds: number[]): string[] {
  const all = paymentMethodRepository.listAll() as { id: number; name: string; active: number }[];
  const activeSet = new Set(activeIds);
  const activeNames: string[] = [];
  for (const pm of all) {
    const shouldBeActive = activeSet.has(pm.id);
    if (shouldBeActive !== (pm.active === 1)) {
      paymentMethodRepository.update(pm.id, { active: shouldBeActive ? 1 : 0 });
    }
    if (shouldBeActive) activeNames.push(pm.name);
  }
  return activeNames;
}

function createTables(count: number): number {
  if (storeTableRepository.findAll().length > 0) return 0;
  for (let i = 1; i <= count; i++) {
    storeTableRepository.create({
      label: `Mesa ${String(i).padStart(2, '0')}`,
      sort_order: i - 1,
      uuid: randomUUID(),
      origin_machine: null,
    });
  }
  return count;
}

function createSimpleProduct(name: string, priceCents: number, unit = 'un', categoryId?: number): number {
  return productRepository.create({
    name, unit, price_cents: priceCents, cost_cents: 0, product_type: 'fisico', track_stock: 0, category_id: categoryId ?? null, uuid: randomUUID(),
  } as Record<string, unknown>);
}

function attachComplementGroup(sellableProductId: number, groupName: string, minSelect: number, maxSelect: number | null, items: { name: string; priceCents: number }[]): void {
  const groupId = complementGroupRepository.create({ name: groupName, min_select: minSelect, max_select: maxSelect, uuid: randomUUID() });
  items.forEach((item, idx) => {
    const productId = createSimpleProduct(item.name, 0);
    complementItemRepository.create({
      group_id: groupId, product_id: productId,
      price_override_cents: item.priceCents, sort_order: idx, uuid: randomUUID(),
    });
  });
  productComplementGroupRepository.create({ product_id: sellableProductId, group_id: groupId, sort_order: 0, uuid: randomUUID() });
}

function getOrCreateCategory(name: string): number {
  const existing = categoryRepository.rawOne('SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL', name) as { id: number } | undefined;
  if (existing) return existing.id;
  return categoryRepository.create({ name, parent_id: null, uuid: randomUUID() });
}

function createRestauranteDemoProducts(withComplements: boolean): number {
  let count = 0;

  // Criar/obter categorias
  const catHamburgueres = getOrCreateCategory('Hambúrgueres');
  const catBebidas = getOrCreateCategory('Bebidas');
  const catAcompanhamentos = getOrCreateCategory('Acompanhamentos');

  const suco = createSimpleProduct('Suco Natural', 800, 'un', catBebidas);
  count += 1;
  if (withComplements) {
    attachComplementGroup(suco, 'Sabor do suco', 1, 1, [
      { name: 'Laranja', priceCents: 0 },
      { name: 'Abacaxi', priceCents: 0 },
      { name: 'Morango', priceCents: 100 },
    ]);
    count += 3;
  }

  const lanche = createSimpleProduct('Lanche Completo (X-Burger)', 1800, 'un', catHamburgueres);
  count += 1;
  if (withComplements) {
    attachComplementGroup(lanche, 'Adicionais', 0, 4, [
      { name: 'Bacon extra', priceCents: 300 },
      { name: 'Queijo extra', priceCents: 200 },
      { name: 'Ovo', priceCents: 200 },
      { name: 'Salada extra', priceCents: 0 },
    ]);
    count += 4;
  }

  createSimpleProduct('Refrigerante Lata', 600, 'un', catBebidas);
  createSimpleProduct('Batata Frita', 1200, 'un', catAcompanhamentos);
  count += 2;

  return count;
}

function createRoupasDemoProducts(): number {
  const tamanhoId = productAttributeRepository.create({ name: 'Tamanho', uuid: randomUUID() });
  const corId = productAttributeRepository.create({ name: 'Cor', uuid: randomUUID() });

  const tamanhoValues = ['P', 'M', 'G', 'GG'].map((v, i) =>
    productAttributeValueRepository.create({ attribute_id: tamanhoId, value: v, sort_order: i, uuid: randomUUID() }));
  const corValues = ['Branco', 'Preto', 'Azul'].map((v, i) =>
    productAttributeValueRepository.create({ attribute_id: corId, value: v, sort_order: i, uuid: randomUUID() }));

  let count = 0;
  count += generateVariantProduct('Camiseta Básica', 4990, [
    { attributeId: tamanhoId, valueIds: tamanhoValues },
    { attributeId: corId, valueIds: corValues },
  ]);
  count += generateVariantProduct('Calça Jeans', 12990, [
    { attributeId: tamanhoId, valueIds: tamanhoValues },
  ]);
  return count;
}

function generateVariantProduct(name: string, priceCents: number, attributeGroups: { attributeId: number; valueIds: number[] }[]): number {
  const parentId = productRepository.create({
    name, unit: 'un', price_cents: priceCents, cost_cents: 0, product_type: 'variante', track_stock: 0, uuid: randomUUID(),
  } as Record<string, unknown>);

  const combos = cartesian(attributeGroups.map((g) => g.valueIds.map((valueId) => ({ attributeId: g.attributeId, valueId }))));
  let created = 1; // produto pai
  for (const combo of combos) {
    const values = productAttributeValueRepository.findByIds(combo.map((c) => c.valueId)) as { id: number; value: string }[];
    const suffix = values.map((v) => v.value).join(', ');
    const variantId = productRepository.create({
      name: `${name} - ${suffix}`, parent_product_id: parentId, product_type: 'variante',
      unit: 'un', price_cents: priceCents, cost_cents: 0, track_stock: 1, min_stock: 0, active: 1, uuid: randomUUID(),
    } as Record<string, unknown>);
    for (const c of combo) {
      productVariantValueRepository.create({
        product_id: variantId, attribute_id: c.attributeId, attribute_value_id: c.valueId, uuid: randomUUID(),
      } as Record<string, unknown>);
    }
    created++;
  }
  return created;
}

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

function createDemoCategories(): number {
  // Categorias de exemplo para restaurante
  const categorias = [
    { name: 'Hambúrgueres', image_url: null },
    { name: 'Bebidas', image_url: null },
    { name: 'Acompanhamentos', image_url: null },
    { name: 'Sobremesas', image_url: null },
  ];

  let count = 0;
  for (const cat of categorias) {
    const existing = categoryRepository.rawOne('SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL', cat.name);
    if (!existing) {
      categoryRepository.create({ name: cat.name, parent_id: null, uuid: randomUUID() });
      count++;
    }
  }
  return count;
}

export function provision(req: Request, input: ProvisionInput): ProvisionResult {
  settingsRepository.set(USAGE_KEY, input.usage);
  settingsRepository.set(BUSINESS_TYPE_KEY, input.businessType);

  // O nome do negócio mora na MESMA chave da tela de Configurações → Empresa, e não numa
  // `onboarding.*` própria: é o nome que sai no cabeçalho do cupom e do orçamento, então
  // duplicá-lo criaria dois lugares para editar a mesma coisa, fatalmente divergentes.
  // Só grava se veio preenchido — reabrir o assistente e deixar o campo vazio não pode
  // apagar um nome já cadastrado.
  const nome = (input.businessName ?? '').trim();
  if (nome) settingsRepository.set(COMPANY_NAME_KEY, nome);
  if (input.employeeRange && EMPLOYEE_RANGES.includes(input.employeeRange)) {
    settingsRepository.set(EMPLOYEE_RANGE_KEY, input.employeeRange);
  }

  // Envio do perfil para a nuvem: disparado e esquecido, de propósito. É dado de pesquisa —
  // travar a conclusão do assistente (ou pior, falhá-la) porque a internet caiu seria
  // trocar o cadastro da loja por uma estatística.
  void enviarPerfilParaNuvem({
    name: nome || null,
    businessType: input.businessType,
    employeeRange: input.employeeRange ?? null,
  });

  const paymentMethodsActive = applyPaymentMethods(input.activePaymentMethodIds);

  /**
   * Fora do bloco de dados de exemplo, de propósito. Antes os recursos só eram ligados
   * junto com os produtos de demonstração — quem dispensava a demonstração (ou reabria o
   * assistente depois, quando o `demo_data_created` já estava marcado) terminava o
   * assistente com mesas e complementos desligados, mesmo tendo respondido que atende em
   * mesas. Responder é o que configura; a demonstração é só brinde.
   */
  const features = applyFeatures(req, input.activeFeatureKeys, input.usage, input.businessType);

  let tablesCreated = 0;
  let productsCreated = 0;

  if (input.resetDemoData) {
    settingsRepository.set(DEMO_DATA_KEY, '0');
  }

  // Se resetDemoData ou se ainda não criou demo data, permite criar
  const shouldCreateDemo = input.createDemoData && (input.resetDemoData || !settingsRepository.getBool(DEMO_DATA_KEY, false));

  if (shouldCreateDemo) {
    // A demonstração segue os recursos que ficaram LIGADOS, não as respostas cruas: sem
    // isso, quem desmarcasse "Complementos" ainda receberia sucos com grupo de sabor que
    // o PDV não mostraria, e as 10 mesas apareceriam num sistema sem o módulo de mesas.
    if (features.active.has('comandas.mesas')) tablesCreated = createTables(10);
    if (input.businessType === 'restaurante') {
      productsCreated = createRestauranteDemoProducts(features.active.has('commercial.complementos'));
    } else if (input.businessType === 'roupas' && features.active.has('commercial.variantes')) {
      productsCreated = createRoupasDemoProducts();
    }
    // Criar categorias de exemplo com imagens
    productsCreated += createDemoCategories();
    settingsRepository.set(DEMO_DATA_KEY, '1');
  }

  markOnboardingCompleted();

  return {
    tablesCreated,
    productsCreated,
    paymentMethodsActive,
    featuresEnabled: features.enabled,
    featuresDisabled: features.disabled,
  };
}
