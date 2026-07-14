import { BaseRepository, type Row } from '../../../core/database/repository';

export class CategoryRepository extends BaseRepository {
  constructor() {
    super('categories');
  }

  listAll(): Row[] {
    return this.raw('SELECT id, name, parent_id, image_url FROM categories WHERE deleted_at IS NULL ORDER BY name');
  }

  migrateProducts(fromId: number, toId: number | null): void {
    if (toId != null) {
      this.rawRun('UPDATE products SET category_id = ? WHERE category_id = ?', toId, fromId);
    } else {
      this.rawRun('UPDATE products SET category_id = NULL WHERE category_id = ?', fromId);
    }
  }
}

export const categoryRepository = new CategoryRepository();
