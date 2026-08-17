-- 0021_business_profile — perfil de pesquisa do negócio, respondido no assistente de
-- boas-vindas do Kivo local e enviado para cá.
--
-- Serve para saber QUEM usa o Kivo: ramo de atividade e porte (faixa de funcionários).
-- Sem isto a única pista sobre o cliente é o plano contratado, que não diz nada sobre o
-- tipo de comércio nem sobre o tamanho da operação.
--
-- `companies.name` já guarda o nome fantasia, então o nome do negócio digitado no
-- assistente cai lá e não ganha coluna nova aqui.
--
-- ATENÇÃO ao escrever migration no cloud (ver 0020_recovery_secret) — `migrate.ts` divide
-- os statements cortando em cada ponto e vírgula, sem entender comentário nem string, então
-- este arquivo não pode conter ponto e vírgula fora dos próprios statements.
--
-- Sem cláusula de charset de propósito: `companies` herda o collation do BANCO e declarar
-- DEFAULT CHARSET aqui usaria o do SERVIDOR, quebrando FKs com ER_FK_INCOMPATIBLE_COLUMNS.

-- Idempotente: DDL no MySQL faz commit implícito, então um retry precisa poder continuar
-- de onde parou sem estourar ER_DUP_FIELDNAME.
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'business_type'
);
SET @sql := IF(
  @exists = 0,
  'ALTER TABLE companies ADD COLUMN business_type VARCHAR(40) NULL COMMENT ''Ramo declarado no assistente de boas-vindas (restaurante, mercado, roupas...).''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'employee_range'
);
SET @sql := IF(
  @exists = 0,
  'ALTER TABLE companies ADD COLUMN employee_range VARCHAR(16) NULL COMMENT ''Faixa de funcionarios declarada no assistente: 1-5, 6-50, 51-100, 100+.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Quando o perfil chegou. Distingue "nunca respondeu" (NULL) de "respondeu e deixou algum
-- campo em branco", que é a diferença que importa ao medir cobertura da pesquisa.
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'business_profile_at'
);
SET @sql := IF(
  @exists = 0,
  'ALTER TABLE companies ADD COLUMN business_profile_at DATETIME(3) NULL COMMENT ''Quando o perfil de negocio foi recebido do app local.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
