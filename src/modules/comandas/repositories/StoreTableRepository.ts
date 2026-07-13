import { BaseRepository, type Row } from '../../../core/database/repository';

export class StoreTableRepository extends BaseRepository {
  constructor() {
    super('store_tables');
  }

  findOpen(id: number): Row | undefined {
    return this.rawOne(
      "SELECT id, status FROM store_tables WHERE id = ? AND status = 'livre' AND deleted_at IS NULL",
      id,
    );
  }

  occupy(id: number): void {
    this.rawRun("UPDATE store_tables SET status = 'ocupada', updated_at = datetime('now') WHERE id = ?", id);
  }

  free(id: number): void {
    this.rawRun("UPDATE store_tables SET status = 'livre', updated_at = datetime('now') WHERE id = ?", id);
  }

  findByComandaTableId(id: number): Row | undefined {
    return this.rawOne("SELECT label FROM store_tables WHERE id = ?", id);
  }
}

export const storeTableRepository = new StoreTableRepository();
