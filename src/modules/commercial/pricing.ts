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
      if (row) {
        return { unitCents: row.unit_price_cents, source: 'customer_list', priceListId: customer.price_list_id, minQtyApplied: row.min_qty };
      }
    }
  }

  const defaultList = priceListRepository.findDefault() as { id: number } | undefined;
  if (defaultList) {
    const row = priceListItemRepository.findByProductAndList(defaultList.id, productId, qty) as
      | { unit_price_cents: number; min_qty: number } | undefined;
    if (row) {
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
