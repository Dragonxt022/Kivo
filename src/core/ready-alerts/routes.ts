import { Router } from 'express';
import { requireAnyPermission } from '../permissions/middleware';
import { listReadyAlerts } from './service';
import { subscribeReadyAlertEvents } from './events';

const router = Router();

/**
 * Quem enxerga um pedido pronto: o garçom/caixa (mesas), quem opera o PDV (venda direta)
 * ou a cozinha. Qualquer um dos três pode receber o aviso; o cliente só não vê ticket de
 * área que não pode acessar.
 */
const canSeeReady = requireAnyPermission('comandas.view', 'store.sales.view', 'foodservice.kitchen.view');

/** Rede de segurança do SSE (e leitura no boot da página): tickets prontos agora. */
router.get('/pending', canSeeReady, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ alerts: listReadyAlerts() });
});

/** Canal em tempo real. O snapshot inicial evita perder o que ficou pronto na troca de tela. */
router.get('/events', canSeeReady, (_req, res) => {
  subscribeReadyAlertEvents(res, listReadyAlerts());
});

export default router;
