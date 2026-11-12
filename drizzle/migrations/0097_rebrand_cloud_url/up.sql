-- Rebrand Kivo -> Kuruk: clientes que salvaram explicitamente a URL antiga do
-- cloud continuam apontando para o servidor antigo. Move só o valor de fábrica
-- antigo; uma URL customizada (outro servidor/mirror) é preservada.
UPDATE settings
   SET value = 'https://kuruk.com.br'
 WHERE key = 'sync.server_url'
   AND deleted_at IS NULL
   AND value IN (
     'https://kivo.buscamais.org',
     'http://kivo.buscamais.org',
     'kivo.buscamais.org'
   );
