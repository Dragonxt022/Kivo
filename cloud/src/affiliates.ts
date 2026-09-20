import { getPool } from './db';

/**
 * Regras do programa de afiliados (representantes comerciais).
 *
 * O afiliado tem DUAS alavancas independentes:
 *  - `discount_pct` — desconto dado à empresa indicada (0029, aplicado na cobrança);
 *  - `commission_pct` — o quanto ELE ganha sobre o que for recebido dessa empresa.
 *
 * Aqui ficam o lançamento automático do crédito (quando uma cobrança é marcada paga),
 * os resumos (disponível/solicitado/pago) e a previsão de lucro (cobranças ainda
 * pendentes das empresas indicadas). As rotas usam estes helpers para não duplicar a
 * regra em vários pontos.
 */

export interface AffiliateSummary {
  /** Créditos já liberados por cobranças pagas e ainda não incluídos em pagamento. */
  availableCents: number;
  /** Créditos presos em um pedido de pagamento aguardando confirmação. */
  requestedCents: number;
  /** Créditos já pagos ao afiliado. */
  paidCents: number;
  /** Quanto ainda pode entrar se as cobranças pendentes forem pagas. */
  forecastCents: number;
  /** Quantas empresas o afiliado indicou. */
  companiesCount: number;
}

interface ChargeForAccrualRow {
  id: number;
  company_uuid: string;
  amount_cents: number;
  status: string;
  affiliate_id: number | null;
  commission_pct: number | null;
  active: number | null;
}

/**
 * Lança o crédito de comissão de uma cobrança PAGA.
 *
 * Idempotente: a UNIQUE em `charge_id` + `INSERT IGNORE` garantem um crédito só, mesmo
 * que a rota "marcar paga" seja chamada de novo. Sem afiliado ativo ou sem percentual,
 * não lança nada. Devolve o valor lançado (centavos) ou null.
 */
export async function accrueCommissionForCharge(chargeId: number): Promise<number | null> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT ch.id, ch.company_uuid, ch.amount_cents, ch.status,
            c.affiliate_id, a.commission_pct, a.active
       FROM charges ch
       JOIN companies c ON c.company_uuid = ch.company_uuid
       LEFT JOIN affiliates a ON a.id = c.affiliate_id
      WHERE ch.id = ?`,
    [chargeId],
  );
  const row = (rows as ChargeForAccrualRow[])[0];
  if (!row || row.status !== 'paga') return null;
  if (!row.affiliate_id || !row.active || Number(row.commission_pct) <= 0) return null;

  const baseCents = Number(row.amount_cents) || 0;
  const pct = Math.max(0, Math.min(100, Number(row.commission_pct) || 0));
  const amountCents = Math.round((baseCents * pct) / 100);
  if (amountCents <= 0) return null;

  await pool.query(
    `INSERT IGNORE INTO affiliate_commissions
       (affiliate_id, company_uuid, charge_id, base_cents, pct, amount_cents, status)
     VALUES (?, ?, ?, ?, ?, ?, 'disponivel')`,
    [row.affiliate_id, row.company_uuid, chargeId, baseCents, pct, amountCents],
  );
  return amountCents;
}

/** Resumo financeiro de um afiliado: créditos por status + previsão + nº de empresas. */
export async function affiliateSummary(affiliateId: number): Promise<AffiliateSummary> {
  const pool = getPool();
  const [commRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'disponivel' THEN amount_cents END), 0) AS available,
       COALESCE(SUM(CASE WHEN status = 'solicitado' THEN amount_cents END), 0) AS requested,
       COALESCE(SUM(CASE WHEN status = 'pago' THEN amount_cents END), 0) AS paid
     FROM affiliate_commissions WHERE affiliate_id = ?`,
    [affiliateId],
  );
  const comm = (commRows as { available: number; requested: number; paid: number }[])[0] ?? {
    available: 0,
    requested: 0,
    paid: 0,
  };

  // Previsão: cobranças PENDENTES das empresas indicadas × percentual de comissão.
  const [fcRows] = await pool.query(
    `SELECT COALESCE(SUM(ROUND(ch.amount_cents * a.commission_pct / 100)), 0) AS forecast
       FROM companies c
       JOIN affiliates a ON a.id = c.affiliate_id
       JOIN charges ch ON ch.company_uuid = c.company_uuid AND ch.status = 'pendente'
      WHERE c.affiliate_id = ?`,
    [affiliateId],
  );
  const forecast = (fcRows as { forecast: number }[])[0]?.forecast ?? 0;

  const [coRows] = await pool.query('SELECT COUNT(*) AS n FROM companies WHERE affiliate_id = ?', [affiliateId]);
  const companiesCount = (coRows as { n: number }[])[0]?.n ?? 0;

  return {
    availableCents: Number(comm.available) || 0,
    requestedCents: Number(comm.requested) || 0,
    paidCents: Number(comm.paid) || 0,
    forecastCents: Number(forecast) || 0,
    companiesCount: Number(companiesCount) || 0,
  };
}

export interface PayoutResult {
  payoutId: number;
  amountCents: number;
  commissionCount: number;
}

/**
 * Cria um pedido de pagamento com TODOS os créditos disponíveis do afiliado.
 *
 * Transação com `FOR UPDATE`: dois cliques simultâneos não podem reservar o mesmo
 * crédito em dois pedidos. `markPaid` cria o pedido já baixado (o admin pagou na hora);
 * caso contrário fica `solicitado` aguardando confirmação. Devolve null quando não há
 * nada a pagar.
 */
export async function createPayoutFromAvailable(opts: {
  affiliateId: number;
  method?: string | null;
  notes?: string | null;
  requestedBy?: string | null;
  markPaid?: boolean;
}): Promise<PayoutResult | null> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, amount_cents FROM affiliate_commissions
        WHERE affiliate_id = ? AND status = 'disponivel' FOR UPDATE`,
      [opts.affiliateId],
    );
    const credits = rows as { id: number; amount_cents: number }[];
    if (!credits.length) {
      await conn.rollback();
      return null;
    }
    const total = credits.reduce((s, c) => s + (Number(c.amount_cents) || 0), 0);
    const paid = opts.markPaid === true;
    const [res] = await conn.query(
      `INSERT INTO affiliate_payouts
         (affiliate_id, amount_cents, method, notes, status, requested_by, paid_at, paid_by)
       VALUES (?, ?, ?, ?, ?, ?, ${paid ? 'NOW(3)' : 'NULL'}, ?)`,
      [
        opts.affiliateId,
        total,
        opts.method ?? null,
        opts.notes ?? null,
        paid ? 'pago' : 'solicitado',
        opts.requestedBy ?? null,
        paid ? opts.requestedBy ?? null : null,
      ],
    );
    const payoutId = (res as { insertId: number }).insertId;
    const placeholders = credits.map(() => '?').join(',');
    await conn.query(
      `UPDATE affiliate_commissions
          SET status = ?, payout_id = ?, paid_at = ${paid ? 'NOW(3)' : 'NULL'}
        WHERE id IN (${placeholders})`,
      [paid ? 'pago' : 'solicitado', payoutId, ...credits.map((c) => c.id)],
    );
    await conn.commit();
    return { payoutId, amountCents: total, commissionCount: credits.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Confirma o pagamento: o pedido vira `pago` e os créditos dele também. */
export async function payPayout(payoutId: number, actor: string | null): Promise<boolean> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.query(
      "UPDATE affiliate_payouts SET status = 'pago', paid_at = NOW(3), paid_by = ? WHERE id = ? AND status = 'solicitado'",
      [actor, payoutId],
    );
    if ((res as { affectedRows: number }).affectedRows === 0) {
      await conn.rollback();
      return false;
    }
    await conn.query(
      "UPDATE affiliate_commissions SET status = 'pago', paid_at = NOW(3) WHERE payout_id = ? AND status = 'solicitado'",
      [payoutId],
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Cancela o pedido e devolve os créditos para "disponível" (voltam a ser pagáveis). */
export async function cancelPayout(payoutId: number): Promise<boolean> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.query(
      "UPDATE affiliate_payouts SET status = 'cancelado' WHERE id = ? AND status = 'solicitado'",
      [payoutId],
    );
    if ((res as { affectedRows: number }).affectedRows === 0) {
      await conn.rollback();
      return false;
    }
    await conn.query(
      "UPDATE affiliate_commissions SET status = 'disponivel', payout_id = NULL WHERE payout_id = ? AND status = 'solicitado'",
      [payoutId],
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
