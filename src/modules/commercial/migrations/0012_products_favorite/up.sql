-- 0012_products_favorite — fixa produtos favoritos no topo da listagem.
ALTER TABLE products ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
