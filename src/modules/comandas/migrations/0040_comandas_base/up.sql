CREATE TABLE store_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'livre' CHECK (status IN ('livre','ocupada')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Mesa fisica — status reflete se ha uma comanda aberta vinculada.'
);

CREATE TABLE comandas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER REFERENCES store_tables(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada','cancelada')),
  opened_by INTEGER REFERENCES users(id),
  sale_id INTEGER REFERENCES sales(id),
  notes TEXT,
  closed_at TEXT,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Pre-venda aberta numa mesa ou balcao. Ao fechar vira uma venda normal (sale_id) — Financeiro/DRE nao sabem que existiu comanda.'
);

CREATE TABLE comanda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  notes TEXT,
  line_group_uuid TEXT,
  added_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item pedido numa comanda aberta — preco ja congelado via resolvePrice no momento do pedido; vira sale_items so ao fechar a comanda.'
);
CREATE INDEX idx_comanda_items_comanda ON comanda_items(comanda_id) WHERE deleted_at IS NULL;
