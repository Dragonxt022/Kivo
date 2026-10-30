import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import {
  acceptRetentionOffer, cancelCloudSubscription, createChargePayment, createCloudSubscription,
  declineRetentionOffer, fetchChargeStatus, fetchCloudCharges, fetchCloudSubscription,
  fetchUrgentCharges, type ChargeMethod,
} from './service';

const router = Router();

router.get('/subscription', requirePermission('billing.view'), async (req, res) => {
  const r = await fetchCloudSubscription(req.query.sync === '1');
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  res.json(r.data);
});

/**
 * Assinar pelo próprio app. O preço é definido no servidor; aqui só escolhemos o plano e o
 * e-mail da conta Mercado Pago que vai autorizar.
 */
router.post('/subscription', requirePermission('billing.view'), async (req, res) => {
  const planKey = String((req.body ?? {}).planKey ?? '');
  const payerEmail = String((req.body ?? {}).payerEmail ?? '').trim();
  const r = await createCloudSubscription(planKey, payerEmail);
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  audit(req, 'assinar_plano', 'subscription', r.data.subscription.id, null, {
    planKey: r.data.subscription.planKey, amountCents: r.data.subscription.amountCents,
  });
  res.json(r.data);
});

/** Cancelamento com efeito no fim do período já pago (não encurta a licença). */
router.post('/subscription/cancel', requirePermission('billing.view'), async (req, res) => {
  const r = await cancelCloudSubscription();
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  audit(req, 'cancelar_assinatura', 'subscription', undefined, null, { accessUntil: r.data.accessUntil });
  res.json(r.data);
});

router.post('/retention/accept', requirePermission('billing.view'), async (req, res) => {
  const r = await acceptRetentionOffer();
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  audit(req, 'aceitar_retencao', 'subscription', undefined, null, { validUntil: r.data.validUntil });
  res.json(r.data);
});

router.post('/retention/decline', requirePermission('billing.view'), async (req, res) => {
  const r = await declineRetentionOffer();
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  audit(req, 'recusar_retencao', 'subscription', undefined, null, { accessUntil: r.data.accessUntil });
  res.json(r.data);
});

router.get('/charges', requirePermission('billing.view'), async (_req, res) => {
  res.json(await fetchCloudCharges());
});

router.get('/alert', requirePermission('billing.view'), async (_req, res) => {
  const urgent = await fetchUrgentCharges();
  res.json({ count: urgent.length, charges: urgent });
});

const METHODS: ChargeMethod[] = ['pix', 'boleto', 'card'];

/**
 * Gera o pagamento da cobrança (Pix, boleto ou link de cartão) para a tela de Cobranças.
 * O app não fala com o Mercado Pago: repassa o pedido ao cloud, que é quem tem a credencial.
 */
router.post('/charges/:id/payment', requirePermission('billing.view'), async (req, res) => {
  const id = Number(req.params.id);
  const raw = String((req.body ?? {}).method ?? 'pix');
  const method: ChargeMethod = (METHODS as string[]).includes(raw) ? (raw as ChargeMethod) : 'pix';

  const r = await createChargePayment(id, method);
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  // Auditoria local do ato: gerar pagamento é ação financeira e o lojista pode perguntar quem fez.
  audit(req, 'gerar_pagamento', 'cloud_charge', id, null, { method, jaGerado: !!r.data.jaGerado });
  res.json(r.data);
});

/** "Já pagou?" — a tela consulta enquanto o QR está aberto. */
router.get('/charges/:id/status', requirePermission('billing.view'), async (req, res) => {
  const id = Number(req.params.id);
  const r = await fetchChargeStatus(id);
  if (!r.ok) {
    res.status(502).json({ error: r.error });
    return;
  }
  if (r.data.status === 'paga') {
    audit(req, 'confirmar_pagamento', 'cloud_charge', id, null, {
      mp_status: r.data.mp_status ?? null, settled_now: !!r.data.settled_now,
    });
  }
  res.json(r.data);
});

export default router;
