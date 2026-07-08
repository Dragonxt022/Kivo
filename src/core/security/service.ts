import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';

/**
 * PIN de administrador: uma linha só (id=1), configuração local da máquina (não
 * sincroniza — mesmo padrão de `users`/`settings` hoje). Usado para confirmar ações
 * críticas no dia a dia (ex.: remover item já lançado no carrinho do PDV) quando a
 * proteção estiver ativada — desativada por padrão (ver setting `seguranca.pin_remover_item`).
 */

export function pinConfigured(): boolean {
  const row = getSqlite().prepare('SELECT id FROM security_pin WHERE id = 1').get();
  return !!row;
}

export function setPin(req: Request, pin: string): void {
  const hash = bcrypt.hashSync(pin, 10);
  getSqlite().prepare(
    `INSERT INTO security_pin (id, pin_hash, updated_by, updated_at) VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET pin_hash = excluded.pin_hash, updated_by = excluded.updated_by, updated_at = datetime('now')`,
  ).run(hash, req.user?.id ?? null);
  audit(req, 'pin_definido', 'security_pin', 1, null, null);
}

export function verifyPin(req: Request, pin: string): boolean {
  const row = getSqlite().prepare('SELECT pin_hash FROM security_pin WHERE id = 1').get() as { pin_hash: string } | undefined;
  const ok = !!row && bcrypt.compareSync(pin, row.pin_hash);
  audit(req, ok ? 'pin_confirmado' : 'pin_invalido', 'security_pin', 1, null, null);
  return ok;
}
