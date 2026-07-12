import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { isModuleEntitled } from '../license/service';

export interface CapabilityRow {
  key: string;
  description: string;
  module: string;
  enabled: number;
}

/**
 * Retorna `true` SOMENTE se a capability existe, está marcada como `enabled=1`
 * E o módulo dono está incluso no plano contratado. Isso garante que um downgrade
 * de plano desliga a capability automaticamente mesmo que o flag local ainda seja 1.
 */
export function hasCapability(key: string): boolean {
  const row = getSqlite()
    .prepare('SELECT key, enabled, module FROM capabilities WHERE key = ? AND deleted_at IS NULL')
    .get(key) as { key: string; enabled: number; module: string } | undefined;
  if (!row) return false;
  if (row.enabled !== 1) return false;
  return isModuleEntitled(row.module);
}

/** Lista todas as capabilities, agrupadas por módulo (para a UI). */
export function listCapabilities(): CapabilityRow[] {
  return getSqlite()
    .prepare('SELECT key, description, module, enabled FROM capabilities WHERE deleted_at IS NULL ORDER BY module, key')
    .all() as CapabilityRow[];
}

/** Liga/desliga uma capability, registra em audit log. */
export function setCapabilityEnabled(req: Request, key: string, enabled: boolean): void {
  const db = getSqlite();
  const before = db.prepare('SELECT key, enabled FROM capabilities WHERE key = ?').get(key) as
    | { key: string; enabled: number }
    | undefined;
  if (!before) throw new Error(`Capability não encontrada: ${key}`);
  db.prepare(
    `UPDATE capabilities SET enabled = ?, updated_at = datetime('now'), uuid = ? WHERE key = ?`,
  ).run(enabled ? 1 : 0, randomUUID(), key);
  const after = db.prepare('SELECT key, enabled FROM capabilities WHERE key = ?').get(key);
  audit(req, 'editar', 'capability', key, before, after);
}
