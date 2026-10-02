-- 0079_odonto_anamnese (rollback).
DROP INDEX IF EXISTS idx_odonto_anamnesis_forms_revisao;
DROP INDEX IF EXISTS idx_odonto_anamnesis_forms_patient;
DROP TABLE IF EXISTS odonto_anamnesis_forms;
DROP INDEX IF EXISTS idx_odonto_anamnesis_templates_active;
DROP INDEX IF EXISTS idx_odonto_anamnesis_templates_nome_versao;
DROP TABLE IF EXISTS odonto_anamnesis_templates;
