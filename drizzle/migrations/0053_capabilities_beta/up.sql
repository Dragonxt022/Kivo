-- 0053_capabilities_beta — marca capabilities que são recursos em avaliação.
-- A tela de Recursos usa isso para exibir o selo BETA e avisar antes de ligar.
-- O valor vem do manifesto do módulo e é reescrito no boot (registerCapabilities).
ALTER TABLE capabilities ADD COLUMN beta INTEGER NOT NULL DEFAULT 0;
