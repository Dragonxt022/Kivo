import { randomUUID } from 'node:crypto';
import { getPool } from './db';
import { accrueCommissionForCharge } from './affiliates';
import type { PaymentSnapshot } from './gateway';

/**
 * Cobranças do Kivo Cloud — o que a empresa paga pela assinatura.
 *
 * Este módulo é o ponto único de BAIXA: marcar uma cobrança como paga (na mão, pelo painel,
 * ou pelo webhook do Mercado Pago) passa por `settleCharge`, que também lança a comissão do
 * afiliado e, quando a cobrança define `extends_days`, empurra a validade da licença.
 * Ter um caminho só evita a cobrança paga "pela metade" (baixada sem comissão, ou com
 * comissão sem validade estendida).
 */

export interface ChargeRow {
  id: number;
  company_uuid: string;
  description: string;
  instructions: string | null;
  amount_cents: number;
  original_amount_cents: number | null;
  discount_cents: number | null;
  due_date: string;
  status: 'pendente' | 'paga' | 'cancelada';
  paid_at: string | null;
  created_at: string;
  public_token: string | null;
  payer_email: string | null;
  extends_days: number | null;
  mp_payment_id: string | null;
  mp_method: string | null;
  mp_status: string | null;
  mp_status_detail: string | null;
  mp_qr_code: string | null;
  mp_qr_code_base64: string | null;
  mp_ticket_url: string | null;
  mp_init_point: string | null;
  mp_updated_at: string | null;
}

const CHARGE_COLS = `id, company_uuid, description, instructions, amount_cents, original_amount_cents,
  discount_cents, due_date, status, paid_at, created_at, public_token, payer_email, extends_days,
  mp_payment_id, mp_method, mp_status, mp_status_detail, mp_qr_code, mp_qr_code_base64,
  mp_ticket_url, mp_init_point, mp_updated_at`;

export async function getCharge(id: number, companyUuid?: string): Promise<ChargeRow | null> {
  const where = companyUuid ? 'WHERE id = ? AND company_uuid = ?' : 'WHERE id = ?';
  const params = companyUuid ? [id, companyUuid] : [id];
  const [rows] = await getPool().query(`SELECT ${CHARGE_COLS} FROM charges ${where}`, params);
  return ((rows as ChargeRow[])[0] ?? null) as ChargeRow | null;
}

/** Página pública: o token é o único jeito de chegar na cobrança sem sessão de admin. */
export async function getChargeByToken(token: string): Promise<ChargeRow | null> {
  if (!token) return null;
  const [rows] = await getPool().query(`SELECT ${CHARGE_COLS} FROM charges WHERE public_token = ?`, [token]);
  return ((rows as ChargeRow[])[0] ?? null) as ChargeRow | null;
}

/** Webhook: reencontra a cobrança pelo pagamento do Mercado Pago. */
export async function getChargeByPaymentId(paymentId: string): Promise<ChargeRow | null> {
  if (!paymentId) return null;
  const [rows] = await getPool().query(`SELECT ${CHARGE_COLS} FROM charges WHERE mp_payment_id = ?`, [paymentId]);
  return ((rows as ChargeRow[])[0] ?? null) as ChargeRow | null;
}

/** Gera (uma vez) o token da página pública e devolve sempre o mesmo. */
export async function ensurePublicToken(id: number): Promise<string> {
  const charge = await getCharge(id);
  if (!charge) throw new Error(`Cobrança ${id} não encontrada.`);
  if (charge.public_token) return charge.public_token;
  const token = randomUUID();
  await getPool().query('UPDATE charges SET public_token = ? WHERE id = ? AND public_token IS NULL', [token, id]);
  const depois = await getCharge(id);
  return depois?.public_token ?? token;
}

export interface GatewayResultInput {
  method: 'pix' | 'boleto' | 'card';
  paymentId?: string | null;
  status: string;
  statusDetail?: string | null;
  qrCode?: string | null;
  qrCodeBase64?: string | null;
  ticketUrl?: string | null;
  initPoint?: string | null;
}

/** Grava o que o gateway devolveu (criação do pagamento ou notificação posterior). */
export async function saveGatewayResult(id: number, r: GatewayResultInput): Promise<void> {
  await getPool().query(
    `UPDATE charges
        SET mp_method = ?, mp_payment_id = COALESCE(?, mp_payment_id), mp_status = ?,
            mp_status_detail = ?, mp_qr_code = COALESCE(?, mp_qr_code),
            mp_qr_code_base64 = COALESCE(?, mp_qr_code_base64),
            mp_ticket_url = COALESCE(?, mp_ticket_url), mp_init_point = COALESCE(?, mp_init_point),
            mp_updated_at = NOW(3)
      WHERE id = ?`,
    [
      r.method, r.paymentId ?? null, r.status, r.statusDetail ?? null,
      r.qrCode ?? null, r.qrCodeBase64 ?? null, r.ticketUrl ?? null, r.initPoint ?? null, id,
    ],
  );
}

/** Conveniência para o webhook: snapshot do pagamento → linha da cobrança. */
export async function savePaymentSnapshot(id: number, snapshot: PaymentSnapshot, method?: string | null): Promise<void> {
  await getPool().query(
    `UPDATE charges
        SET mp_status = ?, mp_status_detail = ?, mp_method = COALESCE(?, mp_method), mp_updated_at = NOW(3)
      WHERE id = ?`,
    [snapshot.status, snapshot.statusDetail, method ?? null, id],
  );
}

export interface SettleResult {
  /** false quando a cobrança já estava paga/cancelada — chamar de novo não tem efeito. */
  settled: boolean;
  extendedDays: number;
  validUntil: string | null;
  companyUuid: string;
}

/**
 * Baixa a cobrança: marca como paga (só se estava pendente), lança a comissão do afiliado e
 * estende a validade da licença quando a cobrança pede (`extends_days`). Idempotente — o
 * webhook pode repetir a notificação à vontade.
 */
export async function settleCharge(id: number): Promise<SettleResult> {
  const charge = await getCharge(id);
  if (!charge) return { settled: false, extendedDays: 0, validUntil: null, companyUuid: '' };

  const [res] = await getPool().query(
    `UPDATE charges SET status = 'paga', paid_at = IFNULL(paid_at, NOW(3)), mp_updated_at = NOW(3)
      WHERE id = ? AND status = 'pendente'`,
    [id],
  );
  if ((res as { affectedRows: number }).affectedRows === 0) {
    return { settled: false, extendedDays: 0, validUntil: null, companyUuid: charge.company_uuid };
  }

  // Mesma sequência da baixa manual do painel: recebeu → crédito de comissão do afiliado.
  await accrueCommissionForCharge(id);

  const days = Number(charge.extends_days ?? 0);
  const validUntil = days > 0 ? await extendLicense(charge.company_uuid, days) : null;
  return { settled: true, extendedDays: days, validUntil, companyUuid: charge.company_uuid };
}

/**
 * Soma dias na validade da licença. A conta parte de hoje quando a licença já venceu — assim
 * cliente atrasado não "perde" os dias pagos por causa do atraso.
 */
export async function extendLicense(companyUuid: string, days: number): Promise<string | null> {
  await getPool().query(
    `UPDATE companies
        SET valid_until = DATE_ADD(GREATEST(COALESCE(valid_until, NOW(3)), NOW(3)), INTERVAL ? DAY)
      WHERE company_uuid = ?`,
    [Math.max(1, Math.round(days)), companyUuid],
  );
  const [rows] = await getPool().query('SELECT valid_until FROM companies WHERE company_uuid = ?', [companyUuid]);
  const row = (rows as { valid_until: string | null }[])[0];
  return row?.valid_until ?? null;
}

/** Dados da empresa que o gateway precisa: nome no boleto e e-mail como pagador padrão. */
export async function companyPayerData(companyUuid: string): Promise<{ name: string; email: string; document: string | null }> {
  const [rows] = await getPool().query(
    'SELECT name, email, document FROM companies WHERE company_uuid = ?', [companyUuid],
  );
  const c = (rows as { name: string | null; email: string | null; document: string | null }[])[0];
  return { name: c?.name ?? '', email: c?.email ?? '', document: c?.document ?? null };
}
