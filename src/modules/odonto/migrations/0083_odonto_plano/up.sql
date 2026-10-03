-- 0083_odonto_plano — plano de tratamento e a ponte para o financeiro (PR §11 e §12).
--
-- A PR §12 é taxativa: "não criar um segundo financeiro específico para odontologia". Então
-- aqui NÃO existe tabela de cobrança: o plano aprovado gera contas a receber no financeiro que
-- já existe (`receivables`), pela porta publicada pelo módulo `finance`
-- (`finance.receivables.create`), com parcelamento (`installment_no`/`installment_count`).
-- O que fica gravado aqui é o PLANO e o rastro de que ele foi cobrado (`charged_at`), para não
-- gerar a mesma cobrança duas vezes.
CREATE TABLE odonto_treatment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  -- Profissional responsável pelo plano (a PR pede profissional por item e no plano).
  professional_id INTEGER REFERENCES odonto_professionals(id),
  title TEXT,
  -- Situações da PR §11.
  status TEXT NOT NULL DEFAULT 'planejado'
    CHECK (status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento', 'concluido', 'cancelado')),
  notes TEXT,
  presented_at TEXT,
  approved_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  -- Cobrança gerada no financeiro (parcelamento escolhido na hora de cobrar).
  charged_at TEXT,
  installments INTEGER,
  first_due_date TEXT,
  -- Snapshot de quem assinou o plano (mesma razão do prontuário: documento não muda depois).
  professional_name_snapshot TEXT,
  professional_cro_snapshot TEXT,
  created_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Plano de tratamento odontológico: itens com procedimento, dente, valor e quantidade, com situação (planejado, apresentado, aprovado, em andamento, concluído, cancelado). O plano aprovado gera contas a receber no financeiro existente do Kivo, com parcelamento — o módulo não tem financeiro próprio.'
);
CREATE INDEX idx_odonto_plans_patient ON odonto_treatment_plans(patient_id, status);

CREATE TABLE odonto_treatment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES odonto_treatment_plans(id),
  procedure_id INTEGER REFERENCES odonto_procedures(id),
  -- Dente (FDI) quando o item é de um dente específico. Item de boca toda não tem dente.
  tooth TEXT,
  description TEXT NOT NULL,
  -- Valor UNITÁRIO em centavos; o total do item é amount_cents * quantity.
  amount_cents INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  professional_id INTEGER REFERENCES odonto_professionals(id),
  status TEXT NOT NULL DEFAULT 'planejado'
    CHECK (status IN ('planejado', 'aprovado', 'em_andamento', 'concluido', 'cancelado')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Item de plano de tratamento odontológico: procedimento, dente (FDI), descrição, valor unitário em centavos, quantidade, profissional responsável e situação própria. O total do item é valor x quantidade.'
);
CREATE INDEX idx_odonto_treatment_items_plan ON odonto_treatment_items(plan_id, sort_order);
CREATE INDEX idx_odonto_treatment_items_tooth ON odonto_treatment_items(plan_id, tooth);
