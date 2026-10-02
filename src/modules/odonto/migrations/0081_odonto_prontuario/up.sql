-- 0081_odonto_prontuario — evolução clínica com retificação versionada (PR §7 e §8).
--
-- A PR §8 é explícita: "Registros clínicos não devem ser simplesmente apagados. Quando houver
-- necessidade de correção, deverá existir mecanismo de retificação, histórico, registro do
-- usuário, data/hora e motivo da alteração." E manda decidir a implementação ANTES de criar as
-- tabelas. A decisão está aqui e no doc (src/docs/dev/odonto.md):
--
--   1. Um registro de evolução é IMUTÁVEL enquanto vigente. Corrigir não altera a linha: cria
--      uma linha NOVA (versão seguinte) apontando para a anterior (`retifica_id`), com motivo
--      obrigatório, e marca a anterior como `retificado` (`replaced_by_id` = a nova).
--   2. Nada é apagado. Não existe DELETE de registro clínico no serviço — a API responde 400
--      explicando que o caminho é retificar. O `deleted_at` existe só para o soft delete do
--      PACIENTE (quando a ficha inteira é excluída), seguindo o resto do módulo.
--   3. A versão vigente de cada cadeia é a que tem `status = 'vigente'`. O histórico mostra a
--      cadeia completa (v1 → v2 → v3) com autor, data/hora e motivo de cada retificação.
--   4. Nome e CRO do profissional são gravados como SNAPSHOT: é um documento assinado, e o
--      registro tem de mostrar quem assinou com o CRO daquele momento — se o CRO mudar depois,
--      o que está assinado não muda.
CREATE TABLE odonto_clinical_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  professional_id INTEGER REFERENCES odonto_professionals(id),
  -- Consulta que originou o registro (a agenda da fase 3). Opcional: evolução sem agendamento
  -- (encaixe, retorno espontâneo) também é evolução.
  appointment_id INTEGER REFERENCES odonto_appointments(id),
  -- Data e hora do ATENDIMENTO (não a do cadastro no sistema).
  happened_at TEXT NOT NULL,
  title TEXT,
  -- Procedimentos realizados: [{ procedure_id, name, tooth, note }]. O nome é o snapshot do
  -- catálogo no momento do atendimento.
  procedures_json TEXT NOT NULL DEFAULT '[]',
  observations TEXT,
  diagnosis TEXT,
  conduct TEXT,
  next_steps TEXT,
  -- Vínculos das fases 7 e 8 (documentos e exames): listas de ids em JSON, sem FK porque as
  -- tabelas ainda não existem — o campo já nasce para não precisar de migration depois.
  documents_json TEXT NOT NULL DEFAULT '[]',
  exams_json TEXT NOT NULL DEFAULT '[]',
  -- 'vigente' é o registro válido; 'retificado' é o que foi substituído por uma correção.
  status TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'retificado')),
  version INTEGER NOT NULL DEFAULT 1,
  -- Quem substituiu este registro (preenchido na linha retificada).
  replaced_by_id INTEGER REFERENCES odonto_clinical_notes(id),
  -- Qual registro esta linha retifica (preenchido na linha nova).
  retifica_id INTEGER REFERENCES odonto_clinical_notes(id),
  retification_reason TEXT,
  professional_name_snapshot TEXT,
  professional_cro_snapshot TEXT,
  created_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Evolução clínica do paciente odontológico: data/hora do atendimento, profissional e CRO (snapshot do momento), procedimentos realizados, observações, diagnóstico, conduta e próximos passos. Registro vigente é imutável: correção cria uma versão nova ligada à anterior (retificação com motivo obrigatório), preservando todo o histórico.'
);
CREATE INDEX idx_odonto_clinical_notes_patient ON odonto_clinical_notes(patient_id, happened_at DESC);
CREATE INDEX idx_odonto_clinical_notes_status ON odonto_clinical_notes(patient_id, status);
CREATE INDEX idx_odonto_clinical_notes_appointment ON odonto_clinical_notes(appointment_id);
CREATE INDEX idx_odonto_clinical_notes_cadeia ON odonto_clinical_notes(retifica_id);
