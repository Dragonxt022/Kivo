-- 0060_commercial_products_unique_indexes_repair — reparo dos índices únicos de
-- barcode/sku que a migration 0049 (rebuild da tabela products) perdia em
-- instalações novas: o migrator comentava os CREATE UNIQUE INDEX (o nome já
-- existia do 0016 no momento do strip) e o DROP TABLE da rebuild derrubava o
-- índice de verdade — sobrava tabela sem unicidade. Corrigido no migrator; esta
-- migration conserta bancos já migrados com o bug.
--
-- Mesma regra do 0016: em caso de duplicata, fica a linha mais antiga (MIN id)
-- e as demais perdem o código — NULL nunca viola índice parcial.

UPDATE products SET barcode = NULL
WHERE deleted_at IS NULL AND barcode IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM products WHERE deleted_at IS NULL AND barcode IS NOT NULL GROUP BY barcode
);

UPDATE products SET sku = NULL
WHERE deleted_at IS NULL AND sku IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM products WHERE deleted_at IS NULL AND sku IS NOT NULL GROUP BY sku
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_unique ON products(sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;