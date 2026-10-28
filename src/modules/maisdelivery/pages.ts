import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { getMaisDeliveryConfig, isMaisDeliveryConfigured } from './settings';

/** Páginas do módulo maisdelivery (montadas em /app/maisdelivery, já autenticadas). */
const router = Router();

// `canManage`/`canSettings` dependem do usuário, então são resolvidos por requisição.
router.get('/pedidos', (req: Request, res: Response) => {
  assertAuth(req);
  if (!req.user.permissions.has('maisdelivery.orders.view')) return res.redirect('/');
  res.render('maisdelivery-orders', {
    user: req.user,
    configured: isMaisDeliveryConfigured(),
    canManage: req.user.permissions.has('maisdelivery.orders.status'),
    canSettings: req.user.permissions.has('maisdelivery.settings.manage'),
  });
});

router.get('/configuracoes', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('maisdelivery.settings.manage')) return res.redirect('/');
  const config = getMaisDeliveryConfig();
  res.render('maisdelivery-settings', {
    user: req.user,
    config,
    configured: isMaisDeliveryConfigured(config),
  });
});

export default router;
