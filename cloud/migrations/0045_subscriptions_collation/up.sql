-- 0045_subscriptions_collation — alinha a collation da tabela nova com `companies`.
--
-- A 0044 criou `company_subscriptions` com o charset/collation padrão do servidor
-- (utf8mb4_0900_ai_ci em MySQL 8), enquanto `companies.company_uuid` em instalações antigas
-- está em utf8mb4_general_ci. A FK foi removida, mas qualquer JOIN/filtro entre as duas
-- colunas estourava ER_CANT_AGGREGATE_2COLLATIONS. Aqui a tabela passa a usar exatamente a
-- collation de `companies.company_uuid`, qualquer que seja ela.

SET @charset := (
  SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @collation := (
  SELECT COLLATION_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE company_subscriptions CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
