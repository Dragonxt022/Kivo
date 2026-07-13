import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';

/**
 * Caixa (Fase 4): sessão única aberta por vez.
 * Esperado no fechamento = abertura + entradas - saídas (livro-razão cash_movements).
 * DoD: abertura/fechamento confere; diferença = contado - esperado.
 */

export interface CashRegister {
  id: number;
  status: string;
  opening_cents: number;
  opened_at: string;
  opened_by: number;
}

export function currentRegister(): CashRegister | undefined {
  return getSqlite()
    .prepare("SELECT * FROM cash_registers WHERE status = 'aberto' AND deleted_at IS NULL LIMIT 1")
    .get() as CashRegister | undefined;
}

export interface CashRegisterDetail {
  id: number;
  status: string;
  opening_cents: number;
  opened_at: string;
  opened_by_name: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  expected_cents: number | null;
  counted_cents: number | null;
  difference_cents: number | null;
  notes: string | null;
  count_breakdown: Record<string, number> | null;
}

/** Dados do caixa para o relatório de fechamento (inclui nomes de quem abriu/fechou). */
export function getRegisterById(registerId: number): CashRegisterDetail | undefined {
  const row = getSqlite().prepare(
    `SELECT r.id, r.status, r.opening_cents, r.opened_at, ou.username AS opened_by_name,
            r.closed_at, cu.username AS closed_by_name, r.expected_cents, r.counted_cents,
            r.difference_cents, r.notes, r.count_breakdown
     FROM cash_registers r
     LEFT JOIN users ou ON ou.id = r.opened_by
     LEFT JOIN users cu ON cu.id = r.closed_by
     WHERE r.id = ? AND r.deleted_at IS NULL`,
  ).get(registerId) as (Omit<CashRegisterDetail, 'count_breakdown'> & { count_breakdown: string | null }) | undefined;
  if (!row) return undefined;
  let countBreakdown: Record<string, number> | null = null;
  if (row.count_breakdown) {
    try {
      countBreakdown = JSON.parse(row.count_breakdown);
    } catch {
      countBreakdown = null;
    }
  }
  return { ...row, count_breakdown: countBreakdown };
}

export function registerTotals(registerId: number): { entradas: number; saidas: number } {
  const row = getSqlite()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
         COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
       FROM cash_movements WHERE register_id = ?`,
    )
    .get(registerId) as { entradas: number; saidas: number };
  return row;
}

/** Esperado na gaveta = todas as entradas (inclui abertura) - saídas. */
export function expectedCents(registerId: number): number {
  const { entradas, saidas } = registerTotals(registerId);
  return entradas - saidas;
}

export function addMovement(
  req: Request,
  registerId: number,
  direction: 'entrada' | 'saida',
  type: 'abertura' | 'suprimento' | 'sangria' | 'venda' | 'recebimento' | 'pagamento',
  amountCents: number,
  description?: string,
  refEntity?: string,
  refId?: string | number,
): void {
  getSqlite()
    .prepare(
      `INSERT INTO cash_movements (register_id, direction, type, amount_cents, description, ref_entity, ref_id, user_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(registerId, direction, type, Math.round(amountCents), description ?? null,
      refEntity ?? null, refId != null ? String(refId) : null, req.user?.id ?? null, randomUUID());
}

export function openRegister(req: Request, openingCents: number): { ok: true; id: number } | { ok: false; error: string } {
  assertAuth(req);
  if (currentRegister()) return { ok: false, error: 'Já existe um caixa aberto. Feche-o antes de abrir outro.' };
  if (!Number.isInteger(openingCents) || openingCents < 0) return { ok: false, error: 'Valor de abertura inválido.' };
  const db = getSqlite();
  let id = 0;
  db.transaction(() => {
    const info = db
      .prepare('INSERT INTO cash_registers (opened_by, opening_cents, uuid) VALUES (?, ?, ?)')
      .run(req.user.id, openingCents, randomUUID());
    id = Number(info.lastInsertRowid);
    if (openingCents > 0) addMovement(req, id, 'entrada', 'abertura', openingCents, 'Fundo de troco');
  })();
  audit(req, 'caixa_abrir', 'cash_register', id, null, { openingCents });
  return { ok: true, id };
}

export function closeRegister(
  req: Request,
  countedCents: number,
  notes?: string,
  countBreakdown?: Record<string, number>,
): { ok: true; id: number; expected: number; counted: number; difference: number } | { ok: false; error: string } {
  assertAuth(req);
  const reg = currentRegister();
  if (!reg) return { ok: false, error: 'Nenhum caixa aberto.' };
  if (!Number.isInteger(countedCents) || countedCents < 0) return { ok: false, error: 'Valor contado inválido.' };

  const expected = expectedCents(reg.id);
  const difference = countedCents - expected;
  const breakdownJson = countBreakdown && Object.keys(countBreakdown).length ? JSON.stringify(countBreakdown) : null;
  getSqlite()
    .prepare(
      `UPDATE cash_registers SET status = 'fechado', closed_by = ?, closed_at = datetime('now'),
         expected_cents = ?, counted_cents = ?, difference_cents = ?, notes = COALESCE(?, notes),
         count_breakdown = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(req.user.id, expected, countedCents, difference, notes ?? null, breakdownJson, reg.id);
  audit(req, 'caixa_fechar', 'cash_register', reg.id, { expected }, { counted: countedCents, difference });
  return { ok: true, id: reg.id, expected, counted: countedCents, difference };
}

export function editClosedRegister(req: Request, registerId: number, updates: { countedCents?: number; notes?: string }):
  { ok: true; id: number; expected: number; counted: number; difference: number } | { ok: false; error: string } {
  assertAuth(req);
  const db = getSqlite();
  const before = db.prepare('SELECT id, status, expected_cents, counted_cents, difference_cents FROM cash_registers WHERE id = ? AND deleted_at IS NULL')
    .get(registerId) as { id: number; status: string; expected_cents: number; counted_cents: number; difference_cents: number } | undefined;
  if (!before) return { ok: false, error: 'Registro de caixa não encontrado.' };
  if (before.status !== 'fechado') return { ok: false, error: 'Apenas caixas fechados podem ser editados.' };

  const counted = updates.countedCents != null ? Math.round(updates.countedCents) : before.counted_cents;
  const difference = counted - before.expected_cents;

  db.prepare(
    `UPDATE cash_registers SET counted_cents = ?, difference_cents = ?, notes = COALESCE(?, notes),
       edited_at = datetime('now'), edited_by = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(counted, difference, updates.notes ?? null, req.user.id, registerId);

  audit(req, 'caixa_editar', 'cash_register', registerId,
    { counted: before.counted_cents, difference: before.difference_cents },
    { counted, difference });
  return { ok: true, id: registerId, expected: before.expected_cents, counted, difference };
}
