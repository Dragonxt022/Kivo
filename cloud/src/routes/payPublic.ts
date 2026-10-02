import { Router } from 'express';
import {
  GatewayError, createBoletoPayment, createCardPreference, createPixPayment,
  getPayment, isConfigured, loadSettings, mapPaymentStatus, publicPayUrl,
} from '../gateway';
import {
  companyPayerData, getChargeByToken, saveGatewayResult, savePaymentSnapshot, settleCharge,
} from '../charges';
import type { ChargeRow } from '../charges';

/**
 * Página pública de pagamento (`/pagar/<token>`) — o link que o lojista manda para o cliente.
 *
 * O token é um UUID por cobrança: a URL não revela o id, não permite enumerar outras
 * cobranças e não exige login. O que a página mostra é só o necessário para pagar: nome da
 * empresa, descrição, valor, vencimento e o status.
 *
 * Nada aqui confia no navegador: o valor cobrado vem SEMPRE da cobrança no banco, nunca do
 * formulário — quem manda no preço é o servidor.
 */

const router = Router();

interface PublicCharge {
  charge: ChargeRow;
  companyName: string;
}

async function load(token: string): Promise<PublicCharge | null> {
  const charge = await getChargeByToken(token);
  if (!charge) return null;
  const empresa = await companyPayerData(charge.company_uuid);
  return { charge, companyName: empresa.name || 'Kivo' };
}

function payerEmailOf(charge: ChargeRow, companyEmail: string, fallback: string): string {
  return charge.payer_email || companyEmail || fallback;
}

router.get('/:token', async (req, res) => {
  const dados = await load(String(req.params.token));
  if (!dados) {
    res.status(404).render('pay-public', { charge: null, companyName: '', notFound: true, gatewayOn: false });
    return;
  }
  const settings = await loadSettings();
  res.render('pay-public', {
    charge: dados.charge,
    companyName: dados.companyName,
    notFound: false,
    gatewayOn: isConfigured(settings),
    publicUrl: publicPayUrl(dados.charge.public_token ?? ''),
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/:token/gateway', async (req, res) => {
  const token = String(req.params.token);
  const dados = await load(token);
  if (!dados) {
    res.status(404).send('Cobrança não encontrada.');
    return;
  }
  const { charge } = dados;
  const method = String((req.body ?? {}).method ?? 'pix');
  const voltar = (kind: 'ok' | 'error', msg: string) => res.redirect(`/pagar/${token}?${kind}=${encodeURIComponent(msg)}`);

  if (charge.status !== 'pendente') {
    voltar('error', 'Esta cobrança não está mais pendente.');
    return;
  }

  const settings = await loadSettings();
  if (!isConfigured(settings)) {
    voltar('error', 'O pagamento online ainda não está disponível. Fale com o suporte do Kivo.');
    return;
  }

  const empresa = await companyPayerData(charge.company_uuid);
  const payerEmail = payerEmailOf(charge, empresa.email, settings.payerEmail);
  if (!payerEmail) {
    voltar('error', 'Não foi possível identificar o e-mail do pagador. Fale com o suporte do Kivo.');
    return;
  }

  const input = {
    chargeId: charge.id,
    description: charge.description,
    amountCents: charge.amount_cents,
    payerEmail,
    payerName: empresa.name,
    payerDocument: empresa.document,
  };

  try {
    if (method === 'boleto') {
      const r = await createBoletoPayment(input, settings);
      await saveGatewayResult(charge.id, { ...r, method: 'boleto' });
      voltar('ok', 'Boleto gerado.');
      return;
    }
    if (method === 'card') {
      const back = publicPayUrl(token);
      const pref = await createCardPreference(input, settings, { success: back, pending: back, failure: back });
      await saveGatewayResult(charge.id, {
        method: 'card', status: 'pending', statusDetail: 'checkout_pro', initPoint: pref.initPoint,
      });
      // Cartão: manda direto para o Checkout Pro (o cliente paga lá e volta para cá).
      res.redirect(pref.initPoint);
      return;
    }
    const r = await createPixPayment(input, settings);
    await saveGatewayResult(charge.id, { ...r, method: 'pix' });
    voltar('ok', 'Pix gerado — use o QR ou o copia e cola.');
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : 'Falha ao falar com o Mercado Pago.';
    console.error('[pagar] erro ao gerar pagamento', { cobranca: charge.id, method, msg });
    voltar('error', msg);
  }
});

/** Auto-refresh da página: consulta o status e, se aprovado, baixa a cobrança. */
router.get('/:token/status', async (req, res) => {
  const dados = await load(String(req.params.token));
  if (!dados) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  const { charge } = dados;
  const settings = await loadSettings();

  // Sem gateway configurado ou sem pagamento gerado, devolve o que já sabemos.
  if (!isConfigured(settings) || !charge.mp_payment_id) {
    res.json({ status: charge.status, mpStatus: charge.mp_status, paidAt: charge.paid_at });
    return;
  }
  try {
    const snapshot = await getPayment(charge.mp_payment_id, settings);
    await savePaymentSnapshot(charge.id, snapshot, charge.mp_method);
    if (mapPaymentStatus(snapshot.status) === 'paga') {
      const r = await settleCharge(charge.id);
      res.json({ status: 'paga', mpStatus: snapshot.status, paidAt: new Date().toISOString(), settledNow: r.settled });
      return;
    }
    res.json({ status: charge.status, mpStatus: snapshot.status, statusDetail: snapshot.statusDetail });
  } catch (e) {
    res.json({ status: charge.status, mpStatus: charge.mp_status, error: (e as Error).message });
  }
});

export default router;
