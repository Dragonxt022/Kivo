-- 0057_quote_pdv — orçamento passa a ser montado no PDV, não mais em tela própria.
--
-- O carrinho do PDV carrega três coisas que quote_items nunca soube guardar:
--  - line_group_uuid: amarra o produto principal aos seus complementos (linhas irmãs,
--    mesmo desenho de sale_items desde a 0041 — não existe tabela de complemento de item)
--  - notes: observação por item ("sem cebola")
--  - surcharge_cents: acréscimo, que a venda tem desde a 0009 e o orçamento não tinha
--
-- Sem essas colunas, um orçamento com pizza + borda recheada perde o vínculo e vira
-- duas linhas soltas na conversão.
ALTER TABLE quote_items ADD COLUMN notes TEXT;
ALTER TABLE quote_items ADD COLUMN line_group_uuid TEXT;
ALTER TABLE quotes ADD COLUMN surcharge_cents INTEGER NOT NULL DEFAULT 0;
