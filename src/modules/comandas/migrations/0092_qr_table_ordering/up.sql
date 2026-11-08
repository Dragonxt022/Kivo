-- 0092_qr_table_ordering — pedido feito pelo cliente escaneando o QR da mesa.
--
-- O pedido entra como uma rodada (`qr_orders`) PENDENTE: os itens vão para a comanda
-- para o garçom revisar, mas NÃO são enviados à cozinha até ele confirmar. Isso evita
-- que uma criança/brincadeira no celular vire pedido no KDS.
--
-- `store_tables.qr_token` guarda o token em claro porque a tela precisa reexibir o
-- mesmo QR sem rotacionar. O Cloud guarda apenas o sha256 (menu_table_tokens).
ALTER TABLE store_tables ADD COLUMN qr_token TEXT;
ALTER TABLE store_tables ADD COLUMN qr_updated_at TEXT;

CREATE TABLE qr_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uuid TEXT NOT NULL UNIQUE,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','confirmado','recusado')),
  cloud_order_id TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Rodada de pedido feita pelo cliente via QR na mesa — fica pendente até o garçom confirmar e só então os itens vão para a cozinha.'
);
CREATE INDEX idx_qr_orders_comanda ON qr_orders(comanda_id, status) WHERE deleted_at IS NULL;

-- `para_viagem`: o cliente está no local, mas o item é embalado para levar. Adicionais
-- herdam o flag do principal e nunca são marcados separadamente.
ALTER TABLE comanda_items ADD COLUMN para_viagem INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comanda_items ADD COLUMN origem TEXT NOT NULL DEFAULT 'garcom';
-- Vínculo com a rodada de QR. Sem FK no SQLite para não exigir rebuild da tabela;
-- a integridade é garantida pelo serviço que cria os dois na mesma transação.
ALTER TABLE comanda_items ADD COLUMN qr_order_id INTEGER;
