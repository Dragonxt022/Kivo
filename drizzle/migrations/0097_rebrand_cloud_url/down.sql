UPDATE settings
   SET value = 'https://kivo.buscamais.org'
 WHERE key = 'sync.server_url'
   AND deleted_at IS NULL
   AND value = 'https://kuruk.com.br';
