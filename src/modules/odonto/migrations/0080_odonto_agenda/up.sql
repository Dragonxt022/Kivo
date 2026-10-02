-- 0080_odonto_agenda — agenda do consultório (PR §6).
--
-- A agenda é do ODONTO: não existe agenda no Core e as outras telas do sistema não têm
-- horário marcado. Como o resto do módulo, nada aqui entra em `syncTables` (dado de
-- atendimento com paciente identificado fica na máquina — auditoria §10 e §19).
--
-- Duas tabelas, de propósito:
--   odonto_appointments      — o estado ATUAL do agendamento (uma linha por atendimento);
--   odonto_appointment_events — histórico append-only (criado, reagendado, confirmado, em
--     atendimento, atendido, faltou, cancelado). Reagendar NÃO cria agendamento novo: move o
--     mesmo e registra de/para. Assim a agenda do dia não enche de linha cancelada e o
--     histórico de "quantas vezes esse paciente remarcou" continua existindo.
CREATE TABLE odonto_appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  professional_id INTEGER NOT NULL REFERENCES odonto_professionals(id),
  procedure_id INTEGER REFERENCES odonto_procedures(id),
  -- Data e hora de início, no formato 'YYYY-MM-DD HH:MM' (o mesmo das outras tabelas).
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado', 'confirmado', 'em_atendimento', 'atendido', 'faltou', 'cancelado')),
  -- Sala/cadeira, quando o consultório controla isso (PR §6).
  room TEXT,
  notes TEXT,
  -- Encaixe: entrou fora do horário normal, então PODE sobrepor outro atendimento do mesmo
  -- profissional (é a razão de existir). Sem esta marca, a sobreposição é recusada.
  is_fit_in INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  cancelled_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Agendamento odontológico: paciente, profissional, procedimento, data/hora, duração, sala e situação (agendado, confirmado, em atendimento, atendido, faltou, cancelado). Encaixe é marcado e pode sobrepor outro atendimento do mesmo profissional.'
);
CREATE INDEX idx_odonto_appointments_periodo ON odonto_appointments(starts_at, status);
CREATE INDEX idx_odonto_appointments_profissional ON odonto_appointments(professional_id, starts_at);
CREATE INDEX idx_odonto_appointments_paciente ON odonto_appointments(patient_id, starts_at);

CREATE TABLE odonto_appointment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES odonto_appointments(id),
  event TEXT NOT NULL CHECK (event IN (
    'criado', 'reagendado', 'confirmado', 'em_atendimento', 'atendido', 'faltou',
    'cancelado', 'reativado', 'encaixe', 'editado'
  )),
  from_starts_at TEXT,
  to_starts_at TEXT,
  from_status TEXT,
  to_status TEXT,
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Histórico do agendamento odontológico (append-only): cada criação, reagendamento, confirmação, início e fim de atendimento, falta, cancelamento ou reativação vira uma linha, com o de/para e quem fez.'
);
CREATE INDEX idx_odonto_appointment_events_appointment ON odonto_appointment_events(appointment_id, id);
