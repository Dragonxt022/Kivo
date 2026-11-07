-- 0051_menu_item_catalog_image — vincula o item publicado ao id da foto no banco de
-- imagens (catalog_images.id). Antes o cardápio só casava a miniatura pelo NOME do
-- produto e exigia que a foto fosse da própria empresa; fotos escolhidas nas sugestões
-- automáticas (ou de outra origem) nunca apareciam.
--
-- O id vem do app local pelo sync (products.catalog_image_id). A foto continua sendo
-- servida só depois de um JOIN com menu_items, então não vira acesso público genérico.
ALTER TABLE menu_items ADD COLUMN catalog_image_id BIGINT NULL AFTER category_uuid;

-- O cardápio ainda cai no casamento por nome para fotos antigas (antes do vínculo por
-- id). Sem índice, cada item público varreria o banco de imagens inteiro.
ALTER TABLE catalog_images ADD KEY idx_catalog_images_product_name (product_name);
