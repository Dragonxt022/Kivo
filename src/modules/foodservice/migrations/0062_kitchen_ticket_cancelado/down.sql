-- Reverte: status 'cancelado' vira 'entregue' (não cabe no CHECK antigo) e as colunas
-- novas somem. Tickets cancelados eram pedidos que não saíram — marcá-los entregue no
-- rollback é perda cosmética de histórico, não operacional.
ALTER TABLE kitchen_ticket_items DROP COLUMN comanda_item_id;
CREATE TABLE kitchen_tickets_down (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sale','comanda')),
  source_id INTEGER NOT NULL,
  table_label TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ticket de producao — 1 por venda direta ou por pedido de comanda com ao menos 1 item roteado para a cozinha.'
);
INSERT INTO kitchen_tickets_down (id, source_type, source_id, table_label, status, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)
  SELECT id, source_type, source_id, table_label, CASE WHEN status = 'cancelado' THEN 'entregue' ELSE status END, uuid, updated_at, deleted_at, synced_at, origin_machine, comment FROM kitchen_tickets;
DROP TABLE kitchen_tickets;
ALTER TABLE kitchen_tickets_down RENAME TO kitchen_tickets;
