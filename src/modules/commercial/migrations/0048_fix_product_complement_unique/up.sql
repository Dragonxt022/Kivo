-- 0048_fix_product_complement_unique — Troca UNIQUE constraint por partial index
-- Permite re-vincular um grupo de complemento a um produto depois de desvincular (soft delete)

-- SQLite não suporta DROP CONSTRAINT direto; recriar a tabela
CREATE TABLE product_complement_groups_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  group_id INTEGER NOT NULL REFERENCES complement_groups(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Liga um grupo de complementos a um produto vendavel.'
);

-- Copiar dados existentes
INSERT INTO product_complement_groups_new (id, product_id, group_id, sort_order, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)
SELECT id, product_id, group_id, sort_order, uuid, updated_at, deleted_at, synced_at, origin_machine, comment
FROM product_complement_groups;

-- Dropar tabela antiga
DROP TABLE product_complement_groups;

-- Renomear nova
ALTER TABLE product_complement_groups_new RENAME TO product_complement_groups;

-- Criar partial unique index (só para linhas não deletadas)
CREATE UNIQUE INDEX uq_product_complement_groups_active
  ON product_complement_groups(product_id, group_id)
  WHERE deleted_at IS NULL;

-- Recriar índices necessários
CREATE INDEX idx_product_complement_groups_product ON product_complement_groups(product_id);
CREATE INDEX idx_product_complement_groups_group ON product_complement_groups(group_id);