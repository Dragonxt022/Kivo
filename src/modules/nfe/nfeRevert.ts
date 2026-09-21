/**
 * Reversão ("desfazer") de uma importação de NF-e.
 *
 * Devolve o estado anterior à nota, como se ela nunca tivesse existido:
 *  1. reverte o estoque (movimentações de saída compensando as entradas da compra);
 *  2. restaura o custo anterior dos produtos vinculados (coluna `prev_cost_cents`);
 *  3. apaga os produtos que a importação CRIOU e que não têm uso fora dela;
 *  4. remove os vínculos produto×fornecedor criados por esta nota;
 *  5. apaga o fornecedor, se ele não tiver mais notas/compras;
 *  6. apaga a compra e a própria NF-e (libera a chave de acesso para reimportar).
 *
 * Tudo numa transação só: ou volta tudo, ou não volta nada. Se o estoque já tiver sido
 * vendido/consumido, a reversão falha com mensagem clara em vez de deixar saldo negativo.
 */
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { moveStockRaw } from '../commercial/stock';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { productBarcodeRepository } from '../commercial/repositories/ProductBarcodeRepository';
import { supplierRepository } from '../commercial/repositories/SupplierRepository';
import { purchaseRepository, purchaseItemRepository } from '../commercial/repositories/PurchaseRepository';
import {
  purchaseInvoiceRepository,
  purchaseInvoiceItemRepository,
  productSupplierRepository,
} from './repositories/NfeRepository';
import { NfeImportError } from './nfeImport';

export interface NfeRevertResult {
  invoiceId: number;
  stockReversed: number;
  costRestored: number;
  priceRestored: number;
  productsDeleted: number;
  linksRemoved: number;
  supplierDeleted: boolean;
  purchaseDeleted: boolean;
}

interface InvoiceRow {
  id: number;
  access_key: string;
  supplier_id: number;
  purchase_id: number | null;
  supplier_created: number;
}

interface ItemRow {
  id: number;
  product_id: number | null;
  qty: number;
  status: string;
  prev_cost_cents: number | null;
  prev_price_cents: number | null;
  ean: string | null;
  ean_box: string | null;
}

/** Referências da própria operação que NÃO contam como "uso" ao apagar um produto. */
export interface ProductUseExclusions {
  /** Compras geradas pela importação (entrada e respectiva reversão). */
  purchaseIds?: number[];
  /** NF-e da operação: movimentos 'nfe_revert'/'nfe_edit' apontam para ela. */
  invoiceIds?: number[];
}

function inList(values: number[], fallback: string): string {
  return values.length ? values.map(() => '?').join(',') : fallback;
}

/**
 * O produto tem alguma referência FORA da importação que está sendo revertida/editada?
 * Se tiver, ele não pode ser apagado — pode estar em outra compra, numa venda, num kit,
 * etc. As referências da própria operação (compras e movimentos de reversão/edição) são
 * desconsideradas de propósito.
 */
export function productHasOtherUse(productId: number, exclude: ProductUseExclusions = {}): boolean {
  const purchaseIds = exclude.purchaseIds ?? [];
  const invoiceIds = exclude.invoiceIds ?? [];
  const purchasePh = inList(purchaseIds, '-1');
  const purchaseRefPh = inList(purchaseIds, "''");
  const invoiceRefPh = inList(invoiceIds, "''");
  const checks: [string, unknown[]][] = [
    [`SELECT 1 FROM purchase_items WHERE product_id = ? AND purchase_id NOT IN (${purchasePh})`, [productId, ...purchaseIds]],
    ['SELECT 1 FROM sale_items WHERE product_id = ?', [productId]],
    [
      `SELECT 1 FROM stock_movements
        WHERE product_id = ?
          AND NOT (ref_entity = 'purchase' AND ref_id IN (${purchaseRefPh}))
          AND NOT (ref_entity IN ('nfe_revert', 'nfe_edit') AND ref_id IN (${invoiceRefPh}))`,
      [productId, ...purchaseIds.map(String), ...invoiceIds.map(String)],
    ],
    ['SELECT 1 FROM kit_items WHERE deleted_at IS NULL AND (kit_product_id = ? OR component_product_id = ?)', [productId, productId]],
    ['SELECT 1 FROM product_recipe_items WHERE deleted_at IS NULL AND (produced_product_id = ? OR input_product_id = ?)', [productId, productId]],
    ['SELECT 1 FROM complement_group_items WHERE deleted_at IS NULL AND product_id = ?', [productId]],
    ['SELECT 1 FROM product_complement_groups WHERE deleted_at IS NULL AND product_id = ?', [productId]],
    ['SELECT 1 FROM product_variant_values WHERE deleted_at IS NULL AND product_id = ?', [productId]],
    ['SELECT 1 FROM products WHERE deleted_at IS NULL AND parent_product_id = ?', [productId]],
  ];
  return checks.some(([sql, params]) => !!productRepository.rawOne(sql, ...params));
}

export function revertImport(req: Request, invoiceId: number): NfeRevertResult {
  const invoice = purchaseInvoiceRepository.rawOne(
    `SELECT id, access_key, supplier_id, purchase_id, supplier_created
       FROM purchase_invoices WHERE id = ? AND deleted_at IS NULL`,
    invoiceId,
  ) as unknown as InvoiceRow | undefined;
  if (!invoice) throw new NfeImportError('Importação não encontrada (talvez já tenha sido revertida).');

  const items = purchaseInvoiceItemRepository.raw(
    `SELECT id, product_id, qty, status, prev_cost_cents, prev_price_cents, ean, ean_box
       FROM purchase_invoice_items WHERE purchase_invoice_id = ? AND deleted_at IS NULL ORDER BY line`,
    invoiceId,
  ) as unknown as ItemRow[];

  // Compra comercial gerada. Notas antigas (antes da coluna purchase_id) caem no fallback
  // pelo texto de `notes`, que sempre cita a chave de acesso.
  let purchaseId = Number(invoice.purchase_id ?? 0);
  if (!purchaseId) {
    const p = purchaseRepository.rawOne(
      "SELECT id FROM purchases WHERE deleted_at IS NULL AND notes LIKE ? ORDER BY id DESC LIMIT 1",
      `%${invoice.access_key}%`,
    ) as { id: number } | undefined;
    purchaseId = p?.id ?? 0;
  }

  let stockReversed = 0;
  let costRestored = 0;
  let priceRestored = 0;
  let productsDeleted = 0;
  let linksRemoved = 0;
  let supplierDeleted = false;
  let purchaseDeleted = false;

  productRepository.transaction(() => {
    // 1. Reverte o estoque e apaga a compra recebida.
    if (purchaseId) {
      for (const it of purchaseItemRepository.listByPurchaseRaw(purchaseId)) {
        const move = moveStockRaw(req, it.productId, 'saida', it.qty, 'reversão de importação de NF-e', 'nfe_revert', invoiceId);
        if (!move.ok) {
          throw new NfeImportError(
            `Não foi possível reverter o estoque do produto ${it.productId}: ${move.error} ` +
            'A nota pode já ter sido vendida/consumida — cancele a venda primeiro.',
          );
        }
        stockReversed++;
      }
      purchaseItemRepository.deleteByPurchase(purchaseId);
      purchaseRepository.softDelete(purchaseId);
      purchaseDeleted = true;
    }

    // 2. Restaura o custo anterior (1ª ocorrência por produto, na ordem das linhas).
    //    Produto criado pela nota não tem "custo anterior" — se for apagado, some; se
    //    continuar em uso (não pode ser apagado), mantém o custo que a compra definiu.
    const restored = new Set<number>();
    for (const it of items) {
      if (it.product_id == null || it.prev_cost_cents == null || it.status === 'criado' || restored.has(it.product_id)) continue;
      restored.add(it.product_id);
      productRepository.updateCost(it.product_id, Number(it.prev_cost_cents));
      costRestored++;
    }

    // 2b. Restaura o preço anterior dos produtos VINCULADOS (produto criado é apagado).
    const restoredPrice = new Set<number>();
    for (const it of items) {
      if (it.product_id == null || it.prev_price_cents == null || it.status === 'criado' || restoredPrice.has(it.product_id)) continue;
      restoredPrice.add(it.product_id);
      productRepository.rawRun(
        "UPDATE products SET price_cents = ?, updated_at = datetime('now') WHERE id = ?",
        Number(it.prev_price_cents), it.product_id,
      );
      priceRestored++;
    }

    // 2c. Remove códigos de barras secundários (caixa/lastro) que esta nota criou. Sem isso
    //     o índice único de product_barcodes impediria reimportar o mesmo EAN depois.
    for (const it of items) {
      if (it.product_id == null) continue;
      if (it.status === 'criado') {
        productBarcodeRepository.softDeleteWhere({ product_id: it.product_id });
        continue;
      }
      if (it.ean) productBarcodeRepository.softDeleteWhere({ product_id: it.product_id, barcode: it.ean });
      if (it.ean_box) productBarcodeRepository.softDeleteWhere({ product_id: it.product_id, barcode: it.ean_box });
    }

    // 3. Apaga os produtos criados pela importação que não têm uso fora dela.
    for (const it of items) {
      if (it.status !== 'criado' || it.product_id == null) continue;
      if (productHasOtherUse(it.product_id, { purchaseIds: purchaseId ? [purchaseId] : [], invoiceIds: [invoiceId] })) continue;
      productRepository.softDelete(it.product_id);
      productsDeleted++;
    }

    // 4. Remove os vínculos produto×fornecedor desta nota — mas só quando não há outra
    //    nota do mesmo fornecedor para o mesmo produto (senão o vínculo ainda é útil).
    for (const it of items) {
      if (it.product_id == null) continue;
      const other = purchaseInvoiceItemRepository.rawOne(
        `SELECT 1 FROM purchase_invoice_items pii
           JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
          WHERE pii.product_id = ? AND pi.supplier_id = ? AND pi.deleted_at IS NULL
            AND pii.deleted_at IS NULL AND pii.purchase_invoice_id <> ?`,
        it.product_id, invoice.supplier_id, invoiceId,
      );
      if (!other) {
        productSupplierRepository.softDeleteWhere({ product_id: it.product_id, supplier_id: invoice.supplier_id });
        linksRemoved++;
      }
    }

    // 5. Apaga a nota + itens (libera a chave de acesso para reimportar).
    purchaseInvoiceItemRepository.softDeleteWhere({ purchase_invoice_id: invoiceId });
    purchaseInvoiceRepository.softDelete(invoiceId);

    // 6. Apaga o fornecedor se não tiver mais nada (foi criado por esta nota ou só servia
    //    a ela). A contagem já exclui a nota/compra recém-apagadas.
    const otherInvoices = purchaseInvoiceRepository.count({ supplier_id: invoice.supplier_id });
    const otherPurchases = purchaseRepository.count({ supplier_id: invoice.supplier_id });
    if (otherInvoices === 0 && otherPurchases === 0) {
      supplierRepository.softDelete(invoice.supplier_id);
      supplierDeleted = true;
    }
  });

  audit(req, 'reverter_nfe', 'purchase_invoice', invoiceId, null, {
    accessKey: invoice.access_key,
    stockReversed, costRestored, priceRestored, productsDeleted, linksRemoved, supplierDeleted, purchaseDeleted,
  });
  return { invoiceId, stockReversed, costRestored, priceRestored, productsDeleted, linksRemoved, supplierDeleted, purchaseDeleted };
}
