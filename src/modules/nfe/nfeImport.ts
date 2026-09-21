/**
 * Regra de negócio da importação de NF-e: preview (classificação) e commit
 * (gravação atômica). Tudo que mexe em banco acontece no commit, dentro de UMA
 * transação — nenhuma alteração (produto/fornecedor/estoque/custo) antes da
 * confirmação da tela de conferência.
 *
 * O commit re-parseia e revalida o XML (nunca confia no preview que o usuário viu):
 * decisões do usuário são aplicadas POR LINHA (vincular/criar/ignorar + qty/custo,
 * preço de venda e conversão de unidade).
 *
 * Conversão de unidade (un/cx): a nota pode faturar em CAIXA enquanto o produto é
 * vendido em UNIDADE. O fator (unidades de venda por unidade da nota) vem, em ordem,
 * do uTrib da nota, da conversão já conhecida do fornecedor (product_suppliers.pack)
 * ou do próprio produto (purchase_unit/purchase_unit_qty); sem pista, o usuário informa
 * na conferência e o vínculo guarda para a próxima.
 *
 * EAN de caixa: o código de embalagem NUNCA sobrescreve `products.barcode`; vai para
 * `product_barcodes` (kind='caixa'). Só um EAN de unidade vira o código principal.
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getService, hasService } from '../../core/services/registry';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import type { CommercialPurchaseInboundService } from '../commercial/setup';
import { audit } from '../../core/audit/service';
import { parseNfeDocument, type NfeDetItem, type NfeParsed } from './nfeParse';
import {
  buildCatalog, resolveItem, normalizeName,
  type CatalogProduct, type NfeLineFlag, type NfeCatalog,
} from './nfeResolve';
import { detectConversion, isPackagingEan, unitEanFor, type ConversionSource, type SupplierPack } from './nfeUnits';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { productBarcodeRepository } from '../commercial/repositories/ProductBarcodeRepository';
import { supplierRepository } from '../commercial/repositories/SupplierRepository';
import { productSupplierRepository, purchaseInvoiceRepository, purchaseInvoiceItemRepository } from './repositories/NfeRepository';
import { validateBarcode } from '../../shared/barcode';
import { normalizeProductUnit, isPackagingUnit, isKnownProductUnit } from '../../shared/units';
import { createLogger } from '../../core/logger';

const log = createLogger('nfe');

export type NfeImportAction = 'link' | 'create' | 'ignore';

export interface NfeDecision {
  line: number;
  action: NfeImportAction;
  productId?: number | null;
  /** Quantidade NA UNIDADE DA NOTA (não convertida). */
  qty: number;
  /** Custo NA UNIDADE DA NOTA (não convertido). */
  unitCostCents: number;
  /** Preço de venda a gravar/manter no produto (centavos). null = não mexe. */
  salePriceCents?: number | null;
  /** Unidades de venda por unidade da nota (ex.: 12 p/ CX). null = usa a sugestão. */
  conversionQty?: number | null;
  /** Unidade de venda do produto novo (só para action='create'). */
  unit?: string | null;
  /** Categoria do produto novo (só para action='create'). */
  categoryId?: number | null;
}

export interface NfePreviewItem {
  line: number;
  cProd: string;
  description: string;
  ean: string | null;
  eanTrib: string | null;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  unitTrib: string | null;
  qty: number;
  unitCostCents: number;
  totalCents: number;
  kind: string;
  reason: string;
  flags: NfeLineFlag[];
  error?: string;
  product: SerializedProduct | null;
  candidates: SerializedProduct[];
  /** Unidade de venda sugerida para o produto. */
  saleUnit: string;
  /** Fator de conversão sugerido (unidades de venda por unidade da nota). null = precisa input. */
  conversionQty: number | null;
  conversionUnit: string | null;
  conversionSource: ConversionSource;
  /** Custo já convertido para a unidade de venda. */
  costSaleCents: number;
  suggestedPriceCents: number;
  currentPriceCents: number;
  salePriceCents: number;
  eanBox: string | null;
  eanUnit: string | null;
  markupBps: number;
}

export interface SerializedProduct {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  ncm: string | null;
  costCents: number;
  priceCents: number;
  purchaseUnit: string | null;
  purchaseUnitQty: number | null;
}

export interface NfeImportPreview {
  accessKey: string;
  serie: string | null;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  markupBps: number;
  supplier: { id: number | null; cnpj: string; name: string | null; tradeName: string | null; exists: boolean };
  items: NfePreviewItem[];
}

export interface NfeImportResult {
  invoiceId: number;
  purchaseId: number | null;
  created: number;
  linked: number;
  ignored: number;
  supplierId: number;
  accessKey: string;
}

class NfeImportError extends Error {}

/** Markup de venda padrão (basis points; 10000 = 100% sobre o custo). */
export const DEFAULT_MARKUP_BPS = 10000;
export const NFE_MARKUP_SETTING = 'nfe.markup_bps';

/** Markup global configurado na tela de importação; sem config, 100%. */
export function globalMarkupBps(): number {
  const raw = settingsRepository.get(NFE_MARKUP_SETTING);
  const n = Number(raw);
  return raw != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MARKUP_BPS;
}

/** Markup do fornecedor (se configurado) ou o global. */
function resolveMarkupBps(supplierId: number | null): number {
  if (supplierId) {
    const row = supplierRepository.findByIdWithColumns(supplierId, 'default_markup_bps') as
      | { default_markup_bps: number } | undefined;
    if (row && Number(row.default_markup_bps) > 0) return Math.round(Number(row.default_markup_bps));
  }
  return globalMarkupBps();
}

function serializeProduct(p: CatalogProduct): SerializedProduct {
  return {
    id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, unit: p.unit, ncm: p.ncm,
    costCents: p.costCents, priceCents: p.priceCents,
    purchaseUnit: p.purchaseUnit, purchaseUnitQty: p.purchaseUnitQty,
  };
}

function loadCatalogRows(): CatalogProduct[] {
  return productRepository.raw(
    `SELECT id, name, sku, barcode, unit, ncm, cost_cents, price_cents, purchase_unit, purchase_unit_qty
       FROM products
      WHERE deleted_at IS NULL
        AND product_type != 'complemento'
        AND product_type != 'variante'
      ORDER BY name`,
  ) as unknown as CatalogProduct[];
}

interface CatalogBundle {
  cat: NfeCatalog;
  products: CatalogProduct[];
  /** Conversão de compra já conhecida por produto, para ESTE fornecedor. */
  packs: Map<number, SupplierPack>;
}

function buildCatalogFor(supplierId: number | null): CatalogBundle {
  const products = loadCatalogRows();
  const mappings = supplierId ? productSupplierRepository.activeCodesForSupplier(supplierId) : [];
  const packs = new Map<number, SupplierPack>();
  for (const m of mappings) {
    if (m.pack_qty && m.pack_unit) packs.set(m.product_id, { unit: m.pack_unit, qty: Number(m.pack_qty) });
  }
  const supplierProductIds = new Set(mappings.map((m) => m.product_id));
  const cat = buildCatalog(products, mappings.map((m) => ({ productId: m.product_id, code: m.supplier_code })), supplierProductIds);
  return { cat, products, packs };
}

interface LinePlan {
  saleUnit: string;
  conversionQty: number | null;
  conversionUnit: string | null;
  conversionSource: ConversionSource;
  costSaleCents: number;
  suggestedPriceCents: number;
  currentPriceCents: number;
  salePriceCents: number;
  eanBox: string | null;
  eanUnit: string | null;
}

/**
 * Plano de uma linha: para qual unidade de venda converter, com que fator, custo já
 * convertido, preço sugerido (markup sobre o custo convertido) e separação EAN
 * unidade × caixa. `product` nulo = produto novo.
 */
function computeLinePlan(
  item: NfeDetItem,
  product: CatalogProduct | null,
  supplierPack: SupplierPack | null | undefined,
  markupBps: number,
): LinePlan {
  let saleUnit: string;
  let pack: SupplierPack | null = null;
  if (product) {
    saleUnit = normalizeProductUnit(product.unit);
    pack = supplierPack?.qty
      ? supplierPack
      : (product.purchaseUnit ? { unit: product.purchaseUnit, qty: product.purchaseUnitQty } : null);
  } else {
    // Produto novo: se a nota fatura em embalagem mas o tributável é uma unidade menor,
    // a venda nasce na unidade menor (ex.: compra CX, vende UN).
    saleUnit = isPackagingUnit(item.unit) && item.unitTrib && !isPackagingUnit(item.unitTrib)
      ? normalizeProductUnit(item.unitTrib)
      : normalizeProductUnit(item.unit);
  }

  const conv = detectConversion(item, saleUnit, pack);
  const factor = conv.factor;
  const effective = factor && factor > 0 ? factor : 1;
  const costSaleCents = Math.round(item.unitCostCents / effective);
  const suggestedPriceCents = Math.round(costSaleCents * (1 + markupBps / 10000));
  const currentPriceCents = product?.priceCents ?? 0;
  const salePriceCents = currentPriceCents > 0 ? currentPriceCents : suggestedPriceCents;

  return {
    saleUnit,
    conversionQty: factor,
    conversionUnit: factor != null && factor !== 1 ? item.unit : null,
    conversionSource: conv.source,
    costSaleCents,
    suggestedPriceCents,
    currentPriceCents,
    salePriceCents,
    eanBox: isPackagingEan(item, factor) ? (item.ean ?? null) : null,
    eanUnit: unitEanFor(item, factor),
  };
}

function findSupplierByCnpj(cnpj: string): { id: number; name: string | null } | null {
  const row = supplierRepository.findOneWhere({ document: cnpj }) as { id: number; name: string } | undefined;
  return row ? { id: row.id, name: row.name } : null;
}

/**
 * Registra no log as siglas de unidade que não estão no conjunto canônico/apelidos.
 * NÃO é validação: a unidade é preservada como veio (o leiaute da NF-e aceita siglas
 * livres e o lojista pode ter um "FD"/"RL" legítimo). O log serve para, com o tempo,
 * mapear as siglas reais que aparecem nas notas.
 */
function logUnknownUnits(items: NfeDetItem[]): void {
  const unknown = new Set<string>();
  for (const it of items) {
    for (const u of [it.unit, it.unitTrib]) {
      const t = (u ?? '').trim();
      if (t && !isKnownProductUnit(t)) unknown.add(t);
    }
  }
  if (unknown.size) {
    log.warn(`unidades de medida não mapeadas (preservadas como vieram): ${[...unknown].join(', ')}`);
  }
}

/** Cria o fornecedor já com os dados que a NF-e traz (IE, endereço, contato). */
function createSupplier(req: Request, doc: NfeParsed): number {
  const e = doc.emitente;
  const name = e.nome?.trim() || `Fornecedor ${e.cnpj}`;
  const id = supplierRepository.create({
    name,
    trade_name: e.fantasia?.trim() || null,
    document: e.cnpj,
    ie: e.ie,
    phone: e.phone,
    cep: e.cep,
    street: e.street,
    number: e.number,
    complement: e.complement,
    district: e.district,
    city: e.city,
    state: e.state,
    active: 1,
    uuid: randomUUID(),
    origin_machine: req.headers['x-machine'] ?? null,
  });
  audit(req, 'criar', 'supplier', id, null, { document: e.cnpj, name, origem: 'importacao_nfe' });
  return id;
}

/** Adota um EAN de UNIDADE num produto vinculado apenas se ele ainda não tem código. */
function adoptEanIfFree(productId: number, ean: string | null, products: CatalogProduct[]): boolean {
  // EAN com dígito verificador errado (comum em nota de fornecedor pequeno) nunca vira
  // código de barras do catálogo: sujaria o produto e travaria a edição depois, porque o
  // PUT de produto recusa barcode inválido. O código continua no item da NF-e.
  if (!ean || !validateBarcode(ean)) return false;
  const owned = products.some((p) => p.id !== productId && (p.barcode ?? '').trim() === ean);
  if (owned) return false;
  productRepository.rawRun(
    "UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ? AND (barcode IS NULL OR barcode = '')",
    ean, productId,
  );
  return true;
}

/** Registra códigos secundários (caixa/lastro) sem tocar no código principal. */
function recordSecondaryBarcodes(productId: number, plan: LinePlan, supplierId: number): void {
  if (plan.eanBox && validateBarcode(plan.eanBox)) {
    productBarcodeRepository.addIfMissing(productId, plan.eanBox, 'caixa', plan.conversionQty ?? null, supplierId);
  }
}

/* ─────────────────────────── Preview ─────────────────────────── */

export function buildImportPreview(xml: string): NfeImportPreview {
  const doc = parseNfeDocument(xml);
  logUnknownUnits(doc.items);
  if (purchaseInvoiceRepository.findByAccessKey(doc.accessKey)) {
    throw new NfeImportError('Esta NF-e (chave de acesso) já foi importada.');
  }
  return buildPreviewFromDoc(doc);
}

/**
 * Monta o preview a partir de um documento JÁ parseado. Separado de `buildImportPreview`
 * para a EDIÇÃO reaproveitar a mesma classificação sem tropeçar na checagem de chave
 * (a NF-e editada já existe e é justamente ela que está sendo reclassificada).
 */
export function buildPreviewFromDoc(doc: NfeParsed): NfeImportPreview {
  const supplier = findSupplierByCnpj(doc.emitente.cnpj);
  const { cat, packs } = buildCatalogFor(supplier?.id ?? null);
  const markupBps = resolveMarkupBps(supplier?.id ?? null);

  const items: NfePreviewItem[] = doc.items.map((item) => {
    const res = resolveItem(item, cat);
    const flags = item.ean && !validateBarcode(item.ean) && !res.flags.includes('ean_invalid')
      ? [...res.flags, 'ean_invalid' as const]
      : res.flags;
    const product = res.product;
    const plan = computeLinePlan(item, product, product ? packs.get(product.id) : null, markupBps);
    return {
      line: item.line,
      cProd: item.cProd,
      description: item.description,
      ean: item.ean,
      eanTrib: item.eanTrib,
      ncm: item.ncm,
      cfop: item.cfop,
      unit: item.unit,
      unitTrib: item.unitTrib,
      qty: item.qty,
      unitCostCents: item.unitCostCents,
      totalCents: item.totalCents,
      kind: res.kind,
      reason: res.reason,
      flags,
      error: res.error,
      product: product ? serializeProduct(product) : null,
      candidates: res.candidates.slice(0, 6).map(serializeProduct),
      saleUnit: plan.saleUnit,
      conversionQty: plan.conversionQty,
      conversionUnit: plan.conversionUnit,
      conversionSource: plan.conversionSource,
      costSaleCents: plan.costSaleCents,
      suggestedPriceCents: plan.suggestedPriceCents,
      currentPriceCents: plan.currentPriceCents,
      salePriceCents: plan.salePriceCents,
      eanBox: plan.eanBox,
      eanUnit: plan.eanUnit,
      markupBps,
    };
  });

  return {
    accessKey: doc.accessKey,
    serie: doc.serie,
    number: doc.number,
    issuedAt: doc.issuedAt,
    totalCents: doc.totalCents,
    markupBps,
    supplier: {
      id: supplier?.id ?? null,
      cnpj: doc.emitente.cnpj,
      name: supplier?.name ?? doc.emitente.nome,
      tradeName: doc.emitente.fantasia,
      exists: supplier != null,
    },
    items,
  };
}

/* ─────────────────────────── Commit ─────────────────────────── */

interface ValidatedLine {
  item: NfeDetItem;
  action: NfeImportAction;
  productId: number | null;
  qty: number;
  unitCostCents: number;
  salePriceCents: number | null;
  conversionQty: number | null;
  unit: string | null;
  categoryId: number | null;
}

export function commitImport(req: Request, xml: string, decisions: NfeDecision[]): NfeImportResult {
  const doc = parseNfeDocument(xml);
  logUnknownUnits(doc.items);
  if (purchaseInvoiceRepository.findByAccessKey(doc.accessKey)) {
    throw new NfeImportError('Esta NF-e (chave de acesso) já foi importada.');
  }
  return applyImportCore(req, doc, xml, decisions);
}

/** Valida/normaliza as decisões da conferência contra as linhas REAIS do XML. */
function validateDecisions(doc: NfeParsed, decisions: NfeDecision[]): Map<number, ValidatedLine> {
  const byLine = new Map(doc.items.map((it) => [it.line, it]));
  const byDecision = new Map(decisions.map((d) => [d.line, d]));
  for (const item of doc.items) {
    if (!byDecision.has(item.line)) throw new NfeImportError(`Linha ${item.line} sem decisão na conferência.`);
  }
  const validated = new Map<number, ValidatedLine>();
  for (const [line, d] of byDecision) {
    const item = byLine.get(line);
    if (!item) throw new NfeImportError(`Linha ${line} não existe na NF-e.`);
    if (!['link', 'create', 'ignore'].includes(d.action)) throw new NfeImportError(`Linha ${line}: ação inválida.`);
    const qty = Number(d.qty);
    const unitCostCents = Math.round(Number(d.unitCostCents));
    if (!(qty > 0)) throw new NfeImportError(`Linha ${line}: quantidade deve ser positiva.`);
    if (!(unitCostCents > 0)) throw new NfeImportError(`Linha ${line}: custo unitário deve ser positivo.`);
    const salePriceCents = d.salePriceCents == null ? null : Math.max(0, Math.round(Number(d.salePriceCents)));
    const rawConv = d.conversionQty as unknown;
    const conversionQty = rawConv == null || rawConv === '' ? null : Number(rawConv);
    if (conversionQty != null && !(conversionQty > 0)) {
      throw new NfeImportError(`Linha ${line}: conversão de unidade deve ser positiva.`);
    }
    validated.set(line, {
      item, action: d.action, productId: d.productId ?? null, qty, unitCostCents,
      salePriceCents, conversionQty, unit: d.unit ? String(d.unit) : null,
      categoryId: d.categoryId != null && Number.isInteger(Number(d.categoryId)) && Number(d.categoryId) > 0 ? Number(d.categoryId) : null,
    });
  }
  return validated;
}

export interface ApplyImportContext {
  /** Edição: reaproveita a NF-e existente (mesmo id) em vez de criar uma nova. */
  existingInvoiceId?: number;
  /** Ação registrada na auditoria (padrão: importar_nfe). */
  auditAction?: string;
  /** Detalhes extras anexados à auditoria (ex.: modo de estoque escolhido na edição). */
  auditDetails?: Record<string, unknown>;
}

/**
 * Núcleo do commit: resolve as decisões, grava produtos/estoque/compra e os itens da
 * NF-e. NÃO checa chave duplicada (o chamador decide) e abre transação própria — que,
 * dentro da transação da EDIÇÃO, vira um savepoint. `ctx.existingInvoiceId` faz a
 * gravação reaproveitar a NF-e existente (os itens antigos são soft-deleted antes).
 */
export function applyImportCore(
  req: Request,
  doc: NfeParsed,
  xml: string,
  decisions: NfeDecision[],
  ctx: ApplyImportContext = {},
): NfeImportResult {
  if (!hasService('commercial.purchaseInbound')) {
    throw new NfeImportError('Módulo commercial indisponível — não é possível lançar a compra.');
  }
  const purchaseInbound = getService<CommercialPurchaseInboundService>('commercial.purchaseInbound');
  const validated = validateDecisions(doc, decisions);

  let invoiceId = 0;
  let purchaseId = 0;
  let created = 0;
  let linked = 0;
  let ignored = 0;
  let resultSupplierId = 0;

  try {
    productRepository.transaction(() => {
      // 1. Fornecedor (cria se for o primeiro XML deste CNPJ).
      let supplierId = findSupplierByCnpj(doc.emitente.cnpj)?.id ?? 0;
      const supplierCreated = supplierId === 0;
      if (!supplierId) supplierId = createSupplier(req, doc);
      resultSupplierId = supplierId;
      const supplierName = (supplierRepository.findById(supplierId) as { name: string }).name;

      // 2. Catálogo + resolução por linha.
      const { products, packs } = buildCatalogFor(supplierId);
      const markupBps = resolveMarkupBps(supplierId);

      // Produtos criados nesta mesma importação (reuso entre linhas iguais).
      const createdByEan = new Map<string, number>();
      const createdByNameUnit = new Map<string, number>();
      const createdProducts = new Map<number, CatalogProduct>();
      const productByLine = new Map<number, number | null>();
      const statusByLine = new Map<number, 'criado' | 'vinculado' | 'ignorado'>();
      const planByLine = new Map<number, LinePlan>();
      const factorByLine = new Map<number, number>();
      const salePriceByLine = new Map<number, number>();
      const convertedByLine = new Map<number, { qty: number; unitCostCents: number }>();

      for (const [line, v] of validated) {
        const item = v.item;
        if (v.action === 'ignore') { ignored++; productByLine.set(line, null); statusByLine.set(line, 'ignorado'); continue; }

        let productId: number | null = null;
        let product: CatalogProduct | null = null;
        const unitKey = item.unit?.trim() || 'un';
        const nameKey = `${normalizeName(item.description)}|${unitKey}`;

        if (v.action === 'link') {
          if (!v.productId) throw new NfeImportError(`Linha ${line}: vincule um produto ou escolha criar/ignorar.`);
          const chosen = products.find((p) => p.id === v.productId);
          if (!chosen) throw new NfeImportError(`Linha ${line}: produto selecionado não existe mais.`);
          product = chosen;
          productId = chosen.id;
          linked++;
        } else {
          const existingByEan = item.ean ? createdByEan.get(item.ean) : undefined;
          const existingByName = existingByEan ?? createdByNameUnit.get(nameKey);
          if (existingByName) {
            productId = existingByName;
            product = createdProducts.get(productId) ?? products.find((p) => p.id === productId) ?? null;
          }
        }

        const plan = computeLinePlan(item, product, product ? packs.get(product.id) : null, markupBps);
        if (v.unit) plan.saleUnit = normalizeProductUnit(v.unit);

        // Fator efetivo: decisão do usuário > sugestão. Sem pista, exige input.
        let factor = v.conversionQty ?? plan.conversionQty;
        if (factor == null) {
          throw new NfeImportError(
            `Linha ${line}: informe quantas unidades de venda (${plan.saleUnit}) vêm em 1 ${item.unit ?? 'unidade'} da nota.`,
          );
        }
        if (!(factor > 0)) factor = 1;
        const salePriceCents = v.salePriceCents != null && v.salePriceCents >= 0 ? v.salePriceCents : plan.salePriceCents;

        if (v.action === 'create') {
          const reusedProductId = productId;
          if (reusedProductId) {
            // Produto já criado nesta nota (linha repetida): só ajusta preço/unidade/categoria.
            productRepository.rawRun(
              `UPDATE products SET price_cents = ?, unit = ?,
                      category_id = COALESCE(?, category_id), updated_at = datetime('now') WHERE id = ?`,
              salePriceCents, plan.saleUnit, v.categoryId, reusedProductId,
            );
          } else {
            if (item.ean && products.some((p) => (p.barcode ?? '').trim() === item.ean)) {
              const used = products.find((p) => (p.barcode ?? '').trim() === item.ean)!;
              throw new NfeImportError(`Linha ${line}: já existe produto com o EAN ${item.ean} ("${used.name}") — vincule em vez de criar.`);
            }
            const primaryEan = plan.eanUnit && validateBarcode(plan.eanUnit) && !products.some((p) => (p.barcode ?? '').trim() === plan.eanUnit)
              ? plan.eanUnit
              : null;
            productId = productRepository.create({
              name: item.description.trim(),
              sku: null,
              barcode: primaryEan,
              category_id: v.categoryId,
              unit: plan.saleUnit,
              price_cents: salePriceCents,
              cost_cents: 0,
              track_stock: 1,
              min_stock: 0,
              active: 1,
              product_type: 'fisico',
              purchase_unit: factor > 1 ? item.unit : null,
              purchase_unit_qty: factor > 1 ? factor : null,
              uuid: randomUUID(),
              origin_machine: req.headers['x-machine'] ?? null,
            });
            created++;
            if (item.ean) createdByEan.set(item.ean, productId);
            createdByNameUnit.set(nameKey, productId);
            createdProducts.set(productId, {
              id: productId, name: item.description.trim(), sku: null, barcode: primaryEan,
              unit: plan.saleUnit, ncm: item.ncm, costCents: 0, priceCents: salePriceCents,
              purchaseUnit: factor > 1 ? item.unit : null, purchaseUnitQty: factor > 1 ? factor : null,
            });
            audit(req, 'criar', 'product', productId, null, {
              origem: 'importacao_nfe', nome: item.description.trim(), ean: primaryEan,
              preco_cents: salePriceCents, unidade: plan.saleUnit,
            });
          }
        } else {
          // link: adota EAN de unidade se estiver livre e grava preço/conversão.
          adoptEanIfFree(productId!, plan.eanUnit, products);
          productRepository.rawRun(
            "UPDATE products SET price_cents = ?, updated_at = datetime('now') WHERE id = ?",
            salePriceCents, productId,
          );
          if (factor > 1) {
            const current = products.find((p) => p.id === productId);
            if (!current?.purchaseUnit || !current.purchaseUnitQty) {
              productRepository.rawRun(
                `UPDATE products SET purchase_unit = ?, purchase_unit_qty = ?, updated_at = datetime('now') WHERE id = ?`,
                item.unit, factor, productId,
              );
            }
          }
        }

        if (productId != null) recordSecondaryBarcodes(productId, { ...plan, conversionQty: factor }, supplierId);
        productByLine.set(line, productId);
        statusByLine.set(line, v.action === 'create' ? 'criado' : 'vinculado');
        planByLine.set(line, plan);
        factorByLine.set(line, factor);
        salePriceByLine.set(line, salePriceCents);
        convertedByLine.set(line, {
          qty: v.qty * factor,
          unitCostCents: Math.round(v.unitCostCents / factor),
        });
      }

      // 3. NF-e + itens (histórico, preserva os dados fiscais da operação). Na EDIÇÃO a
      //    NF-e já existe: reaproveita o id e derruba os itens antigos (recriados abaixo).
      if (ctx.existingInvoiceId) {
        invoiceId = ctx.existingInvoiceId;
        purchaseInvoiceItemRepository.softDeleteWhere({ purchase_invoice_id: invoiceId });
      } else {
        invoiceId = purchaseInvoiceRepository.create({
          access_key: doc.accessKey,
          supplier_id: supplierId,
          supplier_name: supplierName,
          invoice_number: doc.number,
          series: doc.serie,
          issued_at: doc.issuedAt,
          total_cents: doc.totalCents,
          xml,
          status: 'importada',
          supplier_created: supplierCreated ? 1 : 0,
          imported_by: (req as { user?: { id: number } }).user?.id ?? null,
          uuid: randomUUID(),
          origin_machine: req.headers['x-machine'] ?? null,
        });
      }

      // Custo/preço de cada produto ANTES da entrada (a compra recebida altera o custo
      // médio). Lido agora, ainda sem a movimentação — é o que a reversão restaura.
      const prevCostByProduct = new Map<number, number>();
      const prevPriceByProduct = new Map<number, number>();
      for (const pid of productByLine.values()) {
        if (pid == null || prevCostByProduct.has(pid)) continue;
        const prod = productRepository.findByIdWithColumns(pid, 'cost_cents, price_cents') as
          | { cost_cents: number; price_cents: number } | undefined;
        prevCostByProduct.set(pid, prod ? Number(prod.cost_cents) : 0);
        prevPriceByProduct.set(pid, prod ? Number(prod.price_cents) : 0);
      }

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      for (const item of doc.items) {
        const outcome = statusByLine.get(item.line) ?? 'ignorado';
        const productId = productByLine.get(item.line) ?? null;
        const plan = planByLine.get(item.line);
        const factor = factorByLine.get(item.line) ?? null;
        purchaseInvoiceItemRepository.create({
          purchase_invoice_id: invoiceId,
          line: item.line,
          product_id: productId,
          supplier_code: item.cProd,
          ean: item.ean,
          description: item.description,
          ncm: item.ncm,
          cfop: item.cfop,
          unit: item.unit,
          qty: item.qty,
          unit_cost_cents: item.unitCostCents,
          total_cost_cents: item.totalCents,
          sale_price_cents: productId != null ? (salePriceByLine.get(item.line) ?? null) : null,
          suggested_price_cents: plan ? plan.suggestedPriceCents : null,
          conversion_qty: factor != null && factor !== 1 ? factor : null,
          conversion_unit: factor != null && factor !== 1 ? item.unit : null,
          ean_box: plan?.eanBox ?? null,
          prev_cost_cents: productId != null ? (prevCostByProduct.get(productId) ?? null) : null,
          prev_price_cents: productId != null ? (prevPriceByProduct.get(productId) ?? null) : null,
          status: outcome,
          uuid: randomUUID(),
          origin_machine: req.headers['x-machine'] ?? null,
        });
        if (productId != null) {
          productSupplierRepository.upsertLink(
            supplierId, productId, item.cProd, supplierName, item.unitCostCents,
            factor != null && factor !== 1 ? factor : null,
            factor != null && factor !== 1 ? item.unit : null,
          );
        }
      }

      // 4. Compra recebida (estoque/custo/custo médio/CMV) — só itens aceitos, já
      //    convertidos para a unidade de venda.
      const accepted = [...productByLine.entries()]
        .filter(([, id]) => id != null)
        .map(([line]) => {
          const conv = convertedByLine.get(line)!;
          return { productId: productByLine.get(line)!, qty: conv.qty, unitCostCents: conv.unitCostCents };
        });
      if (accepted.length) {
        purchaseId = purchaseInbound.createInbound(req, {
          supplierId,
          items: accepted,
          notes: `Importada da NF-e chave ${doc.accessKey}`,
          status: 'recebida',
          receivedAt: now,
        });
        purchaseInvoiceRepository.rawRun(
          'UPDATE purchase_invoices SET purchase_id = ? WHERE id = ?',
          purchaseId, invoiceId,
        );
      }

      audit(req, ctx.auditAction ?? 'importar_nfe', 'purchase_invoice', invoiceId, null, {
        accessKey: doc.accessKey,
        supplierId: resultSupplierId,
        created, linked, ignored,
        ...(ctx.auditDetails ?? {}),
        decisions: [...statusByLine.entries()].map(([l, s]) => ({ line: l, status: s })),
      });
    });
  } catch (e) {
    if (e instanceof NfeImportError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/access_key|UNIQUE/i.test(msg)) throw new NfeImportError('Esta NF-e (chave de acesso) já foi importada.');
    throw new NfeImportError(`Falha ao importar: ${msg}`);
  }

  return {
    invoiceId,
    purchaseId: purchaseId || null,
    created,
    linked,
    ignored,
    supplierId: resultSupplierId,
    accessKey: doc.accessKey,
  };
}

export { NfeImportError };
