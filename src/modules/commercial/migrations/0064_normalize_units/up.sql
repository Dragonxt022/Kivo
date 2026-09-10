-- Normaliza unidades de medida gravadas fora do conjunto canônico do catálogo.
--
-- Os importadores (CSV e NF-e) guardavam a unidade do fornecedor como texto livre
-- ("UN", "PC", "CX"...), o que criava duplicatas de "un" no catálogo — e a tela de
-- produto passava a exibir "UN (atual)" no select. O código já normaliza daqui pra
-- frente (shared/units.ts); esta migration corrige o que já entrou.
--
-- `AND unit <> <canonico>` evita bumpar updated_at (e gerar sync) em quem já está certo.

UPDATE products SET unit = 'un', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'un'
   AND UPPER(TRIM(unit)) IN ('UN','UND','UNID','UNIDADE','UNI','U','PC','PECA');
UPDATE products SET unit = 'un', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'un' AND TRIM(unit) IN ('PÇ','PEÇA');

UPDATE products SET unit = 'kg', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'kg'
   AND UPPER(TRIM(unit)) IN ('KG','QUILO','QUILOGRAMA');

UPDATE products SET unit = 'g', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'g'
   AND UPPER(TRIM(unit)) IN ('G','GR','GRAMA');

UPDATE products SET unit = 'L', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'L'
   AND UPPER(TRIM(unit)) IN ('L','LT','LITRO');

UPDATE products SET unit = 'ml', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'ml'
   AND UPPER(TRIM(unit)) IN ('ML','MLT','MILILITRO');

UPDATE products SET unit = 'cx', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'cx'
   AND UPPER(TRIM(unit)) IN ('CX','CAIXA');

UPDATE products SET unit = 'pct', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'pct'
   AND UPPER(TRIM(unit)) IN ('PCT','PCOTE','PACOTE','PACK');

UPDATE products SET unit = 'porcao', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'porcao'
   AND UPPER(TRIM(unit)) IN ('PORCAO','PORC');

UPDATE products SET unit = 'dz', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'dz'
   AND UPPER(TRIM(unit)) IN ('DZ','DUZIA');

UPDATE products SET unit = 'par', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'par'
   AND UPPER(TRIM(unit)) IN ('PAR','PARES');

UPDATE products SET unit = 'm', updated_at = datetime('now')
 WHERE deleted_at IS NULL AND unit <> 'm'
   AND UPPER(TRIM(unit)) IN ('M','MT','METRO');
