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

router.get('/cozinha', page('foodservice-cozinha', 'foodservice.kitchen.view'));
router.get('/roteamento', page('foodservice-routing', 'foodservice.routing.manage'));

export default router;
