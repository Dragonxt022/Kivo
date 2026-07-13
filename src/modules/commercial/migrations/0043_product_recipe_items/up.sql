CREATE TABLE product_recipe_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produced_product_id INTEGER NOT NULL REFERENCES products(id),
  input_product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ficha tecnica: quantidade de insumo consumida do estoque por unidade vendida do produto produzido. Nao gera linha propria em sale_items — so stock_movements — e compoe o cost_cents calculado na venda.'
);
CREATE INDEX idx_recipe_items_produced ON product_recipe_items(produced_product_id) WHERE deleted_at IS NULL;
