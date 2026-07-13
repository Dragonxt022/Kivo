-- 0046_product_visivel_cardapio — marca quais produtos o lojista escolheu mostrar no cardápio online público (Fase 6).
ALTER TABLE products ADD COLUMN visivel_cardapio INTEGER NOT NULL DEFAULT 0;
