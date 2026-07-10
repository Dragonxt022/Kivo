-- 0018_commercial_customer_balances — CEP, saldos derivados (crédito de troca e
-- pontos de fidelidade) e vínculo opcional com uma empresa conveniada.
ALTER TABLE customers ADD COLUMN cep TEXT;
ALTER TABLE customers ADD COLUMN store_credit_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN agreement_company_id INTEGER REFERENCES agreement_companies(id);
CREATE INDEX idx_customers_agreement_company ON customers(agreement_company_id);
