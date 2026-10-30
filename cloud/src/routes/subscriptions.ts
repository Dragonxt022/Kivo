import { Router, type Request, type Response } from 'express';
import { getPool } from '../db';
import { requireAdminAuth } from '../adminAuth';
import { parseAmountCents } from '../format';
import {
  cancelCompanySubscription,
  createCompanySubscription,
  getSubscriptionByToken,
  publicSubscriptionUrl,
  syncSubscription,
  syncSubscriptionPayments,
} from '../subscriptions';

/**
 * Assinaturas recorrentes: painel do admin + página pública de autorização.
 *
 * O admin cria a assinatura, copia o link e manda ao cliente. O cliente autoriza o cartão
 * no Mercado Pago; o webhook de `subscription_authorized_payment` gera a cobrança e chama
 * `settleCharge`, que estende a licença. Nada aqui altera validade por conta própria.
 */
export const adminSubscriptionsRouter = Router();
export const publicSubscriptionsRouter = Router();

function redirectList(res: Response, kind: 'ok' | 'error', msg: string, companyUuid?: string): void {
  const q = new URLSearchParams({ [kind]: msg });
  if (companyUuid) q.set('company', companyUuid);
  res.redirect('/admin/subscriptions?' + q.toString());
}

adminSubscriptionsRouter.get('/subscriptions', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const companyFilter = typeof req.query.company === 'string' ? req.query.company : '';
  const [rows] = await pool.query(
    `SELECT s.*, c.name AS company_name
       FROM company_subscriptions s
       JOIN companies c ON c.company_uuid = s.company_uuid
      ${companyFilter ? 'WHERE s.company_uuid = ?' : ''}
      ORDER BY FIELD(s.status, 'pendente','autorizada','pausada','erro','cancelada','encerrada'), s.created_at DESC
      LIMIT 500`,
    companyFilter ? [companyFilter] : [],
  );
  const subscriptions = (rows as Record<string, unknown>[]).map((s) => ({
    ...s,
    public_url: s.public_token ? publicSubscriptionUrl(String(s.public_token)) : null,
  }));

  const [companies] = await pool.query(
    'SELECT company_uuid, name, plan, email FROM companies ORDER BY name, company_uuid',
  );

  const [statsRows] = await pool.query(
    `SELECT
       SUM(status = 'autorizada') AS ativas,
       SUM(status = 'pendente') AS pendentes,
       SUM(status = 'erro') AS erros,
       COALESCE(SUM(CASE WHEN status = 'autorizada' THEN amount_cents END), 0) AS mrr_cents,
       SUM(next_payment_date IS NOT NULL AND next_payment_date < (NOW(3) + INTERVAL 7 DAY)) AS proximas
     FROM company_subscriptions`,
  );
  const r = ((statsRows as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
  const stats = {
    ativas: Number(r.ativas || 0),
    pendentes: Number(r.pendentes || 0),
    erros: Number(r.erros || 0),
    mrr_cents: Number(r.mrr_cents || 0),
    proximas: Number(r.proximas || 0),
  };

  res.render('subscriptions', {
    subscriptions,
    companies: companies as Record<string, unknown>[],
    stats,
    companyFilter,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

adminSubscriptionsRouter.post('/companies/:uuid/subscriptions', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const [companyRows] = await getPool().query('SELECT name, email FROM companies WHERE company_uuid = ?', [uuid]);
  const company = (companyRows as { name: string | null; email: string | null }[])[0];
  if (!company) {
    redirectList(res, 'error', 'Empresa não encontrada.');
    return;
  }

  const amountCents = parseAmountCents(body.amount);
  if (amountCents <= 0) {
    redirectList(res, 'error', 'Informe um valor mensal maior que zero.', uuid);
    return;
  }
  const frequency = Math.max(1, Number(body.frequency) || 1);
  const frequencyType = body.frequencyType === 'days' ? 'days' : 'months';
  const extendsDays = Math.max(1, Number(body.extendsDays) || 30);
  const reason = String(body.reason ?? '').trim() || `Assinatura Kivo — ${company.name || 'cliente'}`;
  const payerEmail = String(body.payerEmail ?? '').trim() || company.email || '';

  try {
    await createCompanySubscription({
      companyUuid: uuid,
      planKey: String(body.planKey ?? '').trim() || null,
      reason,
      amountCents,
      extendsDays,
      frequency,
      frequencyType,
      payerEmail,
    });
    redirectList(res, 'ok', 'Assinatura criada. Copie o link e envie ao cliente para autorizar o cartão.', uuid);
  } catch (e) {
    redirectList(res, 'error', e instanceof Error ? e.message : String(e), uuid);
  }
});

adminSubscriptionsRouter.post('/subscriptions/:id/sync', requireAdminAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const sub = await syncSubscription(id);
    const pagamentos = await syncSubscriptionPayments(id);
    const extra = pagamentos.processed
      ? ` ${pagamentos.processed} cobrança(s) processada(s) e licença estendida.`
      : (pagamentos.checked ? ' Nenhuma cobrança nova aprovada.' : '');
    redirectList(res, 'ok', `Assinatura sincronizada: ${sub?.status ?? 'sem alteração'}.${extra}`, sub?.company_uuid);
  } catch (e) {
    redirectList(res, 'error', e instanceof Error ? e.message : String(e));
  }
});

adminSubscriptionsRouter.post('/subscriptions/:id/cancel', requireAdminAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await cancelCompanySubscription(id);
    redirectList(res, 'ok', 'Assinatura cancelada. Os meses já pagos continuam valendo.', undefined);
  } catch (e) {
    redirectList(res, 'error', e instanceof Error ? e.message : String(e));
  }
});

/**
 * Página pública que o cliente recebe. Mostra o resumo, o botão para autorizar no Mercado
 * Pago e o status real. Se o cliente voltar do checkout, tentamos sincronizar na hora para
 * não depender só do webhook (que pode chegar segundos depois).
 */
publicSubscriptionsRouter.get('/assinar/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token ?? '');
  let sub = await getSubscriptionByToken(token);
  if (!sub) {
    res.status(404).render('subscription-public', {
      sub: null,
      companyName: null,
      notFound: true,
    });
    return;
  }

  if (sub.status === 'pendente' && sub.preapproval_id) {
    try {
      sub = (await syncSubscription(sub.id)) ?? sub;
    } catch {
      // Sem internet/gateway: mostra o estado local e o botão continua válido.
    }
  }

  const [companyRows] = await getPool().query('SELECT name FROM companies WHERE company_uuid = ?', [sub.company_uuid]);
  const companyName = (companyRows as { name: string | null }[])[0]?.name ?? null;
  res.setHeader('Cache-Control', 'no-store');
  res.render('subscription-public', { sub, companyName, notFound: false });
});
