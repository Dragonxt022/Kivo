-- 0094_kitchen_item_takeaway — permite marcar "viagem" por item no ticket da cozinha.
-- O ticket continua com service_type (local/viagem) para o caso homogêneo; em pedidos
-- mistos o KDS mostra a tag por item para não embalar o prato errado.
ALTER TABLE kitchen_ticket_items ADD COLUMN para_viagem INTEGER NOT NULL DEFAULT 0;
