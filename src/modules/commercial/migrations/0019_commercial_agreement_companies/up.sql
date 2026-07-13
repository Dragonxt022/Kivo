-- 0017_commercial_agreement_companies — empresas conveniadas: clientes vinculados a
-- uma empresa têm suas compras faturadas mensalmente pra empresa, não pagas na hora.
CREATE TABLE agreement_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  document TEXT,
  billing_day INTEGER NOT NULL DEFAULT 5 CHECK (billing_day BETWEEN 1 AND 31),
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Empresas conveniadas: clientes vinculados (customers.agreement_company_id) têm compras a convênio acumuladas e faturadas mensalmente no billing_day (dia fixo do mês), em vez de cobradas na hora.'
);
