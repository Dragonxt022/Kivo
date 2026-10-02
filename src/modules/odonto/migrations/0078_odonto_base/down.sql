-- 0078_odonto_base (rollback) — remove a fundação do módulo odonto, na ordem inversa das FKs.
DROP TABLE IF EXISTS odonto_procedures;
DROP TABLE IF EXISTS odonto_professionals;
DROP TABLE IF EXISTS odonto_patient_clinical;
DROP TABLE IF EXISTS odonto_patients;
