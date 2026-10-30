-- 0046_company_contact_name — quem está testando o Kivo, além da empresa.
--
-- O trial era criado só com o machine id ("Avaliação — abc123"). Agora a ativação pede
-- nome e celular do responsável; `name` continua sendo o nome exibido e `contact_name`
-- guarda explicitamente a pessoa que preencheu. `phone` já existia no perfil da empresa.

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'contact_name');
SET @sql := IF(@exists = 0,
  'ALTER TABLE companies ADD COLUMN contact_name VARCHAR(160) NULL COMMENT ''Nome do responsável informado na solicitação do teste.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
