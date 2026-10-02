import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import {
  appointmentRepository,
  type AppointmentDetailRow,
  type AppointmentEvent,
  type AppointmentEventRow,
  type AppointmentStatus,
} from './repositories/AppointmentRepository';
import type { Result } from './permissions';

/**
 * Agenda do consultório (PR §6).
 *
 * Regras que sustentam a agenda no dia a dia:
 *
 *  1. **Um profissional não atende dois pacientes no mesmo horário.** Ao marcar (ou remarcar)
 *     o serviço procura sobreposição para aquele profissional e recusa com 409 dizendo com
 *     quem bate. O que libera o horário é o status: `cancelado` e `faltou` não bloqueiam.
 *  2. **Encaixe é exceção declarada.** `is_fit_in` permite a sobreposição (é a razão de
 *     existir) e fica registrado no histórico como `encaixe`.
 *  3. **Reagendar move o mesmo agendamento** e grava `reagendado` com o de/para — não cria
 *     linha nova. Assim a agenda do dia não vira uma pilha de cancelados e o histórico de
 *     remarcações continua existindo.
 *  4. **Situação anda para frente, com volta só onde faz sentido** (`atendido` é final;
 *     `faltou`/`cancelado` podem ser reabertos para `agendado`).
 *  5. Toda mudança de situação/horário vira linha em `odonto_appointment_events` (append-only)
 *     e a auditoria registra o ato — sem copiar observação clínica para o log.
 */

const STATUS: AppointmentStatus[] = ['agendado', 'confirmado', 'em_atendimento', 'atendido', 'faltou', 'cancelado'];

/** Para onde cada situação pode ir. `atendido` é final. */
const TRANSICOES: Record<AppointmentStatus, AppointmentStatus[]> = {
  agendado: ['confirmado', 'em_atendimento', 'faltou', 'cancelado'],
  confirmado: ['em_atendimento', 'faltou', 'cancelado'],
  em_atendimento: ['atendido', 'cancelado'],
  atendido: [],
  faltou: ['agendado', 'cancelado'],
  cancelado: ['agendado'],
};

const EVENTO_POR_STATUS: Record<AppointmentStatus, AppointmentEvent> = {
  agendado: 'reativado',
  confirmado: 'confirmado',
  em_atendimento: 'em_atendimento',
  atendido: 'atendido',
  faltou: 'faltou',
  cancelado: 'cancelado',
};

const DURACAO_MIN = 5;
const DURACAO_MAX = 480;

export interface AppointmentInput {
  patient_id?: number;
  professional_id?: number;
  procedure_id?: number | null;
  /** 'YYYY-MM-DD HH:MM'. */
  starts_at?: string;
  duration_min?: number;
  room?: string | null;
  notes?: string | null;
  is_fit_in?: boolean | number;
}

// ─────────────────────────────── Datas ───────────────────────────────

const DATA_HORA = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Normaliza 'YYYY-MM-DD HH:MM' (aceita 'T' no meio, como vem de input datetime-local). */
export function normalizaDataHora(v: unknown): string | null {
  const m = DATA_HORA.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, ano, mes, dia, hora, minuto] = m;
  if (Number(hora) > 23 || Number(minuto) > 59) return null;
  const d = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return `${ano}-${mes}-${dia} ${hora}:${minuto}`;
}

function somaMinutos(dataHora: string, minutos: number): string {
  const [dia, hora] = dataHora.split(' ');
  const [a, m, d] = dia.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  const base = Date.UTC(a, m - 1, d, h, mi) + minutos * 60_000;
  const dt = new Date(base);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

/** Fim do período pedido: dia, semana (7 dias) ou mês do calendário. */
export function periodo(view: unknown, data: unknown): Result<{ from: string; to: string }> {
  const dia = DATA.test(String(data ?? '')) ? String(data) : new Date().toISOString().slice(0, 10);
  const [a, m, d] = dia.split('-').map(Number);
  // `todos`: sem recorte de período. Usado para vincular uma evolução a um atendimento do
  // paciente (a lista já vem filtrada por `patient_id`, então o volume é o histórico dele).
  if (view === 'todos') {
    return { ok: true, data: { from: '1900-01-01 00:00', to: '2999-12-31 23:59' } };
  }
  if (view === 'mes') {
    const inicio = new Date(Date.UTC(a, m - 1, 1));
    const fim = new Date(Date.UTC(a, m, 0, 23, 59));
    return { ok: true, data: { from: `${inicio.toISOString().slice(0, 10)} 00:00`, to: `${fim.toISOString().slice(0, 10)} 23:59` } };
  }
  if (view === 'semana') {
    const base = new Date(Date.UTC(a, m - 1, d));
    const domingo = new Date(base);
    domingo.setUTCDate(base.getUTCDate() - base.getUTCDay());
    const sabado = new Date(domingo);
    sabado.setUTCDate(domingo.getUTCDate() + 6);
    return { ok: true, data: { from: `${domingo.toISOString().slice(0, 10)} 00:00`, to: `${sabado.toISOString().slice(0, 10)} 23:59` } };
  }
  return { ok: true, data: { from: `${dia} 00:00`, to: `${dia} 23:59` } };
}

// ─────────────────────────────── Saída ───────────────────────────────

export interface AppointmentOutput {
  id: number;
  patient_id: number;
  patient_name: string;
  patient_phone: string | null;
  professional_id: number;
  professional_name: string;
  professional_cro: string | null;
  procedure_id: number | null;
  procedure_name: string | null;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  status: AppointmentStatus;
  room: string | null;
  notes: string | null;
  is_fit_in: boolean;
  cancel_reason: string | null;
}

function saida(row: AppointmentDetailRow): AppointmentOutput {
  return {
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    patient_phone: row.patient_phone,
    professional_id: row.professional_id,
    professional_name: row.professional_name,
    professional_cro: row.professional_cro,
    procedure_id: row.procedure_id,
    procedure_name: row.procedure_name,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    duration_min: row.duration_min,
    status: row.status,
    room: row.room,
    notes: row.notes,
    is_fit_in: Number(row.is_fit_in) === 1,
    cancel_reason: row.cancel_reason,
  };
}

function evento(row: AppointmentEventRow): {
  id: number; event: AppointmentEvent; from: string | null; to: string | null;
  from_status: string | null; to_status: string | null; notes: string | null;
  username: string | null; created_at: string;
} {
  return {
    id: row.id,
    event: row.event,
    from: row.from_starts_at,
    to: row.to_starts_at,
    from_status: row.from_status,
    to_status: row.to_status,
    notes: row.notes,
    username: row.username,
    created_at: row.created_at,
  };
}

// ─────────────────────────────── Consultas ───────────────────────────────

export function listAppointments(
  req: Request,
  opts: { view?: unknown; date?: unknown; professionalId?: number; status?: string; patientId?: number },
): Result<{ from: string; to: string; items: AppointmentOutput[]; porDia: { dia: string; total: number; pendentes: number }[] }> {
  const p = periodo(opts.view, opts.date);
  if (!p.ok) return p;
  const status = STATUS.includes(opts.status as AppointmentStatus) ? (opts.status as AppointmentStatus) : undefined;
  const items = appointmentRepository.listPeriod({
    from: p.data.from,
    to: p.data.to,
    professionalId: opts.professionalId,
    status,
    patientId: opts.patientId,
  }).map(saida);
  return {
    ok: true,
    data: {
      from: p.data.from,
      to: p.data.to,
      items,
      porDia: appointmentRepository.contagemPorDia(p.data.from, p.data.to, opts.professionalId),
    },
  };
}

export function getAppointment(id: number): Result<{ appointment: AppointmentOutput; history: ReturnType<typeof evento>[] }> {
  const row = appointmentRepository.findDetail(id);
  if (!row) return { ok: false, error: 'Agendamento não encontrado.', status: 404 };
  return {
    ok: true,
    data: { appointment: saida(row), history: appointmentRepository.listEvents(id).map(evento) },
  };
}

// ─────────────────────────────── Criação ───────────────────────────────

function resolveSala(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 40) : null;
}

function resolveDuracao(v: unknown, padrao: number): number | null {
  if (v === undefined || v === null || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n) || n < DURACAO_MIN || n > DURACAO_MAX) return null;
  return Math.round(n);
}

/** Checa se o profissional já tem atendimento no intervalo. Devolve a mensagem do conflito. */
function conflito(
  professionalId: number,
  startsAt: string,
  durationMin: number,
  ignorarId?: number,
): { mensagem: string; conflito: AppointmentOutput } | null {
  const fim = somaMinutos(startsAt, durationMin);
  const achados = appointmentRepository.conflitos(professionalId, startsAt, fim, ignorarId);
  if (!achados.length) return null;
  const c = achados[0];
  const hhmm = (v: string) => v.slice(11, 16);
  return {
    mensagem: `Horário ocupado: ${c.professional_name} já atende ${c.patient_name} das ${hhmm(c.starts_at)} às ${hhmm(c.ends_at)}. `
      + 'Escolha outro horário, outro profissional — ou marque como encaixe.',
    conflito: saida(c),
  };
}

export function createAppointment(req: Request, input: AppointmentInput): Result<AppointmentOutput> {
  assertAuth(req);
  const patientId = Number(input.patient_id);
  const professionalId = Number(input.professional_id);
  if (!patientId || !patientRepository.findById(patientId)) {
    return { ok: false, error: 'Informe o paciente do agendamento.', status: 400 };
  }
  const profissional = professionalRepository.findById(professionalId);
  if (!profissional) return { ok: false, error: 'Informe o profissional do agendamento.', status: 400 };
  if (Number(profissional.active) !== 1) return { ok: false, error: 'Este profissional está inativo.', status: 400 };

  const startsAt = normalizaDataHora(input.starts_at);
  if (!startsAt) return { ok: false, error: 'Informe a data e o horário do atendimento.', status: 400 };

  const duracao = resolveDuracao(input.duration_min, 30);
  if (duracao === null) {
    return { ok: false, error: `A duração deve ficar entre ${DURACAO_MIN} e ${DURACAO_MAX} minutos.`, status: 400 };
  }

  const encaixe = input.is_fit_in === true || input.is_fit_in === 1 ? 1 : 0;
  const choque = conflito(professionalId, startsAt, duracao);
  if (choque && !encaixe) return { ok: false, error: choque.mensagem, status: 409 };

  let id = 0;
  appointmentRepository.transaction(() => {
    id = appointmentRepository.create({
      patient_id: patientId,
      professional_id: professionalId,
      procedure_id: input.procedure_id ? Number(input.procedure_id) : null,
      starts_at: startsAt,
      duration_min: duracao,
      status: 'agendado',
      room: resolveSala(input.room),
      notes: String(input.notes ?? '').trim() || null,
      is_fit_in: encaixe,
    });
    appointmentRepository.addEvent({
      appointment_id: id, event: 'criado', to_starts_at: startsAt, to_status: 'agendado',
      notes: null, user_id: req.user?.id ?? null,
    });
    if (encaixe) {
      appointmentRepository.addEvent({
        appointment_id: id, event: 'encaixe', to_starts_at: startsAt, to_status: 'agendado',
        notes: choque ? `Sobre ${choque.conflito.patient_name} (${choque.conflito.starts_at.slice(11, 16)}).` : null,
        user_id: req.user?.id ?? null,
      });
    }
  });

  const row = appointmentRepository.findDetail(id)!;
  audit(req, 'criar', 'odonto_appointment', id, null, {
    patient_id: patientId, professional_id: professionalId, starts_at: startsAt,
    duration_min: duracao, encaixe: encaixe === 1, conflito_declarado: !!choque,
  });
  return { ok: true, data: saida(row) };
}

// ──────────────────────────── Reagendar / editar ────────────────────────────

export function updateAppointment(req: Request, id: number, input: AppointmentInput): Result<AppointmentOutput> {
  assertAuth(req);
  const atual = appointmentRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Agendamento não encontrado.', status: 404 };
  if (atual.status === 'atendido') {
    return { ok: false, error: 'Atendimento já realizado: a agenda dele não muda mais.', status: 400 };
  }

  const professionalId = input.professional_id ? Number(input.professional_id) : atual.professional_id;
  if (professionalId !== atual.professional_id) {
    const p = professionalRepository.findById(professionalId);
    if (!p) return { ok: false, error: 'Profissional não encontrado.', status: 400 };
    if (Number(p.active) !== 1) return { ok: false, error: 'Este profissional está inativo.', status: 400 };
  }
  if (input.patient_id !== undefined) {
    const pid = Number(input.patient_id);
    if (!pid || !patientRepository.findById(pid)) return { ok: false, error: 'Paciente não encontrado.', status: 400 };
  }

  const startsAt = input.starts_at !== undefined ? normalizaDataHora(input.starts_at) : atual.starts_at;
  if (!startsAt) return { ok: false, error: 'Informe a data e o horário do atendimento.', status: 400 };

  const duracao = resolveDuracao(input.duration_min, atual.duration_min);
  if (duracao === null) {
    return { ok: false, error: `A duração deve ficar entre ${DURACAO_MIN} e ${DURACAO_MAX} minutos.`, status: 400 };
  }

  const encaixe = input.is_fit_in === undefined
    ? Number(atual.is_fit_in)
    : (input.is_fit_in === true || input.is_fit_in === 1 ? 1 : 0);
  const mudouHorario = startsAt !== atual.starts_at || duracao !== atual.duration_min || professionalId !== atual.professional_id;

  const choque = conflito(professionalId, startsAt, duracao, id);
  if (choque && encaixe !== 1) return { ok: false, error: choque.mensagem, status: 409 };

  appointmentRepository.transaction(() => {
    appointmentRepository.update(id, {
      ...(input.patient_id !== undefined ? { patient_id: Number(input.patient_id) } : {}),
      professional_id: professionalId,
      ...(input.procedure_id !== undefined ? { procedure_id: input.procedure_id ? Number(input.procedure_id) : null } : {}),
      starts_at: startsAt,
      duration_min: duracao,
      ...(input.room !== undefined ? { room: resolveSala(input.room) } : {}),
      ...(input.notes !== undefined ? { notes: String(input.notes ?? '').trim() || null } : {}),
      is_fit_in: encaixe,
    });
    appointmentRepository.addEvent({
      appointment_id: id,
      event: mudouHorario ? 'reagendado' : 'editado',
      from_starts_at: atual.starts_at,
      to_starts_at: startsAt,
      from_status: atual.status,
      to_status: atual.status,
      notes: encaixe === 1 && choque ? `Encaixe sobre ${choque.conflito.patient_name}.` : (String(input.notes ?? '').trim() || null),
      user_id: req.user?.id ?? null,
    });
  });

  const row = appointmentRepository.findDetail(id)!;
  audit(req, 'editar', 'odonto_appointment', id, {
    starts_at: atual.starts_at, duration_min: atual.duration_min, professional_id: atual.professional_id, status: atual.status,
  }, {
    starts_at: row.starts_at, duration_min: row.duration_min, professional_id: row.professional_id,
    status: row.status, reagendado: mudouHorario,
  });
  return { ok: true, data: saida(row) };
}

// ─────────────────────────────── Situação ───────────────────────────────

export function changeAppointmentStatus(
  req: Request,
  id: number,
  novo: unknown,
  motivo?: unknown,
): Result<AppointmentOutput> {
  assertAuth(req);
  const atual = appointmentRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Agendamento não encontrado.', status: 404 };

  const status = String(novo ?? '') as AppointmentStatus;
  if (!STATUS.includes(status)) {
    return { ok: false, error: `Situação inválida. Use: ${STATUS.join(', ')}.`, status: 400 };
  }
  if (status === atual.status) {
    return { ok: false, error: `O agendamento já está como ${status}.`, status: 400 };
  }
  if (!TRANSICOES[atual.status].includes(status)) {
    return {
      ok: false,
      status: 400,
      error: `De "${atual.status}" não dá para ir para "${status}".`,
    };
  }

  // Carimbo de tempo por situação: é o que permite medir espera e atraso depois.
  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const carimbos: Partial<Record<AppointmentStatus, Record<string, string>>> = {
    confirmado: { confirmed_at: agora },
    em_atendimento: { started_at: agora },
    atendido: { finished_at: agora },
    cancelado: { cancelled_at: agora },
  };

  appointmentRepository.transaction(() => {
    appointmentRepository.update(id, {
      status,
      ...(carimbos[status] ?? {}),
      ...(status === 'cancelado'
        ? { cancel_reason: String(motivo ?? '').trim().slice(0, 200) || null }
        : {}),
    });
    appointmentRepository.addEvent({
      appointment_id: id,
      event: EVENTO_POR_STATUS[status],
      from_status: atual.status,
      to_status: status,
      notes: status === 'cancelado' ? (String(motivo ?? '').trim() || null) : (String(motivo ?? '').trim() || null),
      user_id: req.user?.id ?? null,
    });
  });

  const row = appointmentRepository.findDetail(id)!;
  audit(req, 'editar', 'odonto_appointment', id, { status: atual.status }, { status: row.status, motivo: String(motivo ?? '') || null });
  return { ok: true, data: saida(row) };
}

/** Remove um agendamento lançado por engano (soft delete). Histórico continua no banco. */
export function removeAppointment(req: Request, id: number): Result<{ ok: true }> {
  assertAuth(req);
  const atual = appointmentRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Agendamento não encontrado.', status: 404 };
  if (atual.status === 'atendido') {
    return { ok: false, error: 'Atendimento realizado não pode ser apagado — registre o ocorrido na evolução.', status: 400 };
  }
  appointmentRepository.softDelete(id);
  audit(req, 'excluir', 'odonto_appointment', id, { starts_at: atual.starts_at, status: atual.status }, null);
  return { ok: true, data: { ok: true } };
}

/**
 * Contrato exposto a outros módulos: o prontuário (Fase 4) e o plano de tratamento (Fase 6)
 * vão querer saber o que está marcado para o paciente.
 */
export interface OdontoAgendaService {
  listPeriod(from: string, to: string, patientId?: number): AppointmentOutput[];
  nextForPatient(patientId: number): AppointmentOutput | null;
}

export const odontoAgendaService: OdontoAgendaService = {
  listPeriod: (from, to, patientId) => appointmentRepository.listPeriod({ from, to, patientId }).map(saida),
  nextForPatient: (patientId) => {
    const hoje = new Date().toISOString().slice(0, 10);
    const proximos = appointmentRepository.listPeriod({
      from: `${hoje} 00:00`, to: '9999-12-31 23:59', patientId,
    }).filter((a) => a.status === 'agendado' || a.status === 'confirmado');
    return proximos.length ? saida(proximos[0]) : null;
  },
};
