-- O KDS precisava distinguir "ainda vai produzir" de "não vai mais": venda ou comanda
-- cancelada deixava ticket pendente para sempre na tela da cozinha (o CHECK só aceitava
-- pendente/preparo/pronto/entregue). CHECK no SQLite só muda com rebuild de tabela.
CREATE TABLE kitchen_tickets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sale','comanda')),
  source_id INTEGER NOT NULL,
  table_label TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue','cancelado')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ticket de producao — 1 por venda direta ou por pedido de comanda com ao menos 1 item roteado para a cozinha.'
);
INSERT INTO kitchen_tickets_new (id, source_type, source_id, table_label, status, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)
  SELECT id, source_type, source_id, table_label, status, uuid, updated_at, deleted_at, synced_at, origin_machine, comment FROM kitchen_tickets;
DROP TABLE kitchen_tickets;
ALTER TABLE kitchen_tickets_new RENAME TO kitchen_tickets;

-- Idade do ticket no painel ("há X min"): até aqui existia só updated_at, que muda a
-- cada avanço — impossível saber há quanto tempo o pedido chegou.
ALTER TABLE kitchen_ticket_items ADD COLUMN comanda_item_id INTEGER;
