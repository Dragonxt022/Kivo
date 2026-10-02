-- 0082_odonto_odontograma (rollback).
DROP INDEX IF EXISTS idx_odonto_tooth_states_ativos;
DROP INDEX IF EXISTS idx_odonto_tooth_states_patient;
DROP TABLE IF EXISTS odonto_tooth_states;
DROP INDEX IF EXISTS idx_odonto_tooth_conditions_active;
DROP INDEX IF EXISTS idx_odonto_tooth_conditions_code;
DROP TABLE IF EXISTS odonto_tooth_conditions;
