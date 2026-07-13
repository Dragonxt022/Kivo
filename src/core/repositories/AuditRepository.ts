import { BaseRepository, type Row } from '../database/repository';

export class AuditRepository extends BaseRepository {
  constructor() {
    super('audit_log');
  }
}

export const auditRepository = new AuditRepository();
