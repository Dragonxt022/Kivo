import { randomUUID } from 'node:crypto';
import { getPool } from './db';
import { settleCharge } from './charges';
import {
  createSubscription as createMpSubscription,
  getAuthorizedPayment,
  getSubscription as getMpSubscription,
  loadSettings,
  updateSubscriptionStatus,
  type GatewaySettings,
} from './gateway';

/**
 * Assinaturas recorrentes do Kivo (produto Assinaturas do Mercado Pago).
 *
 * O fluxo tem três estados de interesse:
 *  - `pendente`: assinatura criada no Mercado Pago, link gerado, cliente ainda não autorizou.
 *  - `autorizada`: cliente autorizou o cartão; o Mercado Pago passa a cobrar sozinho.
 *  - `cancelada`/`encerrada`/`pausada`: estado vindo do Mercado Pago.
 *
 * A licença NUNCA é estendida na autorização — só quando uma parcela realmente é aprovada
 * (`subscription_authorized_payment`). É isso que impede liberar um mês de graça quando o
 * cliente autoriza um cartão que depois recusa a cobrança.
 */
export type SubscriptionStatus = 'pendente' | 'autorizada' | 'pausada' | 'cancelada' | 'encerrada' | 'erro';

export interface SubscriptionRow {
  id: number;
  company_uuid: string;
  plan_key: string | null;
  reason: string;
  amount_cents: number;
  extends_days: number;
  frequency: number;
  frequency_type: 'days' | 'months';
  payer_email: string | null;
  public_token: string;
  preapproval_id: string | null;
  status: SubscriptionStatus;
  init_point: string | null;
  next_payment_date: string | null;
  last_payment_at: string | null;
  last_payment_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = `id, company_uuid, plan_key, reason, amount_cents, extends_days, frequency, frequency_type,
  payer_email, public_token, preapproval_id, status, init_point, next_payment_date, last_payment_at,
  last_payment_id, last_error, created_at, updated_at`;

export async function getSubscriptionById(id: number): Promise<SubscriptionRow | null> {
  const [rows] = await getPool().query(`SELECT ${COLS} FROM company_subscriptions WHERE id = ?`, [id]);
  return ((rows as SubscriptionRow[])[0] ?? null) as SubscriptionRow | null;
}

export async function getSubscriptionByToken(token: string): Promise<SubscriptionRow | null> {
  if (!token) return null;
  const [rows] = await getPool().query(`SELECT ${COLS} FROM company_subscriptions WHERE public_token = ?`, [token]);
  return ((rows as SubscriptionRow[])[0] ?? null) as SubscriptionRow | null;
}

export async function getSubscriptionByPreapprovalId(preapprovalId: string): Promise<SubscriptionRow | null> {
  if (!preapprovalId) return null;
  const [rows] = await getPool().query(`SELECT ${COLS} FROM company_subscriptions WHERE preapproval_id = ?`, [preapprovalId]);
  return ((rows as SubscriptionRow[])[0] ?? null) as SubscriptionRow | null;
}

/** URL pública que o admin manda ao cliente (a mesma que o Mercado Pago usa como back_url). */
export function publicSubscriptionUrl(token: string): string {
  const base = (process.env.CLOUD_PUBLIC_URL ?? 'https://kivo.buscamais.org').replace(/\/+$/, '');
  return `${base}/assinar/${token}`;
}

/** Status do Mercado Pago → enum local. Sinônimos de "cancelado" e "encerrado" variam por país. */
export function mapSubscriptionStatus(mpStatus: string): SubscriptionStatus {
  switch (String(mpStatus || '').toLowerCase()) {
    case 'authorized':
      return 'autorizada';
    case 'paused':
      return 'pausada';
    case 'canceled':
    case 'cancelled':
      return 'cancelada';
    case 'finished':
    case 'ended':
      return 'encerrada';
    case 'pending':
      return 'pendente';
    default:
      return 'erro';
  }
}

export interface CreateSubscriptionInput {
  companyUuid: string;
  planKey: string | null;
  reason: string;
  amountCents: number;
  extendsDays: number;
  frequency: number;
  frequencyType: 'days' | 'months';
  payerEmail: string | null;
}

/**
 * Cria a linha local primeiro (precisamos do id para o external_reference) e logo em seguida
 * a assinatura no Mercado Pago. Se o gateway falhar, a linha fica em `erro` com a mensagem —
 * o admin vê o motivo e pode gerar de novo, em vez de perder o cadastro.
 */
export async function createCompanySubscription(input: CreateSubscriptionInput): Promise<SubscriptionRow> {
  const pool = getPool();
  const token = randomUUID();
  const [res] = await pool.query(
    `INSERT INTO company_subscriptions
       (company_uuid, plan_key, reason, amount_cents, extends_days, frequency, frequency_type, payer_email, public_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.companyUuid,
      input.planKey,
      input.reason.slice(0, 160),
      Math.max(1, Math.round(input.amountCents)),
      Math.max(1, Math.round(input.extendsDays)),
      Math.max(1, Math.round(input.frequency)),
      input.frequencyType,
      input.payerEmail?.trim() || null,
      token,
    ],
  );
  const id = (res as { insertId: number }).insertId;

  const settings = await loadSettings();
  if (!settings.accessToken) {
    await pool.query("UPDATE company_subscriptions SET status = 'erro', last_error = ? WHERE id = ?", [
      'Configure o Access Token do Mercado Pago em Pagamento online.',
      id,
    ]);
    throw new Error('Configure o Access Token do Mercado Pago em Pagamento online antes de criar a assinatura.');
  }

  try {
    const mp = await createMpSubscription(
      {
        subscriptionId: id,
        reason: input.reason,
        amountCents: input.amountCents,
        payerEmail: input.payerEmail || settings.payerEmail,
        frequency: input.frequency,
        frequencyType: input.frequencyType,
        backUrl: publicSubscriptionUrl(token),
      },
      settings,
    );
    await pool.query(
      `UPDATE company_subscriptions
          SET preapproval_id = ?, status = ?, init_point = ?, next_payment_date = ?, last_error = NULL
        WHERE id = ?`,
      [mp.preapprovalId, mapSubscriptionStatus(mp.status), mp.initPoint, mp.nextPaymentDate, id],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await pool.query("UPDATE company_subscriptions SET status = 'erro', last_error = ? WHERE id = ?", [msg.slice(0, 500), id]);
    throw e;
  }

  return (await getSubscriptionById(id))!;
}

/** Relê a assinatura no Mercado Pago e atualiza o estado local. */
export async function syncSubscription(id: number): Promise<SubscriptionRow | null> {
  const sub = await getSubscriptionById(id);
  if (!sub) return null;
  if (!sub.preapproval_id) return sub;

  const settings = await loadSettings();
  if (!settings.accessToken) throw new Error('Gateway do Mercado Pago não configurado.');

  try {
    const mp = await getMpSubscription(sub.preapproval_id, settings);
    await getPool().query(
      `UPDATE company_subscriptions
          SET status = ?, init_point = COALESCE(?, init_point), next_payment_date = COALESCE(?, next_payment_date),
              last_error = NULL
        WHERE id = ?`,
      [mapSubscriptionStatus(mp.status), mp.initPoint, mp.nextPaymentDate, id],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await getPool().query('UPDATE company_subscriptions SET last_error = ? WHERE id = ?', [msg.slice(0, 500), id]);
    throw e;
  }
  return getSubscriptionById(id);
}

export interface AuthorizedPaymentResult {
  processed: boolean;
  reason: string;
  chargeId?: number;
  extendedDays?: number;
  validUntil?: string | null;
}

function dateOnly(value: string | null | undefined): string {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(value ?? ''));
  return m ? m[0] : new Date().toISOString().slice(0, 10);
}

/**
 * Processa a cobrança recorrente. O `subscription_authorized_payment` é a única fonte que
 * libera licença: cria uma cobrança já vinculada e chama `settleCharge`, que estende
 * `valid_until` e lança a comissão do afiliado no mesmo caminho da baixa manual.
 *
 * A UNIQUE em `charges.subscription_payment_id` garante idempotência mesmo com webhook
 * repetido ou duas instâncias do cloud processando a mesma notificação.
 */
export async function recordAuthorizedPayment(authorizedPaymentId: string): Promise<AuthorizedPaymentResult> {
  const pool = getPool();
  const [existing] = await pool.query(
    'SELECT id, status FROM charges WHERE subscription_payment_id = ? LIMIT 1',
    [authorizedPaymentId],
  );
  const jaExiste = (existing as { id: number; status: string }[])[0];
  if (jaExiste) {
    // Se a execução anterior criou a cobrança mas caiu antes da baixa, o reenvio do webhook
    // ainda consegue fechar a conta (idempotente: settleCharge só mexe em pendente).
    if (jaExiste.status === 'pendente') {
      const baixa = await settleCharge(jaExiste.id);
      return {
        processed: baixa.settled,
        reason: baixa.settled ? 'Cobrança pendente baixada no reenvio.' : 'Cobrança já estava baixada.',
        chargeId: jaExiste.id,
        extendedDays: baixa.extendedDays,
        validUntil: baixa.validUntil,
      };
    }
    return { processed: false, reason: 'Esta cobrança recorrente já foi processada.' };
  }

  const settings = await loadSettings();
  if (!settings.accessToken) throw new Error('Gateway do Mercado Pago não configurado.');

  const parcela = await getAuthorizedPayment(authorizedPaymentId, settings);
  if (!parcela.preapprovalId) throw new Error('Cobrança recorrente sem preapproval_id.');
  const sub = await getSubscriptionByPreapprovalId(parcela.preapprovalId);
  if (!sub) {
    return { processed: false, reason: `Assinatura ${parcela.preapprovalId} não encontrada no Kivo.` };
  }

  // O status que importa é o do PAGAMENTO. A parcela pode estar `processed` com pagamento
  // recusado — nesse caso não se estende nada.
  if (parcela.paymentStatus !== 'approved') {
    await pool.query('UPDATE company_subscriptions SET last_error = ? WHERE id = ?', [
      `Cobrança ${parcela.status}: ${parcela.paymentStatusDetail ?? parcela.paymentStatus ?? 'sem detalhe'}`.slice(0, 500),
      sub.id,
    ]);
    return { processed: false, reason: `Pagamento ainda não aprovado (${parcela.paymentStatus ?? parcela.status}).` };
  }

  const descricao = `Assinatura Kivo — ${sub.reason}`.slice(0, 255);
  const valor = parcela.amountCents ?? sub.amount_cents;
  let chargeId: number;
  try {
    const [ins] = await pool.query(
      `INSERT INTO charges
         (company_uuid, description, instructions, amount_cents, due_date, status, extends_days,
          payer_email, subscription_id, subscription_payment_id, mp_payment_id, mp_method,
          mp_status, mp_status_detail, mp_updated_at)
       VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?, ?, ?, ?, 'subscription', ?, ?, NOW(3))`,
      [
        sub.company_uuid,
        descricao,
        `Cobrança recorrente automática (${parcela.authorizedPaymentId}).`,
        Math.max(1, valor),
        dateOnly(parcela.debitDate),
        sub.extends_days,
        sub.payer_email,
        sub.id,
        parcela.authorizedPaymentId,
        parcela.paymentId,
        parcela.paymentStatus,
        parcela.paymentStatusDetail,
      ],
    );
    chargeId = (ins as { insertId: number }).insertId;
  } catch (e) {
    // Corrida entre duas notificações: a UNIQUE barra a segunda; não é erro de negócio.
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
      return { processed: false, reason: 'Esta cobrança recorrente já foi processada.' };
    }
    throw e;
  }

  const baixa = await settleCharge(chargeId);
  await pool.query(
    `UPDATE company_subscriptions
        SET status = 'autorizada', last_payment_at = NOW(3), last_payment_id = ?,
            next_payment_date = COALESCE(?, next_payment_date), last_error = NULL
      WHERE id = ?`,
    [parcela.authorizedPaymentId, parcela.nextPaymentDate, sub.id],
  );

  return {
    processed: true,
    reason: baixa.settled ? 'Cobrança aprovada e licença estendida.' : 'Cobrança já estava baixada.',
    chargeId,
    extendedDays: baixa.extendedDays,
    validUntil: baixa.validUntil,
  };
}

/** Cancela no Mercado Pago e reflete localmente. Cancelamento não desfaz meses já pagos. */
export async function cancelCompanySubscription(id: number): Promise<void> {
  const sub = await getSubscriptionById(id);
  if (!sub) throw new Error('Assinatura não encontrada.');
  if (!sub.preapproval_id) {
    await getPool().query("UPDATE company_subscriptions SET status = 'cancelada' WHERE id = ?", [id]);
    return;
  }

  const settings: GatewaySettings = await loadSettings();
  if (!settings.accessToken) throw new Error('Gateway do Mercado Pago não configurado.');
  await updateSubscriptionStatus(sub.preapproval_id, 'cancelled', settings);
  await getPool().query("UPDATE company_subscriptions SET status = 'cancelada', last_error = NULL WHERE id = ?", [id]);
}
