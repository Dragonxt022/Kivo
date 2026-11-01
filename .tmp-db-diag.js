const Database = require('better-sqlite3');
const db = new Database('C:\\apps\\Kivo\\database\\kivo.db', { readonly: true });
for (const t of ['license', 'settings']) {
  try {
    const rows = db.prepare(`SELECT * FROM ${t} LIMIT 1`).all();
    console.log(t, rows.length ? Object.keys(rows[0]) : '(vazio)');
    if (rows.length) {
      const r = rows[0];
      for (const k of Object.keys(r)) {
        if (/key|token|secret|password/i.test(k)) console.log(' ', k, r[k] ? '(preenchido)' : '(vazio)');
        else console.log(' ', k, r[k]);
      }
    }
  } catch (e) { console.log(t, 'erro:', e.message); }
}
db.close();
