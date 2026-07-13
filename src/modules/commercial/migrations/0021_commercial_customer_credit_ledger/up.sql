-- 0019_commercial_customer_credit_ledger — livro-razão do crédito de troca (vale por
-- devolução). customers.store_credit_cents é sempre derivado destas linhas (nunca
-- editado direto), mesmo padrão de stock_movements/products.stock_qty.
CREATE TABLE customer_credit_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('concessao', 'resgate', 'estorno_resgate', 'estorno_ganho')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  ref_entity TEXT,
  ref_id TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  origin_machine TEXT,
  synced_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Livro-razão do crédito de troca (append-only): concessão (devolução), resgate (uso em compra), estorno_resgate (devolve saldo gasto) e estorno_ganho (remove saldo concedido). store_credit_cents do cliente é sempre reconstruído a partir destas linhas.'
);
CREATE INDEX idx_customer_credit_customer ON customer_credit_movements(customer_id, created_at);
