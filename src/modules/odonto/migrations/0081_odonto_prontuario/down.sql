-- 0081_odonto_prontuario (rollback).
DROP INDEX IF EXISTS idx_odonto_clinical_notes_cadeia;
DROP INDEX IF EXISTS idx_odonto_clinical_notes_appointment;
DROP INDEX IF EXISTS idx_odonto_clinical_notes_status;
DROP INDEX IF EXISTS idx_odonto_clinical_notes_patient;
DROP TABLE IF EXISTS odonto_clinical_notes;
