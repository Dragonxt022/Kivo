import { Router } from 'express';
import { getPool } from '../db';
import { requireAdminAuth } from '../adminAuth';
import {
  GatewayError, createBoletoPayment, createCardPreference, createPixPayment,
  getPayment, isConfigured, loadSettings, loadSettingsForView, mapPaymentStatus,
  publicPayUrl, saveSettings,
} from '../gateway';
import {
  ensurePublicToken, getCharge, saveGatewayResult, savePaymentSnapshot, settleCharge,
} from '../charges';

/**
 * Pagamento da assinatura no painel do cloud.
 *
 *  - `/admin/payments` — credenciais do Mercado Pago + tutorial de como obtê-las;
 *  - `/admin/companies/:uuid/charges/:id/gateway` — gera o pagamento (Pix, boleto ou link do
 *    Checkout Pro) para uma cobrança da empresa;
 *  - `/admin/companies/:uuid/charges/:id/sync` — "já pagou?": relê o status no Mercado Pago
 *    e baixa a cobrança se estiver aprovado (útil quando o webhook não chegou, ex.: URL
 *    ainda não configurada no painel do MP).
 *
 * A baixa em si mora em `charges.ts` (`settleCharge`) e é a MESMA usada pelo webhook e pelo
 * botão manual "Marcar paga" — comissão de afiliado e extensão de validade saem daí.
 */

const router = Router();

function redirectCompanyCharges(res: import('express').Response, uuid: string, kind: 'ok' | 'error', msg: string): void {
  res.redirect(`/admin/companies/${uuid}?${kind}=${encodeURIComponent(msg)}#cobrancas`);
}

// ─────────────────────────── Credenciais e tutorial ───────────────────────────

router.get('/payments', requireAdminAuth, async (req, res) => {
  const view = await loadSettingsForView();
  res.render('payments', {
    gateway: view,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/payments', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  await saveSettings(b);
  res.redirect('/admin/payments?ok=' + encodeURIComponent('Configurações de pagamento salvas.'));
});

// ─────────────────────── Pagamento de uma cobrança ───────────────────────

/** Dados da empresa que o gateway precisa (nome para o boleto, e-mail como pagador padrão). */
async function companyPayer(uuid: string): Promise<{ name: string; email: string; document: string | null }> {
  const [rows] = await getPool().query('SELECT name, email, document FROM companies WHERE company_uuid = ?', [uuid]);
  const c = (rows as { name: string | null; email: string | null; document: string | null }[])[0];
  return { name: c?.name ?? '', email: c?.email ?? '', document: c?.document ?? null };
}

router.post('/companies/:uuid/charges/:id/gateway', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const id = Number(req.params.id);
  const method = String((req.body ?? {}).method ?? 'pix');

  const charge = await getCharge(id, uuid);
  if (!charge) {
    redirectCompanyCharges(res, uuid, 'error', 'Cobrança não encontrada.');
    return;
  }
  if (charge.status !== 'pendente') {
    redirectCompanyCharges(res, uuid, 'error', 'Só uma cobrança pendente pode gerar pagamento.');
    return;
  }

  const settings = await loadSettings();
  if (!isConfigured(settings)) {
    redirectCompanyCharges(res, uuid, 'error', 'Configure o Access Token do Mercado Pago em Pagamentos antes de gerar a cobrança.');
    return;
  }

  const empresa = await companyPayer(uuid);
  const input = {
    chargeId: charge.id,
    description: charge.description,
    amountCents: charge.amount_cents,
    payerEmail: charge.payer_email || empresa.email || settings.payerEmail,
    payerName: empresa.name,
    payerDocument: empresa.document,
  };
  if (!input.payerEmail) {
    redirectCompanyCharges(res, uuid, 'error', 'Sem e-mail do pagador: informe um na cobrança, no cadastro da empresa ou nas configurações de pagamento.');
    return;
  }

  try {
    const token = await ensurePublicToken(charge.id);
    if (method === 'boleto') {
      const r = await createBoletoPayment(input, settings);
      await saveGatewayResult(charge.id, { ...r, method: 'boleto' });
      redirectCompanyCharges(res, uuid, 'ok', 'Boleto gerado. Copie o link na cobrança para enviar ao cliente.');
      return;
    }
    if (method === 'card') {
      const back = publicPayUrl(token);
      const pref = await createCardPreference(input, settings, { success: back, pending: back, failure: back });
      await saveGatewayResult(charge.id, {
        method: 'card', status: 'pending', statusDetail: 'checkout_pro', initPoint: pref.initPoint,
      });
      redirectCompanyCharges(res, uuid, 'ok', 'Link de cartão gerado. Copie o link na cobrança para enviar ao cliente.');
      return;
    }
    const r = await createPixPayment(input, settings);
    await saveGatewayResult(charge.id, { ...r, method: 'pix' });
    redirectCompanyCharges(res, uuid, 'ok', 'Pix gerado. O QR e o copia e cola estão na cobrança.');
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `Falha ao falar com o Mercado Pago: ${(e as Error).message}`;
    console.error('[payments] erro ao gerar pagamento', { cobranca: charge.id, method, msg });
    redirectCompanyCharges(res, uuid, 'error', msg);
  }
});

router.post('/companies/:uuid/charges/:id/sync', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const id = Number(req.params.id);
  const charge = await getCharge(id, uuid);
  if (!charge) {
    redirectCompanyCharges(res, uuid, 'error', 'Cobrança não encontrada.');
    return;
  }

  const settings = await loadSettings();
  if (!isConfigured(settings)) {
    redirectCompanyCharges(res, uuid, 'error', 'Gateway não configurado.');
    return;
  }
  // Pix cujo QR ainda não foi lido pelo cliente não tem id? Tem: o id vem da criação.
  // Cobrança antiga (boleto/pix gerado fora) não tem como ser consultada.
  const [pagamentos] = await getPool().query(
    'SELECT mp_payment_id FROM charges WHERE id = ? AND mp_payment_id IS NOT NULL', [id],
  );
  const pagamento = (pagamentos as { mp_payment_id: string }[])[0]?.mp_payment_id;
  if (!pagamento) {
    redirectCompanyCharges(res, uuid, 'error', 'Esta cobrança ainda não tem pagamento gerado no Mercado Pago.');
    return;
  }

  try {
    const snapshot = await getPayment(pagamento, settings);
    await savePaymentSnapshot(charge.id, snapshot, charge.mp_method);
    if (mapPaymentStatus(snapshot.status) === 'paga') {
      const r = await settleCharge(charge.id);
      const extra = r.extendedDays > 0 ? ` Validade da licença agora é ${r.validUntil}.` : '';
      redirectCompanyCharges(res, uuid, 'ok', `Pagamento aprovado — cobrança baixada.${extra}`);
      return;
    }
    redirectCompanyCharges(res, uuid, 'ok', `Mercado Pago ainda não aprovou: ${snapshot.status} (${snapshot.statusDetail ?? 'sem detalhe'}).`);
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `Falha ao consultar o Mercado Pago: ${(e as Error).message}`;
    redirectCompanyCharges(res, uuid, 'error', msg);
  }
});

export default router;
