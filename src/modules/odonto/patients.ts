import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { getService, hasService } from '../../core/services/registry';
import { assertAuth } from '../../shared/auth';
import { validateDocument } from '../../shared/documents';
import type { CommercialCustomersService } from '../commercial/setup';
import type { CustomerPatch } from '../commercial/customers';
import { canEditClinical, canViewClinical, type Result } from './permissions';
import { removeAnamnesisByPatient } from './anamnesis';
import { removeNotesByPatient } from './clinicalNotes';
import { removeOdontogramByPatient } from './odontogram';
import { removePlansByPatient } from './treatmentPlans';
import { removeDocumentsByPatient } from './documents';
import { removeExamsByPatient } from './exams';
import {
  patientRepository,
  type PatientClinicalInput,
  type PatientClinicalRow,
  type PatientListRow,
  type PatientRow,
} from './repositories/PatientRepository';

/**
 * Regras do paciente do consultório (PR §4).
 *
 * Um paciente é SEMPRE um cliente (`customers`) + uma ficha odontológica:
 *  - `customers` guarda nome, CPF/CNPJ, contato e nascimento — é para lá que
 *    `receivables.customer_id` aponta (cobrança do tratamento, convênio, lista de preço);
 *  - `odonto_patients` guarda o que é do atendimento (sexo, RG, foto, observações);
 *  - `odonto_patient_clinical` guarda o dado de saúde, atrás de permissão própria.
 *
 * Excluir um paciente NÃO exclui o cliente: histórico de venda e financeiro continuam
 * íntegros (PR §24.3 — nada de exclusão silenciosa de registro clínico).
 */

export const PERM_CLINICAL_VIEW = 'odonto.clinical.view';
export const PERM_CLINICAL_EDIT = 'odonto.clinical.edit';

/** Permissões e tipo de resultado vivem em `permissions.ts` (evita ciclo com a anamnese). */
export { canViewClinical, canEditClinical } from './permissions';
export type { Result } from './permissions';

export interface PatientInput {
  /** Dados do cliente (`customers`). */
  name?: string;
  document?: string | null;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  address?: string | null;
  cep?: string | null;
  /** Dados do paciente (`odonto_patients`). */
  sex?: string | null;
  rg?: string | null;
  photo_file?: string | null;
  notes?: string | null;
  active?: boolean | number;
  /** Bloco clínico — só gravado com `odonto.clinical.edit`. */
  clinical?: PatientClinicalInput;
}

export interface PatientClinicalOutput extends PatientClinicalInput {
  updated_by: number | null;
  updated_at: string;
}

export interface PatientDetail extends PatientListRow {
  /** Ausente quando o usuário não tem `odonto.clinical.view` (dado de saúde não trafega). */
  clinical?: PatientClinicalOutput | null;
}

function customersService(): CommercialCustomersService {
  if (!hasService('commercial.customers')) {
    throw new Error('odonto: serviço commercial.customers indisponível (módulo commercial fora do plano?).');
  }
  return getService<CommercialCustomersService>('commercial.customers');
}

/** Monta o patch cadastral do cliente com apenas as chaves informadas na requisição. */
function customerPatch(input: PatientInput): CustomerPatch {
  const patch: CustomerPatch = {};
  if (input.document !== undefined) patch.document = input.document;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.email !== undefined) patch.email = input.email;
  if (input.birthday !== undefined) patch.birthday = input.birthday;
  if (input.address !== undefined) patch.address = input.address;
  if (input.cep !== undefined) patch.cep = input.cep;
  if (input.name !== undefined) patch.name = String(input.name).trim();
  return patch;
}

function activeFlag(value: boolean | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value ? 1 : 0;
}

function clinicalOutput(row: PatientClinicalRow | undefined): PatientClinicalOutput | null {
  if (!row) return null;
  return {
    medical_history: row.medical_history,
    dental_history: row.dental_history,
    allergies: row.allergies,
    medications: row.medications,
    conditions: row.conditions,
    clinical_notes: row.clinical_notes,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

function hasClinicalBlock(input: PatientInput): boolean {
  return !!input.clinical && Object.keys(input.clinical).length > 0;
}

export function listPatients(opts: { q?: string; active?: boolean } = {}): PatientListRow[] {
  return patientRepository.list(opts);
}

export function getPatient(req: Request, id: number): Result<PatientDetail> {
  const patient = patientRepository.findDetail(id);
  if (!patient) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  const detail: PatientDetail = { ...patient };
  // Sem a permissão clínica a chave nem aparece na resposta (não é "null": é ausente).
  if (canViewClinical(req)) detail.clinical = clinicalOutput(patientRepository.getClinical(id));
  return { ok: true, data: detail };
}

export function createPatient(req: Request, input: PatientInput): Result<{ id: number }> {
  assertAuth(req);
  const user = req.user;
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, error: 'Campo obrigatório: name', status: 400 };
  if (input.document && !validateDocument(String(input.document))) {
    return { ok: false, error: 'CPF/CNPJ inválido.', status: 400 };
  }

  const service = customersService();
  if (input.document) {
    const dupe = service.findByDocument(input.document);
    if (dupe) {
      return { ok: false, error: `Já existe um cadastro com este CPF/CNPJ: ${dupe.name}.`, status: 409 };
    }
  }

  const wantsClinical = hasClinicalBlock(input);
  if (wantsClinical && !canEditClinical(req)) {
    return { ok: false, error: `Permissão negada: ${PERM_CLINICAL_EDIT}`, status: 403 };
  }

  let id = 0;
  patientRepository.transaction(() => {
    const customerId = service.create({ ...customerPatch(input), name });
    id = patientRepository.create({
      customer_id: customerId,
      sex: input.sex ?? null,
      rg: input.rg ?? null,
      photo_file: input.photo_file ?? null,
      notes: input.notes ?? null,
      active: activeFlag(input.active) ?? 1,
      uuid: randomUUID(),
    });
    if (wantsClinical) patientRepository.upsertClinical(id, input.clinical as PatientClinicalInput, user.id);
  });

  // A auditoria registra QUEM criou e o que mudou, sem copiar o conteúdo clínico para o log
  // (minimização de dado sensível — ver doc/KIVO_ODONTO_ARCHITECTURE_AUDIT.md §6 e §19).
  audit(req, 'criar', 'odonto_patient', id, null, {
    name,
    document: input.document ?? null,
    ficha_clinica_criada: wantsClinical,
  });
  return { ok: true, data: { id } };
}

export function updatePatient(req: Request, id: number, input: PatientInput): Result<PatientDetail> {
  assertAuth(req);
  const user = req.user;
  const patient = patientRepository.findById(id);
  if (!patient) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  const before = patientRepository.findDetail(id);

  if (input.name !== undefined && !String(input.name).trim()) {
    return { ok: false, error: 'Campo obrigatório: name', status: 400 };
  }
  if (input.document && !validateDocument(String(input.document))) {
    return { ok: false, error: 'CPF/CNPJ inválido.', status: 400 };
  }

  const service = customersService();
  if (input.document) {
    const dupe = service.findByDocument(input.document);
    if (dupe && dupe.id !== patient.customer_id) {
      return { ok: false, error: `Já existe um cadastro com este CPF/CNPJ: ${dupe.name}.`, status: 409 };
    }
  }

  const wantsClinical = hasClinicalBlock(input);
  if (wantsClinical && !canEditClinical(req)) {
    return { ok: false, error: `Permissão negada: ${PERM_CLINICAL_EDIT}`, status: 403 };
  }

  const patientData: Record<string, unknown> = {};
  if (input.sex !== undefined) patientData.sex = input.sex;
  if (input.rg !== undefined) patientData.rg = input.rg;
  if (input.photo_file !== undefined) patientData.photo_file = input.photo_file;
  if (input.notes !== undefined) patientData.notes = input.notes;
  const active = activeFlag(input.active);
  if (active !== undefined) patientData.active = active;

  patientRepository.transaction(() => {
    const patch = customerPatch(input);
    if (Object.keys(patch).length) service.update(patient.customer_id, patch);
    if (Object.keys(patientData).length) patientRepository.update(id, patientData);
    if (wantsClinical) patientRepository.upsertClinical(id, input.clinical as PatientClinicalInput, user.id);
  });

  const result = getPatient(req, id);
  audit(req, 'editar', 'odonto_patient', id, before, {
    ...(result.ok ? result.data : {}),
    // Nunca o conteúdo clínico: só o sinal de que a ficha foi tocada nesta edição.
    ficha_clinica_atualizada: wantsClinical,
  });
  return result;
}

/** Exclui a FICHA do paciente; o cliente (`customers`) permanece com venda e financeiro. */
export function removePatient(req: Request, id: number): Result<{ ok: true }> {
  assertAuth(req);
  const before = patientRepository.findDetail(id);
  if (!before) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  patientRepository.transaction(() => {
    patientRepository.softDeleteClinical(id);
    // A anamnese é histórico clínico do paciente: sai junto (soft delete), nunca fica órfã.
    removeAnamnesisByPatient(id);
    removeNotesByPatient(id);
    removeOdontogramByPatient(id);
    removePlansByPatient(id);
    removeDocumentsByPatient(id);
    removeExamsByPatient(id);
    patientRepository.softDelete(id);
  });
  audit(req, 'excluir', 'odonto_patient', id, before, null);
  return { ok: true, data: { ok: true } };
}

/** Contrato exposto a outros módulos (a agenda vai precisar escolher o paciente). */
export interface OdontoPatientsService {
  findById(id: number): PatientRow | undefined;
  findByCustomer(customerId: number): PatientRow | undefined;
  listActive(): PatientListRow[];
}

export const odontoPatientsService: OdontoPatientsService = {
  findById: (id) => patientRepository.findById(id),
  findByCustomer: (customerId) => patientRepository.findByCustomer(customerId),
  listActive: () => patientRepository.list({ active: true }),
};
