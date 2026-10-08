-- Reverte a coluna de foto do cliente. As fotos legadas continuam em `odonto_patients`.
ALTER TABLE customers DROP COLUMN photo_file;
