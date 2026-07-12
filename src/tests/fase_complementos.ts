import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { hasCapability } from '../core/capabilities/service';
import { registerCapabilities } from '../core/modules/loader';

const TEST_MODULE = {
  id: 'commercial',
  name: 'Comercial',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [],
  capabilities: [
    { key: 'commercial.complementos', description: 'Grupos de complementos' },
  ],
};

let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();

  const db = getSqlite();

  // 1. Tabelas existem
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('complement_groups','complement_group_items','product_complement_groups')").all() as { name: string }[];
  check('complement_groups existe', tables.some(t => t.name === 'complement_groups'));
  check('complement_group_items existe', tables.some(t => t.name === 'complement_group_items'));
  check('product_complement_groups existe', tables.some(t => t.name === 'product_complement_groups'));

  // 2. sale_items tem notes e line_group_uuid
  const cols = db.prepare("PRAGMA table_info('sale_items')").all() as { name: string }[];
  check('sale_items tem notes', cols.some(c => c.name === 'notes'));
  check('sale_items tem line_group_uuid', cols.some(c => c.name === 'line_group_uuid'));

  // 3. Criar produtos
  const mainProd = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 1, ?, 'fisico')",
  ).run('Hamburguer', 2500, 800, randomUUID());
  const mainId = Number(mainProd.lastInsertRowid);
  check('produto principal Hamburguer criado', mainId > 0);

  const paoBrioche = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 0, ?, 'fisico')",
  ).run('Pao brioche', 500, 200, randomUUID());
  const paoBriocheId = Number(paoBrioche.lastInsertRowid);
  check('Pao brioche criado', paoBriocheId > 0);

  const paoAustraliano = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 0, ?, 'fisico')",
  ).run('Pao australiano', 500, 200, randomUUID());
  const paoAustralianoId = Number(paoAustraliano.lastInsertRowid);
  check('Pao australiano criado', paoAustralianoId > 0);

  const molhoBbq = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 0, ?, 'fisico')",
  ).run('Molho barbecue', 300, 100, randomUUID());
  const molhoBbqId = Number(molhoBbq.lastInsertRowid);
  check('Molho barbecue criado', molhoBbqId > 0);

  const molhoCheddar = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 0, ?, 'fisico')",
  ).run('Molho cheddar', 400, 150, randomUUID());
  const molhoCheddarId = Number(molhoCheddar.lastInsertRowid);
  check('Molho cheddar criado', molhoCheddarId > 0);

  // 4. Criar grupo "Pao" (min=1, max=1)
  const groupPao = db.prepare(
    "INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)",
  ).run('Escolha o pao', 1, 1, randomUUID());
  const paoGroupId = Number(groupPao.lastInsertRowid);
  check('grupo Pao criado', paoGroupId > 0);
  check('Pao min_select=1', (db.prepare('SELECT min_select FROM complement_groups WHERE id=?').get(paoGroupId) as { min_select: number }).min_select === 1);
  check('Pao max_select=1', (db.prepare('SELECT max_select FROM complement_groups WHERE id=?').get(paoGroupId) as { max_select: number }).max_select === 1);

  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(paoGroupId, paoBriocheId, null, 1, randomUUID());
  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(paoGroupId, paoAustralianoId, null, 2, randomUUID());
  const paoItems = db.prepare('SELECT COUNT(*) AS c FROM complement_group_items WHERE group_id=? AND deleted_at IS NULL').get(paoGroupId) as { c: number };
  check('grupo Pao tem 2 itens', paoItems.c === 2);

  // 5. Criar grupo "Molhos" (min=0, max=3)
  const groupMolhos = db.prepare(
    "INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)",
  ).run('Molhos', 0, 3, randomUUID());
  const molhosGroupId = Number(groupMolhos.lastInsertRowid);
  check('grupo Molhos criado', molhosGroupId > 0);

  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(molhosGroupId, molhoBbqId, null, 1, randomUUID());
  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(molhosGroupId, molhoCheddarId, null, 2, randomUUID());
  const molhoItems = db.prepare('SELECT COUNT(*) AS c FROM complement_group_items WHERE group_id=? AND deleted_at IS NULL').get(molhosGroupId) as { c: number };
  check('grupo Molhos tem 2 itens', molhoItems.c === 2);

  // 6. Vincular grupos ao produto principal
  db.prepare('INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)')
    .run(mainId, paoGroupId, 1, randomUUID());
  db.prepare('INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)')
    .run(mainId, molhosGroupId, 2, randomUUID());
  const links = db.prepare(
    'SELECT COUNT(*) AS c FROM product_complement_groups WHERE product_id=? AND deleted_at IS NULL',
  ).get(mainId) as { c: number };
  check('Hamburguer tem 2 grupos vinculados', links.c === 2);

  // 7. Simular venda: inserir linhas em sale_items com notes e line_group_uuid
  const lineGroupUuid = randomUUID();
  const sale = db.prepare(
    "INSERT INTO sales (customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, client_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(null, 3800, 0, 0, 3800, 'dinheiro', 4000, 200, 1, randomUUID(), randomUUID());
  const saleId = Number(sale.lastInsertRowid);
  check('venda criada', saleId > 0);

  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(saleId, mainId, 'Hamburguer', 1, 2500, 800, 2500, 'sem cebola', lineGroupUuid);
  insertItem.run(saleId, paoBriocheId, 'Pao brioche', 1, 500, 200, 500, 'sem cebola', lineGroupUuid);
  insertItem.run(saleId, molhoCheddarId, 'Molho cheddar', 2, 400, 150, 800, 'sem cebola', lineGroupUuid);

  const saleItems = db.prepare(
    'SELECT product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid FROM sale_items WHERE sale_id=? ORDER BY id',
  ).all(saleId) as { product_id: number; product_name: string; qty: number; unit_price_cents: number; cost_cents: number; total_cents: number; notes: string | null; line_group_uuid: string | null }[];
  check('3 linhas em sale_items', saleItems.length === 3);
  check('todas com mesmo line_group_uuid', saleItems.every(i => i.line_group_uuid === lineGroupUuid));
  check('todas com notes="sem cebola"', saleItems.every(i => i.notes === 'sem cebola'));
  check('item 0 = Hamburguer qty=1 price=2500 cost=800', saleItems[0].product_id === mainId && saleItems[0].qty === 1 && saleItems[0].unit_price_cents === 2500 && saleItems[0].cost_cents === 800);
  check('item 1 = Pao brioche qty=1 price=500 cost=200', saleItems[1].product_name === 'Pao brioche' && saleItems[1].qty === 1 && saleItems[1].unit_price_cents === 500 && saleItems[1].cost_cents === 200);
  check('item 2 = Molho cheddar qty=2 price=400 cost=150', saleItems[2].product_name === 'Molho cheddar' && saleItems[2].qty === 2 && saleItems[2].unit_price_cents === 400 && saleItems[2].cost_cents === 150);

  // 8. Gating: complementos desligado por padrao
  registerCapabilities(TEST_MODULE);
  check('commercial.complementos comeca desligada',
    (db.prepare("SELECT enabled FROM capabilities WHERE key='commercial.complementos'").get() as { enabled: number })?.enabled === 0);

  // Liga e confirma
  db.prepare("UPDATE capabilities SET enabled=1 WHERE key='commercial.complementos'").run();
  check('commercial.complementos ligada',
    (db.prepare("SELECT enabled FROM capabilities WHERE key='commercial.complementos'").get() as { enabled: number })?.enabled === 1);

  // 9. Soft-delete grupo em cascata (mesma logica das rotas: transaction que deleta items + vinculos + grupo)
  db.transaction(() => {
    db.prepare("UPDATE complement_group_items SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE group_id=?").run(paoGroupId);
    db.prepare("UPDATE product_complement_groups SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE group_id=?").run(paoGroupId);
    db.prepare("UPDATE complement_groups SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(paoGroupId);
  })();
  const remainingItems = db.prepare('SELECT COUNT(*) AS c FROM complement_group_items WHERE deleted_at IS NULL AND group_id=?').get(paoGroupId) as { c: number };
  check('itens do grupo deletado nao contam mais', remainingItems.c === 0);
  const remainingLinks = db.prepare('SELECT COUNT(*) AS c FROM product_complement_groups WHERE deleted_at IS NULL AND group_id=?').get(paoGroupId) as { c: number };
  check('vinculos do grupo deletado nao contam mais', remainingLinks.c === 0);

  console.log(`\nComplementos: TODOS OS TESTES PASSARAM (${failures} falhas)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
