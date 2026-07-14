-- 0047_category_image — Reverte: remove coluna image_url da tabela categories
-- Nota: SQLite não suporta DROP COLUMN diretamente; precisamos recriar a tabela.

-- 1. Criar tabela temporária sem image_url
CREATE TABLE categories_tmp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories_tmp(id),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Categorias de produtos (hierárquicas via parent_id). Organizam o catálogo de qualquer segmento.'
);

-- 2. Copiar dados (excluindo image_url)
INSERT INTO categories_tmp (id, name, parent_id, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)
SELECT id, name, parent_id, uuid, updated_at, deleted_at, synced_at, origin_machine, comment
FROM categories;

-- 3. Dropar tabela original
DROP TABLE categories;

-- 4. Renomear temporária
ALTER TABLE categories_tmp RENAME TO categories;