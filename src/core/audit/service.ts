import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { settingsRepository } from '../repositories/SettingsRepository';
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

/** Chave de `settings` com a retenção da trilha. 0 (ou negativo) = nunca apaga. */
export const AUDIT_RETENTION_KEY = 'auditoria.retencao_dias';
const DEFAULT_RETENTION_DAYS = 365;

/**
 * Apaga registros de auditoria além da retenção configurada.
 *
 * A tabela `audit_logs` guarda antes/depois em JSON e cresce para sempre num banco de
 * cliente que roda por anos — foi por isso que o log chegou a dezenas de GB. O padrão é
 * 365 dias; o lojista pode aumentar, diminuir ou zerar (nunca apaga) em Configurações.
 * Devolve quantos registros saíram.
 */
export function pruneAuditLogs(): number {
  const raw = settingsRepository.get(AUDIT_RETENTION_KEY);
  const dias = raw == null || raw === '' ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(dias) || dias <= 0) return 0;
  const info = getSqlite()
    .prepare(`DELETE FROM audit_logs WHERE created_at < datetime('now', ?)`)
    .run(`-${Math.floor(dias)} days`);
  return info.changes;
}
