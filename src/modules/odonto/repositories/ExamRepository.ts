import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/** Tipos de exame (PR §16). */
export const EXAM_TYPES = ['radiografia', 'tomografia', 'fotografia', 'documento', 'outro'] as const;
export type ExamType = (typeof EXAM_TYPES)[number];
export const EXAM_TYPE_LABELS: Record<ExamType, string> = {
  radiografia: 'Radiografia',
  tomografia: 'Tomografia',
  fotografia: 'Fotografia clínica',
  documento: 'Documento',
  outro: 'Outro',
};

/** Fase da fotografia clínica (PR §17: antes, durante, depois). */
export const EXAM_PHASES = ['antes', 'durante', 'depois'] as const;
export type ExamPhase = (typeof EXAM_PHASES)[number];
export const EXAM_PHASE_LABELS: Record<ExamPhase, string> = {
  antes: 'Antes',
  durante: 'Durante',
  depois: 'Depois',
};

export interface ExamRow extends Row {
  id: number;
  patient_id: number;
  appointment_id: number | null;
  plan_id: number | null;
  professional_id: number | null;
  type: ExamType;
  phase: ExamPhase | null;
  exam_date: string;
  tooth: string | null;
  title: string;
  description: string | null;
  file_name: string;
  original_name: string;
  mime: string;
  size_bytes: number;
  created_by: number | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

export interface ExamDetailRow extends ExamRow {
  patient_name: string;
  professional_name: string | null;
  created_by_name: string | null;
  appointment_at: string | null;
}

const EXAME_SELECT = `
  SELECT e.*, c.name AS patient_name, p.name AS professional_name, u.username AS created_by_name,
         a.starts_at AS appointment_at
    FROM odonto_exams e
    JOIN odonto_patients pa ON pa.id = e.patient_id
    JOIN customers c ON c.id = pa.customer_id
    LEFT JOIN odonto_professionals p ON p.id = e.professional_id
    LEFT JOIN users u ON u.id = e.created_by
    LEFT JOIN odonto_appointments a ON a.id = e.appointment_id`;

class ExamRepository extends BaseRepository<ExamRow> {
  constructor() {
    super('odonto_exams');
  }

  listByPatient(patientId: number, opts: { type?: string; phase?: string; from?: string; to?: string } = {}): ExamDetailRow[] {
    const filtros = ['e.patient_id = ?', 'e.deleted_at IS NULL'];
    const params: unknown[] = [patientId];
    if (opts.type) { filtros.push('e.type = ?'); params.push(opts.type); }
    if (opts.phase) { filtros.push('e.phase = ?'); params.push(opts.phase); }
    if (opts.from) { filtros.push('date(e.exam_date) >= ?'); params.push(opts.from); }
    if (opts.to) { filtros.push('date(e.exam_date) <= ?'); params.push(opts.to); }
    return this.raw(
      `${EXAME_SELECT} WHERE ${filtros.join(' AND ')}
        ORDER BY e.exam_date DESC, e.id DESC`,
      ...(params as never[]),
    ) as unknown as ExamDetailRow[];
  }

  findExam(id: number): ExamDetailRow | undefined {
    return this.rawOne(`${EXAME_SELECT} WHERE e.id = ? AND e.deleted_at IS NULL`, id) as unknown as ExamDetailRow | undefined;
  }

  createExam(data: Record<string, unknown>): number {
    const campos = [
      'patient_id', 'appointment_id', 'plan_id', 'professional_id', 'type', 'phase', 'exam_date',
      'tooth', 'title', 'description', 'file_name', 'original_name', 'mime', 'size_bytes', 'created_by',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_exams (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  updateExam(id: number, patch: Record<string, unknown>): void {
    const campos = [
      'appointment_id', 'plan_id', 'professional_id', 'type', 'phase', 'exam_date', 'tooth',
      'title', 'description', 'file_name', 'original_name', 'mime', 'size_bytes',
    ].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_exams SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  softDeleteExam(id: number): void {
    this.rawRun(
      `UPDATE odonto_exams SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  /** Excluir o paciente leva os exames junto (as linhas; os arquivos são removidos pelo serviço). */
  listFilesByPatient(patientId: number): string[] {
    return (this.raw(
      'SELECT file_name FROM odonto_exams WHERE patient_id = ? AND deleted_at IS NULL',
      patientId,
    ) as unknown as { file_name: string }[]).map((r) => r.file_name);
  }

  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_exams SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }

  /** Resumo do paciente: quantos exames por tipo (ficha e painel; sem conteúdo clínico). */
  resumo(patientId: number): { total: number; por_tipo: { type: ExamType; total: number }[]; ultimo_em: string | null } {
    const porTipo = this.raw(
      `SELECT type, COUNT(*) AS total FROM odonto_exams
        WHERE patient_id = ? AND deleted_at IS NULL GROUP BY type ORDER BY total DESC`,
      patientId,
    ) as unknown as { type: ExamType; total: number }[];
    const ultimo = this.rawOne(
      `SELECT MAX(exam_date) AS ultimo FROM odonto_exams WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    ) as { ultimo: string | null } | undefined;
    return {
      total: porTipo.reduce((s, r) => s + Number(r.total), 0),
      por_tipo: porTipo.map((r) => ({ type: r.type, total: Number(r.total) })),
      ultimo_em: ultimo?.ultimo ?? null,
    };
  }

  /** Exames por tipo num período (relatórios da fase 9). */
  countByType(from: string, to: string): { type: ExamType; total: number }[] {
    return this.raw(
      `SELECT type, COUNT(*) AS total FROM odonto_exams
        WHERE deleted_at IS NULL AND date(exam_date) BETWEEN ? AND ?
        GROUP BY type ORDER BY total DESC`,
      from, to,
    ) as unknown as { type: ExamType; total: number }[];
  }
}

export const examRepository = new ExamRepository();
