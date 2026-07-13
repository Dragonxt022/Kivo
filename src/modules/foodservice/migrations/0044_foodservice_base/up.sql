CREATE TABLE kitchen_routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  station TEXT,
  estimated_minutes INTEGER,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Marca quais produtos geram ticket de cozinha ao serem pedidos/vendidos, com estação e tempo estimado opcionais.',
  UNIQUE(product_id)
);

CREATE TABLE kitchen_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sale','comanda')),
  source_id INTEGER NOT NULL,
  table_label TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ticket de producao — 1 por venda direta ou por pedido de comanda com ao menos 1 item roteado para a cozinha.'
);

CREATE TABLE kitchen_ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  notes TEXT,
  station TEXT,
  estimated_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item de um ticket de cozinha — snapshot de estacao/tempo estimado no momento do pedido.'
);
CREATE INDEX idx_kitchen_ticket_items_ticket ON kitchen_ticket_items(ticket_id);
