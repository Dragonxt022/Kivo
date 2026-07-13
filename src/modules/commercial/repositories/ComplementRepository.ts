import { BaseRepository, type Row } from '../../../core/database/repository';

export class ComplementGroupRepository extends BaseRepository {
  constructor() {
    super('complement_groups');
  }

  listAll(): Row[] {
    return this.raw(
      'SELECT id, name, min_select, max_select, uuid, updated_at FROM complement_groups WHERE deleted_at IS NULL ORDER BY name',
    );
  }

  softDeleteWithItems(id: number): void {
    this.transaction(() => {
      this.rawRun(
        "UPDATE complement_group_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE group_id = ?",
        id,
      );
      this.rawRun(
        "UPDATE product_complement_groups SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE group_id = ?",
        id,
      );
      this.softDelete(id);
    });
  }
}

export const complementGroupRepository = new ComplementGroupRepository();

export class ComplementItemRepository extends BaseRepository {
  constructor() {
    super('complement_group_items');
  }

  listByGroup(groupId: number): Row[] {
    return this.raw(
      `SELECT i.id, i.group_id, i.product_id, p.name AS product_name, p.sku, i.price_override_cents, i.sort_order, i.uuid, i.updated_at
       FROM complement_group_items i JOIN products p ON p.id = i.product_id
       WHERE i.group_id = ? AND i.deleted_at IS NULL ORDER BY i.sort_order, p.name`,
      groupId,
    );
  }

  findDetailed(id: number): Row | undefined {
    return this.rawOne(
      `SELECT i.id, i.group_id, i.product_id, p.name AS product_name, i.price_override_cents, i.sort_order
       FROM complement_group_items i JOIN products p ON p.id = i.product_id WHERE i.id = ?`,
      id,
    );
  }
}

export const complementItemRepository = new ComplementItemRepository();

export class ProductComplementGroupRepository extends BaseRepository {
  constructor() {
    super('product_complement_groups');
  }

  listByProduct(productId: number): Row[] {
    return this.raw(
      `SELECT pcg.id, pcg.group_id, cg.name AS group_name, cg.min_select, cg.max_select, pcg.sort_order,
              json_group_array(json_object('id', i.id, 'product_id', i.product_id, 'product_name', p.name, 'price_override_cents', i.price_override_cents, 'sort_order', i.sort_order)) AS items
       FROM product_complement_groups pcg
       JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
       LEFT JOIN complement_group_items i ON i.group_id = pcg.group_id AND i.deleted_at IS NULL
       LEFT JOIN products p ON p.id = i.product_id
       WHERE pcg.product_id = ? AND pcg.deleted_at IS NULL
       GROUP BY pcg.id ORDER BY pcg.sort_order, cg.name`,
      productId,
    );
  }

  findExisting(productId: number, groupId: number): Row | undefined {
    return this.findOneWhere({ product_id: productId, group_id: groupId } as unknown as Record<string, string | number | boolean | null>);
  }
}

export const productComplementGroupRepository = new ProductComplementGroupRepository();
