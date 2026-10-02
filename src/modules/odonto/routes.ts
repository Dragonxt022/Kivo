import { Router, type Response } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import {
  createAnamnesisTemplateSchema, createPatientSchema, createProcedureSchema, createProfessionalSchema,
  saveAnamnesisSchema, updatePatientSchema, updateProcedureSchema, updateProfessionalSchema,
} from './schemas';
import { createPatient, getPatient, listPatients, removePatient, updatePatient } from './patients';
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

export default router;
