-- 0033_indexes_name — Índices em colunas de busca por nome.
-- Buscas por nome de produto/cliente/fornecedor faziam full scan.
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);
