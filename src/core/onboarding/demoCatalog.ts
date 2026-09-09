import { randomUUID } from 'node:crypto';

import { productRepository } from '../../modules/commercial/repositories/ProductRepository';
import { categoryRepository } from '../../modules/commercial/repositories/CategoryRepository';
import {
  complementGroupRepository, complementItemRepository, productComplementGroupRepository,
} from '../../modules/commercial/repositories/ComplementRepository';
import {
  productAttributeRepository, productAttributeValueRepository, productVariantValueRepository,
} from '../../modules/commercial/repositories/AttributeRepository';
import { kitItemRepository } from '../../modules/commercial/repositories/KitRepository';
import { recipeItemRepository } from '../../modules/commercial/repositories/RecipeRepository';
import { kitchenRoutingRepository } from '../../modules/foodservice/repositories/KitchenRepository';
import type { OnboardingBusinessType } from './service';

/**
 * Catálogo de demonstração por ramo.
 *
 * O assistente de configuração pergunta qual é o ramo do negócio e gera um ambiente de
 * teste coerente com ele — categorias + produtos que cobrem os TIPOS de cadastro que
 * aquele ramo usa de verdade, em vez de despejar "produto simples" genérico em todo mundo.
 *
 * A intenção é o lojista conseguir testar o Kivo sem cadastrar nada: abrir o PDV, lançar
 * num cardápio com complementos, vender um combo que explode nos componentes, ver o
 * pedido cair no painel da cozinha, ou uma ficha técnica consumindo insumo. Cada tipo de
 * produto nasce aqui do mesmo jeito que a tela criaria (mesmas tabelas, mesmas regras),
 * então o que o lojista vê no teste é exatamente o que ele vai operar depois.
 *
 * Reexecução segura (botão "Regenerar dados de exemplo"): nenhum item é duplicado. Toda
 * criação é "garante que existe" por nome — se o produto/grupo/roteamento já existe, ele
 * é reaproveitado e apenas o que faltar é completado.
 */

export interface DemoFlags {
  /** commercial.complementos — grupos de opcionais perguntados na hora da venda. */
  complementos: boolean;
  /** commercial.kits — produtos kit e combo (mesma capability). */
  kits: boolean;
  /** commercial.variantes — grade de variações (pai + filhas). */
  variantes: boolean;
  /** commercial.producao — ficha técnica (produto produzido consome insumos). */
  producao: boolean;
  /** foodservice.cozinha — painel de produção (roteamento de produtos). */
  kitchen: boolean;
}

export interface DemoCounts {
  /** Total de linhas de produto criadas (simples, complementos, filhas, kits…). */
  productsCreated: number;
  categoriesCreated: number;
  /** Produtos que passaram a gerar pedido no painel de cozinha. */
  kitchenRoutesCreated: number;
}

type ProductType =
  | 'fisico' | 'servico' | 'kit' | 'combo' | 'produzido' | 'variante';

interface EnsureProductOpts {
  name: string;
  type: ProductType;
  /** Categoria por nome. Ausente = produto sem categoria (itens de complemento). */
  category?: string;
  priceCents: number;
  costCents?: number;
  unit?: string;
  /** Controle de estoque. Produto de demonstração nasce SEM estoque (só os insumos da
   *  ficha técnica controlam, para a baixa automática aparecer no teste). */
  trackStock?: boolean;
}

interface DemoRun {
  flags: DemoFlags;
  productsCreated: number;
  categoriesCreated: number;
  kitchenRoutesCreated: number;
}

interface KitComponent { productId: number; qty: number }

/** Cria a categoria se ainda não existir (por nome) e devolve o id. */
function category(run: DemoRun, name: string): number {
  const existing = categoryRepository.rawOne(
    'SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL LIMIT 1', name,
  ) as { id: number } | undefined;
  if (existing) return existing.id;
  const id = categoryRepository.create({ name, parent_id: null, uuid: randomUUID() });
  run.categoriesCreated++;
  return id;
}

/** Ponto único de criação de produto. `created` false quando já existia (sem duplicar). */
function ensureProduct(run: DemoRun, opts: EnsureProductOpts): { id: number; created: boolean } {
  const existing = productRepository.rawOne(
    `SELECT id FROM products
     WHERE name = ? AND product_type = ? AND deleted_at IS NULL LIMIT 1`,
    opts.name, opts.type,
  ) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };

  const id = productRepository.create({
    name: opts.name,
    description: null,
    sku: null,
    barcode: null,
    category_id: opts.category ? category(run, opts.category) : null,
    unit: opts.unit ?? 'un',
    price_cents: Math.round(opts.priceCents),
    cost_cents: Math.round(opts.costCents ?? 0),
    track_stock: opts.trackStock ? 1 : 0,
    min_stock: 0,
    active: 1,
    product_type: opts.type,
    parent_product_id: null,
    uuid: randomUUID(),
  } as Record<string, unknown>);
  run.productsCreated++;
  return { id, created: true };
}

/** Insumo da ficha técnica: controla estoque e já nasce com saldo para a venda do
 *  produto produzido conseguir baixar — é o que torna a ficha técnica testável. */
function seedInputStock(id: number, qty: number): void {
  productRepository.updateStock(id, qty);
  productRepository.rawRun(
    `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, uuid)
     VALUES (?, 'ajuste', ?, ?, 'Estoque inicial (produtos de exemplo)', ?)`,
    id, qty, qty, randomUUID(),
  );
}

/** Roteia o produto para o painel de cozinha (tabela kitchen_routing). */
function routeToKitchen(run: DemoRun, productId: number, station: string, minutes: number): void {
  const existing = kitchenRoutingRepository.rawOne(
    'SELECT id FROM kitchen_routing WHERE product_id = ? AND deleted_at IS NULL', productId,
  ) as { id: number } | undefined;
  if (existing) return;
  kitchenRoutingRepository.create({
    product_id: productId, station, estimated_minutes: minutes, uuid: randomUUID(),
  });
  run.kitchenRoutesCreated++;
}

/** Prende um item (componente) a um produto kit/combo — sem duplicar. */
function attachKitComponent(kitProductId: number, componentProductId: number, qty: number, sort: number): void {
  const existing = kitItemRepository.rawOne(
    `SELECT id FROM kit_items
     WHERE kit_product_id = ? AND component_product_id = ? AND deleted_at IS NULL`,
    kitProductId, componentProductId,
  ) as { id: number } | undefined;
  if (existing) return;
  kitItemRepository.create({
    kit_product_id: kitProductId, component_product_id: componentProductId,
    qty, sort_order: sort, uuid: randomUUID(),
  });
}

/** Prende um insumo à ficha técnica de um produto produzido — sem duplicar. */
function attachRecipeInput(producedProductId: number, inputProductId: number, qty: number): void {
  const existing = recipeItemRepository.rawOne(
    `SELECT id FROM product_recipe_items
     WHERE produced_product_id = ? AND input_product_id = ? AND deleted_at IS NULL`,
    producedProductId, inputProductId,
  ) as { id: number } | undefined;
  if (existing) return;
  recipeItemRepository.create({
    produced_product_id: producedProductId, input_product_id: inputProductId,
    qty, sort_order: 0, uuid: randomUUID(),
  });
}

/**
 * Anexa um grupo de complementos a um produto vendável. Os itens do grupo são produtos
 * de preço 0 — quem cobra a mais (Morango +R$1) cobra no `price_override_cents` do item,
 * o mesmo padrão da tela de complementos.
 */
function attachComplementGroup(
  run: DemoRun, productId: number, groupName: string,
  minSelect: number, maxSelect: number | null,
  items: { name: string; priceCents: number }[],
): void {
  const linked = productComplementGroupRepository.rawOne(
    `SELECT pcg.id FROM product_complement_groups pcg
     JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
     WHERE pcg.product_id = ? AND cg.name = ? AND pcg.deleted_at IS NULL LIMIT 1`,
    productId, groupName,
  ) as { id: number } | undefined;
  if (linked) return;

  const groupId = complementGroupRepository.create({
    name: groupName, min_select: minSelect, max_select: maxSelect, uuid: randomUUID(),
  });
  items.forEach((item, idx) => {
    const itemProduct = ensureProduct(run, {
      name: item.name, type: 'fisico', priceCents: 0, unit: 'un',
    });
    complementItemRepository.create({
      group_id: groupId, product_id: itemProduct.id,
      price_override_cents: Math.round(item.priceCents), sort_order: idx, uuid: randomUUID(),
    });
  });
  productComplementGroupRepository.create({
    product_id: productId, group_id: groupId, sort_order: 0, uuid: randomUUID(),
  });
}

interface AttributeSpec {
  name: string;
  values: string[];
}

/**
 * Gera a grade (pai + filhas) de um produto com variações. `priceCents` vira o preço de
 * cada filha. Só roda com a capability de variações ligada — pai sem filha gerada é um
 * produto preso, e é exatamente o cenário que o recurso desligado causa.
 */
function ensureVariantProduct(
  run: DemoRun, name: string, categoryName: string,
  priceCents: number, attributes: AttributeSpec[],
): void {
  // Atributos são globais (Tamanho, Cor, Numeração…) — garante que existem e devolve ids.
  const resolved = attributes.map((attr) => {
    let attrId = productAttributeRepository.rawOne(
      'SELECT id FROM product_attributes WHERE name = ? AND deleted_at IS NULL', attr.name,
    ) as { id: number } | undefined;
    if (!attrId) {
      attrId = { id: productAttributeRepository.create({ name: attr.name, uuid: randomUUID() }) };
    }
    const valueIds = attr.values.map((value, idx) => {
      const existing = productAttributeValueRepository.rawOne(
        `SELECT id FROM product_attribute_values
         WHERE attribute_id = ? AND value = ? AND deleted_at IS NULL`, attrId!.id, value,
      ) as { id: number } | undefined;
      if (existing) return existing.id;
      return productAttributeValueRepository.create({
        attribute_id: attrId!.id, value, sort_order: idx, uuid: randomUUID(),
      });
    });
    return { attributeId: attrId!.id, valueIds };
  });

  const parent = ensureProduct(run, {
    name, type: 'variante', category: categoryName, priceCents,
    costCents: 0, trackStock: false,
  });
  if (!parent.created) return; // grade inteira já existia — não recria as filhas

  const combos = cartesian(resolved.map((g) => g.valueIds));
  for (const combo of combos) {
    const valueRows = productAttributeValueRepository.findByIds(combo) as
      { id: number; value: string }[];
    const valueById = new Map(valueRows.map((v) => [v.id, v.value]));
    const suffix = combo.map((id) => valueById.get(id) ?? String(id)).join(', ');
    const childId = productRepository.create({
      name: `${name} - ${suffix}`,
      sku: null, barcode: null, parent_product_id: parent.id, product_type: 'variante',
      category_id: category(run, categoryName), unit: 'un',
      price_cents: Math.round(priceCents), cost_cents: 0, track_stock: 1, min_stock: 0,
      active: 1, uuid: randomUUID(),
    } as Record<string, unknown>);
    run.productsCreated++;
    combo.forEach((valueId, attrIdx) => {
      productVariantValueRepository.create({
        product_id: childId, attribute_id: resolved[attrIdx].attributeId,
        attribute_value_id: valueId, uuid: randomUUID(),
      } as Record<string, unknown>);
    });
  }
}

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

/** Combo promocional (preço fechado abaixo da soma) a partir de itens existentes. */
function ensureCombo(
  run: DemoRun, name: string, priceCents: number, components: KitComponent[],
): void {
  const combo = ensureProduct(run, {
    name, type: 'combo', category: 'Kits e Combos', priceCents, trackStock: false,
  });
  if (!combo.created) return;
  components.forEach((c, idx) => attachKitComponent(combo.id, c.productId, c.qty, idx));
}

/** Kit (conjunto vendido como um item, sem desconto) a partir de itens existentes. */
function ensureKit(run: DemoRun, name: string, priceCents: number, components: KitComponent[]): void {
  const kit = ensureProduct(run, {
    name, type: 'kit', category: 'Kits e Combos', priceCents, trackStock: false,
  });
  if (!kit.created) return;
  components.forEach((c, idx) => attachKitComponent(kit.id, c.productId, c.qty, idx));
}

// ────────────────────────────────────────────────────────────────────────────────────────
// Catálogos por ramo
// ────────────────────────────────────────────────────────────────────────────────────────

function restaurante(run: DemoRun): void {
  // Simples (físico) — vira ticket de cozinha quando o painel está ligado.
  const suco = ensureProduct(run, { name: 'Suco Natural 500ml', type: 'fisico', category: 'Bebidas', priceCents: 800 });
  if (run.flags.complementos) {
    attachComplementGroup(run, suco.id, 'Sabor do suco', 1, 1, [
      { name: 'Laranja', priceCents: 0 },
      { name: 'Abacaxi', priceCents: 0 },
      { name: 'Morango', priceCents: 150 },
    ]);
  }
  const xBurger = ensureProduct(run, { name: 'X-Burger', type: 'fisico', category: 'Hambúrgueres', priceCents: 1800 });
  if (run.flags.complementos) {
    attachComplementGroup(run, xBurger.id, 'Adicionais do lanche', 0, 4, [
      { name: 'Bacon extra', priceCents: 300 },
      { name: 'Queijo extra', priceCents: 200 },
      { name: 'Ovo', priceCents: 200 },
      { name: 'Salada extra', priceCents: 0 },
    ]);
  }
  const batata = ensureProduct(run, { name: 'Batata Frita 300g', type: 'fisico', category: 'Acompanhamentos', priceCents: 1400 });
  const refri = ensureProduct(run, { name: 'Refrigerante Lata 350ml', type: 'fisico', category: 'Bebidas', priceCents: 600 });
  ensureProduct(run, { name: 'Anéis de Cebola', type: 'fisico', category: 'Acompanhamentos', priceCents: 1600 });
  ensureProduct(run, { name: 'Salada Caesar', type: 'fisico', category: 'Acompanhamentos', priceCents: 1800 });
  ensureProduct(run, { name: 'Brownie', type: 'fisico', category: 'Sobremesas', priceCents: 800 });
  ensureProduct(run, { name: 'Pudim de Leite', type: 'fisico', category: 'Sobremesas', priceCents: 900 });

  if (run.flags.kitchen) {
    routeToKitchen(run, xBurger.id, 'Chapa', 12);
    routeToKitchen(run, batata.id, 'Frituras', 8);
  }

  // Combo (tipo 'combo') — preço fechado abaixo da soma das partes.
  if (run.flags.kits) {
    ensureCombo(run, 'Combo X-Burger', 2800, [
      { productId: xBurger.id, qty: 1 },
      { productId: batata.id, qty: 1 },
      { productId: refri.id, qty: 1 },
    ]);
  }

  // Grade de variações — pizzaria dentro do restaurante.
  if (run.flags.variantes) {
    ensureVariantProduct(run, 'Pizza Artesanal', 'Pizzas', 3490, [
      { name: 'Tamanho da Pizza', values: ['Média', 'Grande'] },
      { name: 'Sabor da Pizza', values: ['Mussarela', 'Calabresa', 'Portuguesa'] },
    ]);
  }
}

function padaria(run: DemoRun): void {
  const paoFrances = ensureProduct(run, { name: 'Pão Francês (kg)', type: 'fisico', category: 'Pães e Salgados', priceCents: 1890, unit: 'kg' });
  const paoDeQueijo = ensureProduct(run, { name: 'Pão de Queijo (un)', type: 'fisico', category: 'Pães e Salgados', priceCents: 350 });
  const coxinha = ensureProduct(run, { name: 'Coxinha', type: 'fisico', category: 'Pães e Salgados', priceCents: 700 });
  const esfiha = ensureProduct(run, { name: 'Esfiha de Carne', type: 'fisico', category: 'Pães e Salgados', priceCents: 650 });
  const boloCenoura = ensureProduct(run, { name: 'Bolo de Cenoura (fatia)', type: 'fisico', category: 'Bolos e Tortas', priceCents: 700 });
  const sucoLaranja = ensureProduct(run, { name: 'Suco de Laranja 300ml', type: 'fisico', category: 'Bebidas e Cafés', priceCents: 600 });
  ensureProduct(run, { name: 'Baguete', type: 'fisico', category: 'Pães e Salgados', priceCents: 500 });

  // Café com complementos — o teste clássico de opcionais.
  const cafe = ensureProduct(run, { name: 'Café Expresso', type: 'fisico', category: 'Bebidas e Cafés', priceCents: 500 });
  if (run.flags.complementos) {
    attachComplementGroup(run, cafe.id, 'No café', 0, 3, [
      { name: 'Leite', priceCents: 100 },
      { name: 'Creme de leite', priceCents: 150 },
      { name: 'Chantilly', priceCents: 250 },
    ]);
    attachComplementGroup(run, paoDeQueijo.id, 'Adicionais do pão de queijo', 0, 2, [
      { name: 'Manteiga', priceCents: 0 },
      { name: 'Queijo minas', priceCents: 250 },
    ]);
  }

  // Produzido com ficha técnica — vender o bolo baixa farinha/chocolate/ovos.
  if (run.flags.producao) {
    const farinha = ensureProduct(run, { name: 'Farinha de Trigo 1kg (insumo)', type: 'fisico', priceCents: 0, costCents: 700, trackStock: true, unit: 'kg' });
    const chocolate = ensureProduct(run, { name: 'Chocolate em Pó 500g (insumo)', type: 'fisico', priceCents: 0, costCents: 900, trackStock: true });
    const ovos = ensureProduct(run, { name: 'Ovos (dúzia) — insumo', type: 'fisico', priceCents: 0, costCents: 1200, trackStock: true });
    const bolo = ensureProduct(run, { name: 'Bolo de Chocolate', type: 'produzido', category: 'Bolos e Tortas', priceCents: 2900 });
    if (farinha.created) seedInputStock(farinha.id, 50);
    if (chocolate.created) seedInputStock(chocolate.id, 30);
    if (ovos.created) seedInputStock(ovos.id, 20);
    if (bolo.created) {
      attachRecipeInput(bolo.id, farinha.id, 0.5);
      attachRecipeInput(bolo.id, chocolate.id, 0.1);
      attachRecipeInput(bolo.id, ovos.id, 0.25);
    }
    if (run.flags.kitchen) routeToKitchen(run, bolo.id, 'Confeitaria', 30);
  }

  // Kit — "café da manhã" junta pão de queijo + suco + café num item só.
  if (run.flags.kits) {
    ensureKit(run, 'Kit Café da Manhã', 1400, [
      { productId: paoDeQueijo.id, qty: 2 },
      { productId: sucoLaranja.id, qty: 1 },
      { productId: cafe.id, qty: 1 },
    ]);
  }

  if (run.flags.kitchen) {
    routeToKitchen(run, paoFrances.id, 'Padaria', 3);
    routeToKitchen(run, paoDeQueijo.id, 'Padaria', 3);
    routeToKitchen(run, coxinha.id, 'Frituras', 6);
    routeToKitchen(run, esfiha.id, 'Frituras', 6);
    routeToKitchen(run, boloCenoura.id, 'Confeitaria', 15);
  }
}

function mercado(run: DemoRun): void {
  const arroz = ensureProduct(run, { name: 'Arroz Tipo 1 — 5kg', type: 'fisico', category: 'Mercearia', priceCents: 2490 });
  const feijao = ensureProduct(run, { name: 'Feijão Carioca — 1kg', type: 'fisico', category: 'Mercearia', priceCents: 799 });
  const acucar = ensureProduct(run, { name: 'Açúcar Cristal — 5kg', type: 'fisico', category: 'Mercearia', priceCents: 1599 });
  const oleo = ensureProduct(run, { name: 'Óleo de Soja — 900ml', type: 'fisico', category: 'Mercearia', priceCents: 799 });
  const cafe = ensureProduct(run, { name: 'Café Torrado — 500g', type: 'fisico', category: 'Mercearia', priceCents: 1599 });
  const macarrao = ensureProduct(run, { name: 'Macarrão Espaguete — 500g', type: 'fisico', category: 'Mercearia', priceCents: 499 });

  ensureProduct(run, { name: 'Banana Prata (kg)', type: 'fisico', category: 'Hortifrúti', priceCents: 699, unit: 'kg' });
  ensureProduct(run, { name: 'Maçã Gala (kg)', type: 'fisico', category: 'Hortifrúti', priceCents: 999, unit: 'kg' });
  ensureProduct(run, { name: 'Tomate (kg)', type: 'fisico', category: 'Hortifrúti', priceCents: 799, unit: 'kg' });
  ensureProduct(run, { name: 'Refrigerante Lata 350ml', type: 'fisico', category: 'Bebidas', priceCents: 600 });
  ensureProduct(run, { name: 'Suco de Uva Integral 1L', type: 'fisico', category: 'Bebidas', priceCents: 999 });
  ensureProduct(run, { name: 'Leite Integral 1L', type: 'fisico', category: 'Laticínios e Frios', priceCents: 599 });
  ensureProduct(run, { name: 'Queijo Muçarela 400g', type: 'fisico', category: 'Laticínios e Frios', priceCents: 1699 });
  ensureProduct(run, { name: 'Picanha (kg)', type: 'fisico', category: 'Açougue', priceCents: 6990, unit: 'kg' });
  ensureProduct(run, { name: 'Detergente 500ml', type: 'fisico', category: 'Limpeza', priceCents: 299 });
  ensureProduct(run, { name: 'Papel Higiênico — 4 un', type: 'fisico', category: 'Limpeza', priceCents: 1099 });

  // Padaria interna e rotisseria — frescos roteados para a cozinha.
  const paoFran = ensureProduct(run, { name: 'Pão Francês (kg)', type: 'fisico', category: 'Padaria', priceCents: 1499, unit: 'kg' });
  const frangoAssado = ensureProduct(run, { name: 'Frango Assado Inteiro', type: 'fisico', category: 'Pratos Prontos', priceCents: 2499 });
  if (run.flags.kitchen) {
    routeToKitchen(run, paoFran.id, 'Padaria', 5);
    routeToKitchen(run, frangoAssado.id, 'Rotisseria', 30);
  }

  if (run.flags.kits) {
    ensureKit(run, 'Cesta Básica', 9990, [
      { productId: arroz.id, qty: 2 },
      { productId: feijao.id, qty: 2 },
      { productId: acucar.id, qty: 1 },
      { productId: oleo.id, qty: 1 },
      { productId: cafe.id, qty: 1 },
      { productId: macarrao.id, qty: 2 },
    ]);
  }
}

function conveniencia(run: DemoRun): void {
  const salgadinho = ensureProduct(run, { name: 'Salgadinho de Milho', type: 'fisico', category: 'Snacks', priceCents: 899 });
  const refri = ensureProduct(run, { name: 'Refrigerante Lata 350ml', type: 'fisico', category: 'Bebidas', priceCents: 600 });
  ensureProduct(run, { name: 'Água Mineral 500ml', type: 'fisico', category: 'Bebidas', priceCents: 300 });
  ensureProduct(run, { name: 'Energético 269ml', type: 'fisico', category: 'Bebidas', priceCents: 1299 });
  ensureProduct(run, { name: 'Chocolate ao Leite 90g', type: 'fisico', category: 'Snacks', priceCents: 799 });
  ensureProduct(run, { name: 'Amendoim Torrado 200g', type: 'fisico', category: 'Snacks', priceCents: 499 });
  ensureProduct(run, { name: 'Biscoito Recheado 140g', type: 'fisico', category: 'Mercearia', priceCents: 399 });
  ensureProduct(run, { name: 'Picolé', type: 'fisico', category: 'Gelados', priceCents: 499 });

  // Recarga de celular é o serviço clássico de conveniência — tipo "serviço", sem estoque.
  ensureProduct(run, { name: 'Recarga de Celular', type: 'servico', category: 'Serviços', priceCents: 1000 });

  if (run.flags.kits) {
    ensureCombo(run, 'Combo Salgadinho + Refrigerante', 1199, [
      { productId: salgadinho.id, qty: 1 },
      { productId: refri.id, qty: 1 },
    ]);
  }
}

function adega(run: DemoRun): void {
  const vinhoTinto = ensureProduct(run, { name: 'Vinho Tinto Seco 750ml', type: 'fisico', category: 'Vinhos', priceCents: 3990 });
  const vinhoBranco = ensureProduct(run, { name: 'Vinho Branco Suave 750ml', type: 'fisico', category: 'Vinhos', priceCents: 3490 });
  const espumante = ensureProduct(run, { name: 'Espumante Brut 750ml', type: 'fisico', category: 'Vinhos', priceCents: 5990 });
  ensureProduct(run, { name: 'Vinho Rosé 750ml', type: 'fisico', category: 'Vinhos', priceCents: 4490 });
  const cerveja = ensureProduct(run, { name: 'Cerveja Pilsen Lata 350ml', type: 'fisico', category: 'Cervejas', priceCents: 599 });
  ensureProduct(run, { name: 'Cerveja Artesanal IPA 473ml', type: 'fisico', category: 'Cervejas', priceCents: 1499 });
  ensureProduct(run, { name: 'Cerveja Premium Long Neck 330ml', type: 'fisico', category: 'Cervejas', priceCents: 999 });
  ensureProduct(run, { name: 'Whisky 12 Anos 750ml', type: 'fisico', category: 'Destilados', priceCents: 12990 });
  ensureProduct(run, { name: 'Gin Premium 750ml', type: 'fisico', category: 'Destilados', priceCents: 9990 });
  ensureProduct(run, { name: 'Água com Gás 500ml', type: 'fisico', category: 'Sem Álcool', priceCents: 400 });
  ensureProduct(run, { name: 'Suco de Uva Integral 1L', type: 'fisico', category: 'Sem Álcool', priceCents: 1499 });

  if (run.flags.kits) {
    ensureKit(run, 'Kit Degustação de Vinhos', 13470, [
      { productId: vinhoTinto.id, qty: 1 },
      { productId: vinhoBranco.id, qty: 1 },
      { productId: espumante.id, qty: 1 },
    ]);
    ensureCombo(run, 'Combo Cerveja do Fim de Semana', 2990, [
      { productId: cerveja.id, qty: 6 },
    ]);
  }
}

function roupas(run: DemoRun): void {
  if (run.flags.variantes) {
    // Camiseta: grade dupla Tamanho × Cor. Calça e tênis: grade só de numeração.
    ensureVariantProduct(run, 'Camiseta Básica', 'Roupas', 4990, [
      { name: 'Tamanho', values: ['P', 'M', 'G', 'GG'] },
      { name: 'Cor', values: ['Branco', 'Preto', 'Azul'] },
    ]);
    ensureVariantProduct(run, 'Calça Jeans', 'Roupas', 12990, [
      { name: 'Numeração', values: ['36', '38', '40', '42', '44'] },
    ]);
    ensureVariantProduct(run, 'Tênis Casual', 'Calçados', 19990, [
      { name: 'Numeração', values: ['37', '38', '39', '40', '41', '42'] },
    ]);
  } else {
    // Sem a capability de variações, a grade não pode nascer (pai sem filha vira produto
    // preso). Cai para produtos simples do mesmo "visual" para o catálogo não ficar vazio.
    ensureProduct(run, { name: 'Camiseta Básica', type: 'fisico', category: 'Roupas', priceCents: 4990 });
    ensureProduct(run, { name: 'Calça Jeans', type: 'fisico', category: 'Roupas', priceCents: 12990 });
    ensureProduct(run, { name: 'Tênis Casual', type: 'fisico', category: 'Calçados', priceCents: 19990 });
  }
  ensureProduct(run, { name: 'Boné', type: 'fisico', category: 'Acessórios', priceCents: 2990 });
  ensureProduct(run, { name: 'Meia Esportiva (par)', type: 'fisico', category: 'Acessórios', priceCents: 1490 });
  ensureProduct(run, { name: 'Cinto de Couro', type: 'fisico', category: 'Acessórios', priceCents: 5990 });
  // Costura/barra: o serviço que toda loja de roupa oferece.
  ensureProduct(run, { name: 'Ajuste de Barra', type: 'servico', category: 'Serviços', priceCents: 2500 });
}

function farmacia(run: DemoRun): void {
  ensureProduct(run, { name: 'Paracetamol 750mg — 20 comp.', type: 'fisico', category: 'Medicamentos', priceCents: 1199 });
  ensureProduct(run, { name: 'Dipirona Gotas 500mg/ml — 20ml', type: 'fisico', category: 'Medicamentos', priceCents: 899 });
  ensureProduct(run, { name: 'Ibuprofeno 600mg — 20 comp.', type: 'fisico', category: 'Medicamentos', priceCents: 1599 });
  ensureProduct(run, { name: 'Álcool 70% — 1L', type: 'fisico', category: 'Medicamentos', priceCents: 699 });
  ensureProduct(run, { name: 'Protetor Solar FPS 50', type: 'fisico', category: 'Higiene e Beleza', priceCents: 8999 });
  const shampoo = ensureProduct(run, { name: 'Shampoo Anticaspa 200ml', type: 'fisico', category: 'Higiene e Beleza', priceCents: 2499 });
  ensureProduct(run, { name: 'Sabonete Líquido 250ml', type: 'fisico', category: 'Higiene e Beleza', priceCents: 1299 });
  ensureProduct(run, { name: 'Vitamina C 1g — 30 comp.', type: 'fisico', category: 'Vitaminas e Suplementos', priceCents: 899 });
  ensureProduct(run, { name: 'Ômega 3 — 30 cápsulas', type: 'fisico', category: 'Vitaminas e Suplementos', priceCents: 2999 });
  ensureProduct(run, { name: 'Fralda Descartável P — 30 un', type: 'fisico', category: 'Infantil', priceCents: 4499 });
  ensureProduct(run, { name: 'Aplicação de Injeção', type: 'servico', category: 'Serviços', priceCents: 2000 });

  if (run.flags.kits) {
    const escova = ensureProduct(run, { name: 'Escova Dental', type: 'fisico', category: 'Higiene e Beleza', priceCents: 899 });
    const pasta = ensureProduct(run, { name: 'Creme Dental 90g', type: 'fisico', category: 'Higiene e Beleza', priceCents: 799 });
    const fio = ensureProduct(run, { name: 'Fio Dental 50m', type: 'fisico', category: 'Higiene e Beleza', priceCents: 899 });
    ensureKit(run, 'Kit Higiene Bucal', 2199, [
      { productId: escova.id, qty: 1 },
      { productId: pasta.id, qty: 1 },
      { productId: fio.id, qty: 1 },
    ]);
    // Kit que usa o shampoo criado acima.
    const perfume = ensureProduct(run, { name: 'Perfume 100ml', type: 'fisico', category: 'Higiene e Beleza', priceCents: 7999 });
    ensureKit(run, 'Kit Presente Higiene', 9499, [
      { productId: shampoo.id, qty: 1 },
      { productId: perfume.id, qty: 1 },
    ]);
  }
}

function petshop(run: DemoRun): void {
  ensureProduct(run, { name: 'Ração Cães Adultos 15kg', type: 'fisico', category: 'Ração e Alimentos', priceCents: 15999 });
  ensureProduct(run, { name: 'Ração Gatos Castrados 10kg', type: 'fisico', category: 'Ração e Alimentos', priceCents: 12999 });
  ensureProduct(run, { name: 'Sachê para Gatos 85g', type: 'fisico', category: 'Ração e Alimentos', priceCents: 499 });
  ensureProduct(run, { name: 'Petisco para Cães 100g', type: 'fisico', category: 'Ração e Alimentos', priceCents: 1499 });
  ensureProduct(run, { name: 'Shampoo Pet 500ml', type: 'fisico', category: 'Higiene', priceCents: 2999 });
  ensureProduct(run, { name: 'Coleira Ajustável', type: 'fisico', category: 'Acessórios', priceCents: 2499 });
  ensureProduct(run, { name: 'Cama Pet Média', type: 'fisico', category: 'Acessórios', priceCents: 7999 });
  ensureProduct(run, { name: 'Bolinha de Borracha', type: 'fisico', category: 'Brinquedos', priceCents: 1499 });

  // Serviços do petshop — o ramo usa o tipo "serviço" de verdade.
  ensureProduct(run, { name: 'Banho e Tosa (pequeno porte)', type: 'servico', category: 'Serviços', priceCents: 5000 });
  ensureProduct(run, { name: 'Banho e Tosa (grande porte)', type: 'servico', category: 'Serviços', priceCents: 8000 });
  ensureProduct(run, { name: 'Hospedagem (diária)', type: 'servico', category: 'Serviços', priceCents: 6000 });
}

function servicos(run: DemoRun): void {
  // Perfil neutro de prestador de serviços (assistência, oficina, salão…): a maior parte
  // do catálogo é tipo "serviço", com alguns produtos de revenda para completar o PDV.
  const horaTecnica = ensureProduct(run, { name: 'Hora Técnica / Atendimento', type: 'servico', category: 'Serviços', priceCents: 12000 });
  ensureProduct(run, { name: 'Visita Técnica', type: 'servico', category: 'Serviços', priceCents: 19900 });
  ensureProduct(run, { name: 'Manutenção Preventiva', type: 'servico', category: 'Serviços', priceCents: 34900 });
  ensureProduct(run, { name: 'Peça de Reposição Padrão', type: 'fisico', category: 'Produtos', priceCents: 9900 });
  ensureProduct(run, { name: 'Material de Consumo (un)', type: 'fisico', category: 'Produtos', priceCents: 1990 });

  if (run.flags.kits) {
    // Pacote de horas: um combo cujo componente é um serviço (quantidade 10).
    ensureCombo(run, 'Pacote 10 Horas Técnicas', 99000, [
      { productId: horaTecnica.id, qty: 10 },
    ]);
  }
}

const BRANCH_BUILDERS: Record<OnboardingBusinessType, (run: DemoRun) => void> = {
  restaurante,
  padaria,
  mercado,
  conveniencia,
  adega,
  roupas,
  farmacia,
  petshop,
  servicos,
  // "outro" é intencionalmente vazio: não inventamos um catálogo para quem ainda não sabe
  // dizer o que é — o cadastro real dele começa limpo, e é isso que o "outro" significa.
  outro: () => {},
};

export function createDemoCatalog(
  businessType: OnboardingBusinessType,
  flags: DemoFlags,
): DemoCounts {
  const run: DemoRun = {
    flags, productsCreated: 0, categoriesCreated: 0, kitchenRoutesCreated: 0,
  };
  // Tudo numa transação: se qualquer passo falhar (banco em estado estranho), nada fica
  // pela metade — um catálogo incompleto confunde mais do que nenhum.
  productRepository.transaction(() => {
    BRANCH_BUILDERS[businessType](run);
  });
  return {
    productsCreated: run.productsCreated,
    categoriesCreated: run.categoriesCreated,
    kitchenRoutesCreated: run.kitchenRoutesCreated,
  };
}
