import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { canEditClinical, canViewClinical } from './permissions';
import { canRetify } from './clinicalNotes';

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
    canRetify: canRetify(req),
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

/** Como `page`, mas para telas de paciente: injeta o `patientId` da rota. */
function page2(view: string, permission: string, extra: { patientId?: boolean } = {}) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, locals(req, extra.patientId ? { patientId: Number(req.params.id) } : {}));
  };
}

router.get('/agenda', page('odonto-agenda', 'odonto.agenda.view'));

router.get('/pacientes', page('odonto-patients', 'odonto.patients.view'));

router.get('/pacientes/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('odonto.patients.view')) return res.redirect('/');
  res.render('odonto-patient-ficha', locals(req, { patientId: Number(req.params.id) }));
});

// Prontuário: a evolução clínica do paciente (dado de saúde — exige permissão clínica).
router.get('/pacientes/:id/prontuario', (req, res) => {
  assertAuth(req);
  if (!canViewClinical(req)) return res.redirect('/');
  res.render('odonto-prontuario', locals(req, { patientId: Number(req.params.id) }));
});

// Odontograma: o mapa dos dentes (também dado de saúde).
router.get('/pacientes/:id/odontograma', (req, res) => {
  assertAuth(req);
  if (!canViewClinical(req)) return res.redirect('/');
  res.render('odonto-odontograma', locals(req, { patientId: Number(req.params.id) }));
});

// Planos de tratamento: a Recepção cobra, então a página não exige permissão clínica — o gate
// é `odonto.plans.view` (o plano mostra procedimentos e valores, não o texto clínico).
router.get('/pacientes/:id/planos', page2('odonto-planos', 'odonto.plans.view', { patientId: true }));

router.get('/profissionais', page('odonto-professionals', 'odonto.professionals.view'));
router.get('/procedimentos', page('odonto-procedures', 'odonto.procedures.view'));

// Anamnese: a do paciente e os formulários. Ambos são dado clínico — a página exige a
// permissão de visão clínica e a API confere de novo (nada é liberado só por estar logado).
router.get('/pacientes/:id/anamnese', (req, res) => {
  assertAuth(req);
  if (!canViewClinical(req)) return res.redirect('/');
  res.render('odonto-anamnesis', locals(req, { patientId: Number(req.params.id) }));
});

router.get('/anamnese-modelos', page('odonto-anamnesis-templates', 'odonto.clinical.view'));

export default router;
