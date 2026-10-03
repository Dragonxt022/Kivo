-- 0083_odonto_plano (rollback).
DROP INDEX IF EXISTS idx_odonto_treatment_items_tooth;
DROP INDEX IF EXISTS idx_odonto_treatment_items_plan;
DROP TABLE IF EXISTS odonto_treatment_items;
DROP INDEX IF EXISTS idx_odonto_plans_patient;
DROP TABLE IF EXISTS odonto_treatment_plans;
