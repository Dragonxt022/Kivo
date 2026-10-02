-- 0082_odonto_odontograma — odontograma, superfícies e situações (PR §9 e §10).
--
-- Duas decisões que a PR pede explicitamente:
--
--  §10: "A arquitetura não deve limitar o sistema a uma lista fixa impossível de expandir."
--       Por isso a SITUAÇÃO é uma TABELA (`odonto_tooth_conditions`), não um ENUM: a clínica
--       cria "selante", "coroa provisória", o que precisar, com cor própria para o desenho.
--       As nove situações iniciais da PR são semeadas no boot e podem ser desativadas.
--
--  §9:  cada dente tem situação, procedimentos, observações, histórico e tratamentos
--       planejados/realizados, com suporte a superfícies (mesial, distal, oclusal,
--       vestibular, lingual/palatina).
--       O estado do dente é registrado em HISTÓRICO APPEND-ONLY: mudar a situação de um dente
--       NÃO sobrescreve nada — grava uma linha nova, e o estado atual é a linha mais recente
--       que não foi desfeita. Corrigir um clique errado é "desfazer" (marca quem e quando),
--       que revela o estado anterior sem apagar o registro. Mesma filosofia do prontuário.
CREATE TABLE odonto_tooth_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Código curto e estável (usado em relatório e no desenho): 'integro', 'carie', 'restaurado'...
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Cor do preenchimento no odontograma (hex).
  color TEXT NOT NULL DEFAULT '#e5e7eb',
  -- Uma situação pode valer para o dente inteiro, para a superfície, ou para os dois.
  applies_to TEXT NOT NULL DEFAULT 'ambos' CHECK (applies_to IN ('dente', 'superficie', 'ambos')),
  -- Situação que representa "nada a registrar" (o dente volta ao normal ao escolhê-la).
  is_neutral INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Catálogo de situações odontológicas do consultório (íntegro, cárie, restaurado, ausente, implante...). É tabela, não lista fixa: a clínica cria novas situações com cor própria para o odontograma.'
);
CREATE UNIQUE INDEX idx_odonto_tooth_conditions_code ON odonto_tooth_conditions(code) WHERE deleted_at IS NULL;
CREATE INDEX idx_odonto_tooth_conditions_active ON odonto_tooth_conditions(active, sort_order);

CREATE TABLE odonto_tooth_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  -- Numeração FDI (ISO 3950) como texto: '18'..'11', '21'..'28', '31'..'38', '48'..'41'.
  tooth TEXT NOT NULL,
  -- Superfície (M, D, O, V, L) ou NULL quando o registro é do dente inteiro.
  surface TEXT CHECK (surface IN ('M', 'D', 'O', 'V', 'L')),
  -- 'situacao' é o que o dente É hoje; 'planejado' é tratamento previsto (a fase 6 transforma
  -- o planejado em plano com valor e cobrança).
  kind TEXT NOT NULL DEFAULT 'situacao' CHECK (kind IN ('situacao', 'planejado')),
  condition_id INTEGER NOT NULL REFERENCES odonto_tooth_conditions(id),
  note TEXT,
  -- Data/hora do exame que originou o registro (relógio de parede, como a agenda).
  recorded_at TEXT NOT NULL,
  professional_id INTEGER REFERENCES odonto_professionals(id),
  professional_name_snapshot TEXT,
  professional_cro_snapshot TEXT,
  created_by INTEGER REFERENCES users(id),
  -- Desfazer um registro errado NÃO apaga: marca quem desfez e quando, e o estado anterior
  -- volta a valer. O registro desfeito continua no histórico.
  undone_at TEXT,
  undone_by INTEGER REFERENCES users(id),
  undo_reason TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Estado de um dente (ou de uma superfície) no odontograma do paciente, em histórico append-only: cada mudança é uma linha nova com data/hora, profissional e CRO do momento; o estado atual é a linha mais recente não desfeita, e desfazer revela o anterior sem apagar nada.'
);
CREATE INDEX idx_odonto_tooth_states_patient ON odonto_tooth_states(patient_id, tooth, surface, kind);
CREATE INDEX idx_odonto_tooth_states_ativos ON odonto_tooth_states(patient_id, undone_at);
