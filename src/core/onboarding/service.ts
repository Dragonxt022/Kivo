import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';
import { setCapabilityEnabled } from '../capabilities/service';
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

export type OnboardingUsage = 'balcao' | 'mesas' | 'ambos';
export type OnboardingBusinessType = 'restaurante' | 'roupas' | 'outro';

export interface ProvisionInput {
  usage: OnboardingUsage;
  businessType: OnboardingBusinessType;
  activePaymentMethodIds: number[];
  createDemoData: boolean;
  resetDemoData?: boolean;
}

export interface ProvisionResult {
  tablesCreated: number;
  productsCreated: number;
  paymentMethodsActive: string[];
}

export function getOnboardingStatus(): { completed: boolean; demoDataCreated: boolean } {
  return {
    completed: settingsRepository.getBool(COMPLETED_KEY, false),
    demoDataCreated: settingsRepository.getBool(DEMO_DATA_KEY, false),
  };
}

export function markOnboardingCompleted(): void {
  settingsRepository.set(COMPLETED_KEY, '1');
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

function createSimpleProduct(name: string, priceCents: number, unit = 'un'): number {
  return productRepository.create({
    name, unit, price_cents: priceCents, cost_cents: 0, product_type: 'fisico', track_stock: 0, uuid: randomUUID(),
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

function createRestauranteDemoProducts(): number {
  let count = 0;

  const suco = createSimpleProduct('Suco Natural', 800);
  attachComplementGroup(suco, 'Sabor do suco', 1, 1, [
    { name: 'Laranja', priceCents: 0 },
    { name: 'Abacaxi', priceCents: 0 },
    { name: 'Morango', priceCents: 100 },
  ]);
  count += 4; // suco + 3 sabores

  const lanche = createSimpleProduct('Lanche Completo (X-Burger)', 1800);
  attachComplementGroup(lanche, 'Adicionais', 0, 4, [
    { name: 'Bacon extra', priceCents: 300 },
    { name: 'Queijo extra', priceCents: 200 },
    { name: 'Ovo', priceCents: 200 },
    { name: 'Salada extra', priceCents: 0 },
  ]);
  count += 5; // lanche + 4 adicionais

  createSimpleProduct('Refrigerante Lata', 600);
  createSimpleProduct('Batata Frita', 1200);
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

function tryEnableCapability(req: Request, key: string): void {
  try { setCapabilityEnabled(req, key, true); } catch (e) {
    console.error(`[onboarding] não deu pra ligar a capability ${key}:`, e);
  }
}

export function provision(req: Request, input: ProvisionInput): ProvisionResult {
  settingsRepository.set(USAGE_KEY, input.usage);
  settingsRepository.set(BUSINESS_TYPE_KEY, input.businessType);

  const paymentMethodsActive = applyPaymentMethods(input.activePaymentMethodIds);

  let tablesCreated = 0;
  let productsCreated = 0;

  if (input.resetDemoData) {
    settingsRepository.set(DEMO_DATA_KEY, '0');
  }

  // Se resetDemoData ou se ainda não criou demo data, permite criar
  const shouldCreateDemo = input.createDemoData && (input.resetDemoData || !settingsRepository.getBool(DEMO_DATA_KEY, false));

  if (shouldCreateDemo) {
    const wantsTables = (input.usage === 'mesas' || input.usage === 'ambos') && input.businessType !== 'roupas';
    if (wantsTables) {
      tryEnableCapability(req, 'comandas.mesas');
      tablesCreated = createTables(10);
    }
    if (input.businessType === 'restaurante') {
      tryEnableCapability(req, 'commercial.complementos');
      productsCreated = createRestauranteDemoProducts();
    } else if (input.businessType === 'roupas') {
      tryEnableCapability(req, 'commercial.variantes');
      productsCreated = createRoupasDemoProducts();
    }
    // Criar categorias de exemplo com imagens
    productsCreated += createDemoCategories();
    settingsRepository.set(DEMO_DATA_KEY, '1');
  }

  markOnboardingCompleted();

  return { tablesCreated, productsCreated, paymentMethodsActive };
}
