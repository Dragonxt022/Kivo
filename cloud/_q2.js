/** Inspeção temporária do MySQL do cloud (fora de src/). Remover ao final. */
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.CLOUD_DB_HOST,
    port: Number(process.env.CLOUD_DB_PORT),
    user: process.env.CLOUD_DB_USER,
    password: process.env.CLOUD_DB_PASSWORD,
    database: process.env.CLOUD_DB_NAME,
  });

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges'
        AND (COLUMN_NAME LIKE 'mp\\_%' OR COLUMN_NAME IN ('public_token','payer_email','extends_days'))
      ORDER BY COLUMN_NAME`,
  );
  console.log('colunas do gateway em charges: ' + cols.length);
  console.log(cols.map((c) => `  ${c.COLUMN_NAME} ${c.COLUMN_TYPE}`).join('\n'));

  const [tabelas] = await conn.query("SHOW TABLES LIKE '%migration%'");
  console.log('tabela de migrations: ' + JSON.stringify(tabelas));

  const [settings] = await conn.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'mp\\_%'");
  console.log('app_settings mp_*: ' + JSON.stringify(settings.map((s) => ({
    key: s.setting_key,
    valor: s.setting_value ? (s.setting_key.includes('token') || s.setting_key.includes('secret') ? `(${String(s.setting_value).length} chars)` : s.setting_value) : null,
  }))));

  await conn.end();
})().catch((e) => { console.error('falhou: ' + e.message); process.exit(1); });
