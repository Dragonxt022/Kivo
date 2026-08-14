-- 0020_recovery_secret — segredo de resgate de senha, por empresa.
--
-- O Kivo local não tem "esqueci minha senha" por e-mail: o hash da senha mora no SQLite da
-- máquina da loja, e um link de e-mail não alcança um servidor em localhost atrás de NAT.
-- A saída é desafio/resposta ditado por telefone, e a resposta é
-- HMAC(recovery_secret, desafio) truncado.
--
-- Por que POR EMPRESA e não uma chave mestra no binário do app: com "Rede local" ligada o
-- Kivo escuta em 0.0.0.0, então a tela de resgate é alcançável por qualquer máquina da rede
-- da loja. Uma chave mestra extraída do instalador destravaria qualquer Kivo. Este segredo
-- destrava só as máquinas desta empresa, e para lê-lo já é preciso ter o banco dela.
--
-- ATENÇÃO ao escrever migration no cloud: `migrate.ts` divide os statements cortando em
-- cada ponto e vírgula, sem entender comentário nem string. Um ponto e vírgula em qualquer
-- outro lugar do arquivo (inclusive dentro de um comentário, como havia aqui) parte o texto
-- no meio, e o pedaço solto vira um statement — estourando ER_PARSE_ERROR no deploy.
--
-- Preenchido sob demanda em GET /api/license/validate (ver cloud/src/routes/license.ts) e
-- entregue ao Kivo local, que o guarda no cofre (storage/secrets.json) — fora do banco, fora
-- do backup e fora do motor de sync.
--
-- Sem cláusula de charset de propósito: `companies` herda o collation do BANCO
-- (utf8mb4_general_ci na VPS) e declarar `DEFAULT CHARSET` aqui usaria o do SERVIDOR,
-- quebrando FKs com ER_FK_INCOMPATIBLE_COLUMNS. Ver doc/instruções_deploy.md.

-- Idempotente: DDL no MySQL faz commit implícito, então um retry precisa poder continuar
-- de onde parou sem estourar ER_DUP_FIELDNAME.
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'recovery_secret'
);
SET @sql := IF(
  @exists = 0,
  'ALTER TABLE companies ADD COLUMN recovery_secret CHAR(64) NULL COMMENT ''Segredo HMAC do resgate de senha (hex 32 bytes). Gerado sob demanda no /license/validate.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
