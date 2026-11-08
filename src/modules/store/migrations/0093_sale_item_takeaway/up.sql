-- 0093_sale_item_takeaway — preserva na venda se o item foi embalado para viagem.
-- O dado nasce em comanda_items.para_viagem e é copiado no fechamento da comanda.
ALTER TABLE sale_items ADD COLUMN para_viagem INTEGER NOT NULL DEFAULT 0;
