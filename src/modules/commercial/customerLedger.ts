import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';

/**
 * Motor genérico de livro-razão de saldo por cliente — usado por crédito de troca
 * (centavos) e pontos de fidelidade (pontos). Mesmo princípio de stock_movements/
 * stock_qty: o saldo na tabela `customers` é sempre derivado do replay das linhas
 * deste livro-razão (nunca editado direto), e é reconstruído (`recomputeForCustomers`)
 * depois de todo merge de sync, pra convergir de forma determinística entre máquinas.
 */
export interface LedgerCfg {
  /** Tabela do livro-razão (ex.: customer_credit_movements). */
  table: string;
  /** Coluna de valor na tabela do livro-razão (amount_cents ou points). */
  amountColumn: string;
  /** Coluna derivada em `customers` que guarda o saldo atual. */
  balanceColumn: string;
  /** Valor de `type` usado ao conceder/ganhar saldo. */
  grantType: string;
  /** Valor de `type` usado ao resgatar/gastar saldo. */
  redeemType: string;
  /** Valor de `type` usado ao estornar um RESGATE (devolve saldo — mesma direção de grantType). */
  reverseRedeemType: string;
  /** Valor de `type` usado ao estornar uma CONCESSÃO/GANHO (remove saldo — mesma direção de redeemType, mas sem checar suficiência: pode ficar negativo). */
  reverseGrantType: string;
  /** Rótulo em português usado nas mensagens de erro (ex.: "crédito de troca"). */
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
  getSqlite().prepare(
    `INSERT INTO ${cfg.table} (customer_id, type, ${cfg.amountColumn}, balance_after, reason, ref_entity, ref_id, user_id, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(customerId, type, amount, balanceAfter, reason ?? null, refEntity ?? null, refId != null ? String(refId) : null, req.user?.id ?? null, randomUUID());
}

function getCustomerBalance(cfg: LedgerCfg, customerId: number): number {
  const row = getSqlite().prepare(`SELECT ${cfg.balanceColumn} AS bal FROM customers WHERE id = ?`).get(customerId) as
    { bal: number } | undefined;
  return row?.bal ?? 0;
}

/** Concede/credita saldo (sem transação própria — use dentro de uma transação existente). */
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
  const db = getSqlite();
  const current = getCustomerBalance(cfg, customerId);
  const balance = current + amount;
  db.prepare(`UPDATE customers SET ${cfg.balanceColumn} = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, customerId);
  insertMovement(cfg, req, customerId, cfg.grantType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_conceder`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

/** Resgata/debita saldo — valida que há saldo suficiente. Sem transação própria. */
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
  const db = getSqlite();
  const current = getCustomerBalance(cfg, customerId);
  if (current < amount) return { ok: false, error: `Saldo de ${cfg.label} insuficiente.` };
  const balance = current - amount;
  db.prepare(`UPDATE customers SET ${cfg.balanceColumn} = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, customerId);
  insertMovement(cfg, req, customerId, cfg.redeemType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_resgatar`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

/** Estorna um RESGATE anterior (ex.: venda paga com saldo foi cancelada — devolve o saldo gasto). Sempre soma, nunca falha. */
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
  const db = getSqlite();
  const current = getCustomerBalance(cfg, customerId);
  const balance = current + amount;
  db.prepare(`UPDATE customers SET ${cfg.balanceColumn} = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, customerId);
  insertMovement(cfg, req, customerId, cfg.reverseRedeemType, amount, balance, reason, refEntity, refId);
  audit(req, `${cfg.table}_estornar_resgate`, 'customer', customerId, { saldo: current }, { saldo: balance, amount, reason });
  return { ok: true, balance };
}

/**
 * Estorna uma CONCESSÃO/GANHO anterior (ex.: venda que gerou pontos foi cancelada —
 * remove os pontos ganhos). Sempre subtrai e SEMPRE sucede, mesmo que o saldo fique
 * negativo (o cliente pode já ter gastado esses pontos em outra compra — risco aceito,
 * ver relatório de reconciliação) — por isso não tem checagem de suficiência como redeemRaw.
 */
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
  const db = getSqlite();
  const current = getCustomerBalance(cfg, customerId);
  const balance = current - amount;
  db.prepare(`UPDATE customers SET ${cfg.balanceColumn} = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, customerId);
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

/**
 * Recomputa o saldo derivado de um conjunto de clientes a partir do replay cronológico
 * do livro-razão. Chamado pelo motor de sync após mesclar linhas de outra máquina —
 * garante que duas máquinas cheguem ao mesmo saldo final, mesmo com lançamentos
 * concorrentes offline (o saldo pode ficar negativo se o mesmo saldo foi gasto duas
 * vezes em máquinas diferentes antes de sincronizar — ver relatório de reconciliação).
 */
export async function recomputeForCustomers(cfg: LedgerCfg, customerIds: number[]): Promise<void> {
  const db = getSqlite();
  const updateMovement = db.prepare(`UPDATE ${cfg.table} SET balance_after = ? WHERE id = ?`);
  const updateCustomer = db.prepare(`UPDATE customers SET ${cfg.balanceColumn} = ? WHERE id = ?`);
  for (const customerId of new Set(customerIds)) {
    await yieldTick();
    const movements = db.prepare(
      `SELECT id, type, ${cfg.amountColumn} AS amount FROM ${cfg.table} WHERE customer_id = ? ORDER BY created_at, uuid`,
    ).all(customerId) as { id: number; type: string; amount: number }[];
    let bal = 0;
    const subtractive = new Set([cfg.redeemType, cfg.reverseGrantType]);
    for (const m of movements) {
      bal = subtractive.has(m.type) ? bal - m.amount : bal + m.amount;
      updateMovement.run(bal, m.id);
    }
    updateCustomer.run(bal, customerId);
  }
}

export function listMovements(cfg: LedgerCfg, customerId: number, limit = 100) {
  return getSqlite().prepare(
    `SELECT id, type, ${cfg.amountColumn} AS amount, balance_after, reason, ref_entity, ref_id, created_at
     FROM ${cfg.table} WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
  ).all(customerId, limit);
}
