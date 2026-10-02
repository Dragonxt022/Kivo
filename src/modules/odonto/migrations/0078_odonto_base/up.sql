-- 0078_odonto_base — módulo odonto: fundação (paciente, profissional, procedimento).
--
-- Regras do projeto: dinheiro em centavos (INTEGER), soft delete via deleted_at, toda
-- tabela tem coluna `comment` descrevendo o objetivo.
--
-- NENHUMA tabela deste módulo entra em `syncTables` nesta versão: dado clínico fica na
-- máquina que o produziu. A decisão está registrada em
-- doc/KIVO_ODONTO_ARCHITECTURE_AUDIT.md (seções 10 e 19) — sincronizar prontuário exige
-- antes resolver conflito de escrita e exposição do dado no MySQL do cloud.

-- Paciente do consultório. É SEMPRE ancorado num cliente (`customers`): a cobrança do
-- tratamento (`receivables.customer_id`), o convênio e a lista de preço vivem lá. Aqui fica
-- só o que é específico do atendimento odontológico — nome, documento, contato e data de
-- nascimento NÃO se repetem aqui: são `customers.name/document/phone/email/birthday`
-- (uma verdade só para aniversariante, extrato e cobrança). O `UNIQUE` de customer_id é de
-- aplicação, não de schema: um paciente excluído (soft delete) pode ser recadastrado.
CREATE TABLE odonto_patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sex TEXT CHECK (sex IN ('feminino', 'masculino', 'outro', 'nao_informado')),
  rg TEXT,
  photo_file TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Paciente do consultório odontológico: ficha de atendimento de um cliente (customers). Guarda sexo, RG, foto e observações do paciente, e liga o paciente à cobrança e ao convênio que já existem no cadastro de cliente.'
);
CREATE INDEX idx_odonto_patients_customer ON odonto_patients(customer_id);
CREATE INDEX idx_odonto_patients_active ON odonto_patients(active);

-- Ficha clínica do paciente, separada de propósito do cadastro: alergia, histórico médico e
-- medicação são dado sensível de saúde e só podem ser lidos/gravados por quem tem
-- `odonto.clinical.view` / `odonto.clinical.edit` — a Recepção cuida do cadastro sem ver
-- clínica (PR §19). Uma linha por paciente.
CREATE TABLE odonto_patient_clinical (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL UNIQUE REFERENCES odonto_patients(id),
  medical_history TEXT,
  dental_history TEXT,
  allergies TEXT,
  medications TEXT,
  conditions TEXT,
  clinical_notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Ficha clínica do paciente odontológico (histórico médico e odontológico, alergias, medicamentos, condições relevantes). Separada do cadastro porque é dado sensível de saúde: exige permissão clínica própria, não a permissão de cadastro.'
);

-- Profissional que atende: dentista ou auxiliar. `user_id` liga ao usuário do sistema quando
-- ele também opera o Kivo; o CRO é o dado profissional exigido pela PR §24.5 e vai assinar
-- evolução e documento nas fases seguintes.
CREATE TABLE odonto_professionals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  cro TEXT,
  cro_state TEXT,
  specialties TEXT,
  phone TEXT,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Profissional que atende no consultório (dentista, auxiliar, técnico): nome, CRO/UF, especialidades e contato. Vinculado opcionalmente a um usuário do sistema. Usado pela agenda, pela evolução clínica e pelos documentos.'
);
CREATE INDEX idx_odonto_professionals_active ON odonto_professionals(active);
CREATE INDEX idx_odonto_professionals_cro ON odonto_professionals(cro, cro_state);

-- Procedimento odontológico. `product_id` liga ao catálogo existente do commercial quando o
-- procedimento também é vendido/estocado (um serviço em `products`), evitando dois preços
-- para a mesma coisa. Sem product_id é um procedimento só clínico (ex.: avaliação inicial).
CREATE TABLE odonto_procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  code TEXT,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  default_price_cents INTEGER NOT NULL DEFAULT 0,
  duration_min INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Catálogo de procedimentos odontológicos do consultório: código interno, nome, categoria, valor padrão em centavos e duração estimada. Liga-se opcionalmente a um produto/serviço do catálogo comercial para não duplicar preço.'
);
CREATE INDEX idx_odonto_procedures_active ON odonto_procedures(active);
CREATE UNIQUE INDEX idx_odonto_procedures_code ON odonto_procedures(code) WHERE code IS NOT NULL AND deleted_at IS NULL;
