import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { canEditClinical, canViewClinical } from './patients';

/**
 * Páginas do módulo odonto (montadas em /app/odonto, já autenticadas pelo Core).
 *
 * O gate de permissão é feito aqui: `/app/<id>` só garante que existe sessão
 * (`app.use('/app', requireAuth)` em server.ts). As flags clínicas vão para a view porque a
 * tela precisa esconder o bloco de saúde de quem não pode vê-lo — o dado em si nunca sai da
 * API sem a permissão correspondente.
 */

const router = Router();

function locals(req: Request, extra: Record<string, unknown> = {}) {
  return {
    user: req.user,
    canViewClinical: canViewClinical(req),
    canEditClinical: canEditClinical(req),
    ...extra,
  };
}

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, locals(req));
  };
}

router.get('/pacientes', page('odonto-patients', 'odonto.patients.view'));

router.get('/pacientes/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('odonto.patients.view')) return res.redirect('/');
  res.render('odonto-patient-ficha', locals(req, { patientId: Number(req.params.id) }));
});

router.get('/profissionais', page('odonto-professionals', 'odonto.professionals.view'));
router.get('/procedimentos', page('odonto-procedures', 'odonto.procedures.view'));

export default router;
