-- 0036_product_complements — grupos de opcionais/complementos por produto.
CREATE TABLE complement_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Grupo de opcionais reutilizavel (ex.: Molhos) — min/max controlam obrigatoriedade e limite de selecao.'
);

CREATE TABLE complement_group_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES complement_groups(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_override_cents INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Opcao dentro de um grupo — reaproveita um produto existente como item selecionavel.'
);

CREATE TABLE product_complement_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  group_id INTEGER NOT NULL REFERENCES complement_groups(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Liga um grupo de complementos a um produto vendavel.',
  UNIQUE(product_id, group_id)
);

ALTER TABLE sale_items ADD COLUMN notes TEXT;
ALTER TABLE sale_items ADD COLUMN line_group_uuid TEXT;
