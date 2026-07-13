import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { customerRepository } from './repositories/CustomerRepository';

export interface LedgerCfg {
  table: string;
  amountColumn: string;
  balanceColumn: string;
  grantType: string;
  redeemType: string;
  reverseRedeemType: string;
  reverseGrantType: string;
  label: string;
}

export type LedgerResult = { ok: true; balance: number } | { ok: false; error: string };

function insertMovement(
  cfg: LedgerCfg,
  req: Request,
  customerId: number,
  type: string,
  amount: number,
  balanceAfter: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): void {
  customerRepository.rawRun(
    `INSERT INTO ${cfg.table} (customer_id, type, ${cfg.amountColumn}, balance_after, reason, ref_entity, ref_id, user_id, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    customerId, type, amount, balanceAfter, reason ?? null, refEntity ?? null,
    refId != null ? String(refId) : null, req.user?.id ?? null, randomUUID(),
  );
}

function getCustomerBalance(cfg: LedgerCfg, customerId: number): number {
  const row = customerRepository.rawOne(`SELECT ${cfg.balanceColumn} AS bal FROM customers WHERE id = ?`, customerId) as
    | { bal: number } | undefined;
  return row?.bal ?? 0;
}

export function grantRaw(
  cfg: LedgerCfg,
  req: Request,
  customerId: number,
  amount: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): LedgerResult {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Valor inválido.' };
  const current = getCustomerBalance(cfg, customerId);
  const balance = current + amount;
  customerRepository.updateBalance(customerId, cfg.balanceColumn, balance);
  insertMovement(cfg, req, customerId, cfg.grantType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_conceder`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

export function redeemRaw(
  cfg: LedgerCfg,
  req: Request,
  customerId: number,
  amount: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): LedgerResult {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Valor inválido.' };
  const current = getCustomerBalance(cfg, customerId);
  if (current < amount) return { ok: false, error: `Saldo de ${cfg.label} insuficiente.` };
  const balance = current - amount;
  customerRepository.updateBalance(customerId, cfg.balanceColumn, balance);
  insertMovement(cfg, req, customerId, cfg.redeemType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_resgatar`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

export function reverseRedeemRaw(
  cfg: LedgerCfg,
  req: Request,
  customerId: number,
  amount: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): LedgerResult {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Valor inválido.' };
  const current = getCustomerBalance(cfg, customerId);
  const balance = current + amount;
  customerRepository.updateBalance(customerId, cfg.balanceColumn, balance);
  insertMovement(cfg, req, customerId, cfg.reverseRedeemType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_estornar_resgate`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

export function reverseGrantRaw(
  cfg: LedgerCfg,
  req: Request,
  customerId: number,
  amount: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): LedgerResult {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Valor inválido.' };
  const current = getCustomerBalance(cfg, customerId);
  const balance = current - amount;
  customerRepository.updateBalance(customerId, cfg.balanceColumn, balance);
  insertMovement(cfg, req, customerId, cfg.reverseGrantType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_estornar_ganho`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

export function balance(cfg: LedgerCfg, customerId: number): number {
  return getCustomerBalance(cfg, customerId);
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function recomputeForCustomers(cfg: LedgerCfg, customerIds: number[]): Promise<void> {
  for (const customerId of new Set(customerIds)) {
    await yieldTick();
    const movements = customerRepository.raw(
      `SELECT id, type, ${cfg.amountColumn} AS amount FROM ${cfg.table} WHERE customer_id = ? ORDER BY created_at, uuid`,
      customerId,
    ) as { id: number; type: string; amount: number }[];
    let bal = 0;
    const subtractive = new Set([cfg.redeemType, cfg.reverseGrantType]);
    for (const m of movements) {
      bal = subtractive.has(m.type) ? bal - m.amount : bal + m.amount;
      customerRepository.rawRun(`UPDATE ${cfg.table} SET balance_after = ? WHERE id = ?`, bal, m.id);
    }
    customerRepository.updateBalance(customerId, cfg.balanceColumn, bal);
  }
}

export function listMovements(cfg: LedgerCfg, customerId: number, limit = 100) {
  return customerRepository.raw(
    `SELECT id, type, ${cfg.amountColumn} AS amount, balance_after, reason, ref_entity, ref_id, created_at
     FROM ${cfg.table} WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
    customerId, limit,
  );
}
