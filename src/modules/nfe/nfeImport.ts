/**
 * Regra de negócio da importação de NF-e: preview (classificação) e commit
 * (gravação atômica). Tudo que mexe em banco acontece no commit, dentro de UMA
 * transação — nenhuma alteração (produto/fornecedor/estoque/custo) antes da
 * confirmação da tela de conferência.
 *
 * O commit re-parseia e revalida o XML (nunca confia no preview que o usuário viu):
 * decisões do usuário são aplicadas POR LINHA (vincular/criar/ignorar + qty/custo).
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getService, hasService } from '../../core/services/registry';
import type { CommercialPurchaseInboundService } from '../commercial/setup';
import { audit } from '../../core/audit/service';
import { parseNfeDocument, type NfeDetItem, type NfeParsed } from './nfeParse';
import {
  buildCatalog, resolveItem, normalizeName,
  type CatalogProduct, type NfeLineFlag, type NfeCatalog,
} from './nfeResolve';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { supplierRepository } from '../commercial/repositories/SupplierRepository';
import { productSupplierRepository, purchaseInvoiceRepository, purchaseInvoiceItemRepository } from './repositories/NfeRepository';

export type NfeImportAction = 'link' | 'create' | 'ignore';

export interface NfeDecision {
  line: number;
  action: NfeImportAction;
  productId?: number | null;
  qty: number;
  unitCostCents: number;
}

export interface NfePreviewItem {
  line: number;
  cProd: string;
  description: string;
  ean: string | null;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  qty: number;
  unitCostCents: number;
  totalCents: number;
  kind: string;
  reason: string;
  flags: NfeLineFlag[];
  error?: string;
  product: SerializedProduct | null;
  candidates: SerializedProduct[];
}

export interface SerializedProduct {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  ncm: string | null;
  costCents: number;
}

export interface NfeImportPreview {
  accessKey: string;
  serie: string | null;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
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

function serializeProduct(p: CatalogProduct): SerializedProduct {
  return { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, unit: p.unit, ncm: p.ncm, costCents: p.costCents };
}

function loadCatalogRows(): CatalogProduct[] {
  return productRepository.raw(
    `SELECT id, name, sku, barcode, unit, ncm, cost_cents
       FROM products
      WHERE deleted_at IS NULL
        AND product_type != 'complemento'
        AND product_type != 'variante'
      ORDER BY name`,
  ) as unknown as CatalogProduct[];
}

function buildCatalogFor(supplierId: number | null): { cat: NfeCatalog; products: CatalogProduct[] } {
  const products = loadCatalogRows();
  const mappings: { productId: number; code: string }[] = supplierId
    ? productSupplierRepository.activeCodesForSupplier(supplierId).map((m) => ({ productId: m.product_id, code: m.supplier_code }))
    : [];
  const supplierProductIds = new Set(mappings.map((m) => m.productId));
  const cat = buildCatalog(products, mappings, supplierProductIds);
  return { cat, products };
}

function findSupplierByCnpj(cnpj: string): { id: number; name: string | null } | null {
  const row = supplierRepository.findOneWhere({ document: cnpj }) as { id: number; name: string } | undefined;
  return row ? { id: row.id, name: row.name } : null;
}

function createSupplier(req: Request, doc: NfeParsed): number {
  const name = doc.emitente.nome?.trim() || `Fornecedor ${doc.emitente.cnpj}`;
  const id = supplierRepository.create({
    name,
    trade_name: doc.emitente.fantasia?.trim() || null,
    document: doc.emitente.cnpj,
    active: 1,
    uuid: randomUUID(),
    origin_machine: req.headers['x-machine'] ?? null,
  });
  audit(req, 'criar', 'supplier', id, null, { document: doc.emitente.cnpj, name, origem: 'importacao_nfe' });
  return id;
}

/** Adota o EAN da nota num produto vinculado apenas se ele ainda não tem código. */
function adoptEanIfFree(productId: number, item: NfeDetItem, products: CatalogProduct[]): boolean {
  if (!item.ean) return false;
  const owned = products.some((p) => p.id !== productId && (p.barcode ?? '').trim() === item.ean);
  if (owned) return false;
  productRepository.rawRun(
    "UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ? AND (barcode IS NULL OR barcode = '')",
    item.ean, productId,
  );
  return true;
}

function createProductForItem(req: Request, item: NfeDetItem, products: CatalogProduct[]): number {
  const barcode = item.ean && !products.some((p) => (p.barcode ?? '').trim() === item.ean) ? item.ean : null;
  const id = productRepository.create({
    name: item.description.trim(),
    sku: null,
    barcode,
    unit: item.unit?.trim() || 'un',
    price_cents: 0,
    cost_cents: 0,
    track_stock: 1,
    min_stock: 0,
    active: 1,
    product_type: 'fisico',
    uuid: randomUUID(),
    origin_machine: req.headers['x-machine'] ?? null,
  });
  audit(req, 'criar', 'product', id, null, { origem: 'importacao_nfe', nome: item.description.trim(), ean: barcode });
  return id;
}

/* ─────────────────────────── Preview ─────────────────────────── */

export function buildImportPreview(xml: string): NfeImportPreview {
  const doc = parseNfeDocument(xml);
  if (purchaseInvoiceRepository.findByAccessKey(doc.accessKey)) {
    throw new NfeImportError('Esta NF-e (chave de acesso) já foi importada.');
  }
  const supplier = findSupplierByCnpj(doc.emitente.cnpj);
  const { cat } = buildCatalogFor(supplier?.id ?? null);

  const items: NfePreviewItem[] = doc.items.map((item) => {
    const res = resolveItem(item, cat);
    return {
      line: item.line,
      cProd: item.cProd,
      description: item.description,
      ean: item.ean,
      ncm: item.ncm,
      cfop: item.cfop,
      unit: item.unit,
      qty: item.qty,
      unitCostCents: item.unitCostCents,
      totalCents: item.totalCents,
      kind: res.kind,
      reason: res.reason,
      flags: res.flags,
      error: res.error,
      product: res.product ? serializeProduct(res.product) : null,
      candidates: res.candidates.slice(0, 6).map(serializeProduct),
    };
  });

  return {
    accessKey: doc.accessKey,
    serie: doc.serie,
    number: doc.number,
    issuedAt: doc.issuedAt,
    totalCents: doc.totalCents,
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

export function commitImport(req: Request, xml: string, decisions: NfeDecision[]): NfeImportResult {
  const doc = parseNfeDocument(xml);

  if (purchaseInvoiceRepository.findByAccessKey(doc.accessKey)) {
    throw new NfeImportError('Esta NF-e (chave de acesso) já foi importada.');
  }
  if (!hasService('commercial.purchaseInbound')) {
    throw new NfeImportError('Módulo commercial indisponível — não é possível lançar a compra.');
  }
  const purchaseInbound = getService<CommercialPurchaseInboundService>('commercial.purchaseInbound');

  const byLine = new Map(doc.items.map((it) => [it.line, it]));
  const byDecision = new Map(decisions.map((d) => [d.line, d]));
  for (const item of doc.items) {
    if (!byDecision.has(item.line)) throw new NfeImportError(`Linha ${item.line} sem decisão na conferência.`);
  }
  const validated: Map<number, { item: NfeDetItem; action: NfeImportAction; productId?: number | null; qty: number; unitCostCents: number }> = new Map();
  for (const [line, d] of byDecision) {
    const item = byLine.get(line);
    if (!item) throw new NfeImportError(`Linha ${line} não existe na NF-e.`);
    if (!['link', 'create', 'ignore'].includes(d.action)) throw new NfeImportError(`Linha ${line}: ação inválida.`);
    const qty = Number(d.qty);
    const unitCostCents = Math.round(Number(d.unitCostCents));
    if (!(qty > 0)) throw new NfeImportError(`Linha ${line}: quantidade deve ser positiva.`);
    if (!(unitCostCents > 0)) throw new NfeImportError(`Linha ${line}: custo unitário deve ser positivo.`);
    validated.set(line, { item, action: d.action, productId: d.productId ?? null, qty, unitCostCents });
  }

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
      if (!supplierId) supplierId = createSupplier(req, doc);
      resultSupplierId = supplierId;
      const supplierName = (supplierRepository.findById(supplierId) as { name: string }).name;

      // 2. Catálogo + resolução por linha (link usa produto existente; create valida EAN).
      const { products } = buildCatalogFor(supplierId);

      // Produtos criados nesta mesma importação (reuso entre linhas iguais — nunca dois
      // produtos com o mesmo EAN ou a mesma descrição/unidade dentro da mesma nota).
      const createdByEan = new Map<string, number>();
      const createdByNameUnit = new Map<string, number>();
      const productByLine = new Map<number, number | null>();
      const statusByLine = new Map<number, 'criado' | 'vinculado' | 'ignorado'>();

      for (const [line, v] of validated) {
        const item = v.item;
        if (v.action === 'ignore') { ignored++; productByLine.set(line, null); statusByLine.set(line, 'ignorado'); continue; }

        let productId: number | null = null;
        if (v.action === 'link') {
          if (!v.productId) throw new NfeImportError(`Linha ${line}: vincule um produto ou escolha criar/ignorar.`);
          const chosen = products.find((p) => p.id === v.productId);
          if (!chosen) throw new NfeImportError(`Linha ${line}: produto selecionado não existe mais.`);
          productId = chosen.id;
          adoptEanIfFree(productId, item, products);
          linked++;
        } else {
          // create: reaproveita produto criado nesta mesma nota (mesmo EAN ou mesma
          // descrição+unidade); nunca cria duas vezes o mesmo item numa importação.
          const unitKey = item.unit?.trim() || 'un';
          const nameKey = `${normalizeName(item.description)}|${unitKey}`;
          const existingByEan = item.ean ? createdByEan.get(item.ean) : undefined;
          const existingByName = existingByEan ?? createdByNameUnit.get(nameKey);
          if (existingByName) {
            productId = existingByName;
          } else {
            if (item.ean && products.some((p) => (p.barcode ?? '').trim() === item.ean)) {
              const used = products.find((p) => (p.barcode ?? '').trim() === item.ean)!;
              throw new NfeImportError(`Linha ${line}: já existe produto com o EAN ${item.ean} ("${used.name}") — vincule em vez de criar.`);
            }
            productId = createProductForItem(req, item, products);
            created++;
            if (item.ean) createdByEan.set(item.ean, productId);
            createdByNameUnit.set(nameKey, productId);
          }
        }
        productByLine.set(line, productId);
        statusByLine.set(line, v.action === 'create' ? 'criado' : 'vinculado');
      }

      // 3. NF-e + itens (histórico, preserva os dados fiscais da operação).
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
        imported_by: (req as { user?: { id: number } }).user?.id ?? null,
        uuid: randomUUID(),
        origin_machine: req.headers['x-machine'] ?? null,
      });
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      for (const item of doc.items) {
        const outcome = statusByLine.get(item.line) ?? 'ignorado';
        const productId = productByLine.get(item.line) ?? null;
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
          status: outcome,
          uuid: randomUUID(),
          origin_machine: req.headers['x-machine'] ?? null,
        });
        if (productId != null) {
          productSupplierRepository.upsertLink(supplierId, productId, item.cProd, supplierName, item.unitCostCents);
        }
      }

      // 4. Compra recebida (estoque/custo/custo médio/CMV) — só itens aceitos.
      const accepted = [...productByLine.entries()]
        .filter(([, id]) => id != null)
        .map(([line]) => {
          const v = validated.get(line)!;
          return { productId: productByLine.get(line)!, qty: v.qty, unitCostCents: v.unitCostCents };
        });
      if (accepted.length) {
        purchaseId = purchaseInbound.createInbound(req, {
          supplierId,
          items: accepted,
          notes: `Importada da NF-e chave ${doc.accessKey}`,
          status: 'recebida',
          receivedAt: now,
        });
      }

      audit(req, 'importar_nfe', 'purchase_invoice', invoiceId, null, {
        accessKey: doc.accessKey,
        supplierId: resultSupplierId,
        created, linked, ignored,
        decisions: [...statusByLine.entries()].map(([l, s]) => ({ line: l, status: s })),
      });
    });
  } catch (e) {
    if (e instanceof NfeImportError) throw e;
    // Erros de UNIQUE da chave / SQLITE_CONSTRAINT caem aqui com mensagem honesta.
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
