import { BaseRepository, type Row } from '../../../core/database/repository';

export class RecipeItemRepository extends BaseRepository {
  constructor() {
    super('product_recipe_items');
  }

  listByProduct(productId: number): Row[] {
    return this.raw(
      `SELECT ri.id, ri.produced_product_id, ri.input_product_id, p.name AS input_name, p.sku, ri.qty, ri.sort_order, ri.uuid, ri.updated_at,
              p.cost_cents, (ri.qty * p.cost_cents) AS total_cost_cents
       FROM product_recipe_items ri JOIN products p ON p.id = ri.input_product_id
       WHERE ri.produced_product_id = ? AND ri.deleted_at IS NULL ORDER BY ri.sort_order, p.name`,
      productId,
    );
  }

  findDetailed(id: number): Row | undefined {
    return this.rawOne(
      `SELECT ri.id, ri.produced_product_id, ri.input_product_id, p.name AS input_name, ri.qty, ri.sort_order
       FROM product_recipe_items ri JOIN products p ON p.id = ri.input_product_id WHERE ri.id = ?`,
      id,
    );
  }

  findRecipeByProduct(productId: number): Row[] {
    return this.raw(
      `SELECT ri.qty AS recipeQty, input.id, input.name, input.cost_cents, input.active, input.track_stock
       FROM product_recipe_items ri
       JOIN products input ON input.id = ri.input_product_id AND input.deleted_at IS NULL
       WHERE ri.produced_product_id = ? AND ri.deleted_at IS NULL
       ORDER BY ri.sort_order`,
      productId,
    );
  }
}

export const recipeItemRepository = new RecipeItemRepository();
