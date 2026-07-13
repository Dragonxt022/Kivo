-- 0024_store_sales_idempotency — fecha a brecha de venda duplicada por duplo-clique
-- ou retry de rede: o PDV gera um id uma única vez por tentativa de checkout; uma
-- segunda tentativa com o mesmo id colide no índice único e é tratada como
-- "venda já registrada" em vez de duplicar estoque/caixa/crédito/pontos.
ALTER TABLE sales ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX idx_sales_client_request_id ON sales(client_request_id) WHERE client_request_id IS NOT NULL;
