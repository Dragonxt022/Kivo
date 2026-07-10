import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';

/** "YYYY-MM" do mês corrente (ou de uma data arbitrária) — identifica uma fatura de convênio. */
export function periodKeyFor(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** Vencimento da fatura: billing_day dentro do período, com clamp pro último dia do mês (ex.: dia 31 em fevereiro). */
function dueDateForPeriod(periodKey: string, billingDay: number): string {
  const [year, month] = periodKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const day = Math.min(billingDay, lastDay);
  return `${periodKey}-${String(day).padStart(2, '0')}`;
}

/** Insere uma cobrança pendente de convênio para uma venda — sem transação própria. */
export function chargeAgreementRaw(saleId: number, agreementCompanyId: number, amountCents: number): number {
  const info = getSqlite().prepare(
    `INSERT INTO agreement_charges (sale_id, agreement_company_id, amount_cents, uuid) VALUES (?, ?, ?, ?)`,
  ).run(saleId, agreementCompanyId, Math.round(amountCents), randomUUID());
  return Number(info.lastInsertRowid);
}

export function pendingTotal(companyId: number): number {
  const row = getSqlite().prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM agreement_charges
     WHERE agreement_company_id = ? AND invoiced_at IS NULL AND deleted_at IS NULL`,
  ).get(companyId) as { total: number };
  return row.total;
}

export function generateInvoice(
  req: Request,
  companyId: number,
  periodKey?: string,
): { ok: true; receivableId: number; amountCents: number } | { ok: false; error: string } {
  const db = getSqlite();
  const company = db.prepare('SELECT id, name, billing_day FROM agreement_companies WHERE id = ? AND deleted_at IS NULL').get(companyId) as
    { id: number; name: string; billing_day: number } | undefined;
  if (!company) return { ok: false, error: 'Empresa conveniada não encontrada.' };

  const key = periodKey ?? periodKeyFor();
  const already = db.prepare(
    'SELECT id FROM receivables WHERE agreement_company_id = ? AND period_key = ? AND deleted_at IS NULL',
  ).get(companyId, key);
  if (already) return { ok: false, error: `Já existe fatura gerada para o período ${key}.` };

  const amountCents = pendingTotal(companyId);
  if (amountCents <= 0) return { ok: false, error: 'Nenhuma cobrança pendente para este convênio.' };

  let receivableId = 0;
  db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO receivables (description, amount_cents, due_date, agreement_company_id, period_key, uuid)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`Fatura convênio ${company.name} — ${key}`, amountCents, dueDateForPeriod(key, company.billing_day), companyId, key, randomUUID());
    receivableId = Number(info.lastInsertRowid);
    db.prepare(
      `UPDATE agreement_charges SET invoiced_at = datetime('now'), receivable_id = ?, updated_at = datetime('now')
       WHERE agreement_company_id = ? AND invoiced_at IS NULL AND deleted_at IS NULL`,
    ).run(receivableId, companyId);
  })();
  audit(req, 'convenio_fatura_gerar', 'agreement_company', companyId, null, { receivableId, amountCents, period: key });
  return { ok: true, receivableId, amountCents };
}

/** Empresas com fechamento já vencido no período corrente e cobranças pendentes ainda não faturadas — usado pelo scheduler de boot. */
export function companiesDueForInvoice(today: Date = new Date()): { id: number; name: string; billingDay: number }[] {
  const db = getSqlite();
  const key = periodKeyFor(today);
  const companies = db.prepare(
    'SELECT id, name, billing_day AS billingDay FROM agreement_companies WHERE active = 1 AND deleted_at IS NULL',
  ).all() as { id: number; name: string; billingDay: number }[];
  return companies.filter((c) => {
    if (today.getDate() < c.billingDay) return false;
    const already = db.prepare(
      'SELECT id FROM receivables WHERE agreement_company_id = ? AND period_key = ? AND deleted_at IS NULL',
    ).get(c.id, key);
    if (already) return false;
    return pendingTotal(c.id) > 0;
  });
}
