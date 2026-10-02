import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import {
  createChargePayment, fetchChargeStatus, fetchCloudCharges, fetchUrgentCharges,
  type ChargeMethod,
} from './service';

const router = Router();

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
