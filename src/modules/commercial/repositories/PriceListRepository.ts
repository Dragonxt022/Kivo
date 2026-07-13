import { BaseRepository, type Row } from '../../../core/database/repository';

export class PriceListRepository extends BaseRepository {
  constructor() {
    super('price_lists');
  }

  listAll(): Row[] {
    return this.raw(
      `SELECT pl.id, pl.name, pl.is_default, pl.active,
              (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = pl.id) AS item_count
       FROM price_lists pl WHERE pl.deleted_at IS NULL ORDER BY pl.name`,
    );
  }

  findDetail(id: number): Row | undefined {
    return this.rawOne(
      'SELECT id, name, is_default, active, updated_at FROM price_lists WHERE id = ? AND deleted_at IS NULL',
      id,
    );
  }

  findDefault(): Row | undefined {
    return this.rawOne("SELECT id FROM price_lists WHERE is_default = 1 AND active = 1 AND deleted_at IS NULL");
  }

  unsetOtherDefaults(): void {
    this.rawRun("UPDATE price_lists SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1");
  }

  findCustomerList(customerId: number): Row | undefined {
    return this.rawOne(
      'SELECT price_list_id FROM customers WHERE id = ? AND deleted_at IS NULL',
      customerId,
    ) as { price_list_id: number | null } | undefined as unknown as Row | undefined;
  }

  migrateCustomers(id: number): void {
    this.rawRun("UPDATE customers SET price_list_id = NULL, updated_at = datetime('now') WHERE price_list_id = ?", id);
  }

  bulkMigrateCustomers(ids: number[]): void {
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    this.rawRun(
      `UPDATE customers SET price_list_id = NULL, updated_at = datetime('now') WHERE price_list_id IN (${ph})`,
      ...ids,
    );
  }
}

export const priceListRepository = new PriceListRepository();

export class PriceListItemRepository extends BaseRepository {
  constructor() {
    super('price_list_items');
  }

  listByPriceList(priceListId: number): Row[] {
    return this.raw(
      `SELECT i.id, i.product_id, p.name AS product_name, i.min_qty, i.unit_price_cents
       FROM price_list_items i JOIN products p ON p.id = i.product_id
       WHERE i.price_list_id = ? ORDER BY p.name, i.min_qty`,
      priceListId,
    );
  }

  deleteByPriceList(priceListId: number): void {
    this.rawRun('DELETE FROM price_list_items WHERE price_list_id = ?', priceListId);
  }

  findByProductAndList(priceListId: number, productId: number, qty: number): Row | undefined {
    return this.rawOne(
      `SELECT unit_price_cents, min_qty FROM price_list_items
       WHERE price_list_id = ? AND product_id = ? AND min_qty <= ?
       ORDER BY min_qty DESC LIMIT 1`,
      priceListId, productId, qty,
    );
  }
}

export const priceListItemRepository = new PriceListItemRepository();
