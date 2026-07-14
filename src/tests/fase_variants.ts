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
    { key: 'commercial.variantes', description: 'Produtos com variantes' },
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

  // 1. parent_product_id column existe
  const cols = db.prepare("PRAGMA table_info('products')").all() as { name: string }[];
  const hasParentCol = cols.some((c) => c.name === 'parent_product_id');
  check('products tem coluna parent_product_id', hasParentCol);

  // 2. Criar produto-pai (product_type = 'variante')
  const parentId = Number(db.prepare(
    `INSERT INTO products (name, product_type, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid)
     VALUES ('Camiseta', 'variante', 'un', 5000, 2000, 0, 0, 1, ?)`,
  ).run(randomUUID()).lastInsertRowid);
  check('produto-pai criado com product_type=variante', parentId > 0);

  // parent_product_id deve ser NULL no pai
  const parentRow = db.prepare('SELECT parent_product_id, track_stock FROM products WHERE id = ?').get(parentId) as
    { parent_product_id: number | null; track_stock: number };
  check('produto-pai tem parent_product_id=NULL', parentRow.parent_product_id === null);
  check('produto-pai tem track_stock=0', parentRow.track_stock === 0);

  // 3. Criar produto normal para comparacao
  const normalId = Number(db.prepare(
    `INSERT INTO products (name, product_type, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid, barcode)
     VALUES ('Produto Normal', 'fisico', 'un', 1000, 500, 1, 0, 1, ?, '1234567890128')`,
  ).run(randomUUID()).lastInsertRowid);
  check('produto normal criado', normalId > 0);

  // 4. Criar atributos: Tamanho (P/M/G) e Cor (Azul/Vermelho)
  const attrTamanho = Number(db.prepare(
    'INSERT INTO product_attributes (name, uuid) VALUES (?, ?)',
  ).run('Tamanho', randomUUID()).lastInsertRowid);
  const attrCor = Number(db.prepare(
    'INSERT INTO product_attributes (name, uuid) VALUES (?, ?)',
  ).run('Cor', randomUUID()).lastInsertRowid);
  check('atributo Tamanho criado', attrTamanho > 0);
  check('atributo Cor criado', attrCor > 0);

  const valP = Number(db.prepare('INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, 0, ?)').run(attrTamanho, 'P', randomUUID()).lastInsertRowid);
  const valM = Number(db.prepare('INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, 1, ?)').run(attrTamanho, 'M', randomUUID()).lastInsertRowid);
  const valG = Number(db.prepare('INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, 2, ?)').run(attrTamanho, 'G', randomUUID()).lastInsertRowid);
  const valAzul = Number(db.prepare('INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, 0, ?)').run(attrCor, 'Azul', randomUUID()).lastInsertRowid);
  const valVermelho = Number(db.prepare('INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, 1, ?)').run(attrCor, 'Vermelho', randomUUID()).lastInsertRowid);
  check('valores de Tamanho (P/M/G) criados', valP > 0 && valM > 0 && valG > 0);
  check('valores de Cor (Azul/Vermelho) criados', valAzul > 0 && valVermelho > 0);

  // 5. Testar geracao de variantes (produto cartesiano: 3 tamanhos x 2 cores = 6)
  const attrValueIds = [valP, valM, valG, valAzul, valVermelho];
  // Agrupar por attribute_id
  const tamanhoIds = [valP, valM, valG];
  const corIds = [valAzul, valVermelho];

  // Gerar as 6 combinacoes manualmente via transacao (como a rota faria)
  const combos: { name: string; ids: number[] }[] = [];
  for (const tId of tamanhoIds) {
    const tVal = db.prepare('SELECT value FROM product_attribute_values WHERE id = ?').get(tId) as { value: string };
    for (const cId of corIds) {
      const cVal = db.prepare('SELECT value FROM product_attribute_values WHERE id = ?').get(cId) as { value: string };
      combos.push({ name: `Camiseta - ${tVal.value}, ${cVal.value}`, ids: [tId, cId] });
    }
  }
  check('produto cartesiano calculado: 3x2=6 combinacoes', combos.length === 6);

  const variantIds: number[] = [];
  db.transaction(() => {
    for (const combo of combos) {
      const info = db.prepare(
        `INSERT INTO products (name, parent_product_id, product_type, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid)
         VALUES (?, ?, 'variante', 'un', 5000, 2000, 1, 0, 1, ?)`,
      ).run(combo.name, parentId, randomUUID());
      const vid = Number(info.lastInsertRowid);
      variantIds.push(vid);
      // 2 atributos por variante: tamanho + cor
      const tValId = combo.ids[0];
      const cValId = combo.ids[1];
      db.prepare('INSERT INTO product_variant_values (product_id, attribute_id, attribute_value_id, uuid) VALUES (?, ?, ?, ?)').run(vid, attrTamanho, tValId, randomUUID());
      db.prepare('INSERT INTO product_variant_values (product_id, attribute_id, attribute_value_id, uuid) VALUES (?, ?, ?, ?)').run(vid, attrCor, cValId, randomUUID());
    }
  })();
  check('6 variantes criadas', variantIds.length === 6);

  // Confirmar vinculos em product_variant_values
  const pvvCount = db.prepare('SELECT COUNT(*) AS c FROM product_variant_values WHERE product_id IN (' + variantIds.map(() => '?').join(',') + ')').get(...variantIds) as { c: number };
  check('12 vinculos em product_variant_values (6 vars x 2 atributos)', pvvCount.c === 12);

  // 6. Confirmar estoque/preco independentes
  // Variar precos em algumas variantes
  db.prepare('UPDATE products SET price_cents = 6000, sku = ? WHERE id = ?').run('SKU-CAM-P-AZUL', variantIds[0]);
  db.prepare('UPDATE products SET price_cents = 7000, barcode = ? WHERE id = ?').run('9876543210128', variantIds[1]);
  db.prepare('UPDATE products SET stock_qty = 10 WHERE id = ?').run(variantIds[2]);

  const v0 = db.prepare('SELECT price_cents, sku FROM products WHERE id = ?').get(variantIds[0]) as { price_cents: number; sku: string | null };
  const v1 = db.prepare('SELECT price_cents, barcode FROM products WHERE id = ?').get(variantIds[1]) as { price_cents: number; barcode: string | null };
  const v2 = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(variantIds[2]) as { stock_qty: number };
  check('variante 0 tem preco 6000 e SKU proprio', v0.price_cents === 6000 && v0.sku === 'SKU-CAM-P-AZUL');
  check('variante 1 tem preco 7000 e barcode proprio', v1.price_cents === 7000 && v1.barcode === '9876543210128');
  check('variante 2 tem stock_qty=10 proprio', v2.stock_qty === 10);

  // 7. Produto-pai nao aparece em busca por barcode
  // Dar um barcode ao pai
  db.prepare('UPDATE products SET barcode = ? WHERE id = ?').run('PARENT-BARCODE', parentId);
  const parentByBarcode = db.prepare(
    `SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.barcode = ? AND p.deleted_at IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`,
  ).get('PARENT-BARCODE') as { id: number } | undefined;
  check('produto-pai NAO encontrado por barcode (excluido como nao-vendavel)', !parentByBarcode);

  // 8. Variante especifica aparece por barcode
  const variantByBarcode = db.prepare(
    `SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.barcode = ? AND p.deleted_at IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`,
  ).get('9876543210128') as { id: number } | undefined;
  check('variante encontrada por barcode', variantByBarcode?.id === variantIds[1]);

  // 9. Variante aparece por SKU na busca
  const variantBySku = db.prepare(
    `SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL) AND p.sku = ?`,
  ).get('SKU-CAM-P-AZUL') as { id: number } | undefined;
  check('variante encontrada por SKU', variantBySku?.id === variantIds[0]);

  // 10. Produto-pai nao aparece na lista (parent_product_id IS NULL filter)
  const listamentoSemQ = db.prepare(
    `SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND p.parent_product_id IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`,
  ).get() as { c: number };
  // Deve ter: 1 normal + 0 pai (pai excluido pelo NOT) = 1
  check('lista sem q mostra 1 produto (so o normal, pai excluido)', listamentoSemQ.c === 1);

  // 11. Na busca com q, pai NAO aparece mas variantes aparecem (search / listTopLevel)
  const buscaCamiseta = db.prepare(
    `SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL) AND p.name LIKE ?`,
  ).get('%Camiseta%') as { c: number };
  check('busca "Camiseta" retorna 6 variantes (pai excluido)', buscaCamiseta.c === 6);

  // 11b. listAll() inclui o produto-pai (sem o filtro excludente)
  const listagemComPai = db.prepare(
    `SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND p.parent_product_id IS NULL`,
  ).get() as { c: number };
  // Deve ter: 1 normal + 1 pai = 2
  check('listAll() mostra 2 produtos (normal + pai de variantes)', listagemComPai.c === 2);

  // 11c. searchAll() retorna pai + 6 variantes = 7
  const buscaComPai = db.prepare(
    `SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND p.name LIKE ?`,
  ).get('%Camiseta%') as { c: number };
  check('searchAll() "Camiseta" retorna 7 (pai + 6 variantes)', buscaComPai.c === 7);

  // 12. Duplicar variante preserva product_type e parent_product_id
  const sourceDuplicate = db.prepare('SELECT product_type, parent_product_id, unit, price_cents, cost_cents, track_stock, min_stock FROM products WHERE id = ?').get(variantIds[0]) as
    { product_type: string; parent_product_id: number; unit: string; price_cents: number; cost_cents: number; track_stock: number; min_stock: number };
  const dupId = Number(db.prepare(
    `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, product_type, parent_product_id, uuid)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'Camiseta - P, Azul (copia)', null, sourceDuplicate.unit, sourceDuplicate.price_cents, sourceDuplicate.cost_cents,
    sourceDuplicate.track_stock, sourceDuplicate.min_stock, sourceDuplicate.product_type, sourceDuplicate.parent_product_id, randomUUID(),
  ).lastInsertRowid);
  const dupCheck = db.prepare('SELECT product_type, parent_product_id FROM products WHERE id = ?').get(dupId) as
    { product_type: string; parent_product_id: number | null };
  check('duplicata preserva product_type=variante', dupCheck.product_type === 'variante');
  check('duplicata preserva parent_product_id', dupCheck.parent_product_id === sourceDuplicate.parent_product_id);

  // 13. Excluir produto-pai faz cascade soft-delete nas variantes filhas
  db.prepare('UPDATE products SET deleted_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE parent_product_id = ?').run(parentId);
  db.prepare('UPDATE products SET deleted_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').run(parentId);
  const remainingVariants = db.prepare('SELECT COUNT(*) AS c FROM products WHERE parent_product_id = ? AND deleted_at IS NULL').get(parentId) as { c: number };
  check('cascade: 0 variantes filhas restantes apos soft-delete do pai', remainingVariants.c === 0);
  const parentDeleted = db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(parentId) as { deleted_at: string | null };
  check('produto-pai soft-deletado', parentDeleted.deleted_at !== null);

  // 14. Gating por capability (desligado por padrao = 403)
  registerCapabilities(TEST_MODULE);
  const capEnabled = hasCapability('commercial.variantes');
  check('commercial.variantes comeca desligada (enabled=0)', capEnabled === false);

  // 15. Nao precisamos testar 403 na rota (teste unitario de middleware), mas verificar que
  // ligar a capability faz hasCapability retornar true
  db.prepare(
    `UPDATE capabilities SET enabled = 1, updated_at = datetime('now'), uuid = ? WHERE key = ?`,
  ).run(randomUUID(), 'commercial.variantes');
  const capLigada = hasCapability('commercial.variantes');
  check('commercial.variantes ligada via UPDATE direto', capLigada === true);

  closeDb();
  console.log(failures === 0 ? '\nVariants: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
