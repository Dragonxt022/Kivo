import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { notificationSounds } from '../../core/sound/notificationSounds';
import { qrOrderAvailability } from './qr';

const router = Router();

function page(view: string, permission: string, extra?: (req: Request) => Record<string, unknown>) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, sons: notificationSounds(), ...(extra ? extra(req) : {}) });
  };
}

router.get('/mesas', page('comandas-mesas', 'comandas.view', () => {
  const qr = qrOrderAvailability();
  return { qrEnabled: qr.available, qrReason: qr.reason };
}));
router.get('/mesas/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('comandas.view')) return res.redirect('/');
  const qr = qrOrderAvailability();
  res.render('comandas-detalhe', {
    user: req.user, comandaId: Number(req.params.id), qrEnabled: qr.available, qrReason: qr.reason,
  });
});

export default router;
