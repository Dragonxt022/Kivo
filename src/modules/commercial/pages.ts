import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';

/** Páginas do módulo commercial (montadas em /app/commercial, já autenticadas). */
const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/clientes', page('commercial-customers', 'commercial.customers.view'));
router.get('/clientes/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-ficha', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/clientes/:id/compras', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-purchases', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/clientes/:id/financeiro', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-receivables', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/fornecedores', page('commercial-suppliers', 'commercial.suppliers.view'));
router.get('/produtos', page('commercial-products', 'commercial.products.view'));
router.get('/categorias', page('commercial-categories', 'commercial.products.view'));
router.get('/listas-de-preco', page('commercial-price-lists', 'commercial.pricelists.view'));
router.get('/compras', page('commercial-purchases', 'commercial.purchases.view'));

export default router;
