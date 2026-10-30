import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import {
  GatewayError, createBoletoPayment, createCardPreference, createPixPayment,
  getPayment, isConfigured, loadSettings, mapPaymentStatus, publicPayUrl,
} from '../gateway';
import {
  companyPayerData, ensurePublicToken, extendLicense, getCharge, saveGatewayResult,
  savePaymentSnapshot, settleCharge,
} from '../charges';
import { COMMERCIAL_PLANS, commercialPlan } from '../plans';
import {
  cancelCompanySubscription,
  createCompanySubscription,
  getLatestCompanySubscription,
  publicSubscriptionUrl,
  subscriptionIsCurrent,
  syncSubscription,
  syncSubscriptionPayments,
} from '../subscriptions';

const router = Router();

/**
 * Cobranças da própria empresa (o Kivo instalado consome isto).
 *
 * A tela de Cobranças do app mostra a lista e, quando o gateway está configurado, oferece o
 * pagamento: Pix (QR + copia e cola), boleto (link) e cartão (link do Checkout Pro). O app
 * NUNCA fala com o Mercado Pago — só com estas rotas, autenticadas pela licença da empresa
 * (mesmo par X-Kivo-Company / X-Kivo-License-Key de /api/sync e /api/backup).
 */
router.get('/charges', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT id, description, instructions, amount_cents, due_date, status, paid_at, created_at,
            public_token, mp_method, mp_status, mp_status_detail, mp_qr_code, mp_qr_code_base64,
            mp_ticket_url, mp_init_point, mp_updated_at
       FROM charges WHERE company_uuid = ? ORDER BY due_date DESC`,
    [req.companyUuid],
  );
  const charges = (rows as Record<string, unknown>[]).map((c) => ({
    ...c,
    // Link pronto para o lojista mandar ao cliente (WhatsApp/e-mail) sem passar pelo painel.
    public_url: c.public_token ? publicPayUrl(String(c.public_token)) : null,
  }));
  res.json(charges);
});

/**
 * Assinatura da própria empresa, para o autoatendimento dentro do app.
 *
 * `?sync=1` relê a preapproval e as parcelas no Mercado Pago antes de responder — é o que
 * faz a tela refletir a autorização/primeiro pagamento mesmo quando o webhook atrasa.
 */
router.get('/subscription', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  let sub = await getLatestCompanySubscription(companyUuid);

  if (req.query.sync === '1' && sub) {
    try {
      sub = (await syncSubscription(sub.id)) ?? sub;
      // Reconciliação das parcelas: se o webhook não chegou, este GET ainda estende a licença.
      await syncSubscriptionPayments(sub.id);
      sub = (await getLatestCompanySubscription(companyUuid)) ?? sub;
    } catch (e) {
      console.error('[billing] falha ao sincronizar assinatura', { companyUuid, erro: (e as Error).message });
    }
  }

  const [companyRows] = await getPool().query(
    `SELECT name, email, plan, valid_until, retention_offer_decided_at, retention_offer_accepted
       FROM companies WHERE company_uuid = ?`,
    [companyUuid],
  );
  const company = (companyRows as {
    name: string | null; email: string | null; plan: string | null; valid_until: string | null;
    retention_offer_decided_at: string | null; retention_offer_accepted: number | null;
  }[])[0] ?? null;

  res.json({
    company: company ? {
      name: company.name,
      email: company.email,
      plan: company.plan,
      validUntil: company.valid_until,
    } : null,
    retention: {
      available: !!company && company.retention_offer_decided_at == null,
      accepted: company?.retention_offer_accepted === 1,
      decidedAt: company?.retention_offer_decided_at ?? null,
    },
    plans: COMMERCIAL_PLANS,
    subscription: sub ? {
      id: sub.id,
      status: sub.status,
      planKey: sub.plan_key,
      amountCents: sub.amount_cents,
      extendsDays: sub.extends_days,
      frequency: sub.frequency,
      frequencyType: sub.frequency_type,
      payerEmail: sub.payer_email,
      initPoint: sub.init_point,
      nextPaymentDate: sub.next_payment_date,
      lastPaymentAt: sub.last_payment_at,
      lastError: sub.last_error,
      publicUrl: sub.public_token ? publicSubscriptionUrl(sub.public_token) : null,
    } : null,
  });
});

/** Cria a assinatura a partir do app. Preço/frequência vêm do catálogo do servidor. */
router.post('/subscription', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const plan = commercialPlan(String(body.planKey ?? ''));
  if (!plan) {
    res.status(400).json({ error: 'Escolha um plano válido.' });
    return;
  }
  const payerEmail = String(body.payerEmail ?? '').trim();
  if (!payerEmail || !payerEmail.includes('@')) {
    res.status(400).json({ error: 'Informe o e-mail da conta Mercado Pago que vai autorizar a assinatura.' });
    return;
  }

  const atual = await getLatestCompanySubscription(companyUuid);
  if (subscriptionIsCurrent(atual)) {
    res.status(409).json({
      error: 'Esta empresa já tem uma assinatura ativa ou aguardando autorização.',
      subscription: atual,
    });
    return;
  }

  try {
    const sub = await createCompanySubscription({
      companyUuid,
      planKey: plan.key,
      reason: `Kivo — Plano ${plan.label}`,
      amountCents: plan.priceCents,
      extendsDays: plan.extendsDays,
      frequency: 1,
      frequencyType: 'months',
      payerEmail,
    });
    res.json({
      subscription: sub,
      initPoint: sub.init_point,
      publicUrl: sub.public_token ? publicSubscriptionUrl(sub.public_token) : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[billing] erro ao criar assinatura pelo app', { companyUuid, plano: plan.key, msg });
    res.status(502).json({ error: msg });
  }
});

/**
 * Cancelamento pedido pelo cliente: interrompe as próximas cobranças no Mercado Pago, mas
 * NÃO encurta a licença. O acesso continua até `valid_until` (fim do período já pago).
 */
router.post('/subscription/cancel', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const sub = await getLatestCompanySubscription(companyUuid);
  if (!subscriptionIsCurrent(sub)) {
    res.status(400).json({ error: 'Não há assinatura ativa para cancelar.' });
    return;
  }
  try {
    await cancelCompanySubscription(sub!.id);
    const [rows] = await getPool().query('SELECT valid_until FROM companies WHERE company_uuid = ?', [companyUuid]);
    const validUntil = (rows as { valid_until: string | null }[])[0]?.valid_until ?? null;
    res.json({
      ok: true,
      message: validUntil
        ? `Assinatura cancelada. O acesso continua até ${validUntil.slice(0, 10)}.`
        : 'Assinatura cancelada. Não haverá novas cobranças.',
      accessUntil: validUntil,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ error: msg });
  }
});

/**
 * Oferta de retenção: 1 mês grátis, uma única vez por empresa.
 *
 * Aceitar cancela a assinatura no Mercado Pago (para o mês grátis não ser cobrado) e
 * estende a licença em 30 dias. Recusar só registra a decisão; a assinatura também é
 * cancelada para não gerar cobrança futura, mas o acesso continua até `valid_until`.
 */
router.post('/retention/accept', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const [rows] = await getPool().query(
    'SELECT retention_offer_decided_at, valid_until FROM companies WHERE company_uuid = ?',
    [companyUuid],
  );
  const company = (rows as { retention_offer_decided_at: string | null; valid_until: string | null }[])[0];
  if (!company) {
    res.status(404).json({ error: 'Empresa não encontrada.' });
    return;
  }
  if (company.retention_offer_decided_at) {
    res.status(409).json({ error: 'Esta empresa já utilizou a oferta de retenção.' });
    return;
  }

  const sub = await getLatestCompanySubscription(companyUuid);
  if (subscriptionIsCurrent(sub)) {
    await cancelCompanySubscription(sub!.id);
  }
  const validUntil = await extendLicense(companyUuid, 30);
  await getPool().query(
    'UPDATE companies SET retention_offer_decided_at = NOW(3), retention_offer_accepted = 1 WHERE company_uuid = ?',
    [companyUuid],
  );

  res.json({
    ok: true,
    validUntil,
    message: validUntil
      ? `Pronto! Você ganhou mais 1 mês grátis. Acesso até ${validUntil.slice(0, 10)}.`
      : 'Pronto! Você ganhou mais 1 mês grátis.',
  });
});

router.post('/retention/decline', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const [rows] = await getPool().query(
    'SELECT retention_offer_decided_at, valid_until FROM companies WHERE company_uuid = ?',
    [companyUuid],
  );
  const company = (rows as { retention_offer_decided_at: string | null; valid_until: string | null }[])[0];
  if (!company) {
    res.status(404).json({ error: 'Empresa não encontrada.' });
    return;
  }
  if (company.retention_offer_decided_at) {
    res.json({ ok: true, accessUntil: company.valid_until });
    return;
  }

  const sub = await getLatestCompanySubscription(companyUuid);
  if (subscriptionIsCurrent(sub)) {
    await cancelCompanySubscription(sub!.id);
  }
  await getPool().query(
    'UPDATE companies SET retention_offer_decided_at = NOW(3), retention_offer_accepted = 0 WHERE company_uuid = ?',
    [companyUuid],
  );
  res.json({ ok: true, accessUntil: company.valid_until });
});

/** Monta o pedido de pagamento da cobrança da própria empresa. */
async function paymentInput(chargeId: number, uuid: string) {
  const charge = await getCharge(chargeId, uuid);
  if (!charge) return { error: 'Cobrança não encontrada.' as const };
  if (charge.status !== 'pendente') return { error: 'Esta cobrança não está mais pendente.' as const };

  const settings = await loadSettings();
  if (!isConfigured(settings)) return { error: 'O pagamento online não está disponível nesta instalação.' as const };
  if (charge.mp_payment_id) {
    // Já existe pagamento gerado: devolve o que temos (o QR do Pix não muda).
    return { charge, settings, jaGerado: true as const };
  }

  const empresa = await companyPayerData(uuid);
  const payerEmail = charge.payer_email || empresa.email || settings.payerEmail;
  if (!payerEmail) return { error: 'Sem e-mail do pagador para gerar a cobrança.' as const };

  return {
    charge,
    settings,
    jaGerado: false as const,
    input: {
      chargeId: charge.id,
      description: charge.description,
      amountCents: charge.amount_cents,
      payerEmail,
      payerName: empresa.name,
      payerDocument: empresa.document,
    },
  };
}

/**
 * Gera o pagamento da cobrança: `method` = pix | boleto | card.
 * Devolve os dados do gateway para a tela desenhar (QR, código, link).
 */
router.post('/charges/:id/gateway', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const method = String((req.body ?? {}).method ?? 'pix');
  const ctx = await paymentInput(id, req.companyUuid!);
  if ('error' in ctx) {
    res.status(400).json({ error: ctx.error });
    return;
  }

  const token = await ensurePublicToken(ctx.charge.id);
  try {
    if (ctx.jaGerado) {
      res.json({
        jaGerado: true,
        public_url: publicPayUrl(token),
        mp_method: ctx.charge.mp_method,
        mp_qr_code: ctx.charge.mp_qr_code,
        mp_qr_code_base64: ctx.charge.mp_qr_code_base64,
        mp_ticket_url: ctx.charge.mp_ticket_url,
        mp_init_point: ctx.charge.mp_init_point,
      });
      return;
    }

    if (method === 'boleto') {
      const r = await createBoletoPayment(ctx.input, ctx.settings);
      await saveGatewayResult(ctx.charge.id, { ...r, method: 'boleto' });
      res.json({ public_url: publicPayUrl(token), mp_method: 'boleto', mp_ticket_url: r.ticketUrl, mp_status: r.status });
      return;
    }
    if (method === 'card') {
      const back = publicPayUrl(token);
      const pref = await createCardPreference(ctx.input, ctx.settings, { success: back, pending: back, failure: back });
      await saveGatewayResult(ctx.charge.id, {
        method: 'card', status: 'pending', statusDetail: 'checkout_pro', initPoint: pref.initPoint,
      });
      res.json({ public_url: publicPayUrl(token), mp_method: 'card', mp_init_point: pref.initPoint });
      return;
    }
    const r = await createPixPayment(ctx.input, ctx.settings);
    await saveGatewayResult(ctx.charge.id, { ...r, method: 'pix' });
    res.json({
      public_url: publicPayUrl(token),
      mp_method: 'pix',
      mp_qr_code: r.qrCode,
      mp_qr_code_base64: r.qrCodeBase64,
      mp_ticket_url: r.ticketUrl,
      mp_status: r.status,
    });
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `Falha ao falar com o Mercado Pago: ${(e as Error).message}`;
    console.error('[billing] erro ao gerar pagamento', { cobranca: id, method, msg });
    res.status(502).json({ error: msg });
  }
});

/**
 * "Já pagou?" — a tela pergunta enquanto o QR está aberto. Reconfere no Mercado Pago e, se
 * aprovado, baixa a cobrança (e estende a licença) na hora, sem depender do webhook.
 */
router.get('/charges/:id/status', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const charge = await getCharge(Number(req.params.id), req.companyUuid!);
  if (!charge) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  const settings = await loadSettings();
  if (!isConfigured(settings) || !charge.mp_payment_id) {
    res.json({ status: charge.status, mp_status: charge.mp_status, paid_at: charge.paid_at });
    return;
  }
  try {
    const snapshot = await getPayment(charge.mp_payment_id, settings);
    await savePaymentSnapshot(charge.id, snapshot, charge.mp_method);
    if (mapPaymentStatus(snapshot.status) === 'paga') {
      const r = await settleCharge(charge.id);
      // A validade nova ajuda a tela a confirmar o que aconteceu, não só "pago".
      const [rows] = await getPool().query('SELECT valid_until FROM companies WHERE company_uuid = ?', [req.companyUuid]);
      res.json({
        status: 'paga',
        mp_status: snapshot.status,
        paid_at: new Date().toISOString(),
        settled_now: r.settled,
        extended_days: r.extendedDays,
        valid_until: (rows as { valid_until: string | null }[])[0]?.valid_until ?? null,
      });
      return;
    }
    res.json({ status: charge.status, mp_status: snapshot.status, mp_status_detail: snapshot.statusDetail });
  } catch (e) {
    res.json({ status: charge.status, mp_status: charge.mp_status, error: (e as Error).message });
  }
});

export default router;
