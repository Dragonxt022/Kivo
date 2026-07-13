import { BaseRepository, type Row } from '../../../core/database/repository';

export class PurchaseRepository extends BaseRepository {
  constructor() {
    super('purchases');
  }

  listAll(): Row[] {
    return this.raw(
      `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at
       FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
       WHERE pu.deleted_at IS NULL ORDER BY pu.id DESC`,
    );
  }

  findDetail(id: number | string): Row | undefined {
    return this.rawOne(
      `SELECT id, supplier_id, status, total_cents, notes, received_at, updated_at
       FROM purchases WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  receive(id: number): void {
    this.rawRun(
      "UPDATE purchases SET status = 'recebida', received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id,
    );
  }

  cancel(id: number): void {
    this.rawRun("UPDATE purchases SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?", id);
  }

  updateTotal(id: number, totalCents: number): void {
    this.rawRun("UPDATE purchases SET total_cents = ?, updated_at = datetime('now') WHERE id = ?", totalCents, id);
  }
}

export const purchaseRepository = new PurchaseRepository();

export class PurchaseItemRepository extends BaseRepository {
  constructor() {
    super('purchase_items');
  }

  listByPurchase(purchaseId: number): Row[] {
    return this.raw(
      `SELECT pi.id, pi.product_id, p.name AS product_name, pi.qty, pi.unit_cost_cents
       FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?`,
      purchaseId,
    );
  }

  deleteByPurchase(purchaseId: number): void {
    this.rawRun('DELETE FROM purchase_items WHERE purchase_id = ?', purchaseId);
  }

  listByPurchaseRaw(purchaseId: number): { productId: number; qty: number; unitCostCents: number }[] {
    return this.raw(
      'SELECT product_id AS productId, qty, unit_cost_cents AS unitCostCents FROM purchase_items WHERE purchase_id = ?',
      purchaseId,
    ) as { productId: number; qty: number; unitCostCents: number }[];
  }

  listProductQtys(purchaseId: number): { product_id: number; qty: number }[] {
    return this.raw(
      'SELECT product_id, qty FROM purchase_items WHERE purchase_id = ?',
      purchaseId,
    ) as { product_id: number; qty: number }[];
  }
}

export const purchaseItemRepository = new PurchaseItemRepository();
