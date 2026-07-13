import { BaseRepository, type Row } from '../../../core/database/repository';

export class KitItemRepository extends BaseRepository {
  constructor() {
    super('kit_items');
  }

  listByProduct(productId: number): Row[] {
    return this.raw(
      `SELECT ki.id, ki.kit_product_id, ki.component_product_id, p.name AS component_name, p.sku, ki.qty, ki.sort_order, ki.uuid, ki.updated_at
       FROM kit_items ki JOIN products p ON p.id = ki.component_product_id
       WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL ORDER BY ki.sort_order, p.name`,
      productId,
    );
  }

  findDetailed(id: number): Row | undefined {
    return this.rawOne(
      `SELECT ki.id, ki.kit_product_id, ki.component_product_id, p.name AS component_name, ki.qty, ki.sort_order
       FROM kit_items ki JOIN products p ON p.id = ki.component_product_id WHERE ki.id = ?`,
      id,
    );
  }

  findComponentsByProduct(productId: number): Row[] {
    return this.raw(
      `SELECT ki.qty AS compQty, comp.id, comp.name, comp.cost_cents, comp.active
       FROM kit_items ki
       JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
       WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL
       ORDER BY ki.sort_order`,
      productId,
    );
  }
}

export const kitItemRepository = new KitItemRepository();
