import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/** Situação do plano (PR §11). */
export type PlanStatus = 'planejado' | 'apresentado' | 'aprovado' | 'em_andamento' | 'concluido' | 'cancelado';
/** Situação do item: mesmo vocabulário, sem "apresentado" (quem é apresentado é o plano). */
export type ItemStatus = 'planejado' | 'aprovado' | 'em_andamento' | 'concluido' | 'cancelado';

export interface TreatmentPlanRow extends Row {
  id: number;
  patient_id: number;
  professional_id: number | null;
  title: string | null;
  status: PlanStatus;
  notes: string | null;
  presented_at: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  charged_at: string | null;
  installments: number | null;
  first_due_date: string | null;
  professional_name_snapshot: string | null;
  professional_cro_snapshot: string | null;
  created_by: number | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

export interface TreatmentItemRow extends Row {
  id: number;
  plan_id: number;
  procedure_id: number | null;
  tooth: string | null;
  description: string;
  amount_cents: number;
  quantity: number;
  professional_id: number | null;
  status: ItemStatus;
  sort_order: number;
  notes: string | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Item já com o nome do procedimento (snapshot do catálogo) e do profissional. */
export interface TreatmentItemDetailRow extends TreatmentItemRow {
  procedure_name: string | null;
  professional_name: string | null;
}

export interface TreatmentPlanDetailRow extends TreatmentPlanRow {
  patient_name: string;
  created_by_name: string | null;
  /** Soma de valor x quantidade dos itens não cancelados. */
  total_cents: number;
  items_count: number;
}

const PLANO_SELECT = `
  SELECT p.*, c.name AS patient_name, u.username AS created_by_name,
         COALESCE((SELECT SUM(i.amount_cents * i.quantity) FROM odonto_treatment_items i
                    WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'cancelado'), 0) AS total_cents,
         (SELECT COUNT(*) FROM odonto_treatment_items i
           WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'cancelado') AS items_count
    FROM odonto_treatment_plans p
    JOIN odonto_patients pa ON pa.id = p.patient_id
    JOIN customers c ON c.id = pa.customer_id
    LEFT JOIN users u ON u.id = p.created_by`;

const ITEM_SELECT = `
  SELECT i.*, pr.name AS procedure_name, prof.name AS professional_name
    FROM odonto_treatment_items i
    LEFT JOIN odonto_procedures pr ON pr.id = i.procedure_id
    LEFT JOIN odonto_professionals prof ON prof.id = i.professional_id`;

export const PLAN_STATUSES: PlanStatus[] = ['planejado', 'apresentado', 'aprovado', 'em_andamento', 'concluido', 'cancelado'];
export const ITEM_STATUSES: ItemStatus[] = ['planejado', 'aprovado', 'em_andamento', 'concluido', 'cancelado'];

class TreatmentPlanRepository extends BaseRepository<TreatmentPlanRow> {
  constructor() {
    super('odonto_treatment_plans');
  }

  listByPatient(patientId: number): TreatmentPlanDetailRow[] {
    return this.raw(
      `${PLANO_SELECT} WHERE p.patient_id = ? AND p.deleted_at IS NULL
        ORDER BY p.status IN ('concluido', 'cancelado'), p.created_at DESC`,
      patientId,
    ) as unknown as TreatmentPlanDetailRow[];
  }

  findDetail(id: number): TreatmentPlanDetailRow | undefined {
    return this.rawOne(
      `${PLANO_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`,
      id,
    ) as unknown as TreatmentPlanDetailRow | undefined;
  }

  listItems(planId: number): TreatmentItemDetailRow[] {
    return this.raw(
      `${ITEM_SELECT} WHERE i.plan_id = ? AND i.deleted_at IS NULL ORDER BY i.sort_order, i.id`,
      planId,
    ) as unknown as TreatmentItemDetailRow[];
  }

  findItem(itemId: number): TreatmentItemDetailRow | undefined {
    return this.rawOne(`${ITEM_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`, itemId) as unknown as TreatmentItemDetailRow | undefined;
  }

  /**
   * Itens planejados de um paciente (o odontograma usa isto para marcar "P" nos dentes).
   * Só planos vivos: cancelado/concluído não são mais planejamento.
   */
  plannedByTooth(patientId: number): { tooth: string; description: string; plan_id: number; status: string }[] {
    return this.raw(
      `SELECT i.tooth, i.description, i.plan_id, i.status
         FROM odonto_treatment_items i
         JOIN odonto_treatment_plans p ON p.id = i.plan_id
        WHERE p.patient_id = ? AND p.deleted_at IS NULL AND i.deleted_at IS NULL
          AND i.tooth IS NOT NULL
          AND p.status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento')
          AND i.status IN ('planejado', 'aprovado', 'em_andamento')
        ORDER BY i.sort_order, i.id`,
      patientId,
    ) as unknown as { tooth: string; description: string; plan_id: number; status: string }[];
  }

  /** Unidades do plano para o rodapé do orçamento: total, aprovado e concluído. */
  resumo(patientId: number): { planos_abertos: number; itens_pendentes: number; total_aberto_cents: number } {
    const row = this.rawOne(
      `SELECT
         (SELECT COUNT(*) FROM odonto_treatment_plans p
           WHERE p.patient_id = ? AND p.deleted_at IS NULL
             AND p.status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento')) AS planos_abertos,
         (SELECT COUNT(*) FROM odonto_treatment_items i JOIN odonto_treatment_plans p ON p.id = i.plan_id
           WHERE p.patient_id = ? AND p.deleted_at IS NULL AND i.deleted_at IS NULL
             AND p.status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento')
             AND i.status IN ('planejado', 'aprovado', 'em_andamento')) AS itens_pendentes,
         (SELECT COALESCE(SUM(i.amount_cents * i.quantity), 0) FROM odonto_treatment_items i
            JOIN odonto_treatment_plans p ON p.id = i.plan_id
           WHERE p.patient_id = ? AND p.deleted_at IS NULL AND i.deleted_at IS NULL
             AND p.status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento')
             AND i.status IN ('planejado', 'aprovado', 'em_andamento')) AS total_aberto_cents`,
      patientId, patientId, patientId,
    ) as { planos_abertos: number; itens_pendentes: number; total_aberto_cents: number } | undefined;
    return {
      planos_abertos: Number(row?.planos_abertos ?? 0),
      itens_pendentes: Number(row?.itens_pendentes ?? 0),
      total_aberto_cents: Number(row?.total_aberto_cents ?? 0),
    };
  }

  createPlan(data: Record<string, unknown>): number {
    const campos = [
      'patient_id', 'professional_id', 'title', 'status', 'notes', 'professional_name_snapshot',
      'professional_cro_snapshot', 'created_by',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_treatment_plans (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  updatePlan(id: number, patch: Record<string, unknown>): void {
    const campos = [
      'professional_id', 'title', 'status', 'notes', 'presented_at', 'approved_at', 'started_at',
      'finished_at', 'cancelled_at', 'cancel_reason', 'charged_at', 'installments', 'first_due_date',
      'professional_name_snapshot', 'professional_cro_snapshot',
    ].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_treatment_plans SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  softDeletePlan(id: number): void {
    this.rawRun(
      `UPDATE odonto_treatment_plans SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  // ─────────────────────────────── Itens ───────────────────────────────

  createItem(data: Record<string, unknown>): number {
    const campos = [
      'plan_id', 'procedure_id', 'tooth', 'description', 'amount_cents', 'quantity',
      'professional_id', 'status', 'sort_order', 'notes',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_treatment_items (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  updateItem(id: number, patch: Record<string, unknown>): void {
    const campos = [
      'procedure_id', 'tooth', 'description', 'amount_cents', 'quantity', 'professional_id',
      'status', 'sort_order', 'notes',
    ].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_treatment_items SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  softDeleteItem(id: number): void {
    this.rawRun(
      `UPDATE odonto_treatment_items SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  /** Excluir o paciente leva planos e itens junto (soft delete, como o resto do módulo). */
  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_treatment_items SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE plan_id IN (SELECT id FROM odonto_treatment_plans WHERE patient_id = ?) AND deleted_at IS NULL`,
      patientId,
    );
    this.rawRun(
      `UPDATE odonto_treatment_plans SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }
}

export const treatmentPlanRepository = new TreatmentPlanRepository();
