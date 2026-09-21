/**
 * Edição de uma importação de NF-e já concluída.
 *
 * Diferente da reversão (que devolve tudo ao estado anterior e apaga a nota), a edição
 * REABRE a conferência para trocar vínculos, criar/ignorar linhas, ajustar quantidade,
 * custo, preço e conversão. Ao confirmar, a versão antiga é estornada e a nova é aplicada
 * na MESMA NF-e (mesmo id/chave), dentro de UMA transação.
 *
 * Reconcílio do estoque — o ponto sensível, porque depois da importação o produto pode
 * ter sido vendido ou ajustado:
 *   - `restore` (Restaurar estado da nota): estorna a entrada antiga exigindo saldo
 *     suficiente; se algo já foi vendido, a edição falha em vez de deixar saldo negativo.
 *   - `keep` (Manter estoque atual): estorna mesmo com saldo insuficiente (respeitando a
 *     configuração de venda com estoque zerado) e aplica a nova entrada. O saldo final é
 *     `atual - antigo + novo`, ou seja, as vendas/ajustes são preservados.
 * Quando há divergência (movimentos após a importação ou saldo insuficiente) e o usuário
 * não informou o modo, `commitEdit` recusa com `NfeEditChoiceRequired` para a tela
 * perguntar.
 */
import type { Request } from 'express';
import { moveStockRaw } from '../commercial/stock';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { productBarcodeRepository } from '../commercial/repositories/ProductBarcodeRepository';
import { purchaseRepository, purchaseItemRepository } from '../commercial/repositories/PurchaseRepository';
import {
  purchaseInvoiceRepository,
  purchaseInvoiceItemRepository,
  productSupplierRepository,
} from './repositories/NfeRepository';
import { parseNfeDocument } from './nfeParse';
import {
  NfeImportError,
  applyImportCore,
  buildPreviewFromDoc,
  type NfeDecision,
  type NfeImportAction,
  type NfeImportPreview,
  type NfeImportResult,
} from './nfeImport';
import { productHasOtherUse } from './nfeRevert';

export type StockMode = 'keep' | 'restore';

interface InvoiceRow {
  id: number;
  access_key: string;
  supplier_id: number;
  supplier_name: string | null;
  invoice_number: string | null;
  series: string | null;
  issued_at: string | null;
  total_cents: number;
  xml: string;
  purchase_id: number | null;
  supplier_created: number;
}

interface ItemRow {
  id: number;
  line: number;
  product_id: number | null;
  qty: number;
  status: string;
  unit: string | null;
  unit_cost_cents: number;
  sale_price_cents: number | null;
  conversion_qty: number | null;
  conversion_unit: string | null;
  prev_cost_cents: number | null;
  prev_price_cents: number | null;
  ean: string | null;
  ean_box: string | null;
}

/** Decisão já aplicada, para a tela reabrir a conferência pré-preenchida. */
export interface NfeEditDecision {
  line: number;
  action: NfeImportAction;
  productId: number | null;
  productName: string | null;
  /** Status gravado originalmente: criado/vinculado/ignorado. */
  status: string;
  qty: number;
  unitCostCents: number;
  salePriceCents: number | null;
  conversionQty: number | null;
  conversionUnit: string | null;
  saleUnit: string | null;
}

export interface NfeEditDivergenceItem {
  productId: number;
  name: string;
  /** Quantidade que a importação lançou (unidade de venda). */
  importedQty: number;
  /** Saldo atual do produto. */
  stockQty: number;
  /** Foi vendido/ajustado desde a importação (ou o saldo não cobre o estorno). */
  changed: boolean;
}

export interface NfeEditDivergence {
  changed: boolean;
  items: NfeEditDivergenceItem[];
}

export interface NfeEditData {
  invoice: {
    id: number;
    number: string | null;
    series: string | null;
    accessKey: string;
    issuedAt: string | null;
    totalCents: number;
    supplierName: string | null;
  };
  preview: NfeImportPreview;
  decisions: NfeEditDecision[];
  divergence: NfeEditDivergence;
}

/** Erro sinalizado à tela quando é preciso perguntar como reconciliar o estoque. */
export class NfeEditChoiceRequired extends NfeImportError {
  constructor(public readonly divergence: NfeEditDivergence) {
    super('Há produtos vendidos ou alterados desde a importação. Escolha como reconciliar o estoque.');
  }
}

function loadInvoice(invoiceId: number): InvoiceRow {
  const invoice = purchaseInvoiceRepository.rawOne(
    `SELECT id, access_key, supplier_id, supplier_name, invoice_number, series, issued_at,
            total_cents, xml, purchase_id, supplier_created
       FROM purchase_invoices WHERE id = ? AND deleted_at IS NULL`,
    invoiceId,
  ) as unknown as InvoiceRow | undefined;
  if (!invoice) throw new NfeImportError('Importação não encontrada (talvez já tenha sido revertida).');
  return invoice;
}

function loadItems(invoiceId: number): ItemRow[] {
  return purchaseInvoiceItemRepository.raw(
    `SELECT id, line, product_id, qty, status, unit, unit_cost_cents, sale_price_cents,
            conversion_qty, conversion_unit, prev_cost_cents, prev_price_cents, ean, ean_box
       FROM purchase_invoice_items
      WHERE purchase_invoice_id = ? AND deleted_at IS NULL ORDER BY line`,
    invoiceId,
  ) as unknown as ItemRow[];
}

/** Compra comercial gerada. Notas antigas caem no fallback pelo texto de `notes`. */
function resolvePurchaseId(invoice: InvoiceRow): number {
  const id = Number(invoice.purchase_id ?? 0);
  if (id) return id;
  const p = purchaseRepository.rawOne(
    "SELECT id FROM purchases WHERE deleted_at IS NULL AND notes LIKE ? ORDER BY id DESC LIMIT 1",
    `%${invoice.access_key}%`,
  ) as { id: number } | undefined;
  return p?.id ?? 0;
}

function loadProductBriefs(ids: number[]): Map<number, { name: string; unit: string | null }> {
  const map = new Map<number, { name: string; unit: string | null }>();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = productRepository.raw(
    `SELECT id, name, unit FROM products WHERE id IN (${ph}) AND deleted_at IS NULL`,
    ...ids,
  ) as { id: number; name: string; unit: string | null }[];
  for (const r of rows) map.set(r.id, { name: r.name, unit: r.unit });
  return map;
}

/**
 * Detecta se algum produto da nota foi vendido/ajustado depois da importação (ou se o
 * saldo atual não cobre o estorno). É o gatilho para a tela perguntar como reconciliar.
 */
export function detectDivergence(invoiceId: number, purchaseId: number, items: ItemRow[]): NfeEditDivergence {
  const productIds = [...new Set(items.filter((i) => i.product_id != null).map((i) => i.product_id as number))];
  if (!productIds.length) return { changed: false, items: [] };

  const imported = new Map<number, number>();
  if (purchaseId) {
    for (const pi of purchaseItemRepository.listByPurchaseRaw(purchaseId)) {
      imported.set(pi.productId, (imported.get(pi.productId) ?? 0) + Number(pi.qty));
    }
  } else {
    for (const it of items) {
      if (it.product_id == null) continue;
      imported.set(it.product_id, (imported.get(it.product_id) ?? 0) + Number(it.qty));
    }
  }

  const lastMove = purchaseId
    ? Number((productRepository.rawOne(
        "SELECT MAX(id) AS m FROM stock_movements WHERE ref_entity = 'purchase' AND ref_id = ?",
        String(purchaseId),
      ) as { m: number | null } | undefined)?.m ?? 0)
    : 0;

  const ph = productIds.map(() => '?').join(',');
  const changedRows = productRepository.raw(
    `SELECT DISTINCT product_id FROM stock_movements
      WHERE product_id IN (${ph}) AND id > ?
        AND NOT (ref_entity IN ('nfe_revert', 'nfe_edit') AND ref_id = ?)`,
    ...productIds, lastMove, String(invoiceId),
  ) as unknown as { product_id: number }[];
  const changedSet = new Set(changedRows.map((r) => Number(r.product_id)));

  const prodRows = productRepository.raw(
    `SELECT id, name, stock_qty FROM products WHERE id IN (${ph})`,
    ...productIds,
  ) as { id: number; name: string; stock_qty: number }[];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));

  const out: NfeEditDivergenceItem[] = productIds.map((pid) => {
    const prod = prodMap.get(pid);
    const importedQty = imported.get(pid) ?? 0;
    const stockQty = prod ? Number(prod.stock_qty) : 0;
    return {
      productId: pid,
      name: prod?.name ?? `Produto ${pid}`,
      importedQty,
      stockQty,
      changed: changedSet.has(pid) || stockQty < importedQty,
    };
  });
  return { changed: out.some((o) => o.changed), items: out };
}

/** Reabre a conferência: preview reclassificado + decisões gravadas + divergência. */
export function buildEditData(invoiceId: number): NfeEditData {
  const invoice = loadInvoice(invoiceId);
  const doc = parseNfeDocument(invoice.xml);
  const preview = buildPreviewFromDoc(doc);
  const items = loadItems(invoiceId);
  const itemByLine = new Map(items.map((i) => [i.line, i]));
  const briefs = loadProductBriefs(
    items.filter((i) => i.product_id != null).map((i) => i.product_id as number),
  );
  const previewByLine = new Map(preview.items.map((p) => [p.line, p]));

  const decisions: NfeEditDecision[] = doc.items.map((item) => {
    const stored = itemByLine.get(item.line);
    const pv = previewByLine.get(item.line);
    if (!stored) {
      return {
        line: item.line, action: 'create', productId: null, productName: null, status: 'novo',
        qty: item.qty, unitCostCents: item.unitCostCents, salePriceCents: null,
        conversionQty: null, conversionUnit: null, saleUnit: pv?.saleUnit ?? null,
      };
    }
    const brief = stored.product_id != null ? briefs.get(stored.product_id) : undefined;
    let action: NfeImportAction;
    if (stored.status === 'ignorado') action = 'ignore';
    else action = brief ? 'link' : 'create';
    const productId = action === 'link' ? stored.product_id : null;
    return {
      line: item.line,
      action,
      productId,
      productName: productId != null ? (brief?.name ?? null) : null,
      status: stored.status,
      qty: Number(stored.qty),
      unitCostCents: Number(stored.unit_cost_cents),
      salePriceCents: stored.sale_price_cents == null ? null : Number(stored.sale_price_cents),
      conversionQty: stored.conversion_qty == null ? null : Number(stored.conversion_qty),
      conversionUnit: stored.conversion_unit,
      saleUnit: brief?.unit ?? pv?.saleUnit ?? null,
    };
  });

  const purchaseId = resolvePurchaseId(invoice);
  return {
    invoice: {
      id: invoice.id,
      number: invoice.invoice_number,
      series: invoice.series,
      accessKey: invoice.access_key,
      issuedAt: invoice.issued_at,
      totalCents: invoice.total_cents,
      supplierName: invoice.supplier_name,
    },
    preview,
    decisions,
    divergence: detectDivergence(invoiceId, purchaseId, items),
  };
}

/**
 * Estorna a importação antiga (estoque/custo/preço/códigos/vínculos/produtos criados)
 * para a nova versão ser aplicada em seguida. NÃO apaga o fornecedor nem a NF-e — a
 * edição reaproveita ambos. Produtos que a nova conferência vai vincular são preservados.
 */
function undoImportForEdit(
  req: Request,
  invoice: InvoiceRow,
  items: ItemRow[],
  purchaseId: number,
  mode: StockMode,
  keepProductIds: Set<number>,
): void {
  // 1. Estorna o estoque da entrada antiga. No modo "manter estoque" aceita saldo
  //    insuficiente (as vendas seguem valendo); no "restaurar estado" exige saldo.
  if (purchaseId) {
    for (const pi of purchaseItemRepository.listByPurchaseRaw(purchaseId)) {
      const move = moveStockRaw(
        req, pi.productId, 'saida', pi.qty,
        'edição de importação de NF-e (estorno)', 'nfe_edit', invoice.id, mode === 'keep',
      );
      if (!move.ok) {
        throw new NfeImportError(
          mode === 'keep'
            ? `Não foi possível ajustar o estoque do produto ${pi.productId}: ${move.error}`
            : `Não foi possível estornar o estoque do produto ${pi.productId}: ${move.error} ` +
              'O produto pode já ter sido vendido/consumido — use a opção de manter o estoque atual.',
        );
      }
    }
    purchaseItemRepository.deleteByPurchase(purchaseId);
    purchaseRepository.softDelete(purchaseId);
  }

  // 2. Restaura custo/preço anteriores dos produtos VINCULADOS (os criados são apagados
  //    ou reaproveitados — o custo deles é recalculado na nova entrada).
  const restoredCost = new Set<number>();
  const restoredPrice = new Set<number>();
  for (const it of items) {
    if (it.product_id == null || it.status === 'criado') continue;
    if (it.prev_cost_cents != null && !restoredCost.has(it.product_id)) {
      restoredCost.add(it.product_id);
      productRepository.updateCost(it.product_id, Number(it.prev_cost_cents));
    }
    if (it.prev_price_cents != null && !restoredPrice.has(it.product_id)) {
      restoredPrice.add(it.product_id);
      productRepository.rawRun(
        "UPDATE products SET price_cents = ?, updated_at = datetime('now') WHERE id = ?",
        Number(it.prev_price_cents), it.product_id,
      );
    }
  }

  // 3. Remove códigos secundários criados por esta nota (para a reimportação do EAN não
  //    esbarrar no índice único).
  for (const it of items) {
    if (it.product_id == null) continue;
    if (it.status === 'criado' && !keepProductIds.has(it.product_id)) {
      productBarcodeRepository.softDeleteWhere({ product_id: it.product_id });
      continue;
    }
    if (it.ean) productBarcodeRepository.softDeleteWhere({ product_id: it.product_id, barcode: it.ean });
    if (it.ean_box) productBarcodeRepository.softDeleteWhere({ product_id: it.product_id, barcode: it.ean_box });
  }

  // 4. Apaga produtos criados pela nota que a edição não vai mais usar e que não têm uso.
  for (const it of items) {
    if (it.status !== 'criado' || it.product_id == null) continue;
    if (keepProductIds.has(it.product_id)) continue;
    if (productHasOtherUse(it.product_id, {
      purchaseIds: purchaseId ? [purchaseId] : [],
      invoiceIds: [invoice.id],
    })) continue;
    productRepository.softDelete(it.product_id);
  }

  // 5. Remove vínculos produto×fornecedor que a nova conferência não vai mais manter.
  for (const it of items) {
    if (it.product_id == null || keepProductIds.has(it.product_id)) continue;
    const other = purchaseInvoiceItemRepository.rawOne(
      `SELECT 1 FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
        WHERE pii.product_id = ? AND pi.supplier_id = ? AND pi.deleted_at IS NULL
          AND pii.deleted_at IS NULL AND pii.purchase_invoice_id <> ?`,
      it.product_id, invoice.supplier_id, invoice.id,
    );
    if (!other) {
      productSupplierRepository.softDeleteWhere({ product_id: it.product_id, supplier_id: invoice.supplier_id });
    }
  }
}

/**
 * Aplica a edição: estorna a versão antiga e grava a nova na mesma NF-e. `stockMode` nulo
 * só é aceito quando não há divergência (caso contrário lança `NfeEditChoiceRequired`).
 */
export function commitEdit(
  req: Request,
  invoiceId: number,
  decisions: NfeDecision[],
  stockMode: string | null,
): NfeImportResult {
  const invoice = loadInvoice(invoiceId);
  const doc = parseNfeDocument(invoice.xml);
  const items = loadItems(invoiceId);
  const purchaseId = resolvePurchaseId(invoice);
  const divergence = detectDivergence(invoiceId, purchaseId, items);

  if (divergence.changed && stockMode !== 'keep' && stockMode !== 'restore') {
    throw new NfeEditChoiceRequired(divergence);
  }
  const mode: StockMode = stockMode === 'keep' ? 'keep' : 'restore';
  const keepProductIds = new Set(
    decisions.filter((d) => d.action === 'link' && d.productId).map((d) => Number(d.productId)),
  );

  let result: NfeImportResult | null = null;
  productRepository.transaction(() => {
    undoImportForEdit(req, invoice, items, purchaseId, mode, keepProductIds);
    result = applyImportCore(req, doc, invoice.xml, decisions, {
      existingInvoiceId: invoiceId,
      auditAction: 'editar_nfe',
      auditDetails: { stockMode: mode, divergencia: divergence.changed },
    });
  });

  return result as unknown as NfeImportResult;
}
