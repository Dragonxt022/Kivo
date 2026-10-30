-- 0043_installer_downloads — cliques em "Baixar" no site, antes de o cliente ativar.
--
-- O painel já enxerga toda instalação que valida licença (inclusive trial) em
-- company_devices. Esta tabela cobre o pedaço anterior: saber quantas pessoas baixaram o
-- instalador, de onde vieram e em que versão, mesmo que nunca cheguem a ativar o teste.
--
-- Sem FK com companies: o download acontece no navegador, antes de existir empresa. O IP
-- e o user-agent são o mínimo para o suporte identificar abuso/origem; a retenção de 180
-- dias é feita no painel.

CREATE TABLE IF NOT EXISTS installer_downloads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(400) NULL,
  referer VARCHAR(500) NULL,
  origem VARCHAR(80) NULL,
  version VARCHAR(24) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_installer_downloads_created (created_at),
  INDEX idx_installer_downloads_ip (ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
