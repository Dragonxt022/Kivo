-- 0048_fix_product_complement_unique — Reverte: volta para UNIQUE constraint hard

-- Dropar partial index
DROP INDEX IF EXISTS uq_product_complement_groups_active;

-- Recriar tabela com UNIQUE constraint hard
CREATE TABLE product_complement_groups_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  group_id INTEGER NOT NULL REFERENCES complement_groups(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Liga um grupo de complementos a um produto vendavel.',
  UNIQUE(product_id, group_id)
);

INSERT INTO product_complement_groups_old (id, product_id, group_id, sort_order, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)
SELECT id, product_id, group_id, sort_order, uuid, updated_at, deleted_at, synced_at, origin_machine, comment
FROM product_complement_groups;

DROP TABLE product_complement_groups;

ALTER TABLE product_complement_groups_old RENAME TO product_complement_groups;

CREATE INDEX idx_product_complement_groups_product ON product_complement_groups(product_id);
CREATE INDEX idx_product_complement_groups_group ON product_complement_groups(group_id);