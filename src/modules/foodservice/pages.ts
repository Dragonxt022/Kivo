import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { notificationSounds } from '../../core/sound/notificationSounds';

const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, sons: notificationSounds() });
  };
}

router.get('/cozinha', page('foodservice-cozinha', 'foodservice.kitchen.view'));
router.get('/roteamento', page('foodservice-routing', 'foodservice.routing.manage'));

export default router;
