import { Router, type Response } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import {
  createAnamnesisTemplateSchema, createAppointmentSchema, createDocumentSchema, createPatientSchema,
  createPlanSchema, createProcedureSchema, createProfessionalSchema, appointmentStatusSchema,
  cancelDocumentSchema, chargePlanSchema, clinicalNoteSchema, documentTemplateSchema,
  issueDocumentSchema, itemStatusSchema, planStatusSchema, retifyClinicalNoteSchema,
  saveAnamnesisSchema, toothConditionSchema, toothStateSchema, undoToothStateSchema,
  updateAppointmentSchema, updateDocumentSchema, updatePatientSchema, updatePlanSchema,
  updateProcedureSchema, updateProfessionalSchema,
} from './schemas';
import { createPatient, getPatient, listPatients, removePatient, updatePatient } from './patients';
import {
  changeAppointmentStatus, createAppointment, getAppointment, listAppointments, removeAppointment,
  updateAppointment,
} from './appointments';
import { createNote, getNote, listNotes, refuseDeleteNote, retifyNote } from './clinicalNotes';
import {
  createCondition, getOdontogram, getTooth, listConditions, removeCondition, setToothState,
  undoToothState, updateCondition,
} from './odontogram';
import {
  changeItemStatus, changePlanStatus, chargePlan, createPlan, getPlan, listPlans, removePlan, updatePlan,
} from './treatmentPlans';
import {
  cancelDocument, createDocument, getDocument, issueDocument, listDocuments, newVersion,
  removeDocument, updateDocument, VARIABLES,
  // `listTemplates`/`createTemplate`... também existem na anamnese: aqui vão com alias.
  createTemplate as createDocumentTemplate,
  listTemplates as listDocumentTemplates,
  removeTemplate as removeDocumentTemplate,
  updateTemplate as updateDocumentTemplate,
} from './documents';
import { dashboard, report, reportCsv, REPORT_TYPES } from './reports';
import {
  createTemplateVersion, getForm, getPatientAnamnesis, getTemplate, listTemplates, savePatientAnamnesis,
} from './anamnesis';
import {
  createProfessional, getProfessional, listProfessionals, removeProfessional, updateProfessional,
} from './professionals';
import { createProcedure, getProcedure, listProcedures, removeProcedure, updateProcedure } from './procedures';

/**
 * API do módulo odonto (montada em /api/odonto, já autenticada pelo Core).
 *
 * Toda rota declara a permissão exigida — inclusive leitura: nada é liberado só por estar
 * logado (`app.use('/api', requireAuth)` em server.ts só exige sessão). O bloco clínico do
 * paciente tem permissão PRÓPRIA (`odonto.clinical.*`), verificada no serviço, porque ele
 * viaja no mesmo corpo do cadastro.
 */

const router = Router();

type AnyResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** Resposta padrão do módulo: 200/201 com o dado, ou o erro com o status decidido no serviço. */
function send<T>(res: Response, result: AnyResult<T>, status = 200): void {
  if (result.ok) {
    res.status(status).json(result.data);
    return;
  }
  res.status(result.status).json({ error: result.error });
}

/** Filtro de ativo aceito por lista: `?active=true|false|1|0` (ausente = todos). */
function activeParam(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  return raw !== 'false' && raw !== '0';
}

function textParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

// ─────────────────────────────── Pacientes ───────────────────────────────

router.get('/patients', requirePermission('odonto.patients.view'), (req, res) => {
  res.json(listPatients({ q: textParam(req.query.q), active: activeParam(req.query.active) }));
});

router.get('/patients/:id', requirePermission('odonto.patients.view'), (req, res) => {
  send(res, getPatient(req, Number(req.params.id)));
});

router.post('/patients', requirePermission('odonto.patients.create'), validateBody(createPatientSchema), (req, res) => {
  send(res, createPatient(req, req.body), 201);
});

router.put('/patients/:id', requirePermission('odonto.patients.edit'), validateBody(updatePatientSchema), (req, res) => {
  send(res, updatePatient(req, Number(req.params.id), req.body));
});

router.delete('/patients/:id', requirePermission('odonto.patients.delete'), (req, res) => {
  send(res, removePatient(req, Number(req.params.id)));
});

// ───────────────────────────── Profissionais ─────────────────────────────

router.get('/professionals', requirePermission('odonto.professionals.view'), (req, res) => {
  res.json(listProfessionals({ q: textParam(req.query.q), active: activeParam(req.query.active) }));
});

router.get('/professionals/:id', requirePermission('odonto.professionals.view'), (req, res) => {
  send(res, getProfessional(Number(req.params.id)));
});

router.post('/professionals', requirePermission('odonto.professionals.manage'), validateBody(createProfessionalSchema), (req, res) => {
  send(res, createProfessional(req, req.body), 201);
});

router.put('/professionals/:id', requirePermission('odonto.professionals.manage'), validateBody(updateProfessionalSchema), (req, res) => {
  send(res, updateProfessional(req, Number(req.params.id), req.body));
});

router.delete('/professionals/:id', requirePermission('odonto.professionals.manage'), (req, res) => {
  send(res, removeProfessional(req, Number(req.params.id)));
});

// ───────────────────────────── Procedimentos ─────────────────────────────

router.get('/procedures', requirePermission('odonto.procedures.view'), (req, res) => {
  res.json(listProcedures({ q: textParam(req.query.q), active: activeParam(req.query.active) }));
});

router.get('/procedures/:id', requirePermission('odonto.procedures.view'), (req, res) => {
  send(res, getProcedure(Number(req.params.id)));
});

router.post('/procedures', requirePermission('odonto.procedures.manage'), validateBody(createProcedureSchema), (req, res) => {
  send(res, createProcedure(req, req.body), 201);
});

router.put('/procedures/:id', requirePermission('odonto.procedures.manage'), validateBody(updateProcedureSchema), (req, res) => {
  send(res, updateProcedure(req, Number(req.params.id), req.body));
});

router.delete('/procedures/:id', requirePermission('odonto.procedures.manage'), (req, res) => {
  send(res, removeProcedure(req, Number(req.params.id)));
});

// ───────────────────────────── Anamnese (PR §5) ─────────────────────────────

// Formulários: publicar cria uma VERSÃO NOVA — o histórico de respostas continua válido.
router.get('/anamnesis/templates', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, listTemplates(req, { activeOnly: activeParam(req.query.active) !== false }));
});

router.post('/anamnesis/templates', requirePermission('odonto.clinical.edit'), validateBody(createAnamnesisTemplateSchema), (req, res) => {
  send(res, createTemplateVersion(req, req.body), 201);
});

router.get('/anamnesis/templates/:id', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getTemplate(req, Number(req.params.id)));
});

// Respostas do paciente: sempre por revisão (salvar de novo NÃO sobrescreve a anterior).
router.get('/patients/:id/anamnesis', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getPatientAnamnesis(req, Number(req.params.id)));
});

router.post('/patients/:id/anamnesis', requirePermission('odonto.clinical.edit'), validateBody(saveAnamnesisSchema), (req, res) => {
  send(res, savePatientAnamnesis(req, Number(req.params.id), req.body), 201);
});

router.get('/anamnesis/:id', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getForm(req, Number(req.params.id)));
});

// ───────────────────────────── Agenda (PR §6) ─────────────────────────────

// `view=dia|semana|mes` + `date=YYYY-MM-DD`: a tela pede o período e recebe o que mostrar
// (inclusive a contagem por dia, que a visão de mês usa).
router.get('/appointments', requirePermission('odonto.agenda.view'), (req, res) => {
  send(res, listAppointments(req, {
    view: req.query.view,
    date: req.query.date,
    professionalId: req.query.professional_id ? Number(req.query.professional_id) : undefined,
    status: textParam(req.query.status),
    patientId: req.query.patient_id ? Number(req.query.patient_id) : undefined,
  }));
});

router.get('/appointments/:id', requirePermission('odonto.agenda.view'), (req, res) => {
  send(res, getAppointment(Number(req.params.id)));
});

router.post('/appointments', requirePermission('odonto.agenda.manage'), validateBody(createAppointmentSchema), (req, res) => {
  send(res, createAppointment(req, req.body), 201);
});

router.put('/appointments/:id', requirePermission('odonto.agenda.manage'), validateBody(updateAppointmentSchema), (req, res) => {
  send(res, updateAppointment(req, Number(req.params.id), req.body));
});

router.post('/appointments/:id/status', requirePermission('odonto.agenda.manage'), validateBody(appointmentStatusSchema), (req, res) => {
  send(res, changeAppointmentStatus(req, Number(req.params.id), req.body.status, req.body.motivo));
});

router.delete('/appointments/:id', requirePermission('odonto.agenda.manage'), (req, res) => {
  send(res, removeAppointment(req, Number(req.params.id)));
});

// ──────────────────── Prontuário / evolução clínica (PR §7 e §8) ────────────────────

router.get('/patients/:id/notes', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, listNotes(req, Number(req.params.id), { incluirRetificadas: req.query.retificadas === '1' }));
});

router.post('/patients/:id/notes', requirePermission('odonto.clinical.edit'), validateBody(clinicalNoteSchema), (req, res) => {
  send(res, createNote(req, Number(req.params.id), req.body), 201);
});

router.get('/notes/:id', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getNote(req, Number(req.params.id)));
});

// Retificação: cria a versão seguinte e marca a anterior (nunca sobrescreve).
router.post('/notes/:id/retify', requirePermission('odonto.clinical.edit'), validateBody(retifyClinicalNoteSchema), (req, res) => {
  send(res, retifyNote(req, Number(req.params.id), req.body, req.body.motivo), 201);
});

// Não existe exclusão de registro clínico — a rota existe para explicar o caminho certo.
router.delete('/notes/:id', requirePermission('odonto.clinical.edit'), (req, res) => {
  send(res, refuseDeleteNote());
});

// ────────────────── Odontograma e situações (PR §9 e §10) ──────────────────

router.get('/tooth-conditions', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, listConditions(req, { activeOnly: activeParam(req.query.active) !== false }));
});

// A situação é catálogo, não lista fixa (PR §10): a clínica cria a sua, com cor.
router.post('/tooth-conditions', requirePermission('odonto.clinical.edit'), validateBody(toothConditionSchema), (req, res) => {
  send(res, createCondition(req, req.body), 201);
});

router.put('/tooth-conditions/:id', requirePermission('odonto.clinical.edit'), validateBody(toothConditionSchema), (req, res) => {
  send(res, updateCondition(req, Number(req.params.id), req.body));
});

router.delete('/tooth-conditions/:id', requirePermission('odonto.clinical.edit'), (req, res) => {
  send(res, removeCondition(req, Number(req.params.id)));
});

router.get('/patients/:id/odontogram', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getOdontogram(req, Number(req.params.id)));
});

router.get('/patients/:id/odontogram/:tooth', requirePermission('odonto.clinical.view'), (req, res) => {
  send(res, getTooth(req, Number(req.params.id), String(req.params.tooth)));
});

// Registrar estado = histórico append-only (nada é sobrescrito nem apagado).
router.post('/patients/:id/odontogram', requirePermission('odonto.clinical.edit'), validateBody(toothStateSchema), (req, res) => {
  send(res, setToothState(req, Number(req.params.id), req.body), 201);
});

router.post('/odontogram/:stateId/undo', requirePermission('odonto.clinical.edit'), validateBody(undoToothStateSchema), (req, res) => {
  send(res, undoToothState(req, Number(req.params.stateId), req.body.motivo));
});

// ─────────────── Plano de tratamento e cobrança (PR §11 e §12) ───────────────

router.get('/patients/:id/treatment-plans', requirePermission('odonto.plans.view'), (req, res) => {
  send(res, listPlans(req, Number(req.params.id)));
});

router.post('/patients/:id/treatment-plans', requirePermission('odonto.plans.manage'), validateBody(createPlanSchema), (req, res) => {
  send(res, createPlan(req, Number(req.params.id), req.body), 201);
});

router.get('/plans/:id', requirePermission('odonto.plans.view'), (req, res) => {
  send(res, getPlan(req, Number(req.params.id)));
});

router.put('/plans/:id', requirePermission('odonto.plans.manage'), validateBody(updatePlanSchema), (req, res) => {
  send(res, updatePlan(req, Number(req.params.id), req.body));
});

router.post('/plans/:id/status', requirePermission('odonto.plans.manage'), validateBody(planStatusSchema), (req, res) => {
  send(res, changePlanStatus(req, Number(req.params.id), req.body.status, req.body.motivo));
});

router.post('/plans/:id/items/:itemId/status', requirePermission('odonto.plans.manage'), validateBody(itemStatusSchema), (req, res) => {
  send(res, changeItemStatus(req, Number(req.params.id), Number(req.params.itemId), req.body.status));
});

router.delete('/plans/:id', requirePermission('odonto.plans.manage'), (req, res) => {
  send(res, removePlan(req, Number(req.params.id)));
});

// A cobrança NÃO mora aqui: o serviço cria contas a receber no financeiro do Kivo (PR §12).
router.post('/plans/:id/charge', requirePermission('odonto.plans.charge'), validateBody(chargePlanSchema), (req, res) => {
  send(res, chargePlan(req, Number(req.params.id), req.body), 201);
});

// ─────────────── Documentos e modelos (PR §14 e §15) ───────────────

// Lista as variáveis disponíveis (a tela mostra e insere no texto do modelo).
router.get('/document-variables', requirePermission('odonto.documents.view'), (_req, res) => {
  send(res, { ok: true, data: VARIABLES });
});

router.get('/document-templates', requirePermission('odonto.documents.view'), (req, res) => {
  send(res, listDocumentTemplates(req, { type: req.query.type ? String(req.query.type) : undefined, activeOnly: activeParam(req.query.active) !== false }));
});

router.post('/document-templates', requirePermission('odonto.documents.templates'), validateBody(documentTemplateSchema), (req, res) => {
  send(res, createDocumentTemplate(req, req.body), 201);
});

router.put('/document-templates/:id', requirePermission('odonto.documents.templates'), validateBody(documentTemplateSchema), (req, res) => {
  send(res, updateDocumentTemplate(req, Number(req.params.id), req.body));
});

router.delete('/document-templates/:id', requirePermission('odonto.documents.templates'), (req, res) => {
  send(res, removeDocumentTemplate(req, Number(req.params.id)));
});

router.get('/patients/:id/documents', requirePermission('odonto.documents.view'), (req, res) => {
  send(res, listDocuments(req, Number(req.params.id), { type: req.query.type ? String(req.query.type) : undefined }));
});

router.post('/patients/:id/documents', requirePermission('odonto.documents.manage'), validateBody(createDocumentSchema), (req, res) => {
  send(res, createDocument(req, Number(req.params.id), req.body), 201);
});

router.get('/documents/:id', requirePermission('odonto.documents.view'), (req, res) => {
  send(res, getDocument(req, Number(req.params.id)));
});

router.put('/documents/:id', requirePermission('odonto.documents.manage'), validateBody(updateDocumentSchema), (req, res) => {
  send(res, updateDocument(req, Number(req.params.id), req.body));
});

router.post('/documents/:id/issue', requirePermission('odonto.documents.manage'), validateBody(issueDocumentSchema), (req, res) => {
  send(res, issueDocument(req, Number(req.params.id), req.body.professional_id));
});

router.post('/documents/:id/cancel', requirePermission('odonto.documents.manage'), validateBody(cancelDocumentSchema), (req, res) => {
  send(res, cancelDocument(req, Number(req.params.id), req.body.motivo));
});

// Emitido não muda: a correção é a versão seguinte, ligada à anterior.
router.post('/documents/:id/new-version', requirePermission('odonto.documents.manage'), (req, res) => {
  send(res, newVersion(req, Number(req.params.id)), 201);
});

router.delete('/documents/:id', requirePermission('odonto.documents.manage'), (req, res) => {
  send(res, removeDocument(req, Number(req.params.id)));
});

// ─────────────── Painel e relatórios (fase 9, PR §21) ───────────────

router.get('/dashboard', requirePermission('odonto.reports.view'), (req, res) => {
  send(res, dashboard(req));
});

router.get('/reports', requirePermission('odonto.reports.view'), (_req, res) => {
  send(res, { ok: true, data: REPORT_TYPES });
});

router.get('/reports/:tipo', requirePermission('odonto.reports.view'), (req, res) => {
  send(res, report(req, String(req.params.tipo), req.query.from, req.query.to));
});

// CSV: o "exportar" do Kivo (mesmo caminho do resto do sistema).
router.get('/reports/:tipo/csv', requirePermission('odonto.reports.view'), (req, res) => {
  const resultado = report(req, String(req.params.tipo), req.query.from, req.query.to);
  if (!resultado.ok) {
    res.status(resultado.status).json({ success: false, error: resultado.error });
    return;
  }
  const nome = `odonto-${resultado.data.type}-${resultado.data.from}-a-${resultado.data.to}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  // BOM: o Excel no Windows abre o CSV com acento correto só com ele.
  res.send('\uFEFF' + reportCsv(resultado.data));
});

export default router;
