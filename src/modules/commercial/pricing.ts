import { productRepository } from './repositories/ProductRepository';
import { priceListRepository, priceListItemRepository } from './repositories/PriceListRepository';

export interface PriceResolution {
  unitCents: number;
  source: 'customer_list' | 'default_list' | 'catalog';
  priceListId?: number;
  minQtyApplied?: number;
}

export function resolvePrice(productId: number, qty: number, customerId?: number | null): PriceResolution {
  if (customerId != null) {
    const customer = priceListRepository.findCustomerList(customerId) as
      | { price_list_id: number | null } | undefined;
    if (customer?.price_list_id) {
      const row = priceListItemRepository.findByProductAndList(customer.price_list_id, productId, qty) as
        | { unit_price_cents: number; min_qty: number } | undefined;
      if (row && row.unit_price_cents > 0) {
        return { unitCents: row.unit_price_cents, source: 'customer_list', priceListId: customer.price_list_id, minQtyApplied: row.min_qty };
      }
    }
  }

  const defaultList = priceListRepository.findDefault() as { id: number } | undefined;
  if (defaultList) {
    const row = priceListItemRepository.findByProductAndList(defaultList.id, productId, qty) as
      | { unit_price_cents: number; min_qty: number } | undefined;
    if (row && row.unit_price_cents > 0) {
      return { unitCents: row.unit_price_cents, source: 'default_list', priceListId: defaultList.id, minQtyApplied: row.min_qty };
    }
  }

  const product = productRepository.rawOne('SELECT price_cents FROM products WHERE id = ?', productId) as
    | { price_cents: number } | undefined;
  return { unitCents: product?.price_cents ?? 0, source: 'catalog' };
}

export function resolveMany(items: { productId: number; qty: number }[], customerId?: number | null): PriceResolution[] {
  return items.map((i) => resolvePrice(i.productId, i.qty, customerId));
}

/**
 * Preço de um complemento configurado no grupo do produto principal.
 *
 * `price_override_cents` manda; sem ele, vale o preço de catálogo do próprio
 * complemento. A tabela de preço não entra aqui de propósito: a modal do PDV e da
 * comanda mostra exatamente esse valor (`override ?? catálogo`), então é ele que
 * precisa ser congelado no item — senão o valor exibido e o total divergem.
 *
 * Retorna `null` quando o produto NÃO é complemento do principal; aí o chamador
 * segue o caminho normal (`resolvePrice`, com tabela de preço/faixa de quantidade).
 */
export function resolveComplementPrice(baseProductId: number, complementProductId: number): number | null {
  const row = productRepository.rawOne(
    `SELECT COALESCE(i.price_override_cents, p.price_cents) AS unit_cents
       FROM product_complement_groups pcg
       JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
       JOIN complement_group_items i ON i.group_id = pcg.group_id AND i.deleted_at IS NULL
       JOIN products p ON p.id = i.product_id AND p.deleted_at IS NULL
      WHERE pcg.product_id = ? AND pcg.deleted_at IS NULL AND i.product_id = ?
      ORDER BY pcg.sort_order, cg.name, i.sort_order, i.id
      LIMIT 1`,
    baseProductId, complementProductId,
  ) as { unit_cents: number | null } | undefined;
  return row && row.unit_cents != null ? Number(row.unit_cents) : null;
}
