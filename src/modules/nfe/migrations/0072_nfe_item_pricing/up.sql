-- 0072_nfe_item_pricing — preço de venda, sugestão e conversão de unidade por item de
-- NF-e importada.
--
-- O item da nota guarda o snapshot fiscal (qty/unit/unit_cost na unidade do FORNECEDOR).
-- As colunas novas registram o que foi aplicado no produto/estoque depois da conferência:
--   sale_price_cents      → preço de venda gravado (ou mantido) no produto;
--   suggested_price_cents → sugestão do sistema, para auditar o que a tela ofereceu;
--   conversion_qty        → unidades de venda por 1 unidade da nota (ex.: 12 p/ CX);
--   conversion_unit       → unidade de compra da nota quando houve conversão (ex.: 'cx');
--   ean_box               → EAN de embalagem detectado (não virou o código do produto);
--   prev_price_cents      → preço do produto ANTES da nota, para a reversão restaurar.
--
-- Tudo aditivo (colunas anuláveis): itens antigos continuam válidos.
ALTER TABLE purchase_invoice_items ADD COLUMN sale_price_cents INTEGER;
ALTER TABLE purchase_invoice_items ADD COLUMN suggested_price_cents INTEGER;
ALTER TABLE purchase_invoice_items ADD COLUMN conversion_qty REAL;
ALTER TABLE purchase_invoice_items ADD COLUMN conversion_unit TEXT;
ALTER TABLE purchase_invoice_items ADD COLUMN ean_box TEXT;
ALTER TABLE purchase_invoice_items ADD COLUMN prev_price_cents INTEGER;
