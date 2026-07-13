import { BaseRepository, type Row } from '../../../core/database/repository';

export class ProductAttributeRepository extends BaseRepository {
  constructor() {
    super('product_attributes');
  }

  listAll(): Row[] {
    return this.raw('SELECT id, name, uuid, updated_at FROM product_attributes WHERE deleted_at IS NULL ORDER BY name');
  }

  softDeleteWithValues(id: number): void {
    this.transaction(() => {
      this.rawRun(
        "UPDATE product_attribute_values SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE attribute_id = ?",
        id,
      );
      this.softDelete(id);
    });
  }
}

export const productAttributeRepository = new ProductAttributeRepository();

export class ProductAttributeValueRepository extends BaseRepository {
  constructor() {
    super('product_attribute_values');
  }

  listByAttribute(attributeId: number): Row[] {
    return this.raw(
      `SELECT id, attribute_id, value, sort_order, uuid, updated_at
       FROM product_attribute_values WHERE attribute_id = ? AND deleted_at IS NULL ORDER BY sort_order, value`,
      attributeId,
    );
  }

  findByIds(ids: number[]): Row[] {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return this.raw(
      `SELECT pav.id, pav.attribute_id, pa.name AS attribute_name, pav.value
       FROM product_attribute_values pav
       JOIN product_attributes pa ON pa.id = pav.attribute_id
       WHERE pav.id IN (${ph}) AND pav.deleted_at IS NULL AND pa.deleted_at IS NULL`,
      ...ids,
    );
  }
}

export const productAttributeValueRepository = new ProductAttributeValueRepository();

export class ProductVariantValueRepository extends BaseRepository {
  constructor() {
    super('product_variant_values');
  }

  findByProduct(productId: number): Row[] {
    return this.findWhere({ product_id: productId } as unknown as Record<string, string | number | boolean | null>);
  }

  findExistingCombination(parentId: number, valueIds: number[]): Row | undefined {
    if (!valueIds.length) return undefined;
    const ph = valueIds.map(() => '?').join(',');
    return this.rawOne(
      `SELECT pv.product_id FROM product_variant_values pv
       WHERE pv.product_id IN (SELECT id FROM products WHERE parent_product_id = ? AND deleted_at IS NULL)
       AND pv.deleted_at IS NULL
       GROUP BY pv.product_id HAVING COUNT(*) = ? AND SUM(CASE WHEN pv.attribute_value_id IN (${ph}) THEN 1 ELSE 0 END) = ?`,
      parentId, valueIds.length, ...valueIds, valueIds.length,
    );
  }
}

export const productVariantValueRepository = new ProductVariantValueRepository();
