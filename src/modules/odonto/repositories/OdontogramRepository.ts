import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';
import { stableUuid } from '../../../shared/uuid';

/** Superfícies dentárias aceitas (PR §9). */
export const SURFACES = ['M', 'D', 'O', 'V', 'L'] as const;
export type Surface = (typeof SURFACES)[number];

/** Numeração FDI (ISO 3950), permanente: 4 quadrantes de 8 dentes (PR §9). */
export const FDI_TEETH = [
  '18', '17', '16', '15', '14', '13', '12', '11',
  '21', '22', '23', '24', '25', '26', '27', '28',
  '48', '47', '46', '45', '44', '43', '42', '41',
  '31', '32', '33', '34', '35', '36', '37', '38',
] as const;

export type StateKind = 'situacao' | 'planejado';

export interface ToothConditionRow extends Row {
  id: number;
  code: string;
  name: string;
  color: string;
  applies_to: 'dente' | 'superficie' | 'ambos';
  is_neutral: number;
  sort_order: number;
  active: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

export interface ToothStateRow extends Row {
  id: number;
  patient_id: number;
  tooth: string;
  surface: Surface | null;
  kind: StateKind;
  condition_id: number;
  note: string | null;
  recorded_at: string;
  professional_id: number | null;
  professional_name_snapshot: string | null;
  professional_cro_snapshot: string | null;
  created_by: number | null;
  undone_at: string | null;
  undone_by: number | null;
  undo_reason: string | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Estado com o nome/cor da situação e quem registrou (o que a tela desenha). */
export interface ToothStateDetailRow extends ToothStateRow {
  condition_code: string;
  condition_name: string;
  condition_color: string;
  is_neutral: number;
  created_by_name: string | null;
  undone_by_name: string | null;
}

const ESTADO_SELECT = `
  SELECT s.*, tc.code AS condition_code, tc.name AS condition_name, tc.color AS condition_color,
         tc.is_neutral AS is_neutral,
         u.username AS created_by_name, ud.username AS undone_by_name
    FROM odonto_tooth_states s
    JOIN odonto_tooth_conditions tc ON tc.id = s.condition_id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN users ud ON ud.id = s.undone_by`;

class OdontogramRepository extends BaseRepository<ToothConditionRow> {
  constructor() {
    super('odonto_tooth_conditions');
  }

  // ─────────────────────────── Situações (catálogo) ───────────────────────────

  listConditions(opts: { activeOnly?: boolean } = {}): ToothConditionRow[] {
    return this.raw(
      `SELECT * FROM odonto_tooth_conditions
        WHERE deleted_at IS NULL ${opts.activeOnly ? 'AND active = 1' : ''}
        ORDER BY sort_order, name`,
    ) as unknown as ToothConditionRow[];
  }

  findCondition(id: number): ToothConditionRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_tooth_conditions WHERE id = ? AND deleted_at IS NULL',
      id,
    ) as unknown as ToothConditionRow | undefined;
  }

  findConditionByCode(code: string): ToothConditionRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_tooth_conditions WHERE code = ? AND deleted_at IS NULL',
      code,
    ) as unknown as ToothConditionRow | undefined;
  }

  createCondition(data: {
    code: string; name: string; color: string; applies_to: string; sort_order: number;
    active: number; is_neutral?: number;
  }): number {
    return Number(this.rawRun(
      `INSERT INTO odonto_tooth_conditions (code, name, color, applies_to, sort_order, active, is_neutral, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.code, data.name, data.color, data.applies_to, data.sort_order, data.active,
      data.is_neutral ?? 0, stableUuid(`odonto_tooth_condition:${data.code}`),
    ).lastInsertRowid);
  }

  updateCondition(id: number, patch: Record<string, unknown>): void {
    const campos = ['name', 'color', 'applies_to', 'sort_order', 'active'].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_tooth_conditions SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  /** Situações ainda em uso não podem ser apagadas (o histórico aponta para elas). */
  conditionUsage(conditionId: number): number {
    const row = this.rawOne(
      'SELECT COUNT(*) AS t FROM odonto_tooth_states WHERE condition_id = ?',
      conditionId,
    ) as { t: number } | undefined;
    return Number(row?.t ?? 0);
  }

  softDeleteCondition(id: number): void {
    this.rawRun(
      "UPDATE odonto_tooth_conditions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id,
    );
  }

  // ─────────────────────────────── Estados ───────────────────────────────

  /** Histórico completo de um dente (mais recente primeiro), incluindo desfeitos. */
  listToothHistory(patientId: number, tooth: string): ToothStateDetailRow[] {
    return this.raw(
      `${ESTADO_SELECT}
        WHERE s.patient_id = ? AND s.tooth = ? AND s.deleted_at IS NULL
        ORDER BY s.recorded_at DESC, s.id DESC`,
      patientId, tooth,
    ) as unknown as ToothStateDetailRow[];
  }

  /** Tudo que o paciente tem no odontograma (o desenho monta o estado atual na tela). */
  listPatientStates(patientId: number): ToothStateDetailRow[] {
    return this.raw(
      `${ESTADO_SELECT}
        WHERE s.patient_id = ? AND s.deleted_at IS NULL
        ORDER BY s.recorded_at, s.id`,
      patientId,
    ) as unknown as ToothStateDetailRow[];
  }

  findState(id: number): ToothStateDetailRow | undefined {
    return this.rawOne(
      `${ESTADO_SELECT} WHERE s.id = ? AND s.deleted_at IS NULL`,
      id,
    ) as unknown as ToothStateDetailRow | undefined;
  }

  createState(data: Record<string, unknown>): number {
    const campos = [
      'patient_id', 'tooth', 'surface', 'kind', 'condition_id', 'note', 'recorded_at',
      'professional_id', 'professional_name_snapshot', 'professional_cro_snapshot', 'created_by',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_tooth_states (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  /** Desfaz (sem apagar): marca quem desfez, quando e por quê. */
  undoState(id: number, userId: number | null, reason: string | null): void {
    this.rawRun(
      `UPDATE odonto_tooth_states
          SET undone_at = datetime('now'), undone_by = ?, undo_reason = ?, updated_at = datetime('now')
        WHERE id = ? AND undone_at IS NULL`,
      userId, reason, id,
    );
  }

  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_tooth_states SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }

  /**
   * Evoluções do prontuário que citam este dente (tratamentos REALIZADOS).
   * O procedimento guarda o dente dentro do JSON, então a busca é por `json_each`.
   */
  proceduresForTooth(patientId: number, tooth: string): { id: number; happened_at: string; name: string; note: string | null }[] {
    return this.raw(
      `SELECT n.id, n.happened_at, json_extract(j.value, '$.name') AS name,
              json_extract(j.value, '$.note') AS note
         FROM odonto_clinical_notes n, json_each(n.procedures_json) j
        WHERE n.patient_id = ? AND n.deleted_at IS NULL
          AND json_extract(j.value, '$.tooth') = ?
        ORDER BY n.happened_at DESC`,
      patientId, tooth,
    ) as unknown as { id: number; happened_at: string; name: string; note: string | null }[];
  }

  /** Resumo do odontograma: quantos dentes com situação e quantos planejados. */
  resumo(patientId: number): { dentes_com_situacao: number; planejados: number; registros: number } {
    const row = this.rawOne(
      `SELECT COUNT(DISTINCT CASE WHEN kind = 'situacao' AND undone_at IS NULL THEN tooth END) AS dentes_com_situacao,
              COUNT(DISTINCT CASE WHEN kind = 'planejado' AND undone_at IS NULL THEN tooth END) AS planejados,
              COUNT(*) AS registros
         FROM odonto_tooth_states WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    ) as { dentes_com_situacao: number | null; planejados: number | null; registros: number | null } | undefined;
    return {
      dentes_com_situacao: Number(row?.dentes_com_situacao ?? 0),
      planejados: Number(row?.planejados ?? 0),
      registros: Number(row?.registros ?? 0),
    };
  }
}

export const odontogramRepository = new OdontogramRepository();
