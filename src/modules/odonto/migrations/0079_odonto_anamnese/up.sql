-- 0079_odonto_anamnese — anamnese odontológica versionada (PR §5).
--
-- A PR pede: criar formulário, responder, salvar respostas, consultar histórico e ATUALIZAR
-- O FORMULÁRIO SEM APAGAR RESPOSTAS ANTERIORES. Isso define duas tabelas:
--
--   odonto_anamnesis_templates — o formulário em si, versionado. Mudar uma pergunta cria a
--     versão seguinte; a anterior fica (as respostas antigas apontam para ela).
--   odonto_anamnesis_forms     — cada resposta preenchida, também versionada por revisão:
--     salvar de novo NÃO sobrescreve, cria a revisão seguinte. O histórico do que foi
--     respondido quando é dado clínico e não pode ser reescrito (PR §24.3).
--
-- Como o resto do módulo, nada aqui entra em `syncTables`: dado clínico fica na máquina que
-- o produziu (doc/KIVO_ODONTO_ARCHITECTURE_AUDIT.md §10 e §19).
CREATE TABLE odonto_anamnesis_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  -- Definição dos campos: [{ key, label, type, required, options, help }]. Fica em JSON
  -- porque a PR exige estrutura flexível: pergunta nova não pode exigir migration.
  fields_json TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Formulário de anamnese odontológica, versionado: cada alteração nas perguntas cria uma versão nova e as respostas antigas continuam apontando para a versão em que foram dadas. Só um é o padrão do consultório.'
);
CREATE UNIQUE INDEX idx_odonto_anamnesis_templates_nome_versao
  ON odonto_anamnesis_templates(name, version) WHERE deleted_at IS NULL;
CREATE INDEX idx_odonto_anamnesis_templates_active ON odonto_anamnesis_templates(active);

CREATE TABLE odonto_anamnesis_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  template_id INTEGER NOT NULL REFERENCES odonto_anamnesis_templates(id),
  -- Versão do formulário no momento da resposta (congelada, mesmo que o template mude).
  template_version INTEGER NOT NULL,
  -- Revisão da resposta daquele paciente: 1, 2, 3... Salvar de novo cria a próxima.
  revision INTEGER NOT NULL DEFAULT 1,
  -- Respostas: { chave_do_campo: valor }. Validadas contra o template no serviço.
  answers_json TEXT NOT NULL,
  professional_id INTEGER REFERENCES odonto_professionals(id),
  filled_by INTEGER REFERENCES users(id),
  filled_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Anamnese respondida para um paciente, em revisões imutáveis: cada salvamento grava uma revisão nova com data, hora, usuário e profissional responsável, preservando o que foi respondido antes (histórico clínico).'
);
CREATE INDEX idx_odonto_anamnesis_forms_patient ON odonto_anamnesis_forms(patient_id, revision DESC);
-- A revisão é do PACIENTE (1, 2, 3...), não do formulário: se o consultório publicar uma
-- versão nova no meio do acompanhamento, a resposta seguinte continua sendo "revisão 4" em
-- vez de voltar para 1 — é assim que a clínica lê o histórico.
CREATE UNIQUE INDEX idx_odonto_anamnesis_forms_revisao
  ON odonto_anamnesis_forms(patient_id, revision) WHERE deleted_at IS NULL;
