-- 0028_license_hardening — ativação obrigatória, trava de máquina, anti-relógio e
-- assinatura de integridade da licença local.
--
-- time_watermark: epoch ms do maior horário confiável já observado (nunca regride).
-- integrity_hmac: assinatura HMAC sobre os campos críticos, amarrada à máquina.
-- activated_at: marco da 1ª ativação online bem-sucedida (define "instalação ativada").
-- machine_id_version: versão do algoritmo usado para calcular machine_id — necessário
--   porque o algoritmo mudou (era hash de hostname/CPU, agora é GUID nativo do SO) e
--   instalações já existentes precisam de um "re-batismo" único (não travar quem já
--   usa o app só porque o valor calculado mudou de fórmula).
ALTER TABLE license ADD COLUMN time_watermark INTEGER;
ALTER TABLE license ADD COLUMN integrity_hmac TEXT;
ALTER TABLE license ADD COLUMN activated_at TEXT;
ALTER TABLE license ADD COLUMN machine_id_version INTEGER NOT NULL DEFAULT 1;

-- Grandfathering: instalações que já configuraram licença pelo fluxo antigo (Configurações
-- → Empresa/Chave) não ficam trancadas atrás da nova tela de ativação obrigatória.
UPDATE license SET activated_at = COALESCE(last_validated_at, updated_at)
WHERE company_uuid IS NOT NULL AND license_key IS NOT NULL AND activated_at IS NULL;
