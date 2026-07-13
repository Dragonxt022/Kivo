import { BaseRepository } from '../../../core/database/repository';

export class SupplierRepository extends BaseRepository {
  constructor() {
    super('suppliers');
  }
}

export const supplierRepository = new SupplierRepository();
