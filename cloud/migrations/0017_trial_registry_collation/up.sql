-- `trial_registry` (0015) é o único CREATE TABLE do cloud/ que declara charset explícito.
-- Declarar `DEFAULT CHARSET=utf8mb4` sem COLLATE junto faz o MySQL usar o collation default
-- do SERVIDOR para utf8mb4 (utf8mb4_0900_ai_ci no MySQL 8) — que não é necessariamente o do
-- BANCO, herdado por todas as outras tabelas. Na VPS o banco está em utf8mb4_general_ci, e aí
-- qualquer JOIN entre trial_registry e companies estoura ER_CANT_AGGREGATE_2COLLATIONS
-- ("Illegal mix of collations"). A comparação contra parâmetro (`WHERE machine_id_hash = ?`)
-- nunca sofreu com isso, o que escondeu a divergência até a primeira tela cruzar as duas.
--
-- Alinha lendo o collation REAL de `companies` em vez de fixar um valor: desenvolvimento
-- (docker, MySQL 8) e produção têm defaults diferentes, e fixar qualquer um dos dois
-- quebraria o outro. O charset sai do próprio nome do collation, que sempre começa por ele.
SET @coll := (SELECT TABLE_COLLATION FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies');
SET @sql := CONCAT('ALTER TABLE trial_registry CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
