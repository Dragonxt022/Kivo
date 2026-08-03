-- Colunas aditivas e nulas: reverter é só limpar o conteúdo fiscal, sem recriar a tabela
-- (o rebuild de `products` custa caro e não traz benefício aqui).
DROP INDEX IF EXISTS idx_products_ncm;
UPDATE products SET ncm = NULL, cest = NULL, csosn = NULL, cst = NULL, origem = NULL, unit_fiscal = NULL;
