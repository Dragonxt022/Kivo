-- 0096_maisdelivery_delivery_tickets — pedidos do marketplace (Mais Delivery) entram na cozinha.
-- 1) O ticket de cozinha passa a aceitar source_type='delivery': um ticket por pedido do
--    marketplace (source_id = idPedido), com os itens originais — sem roteamento por produto,
--    porque produtos do marketplace não são o catálogo do Kivo.
-- 2) `kitchen_ticket_items.product_id` fica NULLABLE pela mesma razão (produtos do marketplace não são catálogo).
-- CHECK constraint no SQLite só muda com rebuild de tabela (mesmo padrão da 0062).

-- ── 1) itens: product_id deixa de ser NOT NULL (mantém a FK quando houver produto) ──
CREATE TABLE kitchen_ticket_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  notes TEXT,
  station TEXT,
  estimated_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item de um ticket de cozinha — snapshot de estacao/tempo estimado no momento do pedido.',
  complements TEXT,
  para_viagem INTEGER NOT NULL DEFAULT 0,
  comanda_item_id INTEGER
);
INSERT INTO kitchen_ticket_items_new (
    id, ticket_id, product_id, product_name, qty, notes, station, estimated_minutes,
    status, uuid, updated_at, deleted_at, synced_at, origin_machine,
    complements, para_viagem, comanda_item_id
  )
  SELECT
    id, ticket_id, product_id, product_name, qty, notes, station, estimated_minutes,
    status, uuid, updated_at, deleted_at, synced_at, origin_machine,
    complements, para_viagem, comanda_item_id
  FROM kitchen_ticket_items;
DROP TABLE kitchen_ticket_items;
ALTER TABLE kitchen_ticket_items_new RENAME TO kitchen_ticket_items;
CREATE INDEX idx_kitchen_ticket_items_ticket ON kitchen_ticket_items(ticket_id);

-- ── 2) tickets: source_type passa a aceitar 'delivery' ──
CREATE TABLE kitchen_tickets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sale','comanda','delivery')),
  source_id INTEGER NOT NULL,
  table_label TEXT,
  service_type TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue','cancelado')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ticket de producao — venda direta, pedido de comanda ou pedido do marketplace (Mais Delivery).'
);
INSERT INTO kitchen_tickets_new (
    id, source_type, source_id, table_label, service_type, status,
    uuid, updated_at, created_at, acknowledged_at, deleted_at, synced_at, origin_machine, comment
  )
  SELECT
    id, source_type, source_id, table_label,
    COALESCE(service_type, 'local'),
    status, uuid, updated_at, created_at, acknowledged_at, deleted_at, synced_at, origin_machine, comment
  FROM kitchen_tickets;
DROP TABLE kitchen_tickets;
ALTER TABLE kitchen_tickets_new RENAME TO kitchen_tickets;
