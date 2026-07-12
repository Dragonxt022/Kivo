CREATE TABLE kit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_product_id INTEGER NOT NULL REFERENCES products(id),
  component_product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Componente fixo incluído automaticamente na venda de um kit/combo — linha gerada a preço zero (já cobrado no cabeçalho do kit), custo real preservado para o DRE.'
);
CREATE INDEX idx_kit_items_kit ON kit_items(kit_product_id) WHERE deleted_at IS NULL;
