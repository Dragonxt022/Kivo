-- Versão do app que cada dispositivo está rodando (enviada no /license/validate via
-- cabeçalho X-Kivo-App-Version). Permite ao painel ver quem está desatualizado sem
-- depender da telemetria (que só existe a partir da versão com o coletor).

ALTER TABLE company_devices ADD COLUMN app_version VARCHAR(24) NULL;
