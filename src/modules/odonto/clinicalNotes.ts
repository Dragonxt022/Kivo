import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import { procedureRepository } from './repositories/ProcedureRepository';
import { appointmentRepository } from './repositories/AppointmentRepository';
import {
  clinicalNoteRepository,
  type ClinicalNoteDetailRow,
  type ClinicalNoteProcedure,
} from './repositories/ClinicalNoteRepository';
import { canEditClinical, canViewClinical, type Result } from './permissions';

/**
 * Prontuário: evolução clínica com retificação versionada (PR §7 e §8).
 *
 * A PR §8 manda decidir a correção ANTES de criar as tabelas, e a decisão está no cabeçalho
 * da migration 0081: **registro vigente é imutável**. Corrigir não altera a linha — cria a
 * versão seguinte ligada à anterior, com motivo obrigatório, e marca a anterior como
 * retificada. Nada de apagar: a API não tem exclusão de registro clínico (responde 400
 * explicando o caminho certo), e o `soft delete` só existe para quando o paciente inteiro é
 * excluído.
 *
 * Duas regras de confiança que valem a pena registrar (PR §24.2):
 *  - o NOME do procedimento vem do catálogo, nunca do corpo da requisição;
 *  - o agendamento vinculado tem de ser do MESMO paciente.
 */

export const PERM_RETIFY = 'odonto.clinical.retify';

const MIN_MOTIVO = 5;

export interface NoteProcedureInput {
  procedure_id?: number | null;
  tooth?: string | null;
  note?: string | null;
}

export interface ClinicalNoteInput {
  professional_id?: number | null;
  appointment_id?: number | null;
  /** 'YYYY-MM-DD HH:MM' do ATENDIMENTO. Em branco usa agora. */
  happened_at?: string | null;
  title?: string | null;
  procedures?: NoteProcedureInput[];
  observations?: string | null;
  diagnosis?: string | null;
  conduct?: string | null;
  next_steps?: string | null;
  documents?: number[];
  exams?: number[];
}

export interface ClinicalNoteOutput {
  id: number;
  patient_id: number;
  patient_name: string;
  professional_id: number | null;
  professional_name: string | null;
  professional_cro: string | null;
  appointment_id: number | null;
  happened_at: string;
  title: string | null;
  procedures: ClinicalNoteProcedure[];
  observations: string | null;
  diagnosis: string | null;
  conduct: string | null;
  next_steps: string | null;
  documents: number[];
  exams: number[];
  status: 'vigente' | 'retificado';
  version: number;
  replaced_by_id: number | null;
  replaced_by_name: string | null;
  retifica_id: number | null;
  retification_reason: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

export function canRetify(req: Request): boolean {
  return !!req.user?.permissions.has(PERM_RETIFY);
}

function jsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function saida(row: ClinicalNoteDetailRow): ClinicalNoteOutput {
  return {
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    professional_id: row.professional_id,
    professional_name: row.professional_name_snapshot,
    professional_cro: row.professional_cro_snapshot,
    appointment_id: row.appointment_id,
    happened_at: row.happened_at,
    title: row.title,
    procedures: jsonArray<ClinicalNoteProcedure>(row.procedures_json),
    observations: row.observations,
    diagnosis: row.diagnosis,
    conduct: row.conduct,
    next_steps: row.next_steps,
    documents: jsonArray<number>(row.documents_json),
    exams: jsonArray<number>(row.exams_json),
    status: row.status,
    version: Number(row.version),
    replaced_by_id: row.replaced_by_id,
    replaced_by_name: row.replaced_by_name,
    retifica_id: row.retifica_id,
    retification_reason: row.retification_reason,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

const DATA_HORA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

function texto(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function idsNumericos(v: unknown): number[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const ids = v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length === v.length ? [...new Set(ids)] : null;
}

/**
 * Resolve os procedimentos contra o CATÁLOGO (nome vem do banco, não do corpo da requisição)
 * e recusa id inexistente — evolução que aponta para procedimento fantasma não serve de
 * histórico.
 */
function resolverProcedimentos(v: unknown): Result<ClinicalNoteProcedure[]> {
  if (v === undefined || v === null) return { ok: true, data: [] };
  if (!Array.isArray(v)) return { ok: false, error: 'Procedimentos em formato inválido.', status: 400 };
  if (v.length > 40) return { ok: false, error: 'Muitos procedimentos em um registro.', status: 400 };

  const saida: ClinicalNoteProcedure[] = [];
  for (const item of v as NoteProcedureInput[]) {
    const id = item?.procedure_id ? Number(item.procedure_id) : null;
    let nome = '';
    if (id) {
      const procedimento = procedureRepository.findById(id);
      if (!procedimento) return { ok: false, error: `Procedimento ${id} não existe no catálogo.`, status: 400 };
      nome = procedimento.name;
    }
    if (!nome) return { ok: false, error: 'Informe o procedimento realizado.', status: 400 };
    saida.push({
      procedure_id: id,
      name: nome,
      tooth: texto(item?.tooth, 8),
      note: texto(item?.note, 300),
    });
  }
  return { ok: true, data: saida };
}

/** Valida o conteúdo comum a criação e retificação e devolve as colunas prontas. */
function prepararConteudo(input: ClinicalNoteInput, patientId: number): Result<Record<string, unknown>> {
  const procs = resolverProcedimentos(input.procedures);
  if (!procs.ok) return procs;

  const observacoes = texto(input.observations, 8000);
  const diagnostico = texto(input.diagnosis, 2000);
  const conduta = texto(input.conduct, 4000);
  const proximos = texto(input.next_steps, 2000);
  if (!procs.data.length && !observacoes && !diagnostico && !conduta && !proximos) {
    return {
      ok: false,
      status: 400,
      error: 'Registre o que foi feito: procedimentos realizados, observações, diagnóstico, conduta ou próximos passos.',
    };
  }

  const documentos = idsNumericos(input.documents);
  const exames = idsNumericos(input.exams);
  if (documentos === null) return { ok: false, error: 'Documentos em formato inválido.', status: 400 };
  if (exames === null) return { ok: false, error: 'Exames em formato inválido.', status: 400 };

  const aconteceuEm = input.happened_at ? String(input.happened_at).slice(0, 16).trim() : nowStamp();
  if (!DATA_HORA.test(aconteceuEm)) {
    return { ok: false, error: 'Informe data e hora do atendimento (AAAA-MM-DD HH:MM).', status: 400 };
  }

  let appointmentId: number | null = null;
  if (input.appointment_id) {
    appointmentId = Number(input.appointment_id);
    const agendamento = appointmentRepository.findDetail(appointmentId);
    if (!agendamento) return { ok: false, error: 'Agendamento não encontrado.', status: 400 };
    // Não confiar no corpo: a consulta vinculada tem de ser DESTE paciente.
    if (agendamento.patient_id !== patientId) {
      return { ok: false, error: 'O agendamento informado é de outro paciente.', status: 400 };
    }
  }

  return {
    ok: true,
    data: {
      happened_at: aconteceuEm,
      title: texto(input.title, 120),
      procedures_json: JSON.stringify(procs.data),
      observations: observacoes,
      diagnosis: diagnostico,
      conduct: conduta,
      next_steps: proximos,
      documents_json: JSON.stringify(documentos),
      exams_json: JSON.stringify(exames),
      appointment_id: appointmentId,
    },
  };
}

/** Snapshot do profissional que assina: nome e CRO do MOMENTO do atendimento. */
function assinatura(professionalId: number | null): { id: number | null; nome: string | null; cro: string | null } {
  if (!professionalId) return { id: null, nome: null, cro: null };
  const p = professionalRepository.findById(professionalId);
  if (!p) return { id: null, nome: null, cro: null };
  const cro = p.cro ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : null;
  return { id: p.id, nome: p.name, cro };
}

// ─────────────────────────────── Consultas ───────────────────────────────

export function listNotes(req: Request, patientId: number, opts: { incluirRetificadas?: boolean } = {}):
Result<{ items: ClinicalNoteOutput[]; resumo: { vigentes: number; retificadas: number; ultima: string | null } }> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const rows = clinicalNoteRepository.listByPatient(patientId, { somenteVigentes: !opts.incluirRetificadas });
  return { ok: true, data: { items: rows.map(saida), resumo: clinicalNoteRepository.resumo(patientId) } };
}

export function getNote(req: Request, id: number): Result<{ note: ClinicalNoteOutput; history: ClinicalNoteOutput[] }> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  const row = clinicalNoteRepository.findDetail(id);
  if (!row) return { ok: false, error: 'Registro de evolução não encontrado.', status: 404 };
  return { ok: true, data: { note: saida(row), history: clinicalNoteRepository.chain(id).map(saida) } };
}

// ─────────────────────────────── Criar ───────────────────────────────

export function createNote(req: Request, patientId: number, input: ClinicalNoteInput): Result<ClinicalNoteOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const conteudo = prepararConteudo(input, patientId);
  if (!conteudo.ok) return conteudo;

  const profissionalId = input.professional_id ? Number(input.professional_id) : null;
  const assina = assinatura(profissionalId);
  if (profissionalId && !assina.id) {
    return { ok: false, error: 'Profissional não encontrado.', status: 400 };
  }

  let id = 0;
  clinicalNoteRepository.transaction(() => {
    id = clinicalNoteRepository.create({
      patient_id: patientId,
      professional_id: assina.id,
      ...conteudo.data,
      status: 'vigente',
      version: 1,
      professional_name_snapshot: assina.nome,
      professional_cro_snapshot: assina.cro,
      created_by: req.user?.id ?? null,
    });
  });

  // Auditoria sem conteúdo clínico: quem registrou, para quem, quando e quantos itens.
  const row = clinicalNoteRepository.findDetail(id)!;
  audit(req, 'criar', 'odonto_clinical_note', id, null, {
    patient_id: patientId,
    professional_id: assina.id,
    appointment_id: row.appointment_id,
    happened_at: row.happened_at,
    procedimentos: jsonArray<ClinicalNoteProcedure>(row.procedures_json).length,
    versao: 1,
  });
  return { ok: true, data: saida(row) };
}

// ────────────────────────────── Retificação ──────────────────────────────

/**
 * Corrige um registro clínico: cria a versão seguinte ligada à anterior e marca a anterior
 * como retificada. O motivo é obrigatório — retificação sem justificativa não é histórico.
 */
export function retifyNote(req: Request, id: number, input: ClinicalNoteInput, motivo: unknown): Result<ClinicalNoteOutput> {
  assertAuth(req);
  if (!canRetify(req)) {
    return { ok: false, error: `Permissão negada: ${PERM_RETIFY}`, status: 403 };
  }
  const atual = clinicalNoteRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Registro de evolução não encontrado.', status: 404 };
  if (atual.status !== 'vigente') {
    return {
      ok: false,
      status: 400,
      error: atual.replaced_by_id
        ? `Este registro já foi retificado (versão ${atual.version}). Retifique a versão vigente.`
        : 'Este registro não está vigente.',
    };
  }

  const razao = texto(motivo, 500);
  if (!razao || razao.length < MIN_MOTIVO) {
    return { ok: false, error: `Explique o motivo da retificação (mínimo ${MIN_MOTIVO} caracteres).`, status: 400 };
  }

  // O conteúdo corrigido pode vir completo (a tela manda o registro editado); o que não vier
  // continua igual ao anterior — retificar é corrigir, não reescrever do zero.
  const base: ClinicalNoteInput = {
    professional_id: input.professional_id !== undefined ? input.professional_id : atual.professional_id,
    appointment_id: input.appointment_id !== undefined ? input.appointment_id : atual.appointment_id,
    happened_at: input.happened_at !== undefined ? input.happened_at : atual.happened_at,
    title: input.title !== undefined ? input.title : atual.title,
    procedures: input.procedures !== undefined ? input.procedures : jsonArray<ClinicalNoteProcedure>(atual.procedures_json),
    observations: input.observations !== undefined ? input.observations : atual.observations,
    diagnosis: input.diagnosis !== undefined ? input.diagnosis : atual.diagnosis,
    conduct: input.conduct !== undefined ? input.conduct : atual.conduct,
    next_steps: input.next_steps !== undefined ? input.next_steps : atual.next_steps,
    documents: input.documents !== undefined ? input.documents : jsonArray<number>(atual.documents_json),
    exams: input.exams !== undefined ? input.exams : jsonArray<number>(atual.exams_json),
  };
  const conteudo = prepararConteudo(base, atual.patient_id);
  if (!conteudo.ok) return conteudo;

  const assina = assinatura(base.professional_id ? Number(base.professional_id) : null);
  if (base.professional_id && !assina.id) {
    return { ok: false, error: 'Profissional não encontrado.', status: 400 };
  }

  let novoId = 0;
  clinicalNoteRepository.transaction(() => {
    novoId = clinicalNoteRepository.create({
      patient_id: atual.patient_id,
      professional_id: assina.id,
      ...conteudo.data,
      status: 'vigente',
      version: Number(atual.version) + 1,
      retifica_id: atual.id,
      retification_reason: razao,
      professional_name_snapshot: assina.nome,
      professional_cro_snapshot: assina.cro,
      created_by: req.user?.id ?? null,
    });
    clinicalNoteRepository.marcarRetificado(atual.id, novoId);
  });

  const row = clinicalNoteRepository.findDetail(novoId)!;
  audit(req, 'editar', 'odonto_clinical_note', novoId, { versao: atual.version, status: 'vigente', id_anterior: atual.id }, {
    versao: row.version,
    id_anterior: atual.id,
    motivo: razao,
    patient_id: atual.patient_id,
  });
  return { ok: true, data: saida(row) };
}

/**
 * Exclusão de registro clínico NÃO existe (PR §8): o serviço existe para a rota poder
 * responder com o motivo, em vez de dar 404 e deixar a dúvida.
 */
export function refuseDeleteNote(): Result<never> {
  return {
    ok: false,
    status: 400,
    error: 'Registro clínico não é apagado (PR §8). Para corrigir, use a retificação: o registro original fica no histórico com o motivo da correção.',
  };
}

/** Resumo do prontuário para a ficha e para a página do prontuário. */
export function patientNotesSummary(patientId: number): { vigentes: number; retificadas: number; ultima: string | null } {
  return clinicalNoteRepository.resumo(patientId);
}

/** Excluir o paciente leva o prontuário junto (o chamador já garante a transação). */
export function removeNotesByPatient(patientId: number): void {
  clinicalNoteRepository.softDeleteByPatient(patientId);
}

/**
 * Contrato exposto a outros módulos: o odontograma (fase 5) e os documentos (fase 7) vão
 * querer a evolução do paciente por aqui.
 */
export interface OdontoRecordsService {
  list(patientId: number): ClinicalNoteOutput[];
  summary(patientId: number): { vigentes: number; retificadas: number; ultima: string | null };
}

export const odontoRecordsService: OdontoRecordsService = {
  list: (patientId) => clinicalNoteRepository.listByPatient(patientId, { somenteVigentes: true }).map(saida),
  summary: (patientId) => clinicalNoteRepository.resumo(patientId),
};
