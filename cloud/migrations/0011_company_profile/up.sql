-- Perfil completo da empresa: o cadastro no painel cloud passa a guardar os dados
-- fiscais/contato/endereco, que descem na ativacao (/license/validate) e preenchem
-- automaticamente as configuracoes do Katsu local (so se ainda estiverem vazias la).
-- name continua sendo o Nome fantasia (o que aparece no cupom) e legal_name a Razao social.
ALTER TABLE companies ADD COLUMN legal_name VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN document VARCHAR(20) NULL;
ALTER TABLE companies ADD COLUMN state_registration VARCHAR(30) NULL;
ALTER TABLE companies ADD COLUMN email VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN phone VARCHAR(30) NULL;
ALTER TABLE companies ADD COLUMN zip VARCHAR(9) NULL;
ALTER TABLE companies ADD COLUMN street VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN number VARCHAR(20) NULL;
ALTER TABLE companies ADD COLUMN complement VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN district VARCHAR(120) NULL;
ALTER TABLE companies ADD COLUMN city VARCHAR(120) NULL;
ALTER TABLE companies ADD COLUMN state CHAR(2) NULL;
