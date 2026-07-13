import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Request } from 'express';
import { auditRepository } from '../repositories/AuditRepository';

export function audit(
  req: Request,
  action: string,
  entity: string,
  entityId?: string | number,
  before?: unknown,
  after?: unknown,
): void {
  auditRepository.rawRun(
    `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, before_json, after_json, ip, machine, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user?.id ?? null,
    req.user?.username ?? null,
    action,
    entity,
    entityId != null ? String(entityId) : null,
    before != null ? JSON.stringify(before) : null,
    after != null ? JSON.stringify(after) : null,
    req.ip ?? null,
    os.hostname(),
    randomUUID(),
  );
}
