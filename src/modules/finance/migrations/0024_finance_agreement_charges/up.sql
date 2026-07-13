-- 0022_finance_agreement_charges — cobranças pendentes de convênio: cada venda paga
-- via convênio gera uma linha aqui (sem mexer em caixa/recebível na hora). O
-- fechamento mensal consolida as linhas com invoiced_at NULL numa única receivables.
CREATE TABLE agreement_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  agreement_company_id INTEGER NOT NULL REFERENCES agreement_companies(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  invoiced_at TEXT,
  receivable_id INTEGER REFERENCES receivables(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Cobranças pendentes de convênio, uma por venda. Ficam sem invoiced_at até o fechamento mensal consolidá-las numa única receivables (fatura da empresa). Uma cobrança ainda não faturada pode ser estornada (soft delete) se a venda for cancelada.'
);
CREATE INDEX idx_agreement_charges_company ON agreement_charges(agreement_company_id, invoiced_at);
CREATE INDEX idx_agreement_charges_sale ON agreement_charges(sale_id);
