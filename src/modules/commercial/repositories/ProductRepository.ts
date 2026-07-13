import { BaseRepository, type Row } from '../../../core/database/repository';

export interface ProductRow extends Row {
  id: number;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  category_id: number | null;
  unit: string;
  price_cents: number;
  cost_cents: number;
  track_stock: number;
  stock_qty: number;
  min_stock: number;
  favorite: number;
  active: number;
  image_url: string | null;
  product_type: string;
  parent_product_id: number | null;
  visivel_cardapio: number;
}

const PRODUCT_COLS = `p.id, p.name, p.description, p.sku, p.barcode, p.category_id, c.name AS category,
  p.unit, p.price_cents, p.cost_cents, p.track_stock, p.stock_qty, p.min_stock, p.favorite, p.active,
  p.image_url, p.updated_at, p.product_type, p.parent_product_id, p.visivel_cardapio`;

export class ProductRepository extends BaseRepository<ProductRow> {
  constructor() {
    super('products');
  }

  findDetailed(id: number | string): Row | undefined {
    return this.rawOne(
      `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      id,
    );
  }

  search(query: string): Row[] {
    return this.raw(
      `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.deleted_at IS NULL
         AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)
         AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)
       ORDER BY p.favorite DESC, p.name`,
      `%${query}%`, query, query,
    );
  }

  listTopLevel(): Row[] {
    return this.raw(
      `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.deleted_at IS NULL AND p.parent_product_id IS NULL
         AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)
       ORDER BY p.favorite DESC, p.name`,
    );
  }

  findByBarcode(barcode: string): Row | undefined {
    return this.rawOne(
      `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.barcode = ? AND p.deleted_at IS NULL
         AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`,
      barcode,
    );
  }

  findVariants(parentId: number): Row[] {
    return this.raw(
      `SELECT ${PRODUCT_COLS},
              (SELECT json_group_array(json_object('attribute_id', pvv.attribute_id, 'attribute_name', pa.name, 'value_id', pvv.attribute_value_id, 'value', pav.value))
               FROM product_variant_values pvv
               LEFT JOIN product_attributes pa ON pa.id = pvv.attribute_id
               LEFT JOIN product_attribute_values pav ON pav.id = pvv.attribute_value_id
               WHERE pvv.product_id = p.id AND pvv.deleted_at IS NULL) AS variant_attrs
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.parent_product_id = ? AND p.deleted_at IS NULL
       ORDER BY p.name`,
      parentId,
    );
  }

  softDeleteWithVariants(id: number | string): void {
    this.transaction(() => {
      this.rawRun(
        `UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_product_id = ?`,
        id,
      );
      this.softDelete(id);
    });
  }

  setFavorite(id: number | string, favorite: boolean): void {
    this.update(id, { favorite: favorite ? 1 : 0 } as unknown as Partial<ProductRow>);
  }

  setCardapioOnline(id: number | string, visivel: boolean): void {
    this.update(id, { visivel_cardapio: visivel ? 1 : 0 } as unknown as Partial<ProductRow>);
  }

  updateStock(id: number | string, qty: number): void {
    this.rawRun("UPDATE products SET stock_qty = ?, updated_at = datetime('now') WHERE id = ?", qty, id);
  }

  updateCost(id: number | string, costCents: number): void {
    this.rawRun("UPDATE products SET cost_cents = ?, updated_at = datetime('now') WHERE id = ?", costCents, id);
  }

  generateAutoSku(id: number): void {
    this.rawRun("UPDATE products SET sku = ? WHERE id = ?", `P${String(id).padStart(6, '0')}`, id);
  }
}

export const productRepository = new ProductRepository();
