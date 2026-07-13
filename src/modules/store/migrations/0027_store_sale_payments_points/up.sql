-- 0025_store_sale_payments_points — quantos pontos de fidelidade foram resgatados
-- nesta parcela de pagamento (type='fidelidade'), pra permitir reverter exatamente
-- essa quantidade se a venda for cancelada.
ALTER TABLE sale_payments ADD COLUMN points_used INTEGER;
