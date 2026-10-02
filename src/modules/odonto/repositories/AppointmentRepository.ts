import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/** Situações do agendamento (PR §6). `atendido` é final; as outras podem voltar. */
export type AppointmentStatus =
  | 'agendado' | 'confirmado' | 'em_atendimento' | 'atendido' | 'faltou' | 'cancelado';

export type AppointmentEvent =
  | 'criado' | 'reagendado' | 'confirmado' | 'em_atendimento' | 'atendido' | 'faltou'
  | 'cancelado' | 'reativado' | 'encaixe' | 'editado';

export interface AppointmentRow extends Row {
  id: number;
  patient_id: number;
  professional_id: number;
  procedure_id: number | null;
  starts_at: string;
  duration_min: number;
  status: AppointmentStatus;
  room: string | null;
  notes: string | null;
  is_fit_in: number;
  cancel_reason: string | null;
  created_by: number | null;
  confirmed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Agendamento já com os nomes que a tela mostra. */
export interface AppointmentDetailRow extends AppointmentRow {
  patient_name: string;
  patient_phone: string | null;
  professional_name: string;
  professional_cro: string | null;
  procedure_name: string | null;
  /** Horário de término calculado no SQL (duração em minutos somada ao início). */
  ends_at: string;
}

export interface AppointmentEventRow extends Row {
  id: number;
  appointment_id: number;
  event: AppointmentEvent;
  from_starts_at: string | null;
  to_starts_at: string | null;
  from_status: string | null;
  to_status: string | null;
  notes: string | null;
  user_id: number | null;
  username: string | null;
  created_at: string;
}

/** Colunas de agendamento que o serviço pode gravar direto. */
export const APPOINTMENT_FIELDS = [
  'patient_id', 'professional_id', 'procedure_id', 'starts_at', 'duration_min', 'status',
  'room', 'notes', 'is_fit_in', 'cancel_reason', 'confirmed_at', 'started_at', 'finished_at',
  'cancelled_at',
] as const;

// `strftime('%Y-%m-%d %H:%M', ...)` em tudo que compara horário: `datetime()` do SQLite
// devolve com segundos ('09:30:00') e comparar string com '09:30' faz '09:30:00' > '09:30',
// o que recusava encaixe legítimo (um atendimento que começa quando o outro termina).
const MINUTO = "strftime('%Y-%m-%d %H:%M', %s)";

const DETALHE_SELECT = `
  SELECT a.*, ${MINUTO.replace('%s', "datetime(a.starts_at, '+' || a.duration_min || ' minutes')")} AS ends_at,
         c.name AS patient_name, c.phone AS patient_phone,
         p.name AS professional_name, p.cro AS professional_cro,
         pr.name AS procedure_name
    FROM odonto_appointments a
    JOIN odonto_patients pa ON pa.id = a.patient_id
    JOIN customers c ON c.id = pa.customer_id
    JOIN odonto_professionals p ON p.id = a.professional_id
    LEFT JOIN odonto_procedures pr ON pr.id = a.procedure_id`;

class AppointmentRepository extends BaseRepository<AppointmentRow> {
  constructor() {
    super('odonto_appointments');
  }

  /** Agenda de um período (inclusive), opcionalmente de um profissional só. */
  listPeriod(opts: {
    from: string;
    to: string;
    professionalId?: number;
    status?: AppointmentStatus;
    patientId?: number;
  }): AppointmentDetailRow[] {
    const where = [
      'a.deleted_at IS NULL',
      `${MINUTO.replace('%s', 'a.starts_at')} >= ?`,
      `${MINUTO.replace('%s', 'a.starts_at')} <= ?`,
    ];
    const params: unknown[] = [opts.from, opts.to];
    if (opts.professionalId) {
      where.push('a.professional_id = ?');
      params.push(opts.professionalId);
    }
    if (opts.status) {
      where.push('a.status = ?');
      params.push(opts.status);
    }
    if (opts.patientId) {
      where.push('a.patient_id = ?');
      params.push(opts.patientId);
    }
    return this.raw(
      `${DETALHE_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.starts_at, p.name`,
      ...params,
    ) as unknown as AppointmentDetailRow[];
  }

  findDetail(id: number): AppointmentDetailRow | undefined {
    return this.rawOne(
      `${DETALHE_SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`,
      id,
    ) as unknown as AppointmentDetailRow | undefined;
  }

  /**
   * Agendamentos do profissional que OCUPAM o intervalo pedido. Cancelado e falta liberam o
   * horário (não bloqueiam outro paciente); atendido e os demais ocupam.
   */
  conflitos(professionalId: number, startsAt: string, endsAt: string, ignorarId?: number): AppointmentDetailRow[] {
    return this.raw(
      `${DETALHE_SELECT}
        WHERE a.deleted_at IS NULL
          AND a.professional_id = ?
          AND a.status NOT IN ('cancelado', 'faltou')
          AND a.id <> COALESCE(?, -1)
          AND ${MINUTO.replace('%s', 'a.starts_at')} < ?
          AND ${MINUTO.replace('%s', "datetime(a.starts_at, '+' || a.duration_min || ' minutes')")} > ?`,
      professionalId, ignorarId ?? null, endsAt, startsAt,
    ) as unknown as AppointmentDetailRow[];
  }

  /** Quantos atendimentos por dia num período — usado na visão de mês. */
  contagemPorDia(from: string, to: string, professionalId?: number): { dia: string; total: number; pendentes: number }[] {
    return this.raw(
      `SELECT date(a.starts_at) AS dia, COUNT(*) AS total,
              SUM(CASE WHEN a.status IN ('agendado', 'confirmado', 'em_atendimento') THEN 1 ELSE 0 END) AS pendentes
         FROM odonto_appointments a
        WHERE a.deleted_at IS NULL AND a.starts_at >= ? AND a.starts_at <= ?
          ${professionalId ? 'AND a.professional_id = ?' : ''}
        GROUP BY date(a.starts_at) ORDER BY dia`,
      ...(professionalId ? [from, to, professionalId] : [from, to]),
    ) as unknown as { dia: string; total: number; pendentes: number }[];
  }

  create(data: Record<string, unknown>): number {
    const campos = APPOINTMENT_FIELDS.filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_appointments (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  update(id: number, data: Record<string, unknown>): void {
    const campos = APPOINTMENT_FIELDS.filter((f) => data[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_appointments SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => data[f] as never), id,
    );
  }

  softDelete(id: number): void {
    this.rawRun(
      `UPDATE odonto_appointments SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  // ─────────────────────────────── Histórico ───────────────────────────────

  addEvent(data: {
    appointment_id: number;
    event: AppointmentEvent;
    from_starts_at?: string | null;
    to_starts_at?: string | null;
    from_status?: string | null;
    to_status?: string | null;
    notes?: string | null;
    user_id: number | null;
  }): void {
    this.rawRun(
      `INSERT INTO odonto_appointment_events
         (appointment_id, event, from_starts_at, to_starts_at, from_status, to_status, notes, user_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.appointment_id, data.event, data.from_starts_at ?? null, data.to_starts_at ?? null,
      data.from_status ?? null, data.to_status ?? null, data.notes ?? null, data.user_id,
      randomUUID(),
    );
  }

  listEvents(appointmentId: number): AppointmentEventRow[] {
    return this.raw(
      `SELECT e.*, u.username FROM odonto_appointment_events e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.appointment_id = ? ORDER BY e.id DESC`,
      appointmentId,
    ) as unknown as AppointmentEventRow[];
  }
}

export const appointmentRepository = new AppointmentRepository();
