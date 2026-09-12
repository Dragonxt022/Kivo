-- 0030_theme_edit — marca quando um tema foi editado à mão no painel.
--
-- O seed (`npm run seed:themes`) roda a cada deploy e reescreve os temas a partir de
-- `cloud/seed-themes/`. Sem essa marca, uma edição feita no painel (nome, preço, capa) seria
-- desfeita no próximo deploy. Com `edited_at` preenchido, o seed pula o tema e preserva a
-- edição.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'themes'
      AND COLUMN_NAME = 'edited_at') = 0,
  'ALTER TABLE themes ADD COLUMN edited_at DATETIME(3) NULL AFTER active',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
