-- 0015_commercial_price_lists — listas de preço nomeadas (atacado/varejo/cliente) com
-- faixas por quantidade mínima. No máximo uma lista pode ser "padrão" (aplicada quando
-- a venda não tem cliente com lista própria, ou o cliente não tem entrada para o produto).
CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Listas de preço nomeadas (ex.: Atacado, Varejo, Revenda). No máximo uma é padrão (is_default), usada por faixa de quantidade quando a venda não tem cliente com lista própria ou o cliente não tem entrada para o produto.'
);
CREATE UNIQUE INDEX idx_price_lists_one_default ON price_lists(is_default) WHERE is_default = 1 AND deleted_at IS NULL;

CREATE TABLE price_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  min_qty INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT 'Preço de um produto dentro de uma lista, a partir de uma quantidade mínima (min_qty). min_qty=1 cobre o caso simples (um preço fixo por lista); múltiplas linhas do mesmo produto criam faixas por quantidade dentro da mesma lista.'
);
CREATE UNIQUE INDEX idx_price_list_items_unique ON price_list_items(price_list_id, product_id, min_qty);
CREATE INDEX idx_price_list_items_product ON price_list_items(product_id);

ALTER TABLE customers ADD COLUMN price_list_id INTEGER REFERENCES price_lists(id);
CREATE INDEX idx_customers_price_list ON customers(price_list_id);
