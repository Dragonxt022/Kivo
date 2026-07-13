import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';

const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/mesas', page('comandas-mesas', 'comandas.view'));
router.get('/mesas/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('comandas.view')) return res.redirect('/');
  res.render('comandas-detalhe', { user: req.user, comandaId: Number(req.params.id) });
});

export default router;
