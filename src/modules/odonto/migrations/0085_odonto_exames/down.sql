-- 0085_odonto_exames (rollback).
DROP INDEX IF EXISTS idx_odonto_exams_fase;
DROP INDEX IF EXISTS idx_odonto_exams_tipo;
DROP INDEX IF EXISTS idx_odonto_exams_patient;
DROP TABLE IF EXISTS odonto_exams;
