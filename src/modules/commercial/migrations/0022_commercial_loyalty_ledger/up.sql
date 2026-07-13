-- 0020_commercial_loyalty_ledger — livro-razão dos pontos de fidelidade.
-- customers.loyalty_points é sempre derivado destas linhas, mesmo padrão de 0019.
CREATE TABLE loyalty_point_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('ganho', 'resgate', 'estorno_resgate', 'estorno_ganho')),
  points INTEGER NOT NULL CHECK (points > 0),
  balance_after INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  ref_entity TEXT,
  ref_id TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  origin_machine TEXT,
  synced_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Livro-razão dos pontos de fidelidade (append-only): ganho (por venda), resgate (desconto em compra), estorno_resgate (devolve pontos gastos) e estorno_ganho (remove pontos ganhos). loyalty_points do cliente é sempre reconstruído a partir destas linhas.'
);
CREATE INDEX idx_loyalty_points_customer ON loyalty_point_movements(customer_id, created_at);
