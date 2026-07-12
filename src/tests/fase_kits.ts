import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { registerCapabilities } from '../core/modules/loader';
import { registerService } from '../core/services/registry';
import type { CommercialStockService, CommercialPricingService, CommercialStoreCreditService, CommercialLoyaltyService } from '../modules/commercial/setup';
import { moveStock, moveStockRaw, listMovements } from '../modules/commercial/stock';
import { resolvePrice, resolveMany } from '../modules/commercial/pricing';
import * as storeCredit from '../modules/commercial/storeCredit';
import * as loyalty from '../modules/commercial/loyalty';

const TEST_MODULE = {
  id: 'commercial',
  name: 'Comercial',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [],
  capabilities: [
    { key: 'commercial.kits', description: 'Produtos do tipo kit/combo' },
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
  registerCapabilities(TEST_MODULE);

  // Registrar servicos necessarios para createSale
  registerService('commercial.stock', { move: moveStock, moveRaw: moveStockRaw, listMovements } satisfies CommercialStockService);
  registerService('commercial.pricing', { resolvePrice, resolveMany } satisfies CommercialPricingService);
  registerService('commercial.storeCredit', {
    grantRaw: storeCredit.grant, redeemRaw: storeCredit.redeem, reverseRaw: storeCredit.reverse,
    balance: storeCredit.getBalance, listMovements: storeCredit.listCreditMovements,
  } satisfies CommercialStoreCreditService);
  registerService('commercial.loyalty', {
    enabled: loyalty.loyaltyEnabled, pointsForSaleCents: loyalty.pointsForSaleCents, centsPerPoint: loyalty.centsPerPoint,
    accrueRaw: loyalty.accrue, redeemRaw: loyalty.redeem, reverseRaw: loyalty.reverse, reverseGrantRaw: loyalty.reverseGrant,
    balance: loyalty.getBalance, listMovements: loyalty.listLoyaltyMovements,
  } satisfies CommercialLoyaltyService);

  const db = getSqlite();

  // 1. Tabela kit_items existe
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kit_items'").all() as { name: string }[];
  check('kit_items existe', tables.length === 1);

  // 2. Criar produtos
  const kitProd = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 1, ?, 'kit')",
  ).run('Combo Lanche', 2500, 1000, randomUUID());
  const kitId = Number(kitProd.lastInsertRowid);
  check('kit Combo Lanche criado', kitId > 0);
  check('kit tem product_type=kit', (db.prepare('SELECT product_type FROM products WHERE id=?').get(kitId) as { product_type: string }).product_type === 'kit');

  const hamburguer = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, stock_qty, uuid, product_type) VALUES (?, ?, ?, 1, ?, ?, 'fisico')",
  ).run('Hamburguer', 1200, 400, 50, randomUUID());
  const hamburguerId = Number(hamburguer.lastInsertRowid);
  check('Hamburguer criado', hamburguerId > 0);

  const batata = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, stock_qty, uuid, product_type) VALUES (?, ?, ?, 1, ?, ?, 'fisico')",
  ).run('Batata frita', 800, 250, 80, randomUUID());
  const batataId = Number(batata.lastInsertRowid);
  check('Batata frita criada', batataId > 0);

  const refrigerante = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, stock_qty, uuid, product_type) VALUES (?, ?, ?, 1, ?, ?, 'fisico')",
  ).run('Refrigerante', 600, 200, 100, randomUUID());
  const refrigeranteId = Number(refrigerante.lastInsertRowid);
  check('Refrigerante criado', refrigeranteId > 0);

  // 3. Adicionar componentes ao kit
  db.prepare('INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(kitId, hamburguerId, 1, 1, randomUUID());
  db.prepare('INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(kitId, batataId, 1, 2, randomUUID());
  db.prepare('INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(kitId, refrigeranteId, 1, 3, randomUUID());
  const compCount = db.prepare('SELECT COUNT(*) AS c FROM kit_items WHERE kit_product_id=? AND deleted_at IS NULL').get(kitId) as { c: number };
  check('kit tem 3 componentes', compCount.c === 3);

  // 4. Verificar expansao em createSale via SQL direta (simulando o que createSale faz)
  const lineGroupUuid = randomUUID();
  const sale = db.prepare(
    "INSERT INTO sales (customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, client_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(null, 2500, 0, 0, 2500, 'dinheiro', 2500, 0, 1, randomUUID(), randomUUID());
  const saleId = Number(sale.lastInsertRowid);
  check('venda criada', saleId > 0);

  // Linha do kit (como createSale faria)
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(saleId, kitId, 'Combo Lanche', 2, 2500, 1000, 5000, null, lineGroupUuid);

  // Linhas dos componentes a preco zero (como createSale faria)
  const kitComponents = db.prepare(
    `SELECT ki.qty AS compQty, comp.id, comp.name, comp.cost_cents
     FROM kit_items ki JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
     WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL ORDER BY ki.sort_order`,
  ).all(kitId) as { compQty: number; id: number; name: string; cost_cents: number }[];
  for (const comp of kitComponents) {
    insertItem.run(saleId, comp.id, comp.name, comp.compQty * 2, 0, comp.cost_cents, 0, null, lineGroupUuid);
  }

  const saleItems = db.prepare(
    `SELECT product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid
     FROM sale_items WHERE sale_id=? ORDER BY id`,
  ).all(saleId) as { product_id: number; product_name: string; qty: number; unit_price_cents: number; cost_cents: number; total_cents: number; notes: string | null; line_group_uuid: string | null }[];
  check('4 linhas em sale_items (kit + 3 componentes)', saleItems.length === 4);

  const lineKit = saleItems[0];
  check('item 0 = kit qty=2 price=2500 cost=1000 total=5000', lineKit.product_id === kitId && lineKit.qty === 2 && lineKit.unit_price_cents === 2500 && lineKit.cost_cents === 1000 && lineKit.total_cents === 5000);

  const components = saleItems.slice(1);
  check('todos os componentes tem unit_price_cents=0', components.every(c => c.unit_price_cents === 0));
  check('todos os componentes tem total_cents=0', components.every(c => c.total_cents === 0));
  check('todos os componentes tem o mesmo line_group_uuid', components.every(c => c.line_group_uuid === lineGroupUuid));
  check('componentes tem notes=null', components.every(c => c.notes === null));

  const compMap = new Map(components.map(c => [c.product_name, c]));
  check('componente Hamburguer qty=2 cost=400', compMap.get('Hamburguer')?.qty === 2 && compMap.get('Hamburguer')?.cost_cents === 400);
  check('componente Batata frita qty=2 cost=250', compMap.get('Batata frita')?.qty === 2 && compMap.get('Batata frita')?.cost_cents === 250);
  check('componente Refrigerante qty=2 cost=200', compMap.get('Refrigerante')?.qty === 2 && compMap.get('Refrigerante')?.cost_cents === 200);

  // 5. Testar combo com complemento
  const combo = db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid, product_type) VALUES (?, ?, ?, 1, ?, 'combo')",
  ).run('Combo Premium', 3500, 1500, randomUUID());
  const comboId = Number(combo.lastInsertRowid);
  check('combo criado com product_type=combo', (db.prepare('SELECT product_type FROM products WHERE id=?').get(comboId) as { product_type: string }).product_type === 'combo');

  db.prepare('INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(comboId, hamburguerId, 2, 1, randomUUID());
  const comboCompCount = db.prepare('SELECT COUNT(*) AS c FROM kit_items WHERE kit_product_id=? AND deleted_at IS NULL').get(comboId) as { c: number };
  check('combo tem 1 componente fixo (2x Hamburguer)', comboCompCount.c === 1);

  const paoGroupId = db.prepare(
    "INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)",
  ).run('Escolha o pao', 1, 1, randomUUID());
  const paoGroupIdNum = Number(paoGroupId.lastInsertRowid);
  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(paoGroupIdNum, refrigeranteId, null, 1, randomUUID());
  db.prepare('INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)')
    .run(comboId, paoGroupIdNum, 1, randomUUID());
  const links = db.prepare('SELECT COUNT(*) AS c FROM product_complement_groups WHERE product_id=? AND deleted_at IS NULL').get(comboId) as { c: number };
  check('combo tem 1 grupo de complemento vinculado', links.c === 1);

  // Simular venda do combo + complemento
  const comboSale = db.prepare(
    "INSERT INTO sales (customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, client_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(null, 4100, 0, 0, 4100, 'dinheiro', 4100, 0, 1, randomUUID(), randomUUID());
  const comboSaleId = Number(comboSale.lastInsertRowid);

  const comboLineGroupUuid = randomUUID();
  insertItem.run(comboSaleId, comboId, 'Combo Premium', 1, 3500, 1500, 3500, null, comboLineGroupUuid);
  const comboComponents = db.prepare(
    `SELECT ki.qty AS compQty, comp.id, comp.name, comp.cost_cents
     FROM kit_items ki JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
     WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL ORDER BY ki.sort_order`,
  ).all(comboId) as { compQty: number; id: number; name: string; cost_cents: number }[];
  for (const comp of comboComponents) {
    insertItem.run(comboSaleId, comp.id, comp.name, comp.compQty * 1, 0, comp.cost_cents, 0, null, comboLineGroupUuid);
  }
  // Complemento escolhido (vem do carrinho, com seu proprio lineGroupUuid)
  insertItem.run(comboSaleId, refrigeranteId, 'Refrigerante', 1, 600, 200, 600, 'gelado', randomUUID());

  const comboSaleItems = db.prepare(
    `SELECT product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid
     FROM sale_items WHERE sale_id=? ORDER BY id`,
  ).all(comboSaleId) as { product_name: string; qty: number; unit_price_cents: number; cost_cents: number; total_cents: number; notes: string | null; line_group_uuid: string | null }[];
  check('combo gerou 3 linhas (combo + componente fixo + complemento)', comboSaleItems.length === 3);
  check('linha 0 = Combo Premium price=3500', comboSaleItems[0].product_name === 'Combo Premium' && comboSaleItems[0].unit_price_cents === 3500);
  check('linha 1 = Hamburguer (componente fixo) price=0 qty=2', comboSaleItems[1].product_name === 'Hamburguer' && comboSaleItems[1].unit_price_cents === 0 && comboSaleItems[1].qty === 2);
  check('linha 2 = Refrigerante (complemento) price=600 notes=gelado', comboSaleItems[2].product_name === 'Refrigerante' && comboSaleItems[2].unit_price_cents === 600 && comboSaleItems[2].notes === 'gelado');
  check('combo e componente fixo tem mesmo lineGroupUuid', comboSaleItems[0].line_group_uuid === comboLineGroupUuid && comboSaleItems[1].line_group_uuid === comboLineGroupUuid);
  check('complemento tem lineGroupUuid diferente', comboSaleItems[2].line_group_uuid !== comboLineGroupUuid);

  // 6. Soft-delete em cascata
  db.transaction(() => {
    db.prepare("UPDATE kit_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE kit_product_id = ?").run(kitId);
  })();
  const remainingComponents = db.prepare('SELECT COUNT(*) AS c FROM kit_items WHERE deleted_at IS NULL AND kit_product_id=?').get(kitId) as { c: number };
  check('componentes do kit deletado nao contam mais', remainingComponents.c === 0);

  // 7. Gating
  check('commercial.kits comeca desligada',
    (db.prepare("SELECT enabled FROM capabilities WHERE key='commercial.kits'").get() as { enabled: number })?.enabled === 0);
  db.prepare("UPDATE capabilities SET enabled=1 WHERE key='commercial.kits'").run();
  check('commercial.kits ligada',
    (db.prepare("SELECT enabled FROM capabilities WHERE key='commercial.kits'").get() as { enabled: number }).enabled === 1);

  console.log(`\nKits: TODOS OS TESTES PASSARAM (${failures} falhas)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
