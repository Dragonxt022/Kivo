-- 0068_store_sale_returns — devolução parcial de venda e motivo do desconto.
-- discount_reason: texto livre gravado junto do desconto/acréscimo da venda (auditoria).
-- sale_returns/sale_return_items: registro append-only de devoluções (totais ou parciais).
-- A devolução recompõe estoque (stock_movements com ref_entity='sale_return') e, quando
-- pedida, devolve o valor em dinheiro (caixa) ou crédito de loja. A venda original não é
-- alterada: o histórico mostra o que foi vendido e o que foi devolvido.
ALTER TABLE sales ADD COLUMN discount_reason TEXT;

CREATE TABLE sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  customer_id INTEGER REFERENCES customers(id),
  refund_method TEXT NOT NULL DEFAULT 'nenhum' CHECK (refund_method IN ('nenhum', 'dinheiro', 'credito_loja')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Devoluções (totais ou parciais) de itens de uma venda: recompõe o estoque e, opcionalmente, devolve em dinheiro ou crédito de loja.'
);
CREATE INDEX idx_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE sale_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Itens devolvidos de uma venda, com quantidade e valor unitário da devolução.'
);
CREATE INDEX idx_sale_return_items_return ON sale_return_items(return_id);
CREATE INDEX idx_sale_return_items_sale ON sale_return_items(sale_id);
