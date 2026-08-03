-- 0055_fiscal_products — Dados fiscais no produto.
--
-- NULL em qualquer um destes significa "herda o padrão da configuração fiscal"
-- (fiscal.csosn_padrao / fiscal.cst_padrao / fiscal.origem_padrao), exceto NCM: NCM é
-- obrigatório por item e não tem padrão que sirva — o painel de prontidão cobra produto
-- a produto antes de deixar emitir.
--
-- `origem` (cOrig, 0-8) é obrigatório dentro de todo grupo de ICMS. Sem ele a nota é
-- rejeitada, e o plano original não previa a coluna.
--
-- `unit_fiscal` é a unidade tributável do XML (uCom/uTrib). A coluna `unit` existente é
-- texto livre digitado pelo lojista ('un', 'unid', 'Kg', 'caixa'…) e não serve direto.

ALTER TABLE products ADD COLUMN ncm TEXT;
ALTER TABLE products ADD COLUMN cest TEXT;
ALTER TABLE products ADD COLUMN csosn TEXT;
ALTER TABLE products ADD COLUMN cst TEXT;
ALTER TABLE products ADD COLUMN origem INTEGER;
ALTER TABLE products ADD COLUMN unit_fiscal TEXT;

-- Alimenta o painel "produtos sem NCM" sem varrer a tabela inteira.
CREATE INDEX idx_products_ncm ON products(ncm);
