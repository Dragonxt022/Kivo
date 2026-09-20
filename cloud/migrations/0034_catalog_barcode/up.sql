-- 0034_catalog_barcode — código de barras no banco de imagens.
--
-- O nome do produto é ambíguo ("Coca lata", "Coca-Cola 350ml") e a busca textual erra.
-- O código de barras (EAN/UPC) identifica o produto sem ambiguidade: quando a empresa envia
-- a foto, manda o barcode junto; quando outra procura imagem, o barcode bate exato. Fica
-- também em catalog_demand para a curadoria saber o que faltou por código.

ALTER TABLE catalog_images ADD COLUMN barcode VARCHAR(64) NULL AFTER keywords;
ALTER TABLE catalog_images ADD KEY idx_catalog_images_barcode (barcode);

ALTER TABLE catalog_demand ADD COLUMN barcode VARCHAR(64) NULL AFTER term;
