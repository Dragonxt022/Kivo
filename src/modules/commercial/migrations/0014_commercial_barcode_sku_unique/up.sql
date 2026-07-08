-- 0014_commercial_barcode_sku_unique — unicidade real de barcode/sku entre produtos
-- ativos (soft-deleted ficam de fora, permitindo reuso do código antigo).
-- Dedup defensivo: instalações existentes podem ter duplicatas por convenção apenas.
-- Mantém a linha de menor id, zera as demais (evita falha da criação do índice único).
UPDATE products SET barcode = NULL
WHERE deleted_at IS NULL AND barcode IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM products WHERE deleted_at IS NULL AND barcode IS NOT NULL GROUP BY barcode
);
UPDATE products SET sku = NULL
WHERE deleted_at IS NULL AND sku IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM products WHERE deleted_at IS NULL AND sku IS NOT NULL GROUP BY sku
);

CREATE UNIQUE INDEX idx_products_barcode_unique ON products(barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX idx_products_sku_unique ON products(sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;
