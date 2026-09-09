import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/**
 * Repositórios do módulo nfe. As tabelas de vínculo produto×fornecedor e de NF-e
 * importada moram AQUI; produtos/fornecedores/compras continuam no módulo commercial
 * (o nfe consome via serviço/repositórios dele, na mesma transação).
 */

export class ProductSupplierRepository extends BaseRepository {
  constructor() {
    super('product_suppliers');
  }

  /** Códigos que este fornecedor usa (cProd) por produto — p/ montar o índice de match. */
  activeCodesForSupplier(supplierId: number): { product_id: number; supplier_code: string }[] {
    return this.raw(
      'SELECT product_id, supplier_code FROM product_suppliers WHERE supplier_id = ? AND deleted_at IS NULL',
      supplierId,
    ) as { product_id: number; supplier_code: string }[];
  }

  /** Reativa ou cria o vínculo produto × fornecedor com os dados da importação. */
  upsertLink(supplierId: number, productId: number, code: string | null, supplierName: string | null, costCents: number): void {
    const existing = this.rawOne(
      'SELECT id FROM product_suppliers WHERE product_id = ? AND supplier_id = ? AND deleted_at IS NULL',
      productId, supplierId,
    ) as { id: number } | undefined;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (existing) {
      this.rawRun(
        `UPDATE product_suppliers
            SET supplier_code = ?, supplier_name = ?, last_cost_cents = ?, last_purchase_at = ?, updated_at = ?
          WHERE id = ?`,
        code, supplierName, costCents, now, existing.id,
      );
      return;
    }
    this.create({
      product_id: productId,
      supplier_id: supplierId,
      supplier_code: code,
      supplier_name: supplierName,
      last_cost_cents: costCents,
      last_purchase_at: now,
      uuid: randomUUID(),
      origin_machine: null,
    });
  }
}

export const productSupplierRepository = new ProductSupplierRepository();

export class PurchaseInvoiceRepository extends BaseRepository {
  constructor() {
    super('purchase_invoices');
  }

  findByAccessKey(accessKey: string): Row | undefined {
    return this.rawOne(
      'SELECT id, access_key FROM purchase_invoices WHERE access_key = ? AND deleted_at IS NULL',
      accessKey,
    );
  }
}

export const purchaseInvoiceRepository = new PurchaseInvoiceRepository();

export class PurchaseInvoiceItemRepository extends BaseRepository {
  constructor() {
    super('purchase_invoice_items');
  }
}

export const purchaseInvoiceItemRepository = new PurchaseInvoiceItemRepository();
