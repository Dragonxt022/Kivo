-- Código de barras do produto no envio de imagem ao banco do Kuruk Cloud.
-- O nome do produto é ambíguo; o código de barras casa a foto exata e acerta mais.
ALTER TABLE product_image_submissions ADD COLUMN barcode TEXT;
