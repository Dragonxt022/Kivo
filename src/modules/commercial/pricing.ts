import { getSqlite } from '../../core/database/connection';

export interface PriceResolution {
  unitCents: number;
  source: 'customer_list' | 'default_list' | 'catalog';
  priceListId?: number;
  minQtyApplied?: number;
}

/**
 * Resolve o preço unitário de um produto, dada a quantidade e (opcionalmente) o cliente.
 * Precedência: (1) lista do cliente, se ele tiver uma linha para o produto — vence mesmo
 * que a lista padrão desse um preço menor; (2) lista padrão (faixa por quantidade); (3)
 * preço de catálogo (products.price_cents), igual ao comportamento de antes das listas existirem.
 */
export function resolvePrice(productId: number, qty: number, customerId?: number | null): PriceResolution {
  const db = getSqlite();

  if (customerId != null) {
    const customer = db.prepare('SELECT price_list_id FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId) as
      { price_list_id: number | null } | undefined;
    if (customer?.price_list_id) {
      const row = db.prepare(
        `SELECT unit_price_cents, min_qty FROM price_list_items
         WHERE price_list_id = ? AND product_id = ? AND min_qty <= ?
         ORDER BY min_qty DESC LIMIT 1`,
      ).get(customer.price_list_id, productId, qty) as { unit_price_cents: number; min_qty: number } | undefined;
      if (row) {
        return { unitCents: row.unit_price_cents, source: 'customer_list', priceListId: customer.price_list_id, minQtyApplied: row.min_qty };
      }
    }
  }

  const defaultList = db.prepare("SELECT id FROM price_lists WHERE is_default = 1 AND active = 1 AND deleted_at IS NULL").get() as
    { id: number } | undefined;
  if (defaultList) {
    const row = db.prepare(
      `SELECT unit_price_cents, min_qty FROM price_list_items
       WHERE price_list_id = ? AND product_id = ? AND min_qty <= ?
       ORDER BY min_qty DESC LIMIT 1`,
    ).get(defaultList.id, productId, qty) as { unit_price_cents: number; min_qty: number } | undefined;
    if (row) {
      return { unitCents: row.unit_price_cents, source: 'default_list', priceListId: defaultList.id, minQtyApplied: row.min_qty };
    }
  }

  const product = db.prepare('SELECT price_cents FROM products WHERE id = ?').get(productId) as { price_cents: number } | undefined;
  return { unitCents: product?.price_cents ?? 0, source: 'catalog' };
}

export function resolveMany(items: { productId: number; qty: number }[], customerId?: number | null): PriceResolution[] {
  return items.map((i) => resolvePrice(i.productId, i.qty, customerId));
}
