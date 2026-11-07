-- 0091_product_catalog_image_id — guarda QUAL foto do banco de imagens do Kivo Cloud
-- representa o produto. Antes o cardápio online só conseguia casar a foto pelo NOME do
-- produto, o que falhava para qualquer imagem vinda das sugestões automáticas (busca no
-- banco compartilhado) e para produtos renomeados.
--
-- O id é do Cloud (catalog_images.id), não uma FK local. Viaja no sync junto com o produto
-- e o Cloud projeta em menu_items.catalog_image_id, permitindo servir a miniatura certa no
-- cardápio público sem depender do nome. NULL = foto local ainda não enviada/vinculada.
ALTER TABLE products ADD COLUMN catalog_image_id INTEGER;
