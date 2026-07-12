-- 0033_product_variants — variantes de produto (tamanho, cor, atributos).
ALTER TABLE products ADD COLUMN parent_product_id INTEGER REFERENCES products(id);

CREATE TABLE product_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Tipos de atributo de variante (Tamanho, Cor, ...), reutilizáveis entre produtos.'
);

CREATE TABLE product_attribute_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id INTEGER NOT NULL REFERENCES product_attributes(id),
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Valores possíveis de um atributo (ex.: P/M/G para Tamanho).'
);

CREATE TABLE product_variant_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  attribute_id INTEGER NOT NULL REFERENCES product_attributes(id),
  attribute_value_id INTEGER NOT NULL REFERENCES product_attribute_values(id),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Liga uma variante ao seu valor de cada atributo (ex.: produto X -> Tamanho=M, Cor=Azul).',
  UNIQUE(product_id, attribute_id)
);
