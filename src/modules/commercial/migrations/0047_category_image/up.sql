-- 0047_category_image — Adiciona coluna image_url na tabela categories
-- Permite associar uma imagem a cada categoria para exibição no cardápio e modais.

ALTER TABLE categories ADD COLUMN image_url TEXT;