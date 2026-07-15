-- 0049_add_complemento_product_type — Adiciona 'complemento' ao CHECK de product_type
-- SQLite não suporta ALTER CHECK; recriar a tabela

CREATE TABLE products_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  barcode TEXT,
  category_id INTEGER REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT 'un',
  price_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 1,
  stock_qty REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Catálogo de produtos: preço e custo em centavos, unidade, código de barras e saldo de estoque (stock_qty é mantido pelas movimentações, nunca editado direto).',
  favorite INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  product_type TEXT NOT NULL DEFAULT 'fisico'
    CHECK (product_type IN ('fisico','variante','fracionado','composto','kit','combo','produzido','servico','digital','assinatura','complemento')),
  parent_product_id INTEGER REFERENCES products(id),
  visivel_cardapio INTEGER NOT NULL DEFAULT 0
);

INSERT INTO products_new SELECT * FROM products;

DROP TABLE products;

ALTER TABLE products_new RENAME TO products;

-- Recriar índices (sqlite_autoindex_products_1 é recriado automaticamente para uuid UNIQUE)
CREATE INDEX idx_products_name ON products(name);
CREATE UNIQUE INDEX idx_products_sku_unique ON products(sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE UNIQUE INDEX idx_products_barcode_unique ON products(barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_barcode ON products(barcode);
