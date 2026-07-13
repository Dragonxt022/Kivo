-- 0034_store_sale_cost_cents — congela o custo do produto no momento da venda
-- para que o CMV no DRE não mude retroativamente quando o custo do produto for alterado.
ALTER TABLE sale_items ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0;
