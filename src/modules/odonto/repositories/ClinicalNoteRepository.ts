import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/** Um procedimento realizado dentro de uma evolução (nome é snapshot do catálogo). */
export interface ClinicalNoteProcedure {
  procedure_id?: number | null;
  name: string;
  /** Dente/superfície quando o procedimento é em dente específico (ex.: '26'). */
  tooth?: string | null;
  note?: string | null;
}

export interface ClinicalNoteRow extends Row {
  id: number;
  patient_id: number;
  professional_id: number | null;
  appointment_id: number | null;
  happened_at: string;
  title: string | null;
  procedures_json: string;
  observations: string | null;
  diagnosis: string | null;
  conduct: string | null;
  next_steps: string | null;
  documents_json: string;
  exams_json: string;
  status: 'vigente' | 'retificado';
  version: number;
  replaced_by_id: number | null;
  retifica_id: number | null;
  retification_reason: string | null;
  professional_name_snapshot: string | null;
  professional_cro_snapshot: string | null;
  created_by: number | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Evolução já com o que a tela precisa (autor, paciente e quem retificou). */
export interface ClinicalNoteDetailRow extends ClinicalNoteRow {
  patient_name: string;
  created_by_name: string | null;
  /** Nome/CRO de quem fez a retificação que substituiu esta linha (quando retificada). */
  replaced_by_name: string | null;
  replaced_by_cro: string | null;
}

/** Colunas que o serviço grava (o resto é derivado). */
export const NOTE_FIELDS = [
  'patient_id', 'professional_id', 'appointment_id', 'happened_at', 'title', 'procedures_json',
  'observations', 'diagnosis', 'conduct', 'next_steps', 'documents_json', 'exams_json', 'status',
  'version', 'replaced_by_id', 'retifica_id', 'retification_reason',
  'professional_name_snapshot', 'professional_cro_snapshot', 'created_by',
] as const;

const DETALHE_SELECT = `
  SELECT n.*, c.name AS patient_name, u.username AS created_by_name,
         r.professional_name_snapshot AS replaced_by_name,
         r.professional_cro_snapshot AS replaced_by_cro
    FROM odonto_clinical_notes n
    JOIN odonto_patients pa ON pa.id = n.patient_id
    JOIN customers c ON c.id = pa.customer_id
    LEFT JOIN users u ON u.id = n.created_by
    LEFT JOIN odonto_clinical_notes r ON r.id = n.replaced_by_id`;

class ClinicalNoteRepository extends BaseRepository<ClinicalNoteRow> {
  constructor() {
    super('odonto_clinical_notes');
  }

  /**
   * Evoluções do paciente, da mais recente para a mais antiga.
   * `somenteVigentes` é o padrão da tela: retificado aparece só no histórico da cadeia.
   */
  listByPatient(patientId: number, opts: { somenteVigentes?: boolean; limit?: number } = {}): ClinicalNoteDetailRow[] {
    const where = ['n.deleted_at IS NULL', 'n.patient_id = ?'];
    const params: unknown[] = [patientId];
    if (opts.somenteVigentes) where.push("n.status = 'vigente'");
    return this.raw(
      `${DETALHE_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY n.happened_at DESC, n.id DESC
        ${opts.limit ? `LIMIT ${Math.max(1, Math.round(opts.limit))}` : ''}`,
      ...params,
    ) as unknown as ClinicalNoteDetailRow[];
  }

  findDetail(id: number): ClinicalNoteDetailRow | undefined {
    return this.rawOne(
      `${DETALHE_SELECT} WHERE n.id = ? AND n.deleted_at IS NULL`,
      id,
    ) as unknown as ClinicalNoteDetailRow | undefined;
  }

  /** Cadeia de versões de um registro (a original e todas as retificações), em ordem. */
  chain(id: number): ClinicalNoteDetailRow[] {
    const raiz = this.rawOne(
      `WITH RECURSIVE sobe(id, retifica_id) AS (
         SELECT id, retifica_id FROM odonto_clinical_notes WHERE id = ?
         UNION ALL
         SELECT n.id, n.retifica_id FROM odonto_clinical_notes n JOIN sobe s ON n.id = s.retifica_id
       )
       SELECT MIN(id) AS raiz FROM sobe`,
      id,
    ) as { raiz: number } | undefined;
    if (!raiz?.raiz) return [];
    return this.raw(
      `WITH RECURSIVE desce(id, replaced_by_id, version) AS (
         SELECT id, replaced_by_id, version FROM odonto_clinical_notes WHERE id = ?
         UNION ALL
         SELECT n.id, n.replaced_by_id, n.version FROM odonto_clinical_notes n JOIN desce d ON n.id = d.replaced_by_id
       )
       SELECT n.*, c.name AS patient_name, u.username AS created_by_name,
              r.professional_name_snapshot AS replaced_by_name,
              r.professional_cro_snapshot AS replaced_by_cro
         FROM desce d
         JOIN odonto_clinical_notes n ON n.id = d.id
         JOIN odonto_patients pa ON pa.id = n.patient_id
         JOIN customers c ON c.id = pa.customer_id
         LEFT JOIN users u ON u.id = n.created_by
         LEFT JOIN odonto_clinical_notes r ON r.id = n.replaced_by_id
        ORDER BY n.version`,
      raiz.raiz,
    ) as unknown as ClinicalNoteDetailRow[];
  }

  /** Quantas evoluções vigentes o paciente tem (resumo do prontuário). */
  resumo(patientId: number): { vigentes: number; retificadas: number; ultima: string | null } {
    const row = this.rawOne(
      `SELECT SUM(CASE WHEN status = 'vigente' THEN 1 ELSE 0 END) AS vigentes,
              SUM(CASE WHEN status = 'retificado' THEN 1 ELSE 0 END) AS retificadas,
              MAX(CASE WHEN status = 'vigente' THEN happened_at END) AS ultima
         FROM odonto_clinical_notes WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    ) as { vigentes: number | null; retificadas: number | null; ultima: string | null } | undefined;
    return {
      vigentes: Number(row?.vigentes ?? 0),
      retificadas: Number(row?.retificadas ?? 0),
      ultima: row?.ultima ?? null,
    };
  }

  create(data: Record<string, unknown>): number {
    const campos = NOTE_FIELDS.filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_clinical_notes (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  /** Marca o registro anterior como retificado e aponta para a versão que o substituiu. */
  marcarRetificado(id: number, replacedById: number): void {
    this.rawRun(
      `UPDATE odonto_clinical_notes
          SET status = 'retificado', replaced_by_id = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'vigente' AND deleted_at IS NULL`,
      replacedById, id,
    );
  }

  /** Excluir o paciente leva o prontuário junto (soft delete, como o resto do módulo). */
  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_clinical_notes SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }
}

export const clinicalNoteRepository = new ClinicalNoteRepository();
