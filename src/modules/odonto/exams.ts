import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import { appointmentRepository } from './repositories/AppointmentRepository';
import { treatmentPlanRepository } from './repositories/TreatmentPlanRepository';
import {
  EXAM_PHASES, EXAM_PHASE_LABELS, EXAM_TYPES, EXAM_TYPE_LABELS, examRepository,
  type ExamDetailRow, type ExamPhase, type ExamType,
} from './repositories/ExamRepository';
import { FDI_TEETH } from './repositories/OdontogramRepository';
import { deleteExamFile, EXAM_URL_PREFIX, isImageFile, saveExamFile } from './examFiles';
import type { Result } from './permissions';

/**
 * Exames e imagens do paciente (PR §16 e §17).
 *
 * Um exame é UM arquivo com paciente, data, tipo, descrição e responsável (§16), e a fotografia
 * clínica ganha a fase antes/durante/depois (§17), que já deixa a comparação futura pronta sem
 * migração nova.
 *
 * O arquivo vive no disco e no banco fica só a referência (`examFiles.ts` explica o porquê). A
 * auditoria registra o ato — tipo, tamanho, paciente — e **nunca** o conteúdo do arquivo.
 */

export const PERM_EXAMS_VIEW = 'odonto.exams.view';
export const PERM_EXAMS_MANAGE = 'odonto.exams.manage';

export interface ExamInput {
  type?: string;
  phase?: string | null;
  exam_date?: string | null;
  tooth?: string | null;
  title?: string;
  description?: string | null;
  appointment_id?: number | null;
  plan_id?: number | null;
  professional_id?: number | null;
  /** Arquivo novo em base64 (com ou sem prefixo `data:`) — só no cadastro/troca. */
  file_base64?: string;
  file_name?: string;
  file_mime?: string;
}

export interface ExamOutput {
  id: number;
  patient_id: number;
  patient_name: string;
  type: ExamType;
  type_label: string;
  phase: ExamPhase | null;
  phase_label: string | null;
  exam_date: string;
  tooth: string | null;
  title: string;
  description: string | null;
  original_name: string;
  mime: string;
  size_bytes: number;
  is_image: boolean;
  url: string;
  professional_id: number | null;
  professional_name: string | null;
  appointment_id: number | null;
  appointment_at: string | null;
  plan_id: number | null;
  created_by_name: string | null;
  created_at: string;
}

function exame(row: ExamDetailRow): ExamOutput {
  return {
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    type: row.type,
    type_label: EXAM_TYPE_LABELS[row.type] ?? row.type,
    phase: row.phase,
    phase_label: row.phase ? EXAM_PHASE_LABELS[row.phase] : null,
    exam_date: row.exam_date,
    tooth: row.tooth,
    title: row.title,
    description: row.description,
    original_name: row.original_name,
    mime: row.mime,
    size_bytes: row.size_bytes,
    is_image: isImageFile(row.file_name),
    url: `${EXAM_URL_PREFIX}${row.file_name}`,
    professional_id: row.professional_id,
    professional_name: row.professional_name,
    appointment_id: row.appointment_id,
    appointment_at: row.appointment_at,
    plan_id: row.plan_id,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Valida o que é comum a criar e editar; devolve o patch pronto para o banco. */
function validaMetadados(patientId: number, input: ExamInput): Result<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};

  if (input.type !== undefined) {
    if (!(EXAM_TYPES as readonly string[]).includes(String(input.type))) {
      return { ok: false, error: `Tipo inválido: use ${EXAM_TYPES.join(', ')}.`, status: 400 };
    }
    patch.type = String(input.type);
  }
  if (input.phase !== undefined) {
    const fase = input.phase ? String(input.phase) : null;
    if (fase && !(EXAM_PHASES as readonly string[]).includes(fase)) {
      return { ok: false, error: `Fase inválida: use ${EXAM_PHASES.join(', ')}.`, status: 400 };
    }
    patch.phase = fase;
  }
  if (input.exam_date !== undefined) {
    const data = String(input.exam_date ?? '').slice(0, 10) || hoje();
    if (!DATA.test(data)) return { ok: false, error: 'Informe a data do exame (AAAA-MM-DD).', status: 400 };
    patch.exam_date = data;
  }
  if (input.title !== undefined) {
    const titulo = String(input.title ?? '').trim();
    if (!titulo) return { ok: false, error: 'Dê um título ao exame (ex.: Radiografia periapical 26).', status: 400 };
    patch.title = titulo.slice(0, 160);
  }
  if (input.description !== undefined) {
    patch.description = String(input.description ?? '').trim().slice(0, 1000) || null;
  }
  if (input.tooth !== undefined) {
    const dente = input.tooth ? String(input.tooth).trim() : null;
    if (dente && !(FDI_TEETH as readonly string[]).includes(dente)) {
      return { ok: false, error: 'Dente inválido: use a numeração FDI.', status: 400 };
    }
    patch.tooth = dente;
  }
  if (input.professional_id !== undefined) {
    const id = input.professional_id ? Number(input.professional_id) : null;
    if (id && !professionalRepository.findById(id)) {
      return { ok: false, error: 'Profissional não encontrado.', status: 400 };
    }
    patch.professional_id = id;
  }
  // Consulta e plano vinculados têm de ser do MESMO paciente (PR §24.2).
  if (input.appointment_id !== undefined) {
    const id = input.appointment_id ? Number(input.appointment_id) : null;
    if (id) {
      const a = appointmentRepository.findDetail(id);
      if (!a || a.patient_id !== patientId) return { ok: false, error: 'Consulta vinculada não é deste paciente.', status: 400 };
    }
    patch.appointment_id = id;
  }
  if (input.plan_id !== undefined) {
    const id = input.plan_id ? Number(input.plan_id) : null;
    if (id) {
      const plano = treatmentPlanRepository.findDetail(id);
      if (!plano || plano.patient_id !== patientId) return { ok: false, error: 'Plano vinculado não é deste paciente.', status: 400 };
    }
    patch.plan_id = id;
  }
  return { ok: true, data: patch };
}

export function listExams(
  req: Request,
  patientId: number,
  filtros: { type?: string; phase?: string; from?: string; to?: string } = {},
): Result<{
  items: ExamOutput[];
  resumo: { total: number; por_tipo: { type: ExamType; total: number }[]; ultimo_em: string | null };
  tipos: { type: ExamType; label: string }[];
  fases: { phase: ExamPhase; label: string }[];
}> {
  if (!req.user?.permissions.has(PERM_EXAMS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_EXAMS_VIEW}`, status: 403 };
  }
  if (!patientRepository.findById(patientId)) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  return {
    ok: true,
    data: {
      items: examRepository.listByPatient(patientId, filtros).map(exame),
      resumo: examRepository.resumo(patientId),
      tipos: EXAM_TYPES.map((t) => ({ type: t, label: EXAM_TYPE_LABELS[t] })),
      fases: EXAM_PHASES.map((f) => ({ phase: f, label: EXAM_PHASE_LABELS[f] })),
    },
  };
}

export function getExam(req: Request, id: number): Result<ExamOutput> {
  if (!req.user?.permissions.has(PERM_EXAMS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_EXAMS_VIEW}`, status: 403 };
  }
  const row = examRepository.findExam(id);
  if (!row) return { ok: false, error: 'Exame não encontrado.', status: 404 };
  return { ok: true, data: exame(row) };
}

export function createExam(req: Request, patientId: number, input: ExamInput): Result<ExamOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_EXAMS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_EXAMS_MANAGE}`, status: 403 };
  }
  if (!patientRepository.findById(patientId)) return { ok: false, error: 'Paciente não encontrado.', status: 404 };

  const meta = validaMetadados(patientId, input);
  if (!meta.ok) return meta;
  if (!input.type) return { ok: false, error: 'Escolha o tipo do exame.', status: 400 };
  if (!input.title || !String(input.title).trim()) {
    return { ok: false, error: 'Dê um título ao exame (ex.: Radiografia periapical 26).', status: 400 };
  }
  if (!input.file_base64) return { ok: false, error: 'Anexe o arquivo do exame.', status: 400 };

  const arquivo = saveExamFile(String(input.file_name ?? ''), input.file_base64, input.file_mime);
  if (!arquivo.ok) return { ok: false, error: arquivo.error, status: 400 };

  let id = 0;
  examRepository.transaction(() => {
    id = examRepository.createExam({
      patient_id: patientId,
      appointment_id: meta.data.appointment_id ?? null,
      plan_id: meta.data.plan_id ?? null,
      professional_id: meta.data.professional_id ?? null,
      type: input.type,
      phase: meta.data.phase ?? null,
      exam_date: (meta.data.exam_date as string) ?? hoje(),
      tooth: meta.data.tooth ?? null,
      title: String(input.title).trim().slice(0, 160),
      description: meta.data.description ?? null,
      file_name: arquivo.file,
      original_name: arquivo.name,
      mime: arquivo.mime,
      size_bytes: arquivo.size,
      created_by: req.user?.id ?? null,
    });
  });

  // Auditoria: o ato e o tamanho, nunca o conteúdo do arquivo.
  audit(req, 'criar', 'odonto_exam', id, null, {
    patient_id: patientId, type: input.type, phase: meta.data.phase ?? null,
    size_bytes: arquivo.size, mime: arquivo.mime,
  });
  return { ok: true, data: exame(examRepository.findExam(id)!) };
}

/** Edita só os metadados; troca de arquivo usa `file_base64` (o antigo sai do disco). */
export function updateExam(req: Request, id: number, input: ExamInput): Result<ExamOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_EXAMS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_EXAMS_MANAGE}`, status: 403 };
  }
  const atual = examRepository.findExam(id);
  if (!atual) return { ok: false, error: 'Exame não encontrado.', status: 404 };

  const meta = validaMetadados(atual.patient_id, input);
  if (!meta.ok) return meta;
  const patch: Record<string, unknown> = { ...meta.data };

  if (input.file_base64) {
    const arquivo = saveExamFile(String(input.file_name ?? atual.original_name), input.file_base64, input.file_mime);
    if (!arquivo.ok) return { ok: false, error: arquivo.error, status: 400 };
    patch.file_name = arquivo.file;
    patch.original_name = arquivo.name;
    patch.mime = arquivo.mime;
    patch.size_bytes = arquivo.size;
    // O arquivo anterior sai do disco só depois de gravar o novo.
    deleteExamFile(atual.file_name);
  }

  examRepository.updateExam(id, patch);
  audit(req, 'editar', 'odonto_exam', id, { type: atual.type }, {
    type: patch.type ?? atual.type,
    arquivo_trocado: !!input.file_base64,
    campos: Object.keys(patch).length,
  });
  return { ok: true, data: exame(examRepository.findExam(id)!) };
}

/**
 * Remove o exame: a linha sai por soft delete (fica o rastro de quem apagou) e o ARQUIVO é
 * apagado do disco, porque é isso que libera espaço — radiografia e tomografia pesam. Um arquivo
 * anexado por engano precisa poder sair; o registro de que existiu permanece.
 */
export function removeExam(req: Request, id: number): Result<{ removido: boolean }> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_EXAMS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_EXAMS_MANAGE}`, status: 403 };
  }
  const atual = examRepository.findExam(id);
  if (!atual) return { ok: false, error: 'Exame não encontrado.', status: 404 };

  examRepository.softDeleteExam(id);
  deleteExamFile(atual.file_name);
  audit(req, 'excluir', 'odonto_exam', id, { type: atual.type, size_bytes: atual.size_bytes }, null);
  return { ok: true, data: { removido: true } };
}

/** Excluir o paciente leva os exames: linhas em soft delete e arquivos fora do disco. */
export function removeExamsByPatient(patientId: number): void {
  for (const arquivo of examRepository.listFilesByPatient(patientId)) deleteExamFile(arquivo);
  examRepository.softDeleteByPatient(patientId);
}

export function patientExamsSummary(
  patientId: number,
): { total: number; por_tipo: { type: ExamType; total: number }[]; ultimo_em: string | null } {
  return examRepository.resumo(patientId);
}

export function countExamsByType(from: string, to: string): { type: ExamType; total: number }[] {
  return examRepository.countByType(from, to);
}

export interface OdontoExamsService {
  list(patientId: number): ExamOutput[];
  get(id: number): ExamOutput | null;
  summary(patientId: number): { total: number; por_tipo: { type: ExamType; total: number }[]; ultimo_em: string | null };
}

export const odontoExamsService: OdontoExamsService = {
  list: (patientId) => examRepository.listByPatient(patientId).map(exame),
  get: (id) => {
    const row = examRepository.findExam(id);
    return row ? exame(row) : null;
  },
  summary: (patientId) => patientExamsSummary(patientId),
};
