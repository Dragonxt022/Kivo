-- 0084_odonto_documentos — documentos do paciente e modelos com variáveis (PR §14 e §15).
--
-- Duas decisões que a PR pede:
--
--  §15: "estrutura de templates... isso permitirá criar documentos sem precisar programar cada
--       documento individualmente". Então o MODELO é uma linha em `odonto_document_templates`
--       com o corpo em texto e variáveis `{{paciente.nome}}`; os onze tipos da §14 (TCLE,
--       contrato, atestado, receita, encaminhamento, alta, termo de recusa...) são só conteúdo
--       semeado, e a clínica cria os seus sem código novo.
--
--  §14: o documento é vinculado ao paciente e à consulta, pode ser gerado, visualizado,
--       impresso e exportado em PDF. O corpo é gravado JÁ RENDERIZADO (snapshot): mudar o
--       modelo depois NÃO altera o documento que já saiu, e o que ficou sem valor é registrado
--       em `missing_variables_json` para a tela avisar em vez de imprimir um documento furado.
--
-- Emitido não se edita: para corrigir, gera-se a VERSÃO SEGUINTE ligada à anterior (mesma
-- filosofia do prontuário — documento assinado não muda em silêncio).
CREATE TABLE odonto_document_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  name TEXT NOT NULL,
  -- Tipos da PR §14. 'outro' cobre documento personalizado da clínica.
  type TEXT NOT NULL CHECK (type IN (
    'anamnese', 'plano_tratamento', 'tcle', 'contrato', 'atestado', 'declaracao',
    'encaminhamento', 'receita', 'termo_responsabilidade', 'termo_recusa', 'alta', 'outro')),
  body TEXT NOT NULL,
  -- Variáveis encontradas no corpo, guardadas para a tela listar sem reparsear.
  variables_json TEXT,
  -- Receita e atestado só valem com profissional e CRO: exige na emissão.
  requires_professional INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  -- Modelos que vieram com o sistema (não são apagados, só desativados/editados).
  is_system INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Modelo de documento odontológico: nome, tipo, corpo com variáveis {{paciente.nome}}, {{profissional.cro}}, {{data}}... e situação. É tabela, não código: a clínica cria os seus documentos (TCLE, receita, atestado, contrato) sem programar.'
);
CREATE UNIQUE INDEX idx_odonto_doc_templates_code ON odonto_document_templates(code) WHERE deleted_at IS NULL AND code IS NOT NULL;
CREATE INDEX idx_odonto_doc_templates_tipo ON odonto_document_templates(type, active, sort_order);

CREATE TABLE odonto_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  -- Vínculo com a consulta (a PR §14 pede) e com o plano (documento nasce do orçamento).
  appointment_id INTEGER REFERENCES odonto_appointments(id),
  plan_id INTEGER REFERENCES odonto_treatment_plans(id),
  template_id INTEGER REFERENCES odonto_document_templates(id),
  type TEXT NOT NULL CHECK (type IN (
    'anamnese', 'plano_tratamento', 'tcle', 'contrato', 'atestado', 'declaracao',
    'encaminhamento', 'receita', 'termo_responsabilidade', 'termo_recusa', 'alta', 'outro')),
  title TEXT NOT NULL,
  -- Corpo JÁ RENDERIZADO (snapshot do que foi entregue ao paciente).
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'emitido', 'cancelado')),
  version INTEGER NOT NULL DEFAULT 1,
  -- Versão anterior que este documento substitui, e quem o substituiu (cadeia de revisões).
  replaces_id INTEGER REFERENCES odonto_documents(id),
  replaced_by_id INTEGER REFERENCES odonto_documents(id),
  -- Variáveis que ficaram sem valor na geração (a tela avisa antes de emitir).
  missing_variables_json TEXT,
  professional_id INTEGER REFERENCES odonto_professionals(id),
  professional_name_snapshot TEXT,
  professional_cro_snapshot TEXT,
  issued_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Documento do paciente (TCLE, receita, atestado, contrato, encaminhamento, alta...), com o texto já renderizado no momento da geração e vínculo com a consulta e com o plano de tratamento. Rascunho pode ser editado; emitido não muda — corrige-se gerando a versão seguinte, que fica ligada à anterior.'
);
CREATE INDEX idx_odonto_documents_patient ON odonto_documents(patient_id, status);
CREATE INDEX idx_odonto_documents_appointment ON odonto_documents(appointment_id);
