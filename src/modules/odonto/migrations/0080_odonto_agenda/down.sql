-- 0080_odonto_agenda (rollback).
DROP INDEX IF EXISTS idx_odonto_appointment_events_appointment;
DROP TABLE IF EXISTS odonto_appointment_events;
DROP INDEX IF EXISTS idx_odonto_appointments_paciente;
DROP INDEX IF EXISTS idx_odonto_appointments_profissional;
DROP INDEX IF EXISTS idx_odonto_appointments_periodo;
DROP TABLE IF EXISTS odonto_appointments;
