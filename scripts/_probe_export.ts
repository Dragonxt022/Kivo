import { migrateUp } from '../src/core/database/migrator';
import { runSeeds } from '../src/core/database/seeds';
import { getSqlite } from '../src/core/database/connection';

migrateUp();
runSeeds();
const db = getSqlite();
try {
  const rows = db.prepare(`SELECT p.uuid, p.sku, p.barcode, p.name, p.description, c.name AS category, p.unit,
            p.price_cents, p.cost_cents, p.min_stock, p.stock_qty,
            p.ncm, p.cest, p.csosn, p.cst, p.origem,
            p.product_type, p.track_stock, p.visivel_cardapio,
            parent.sku AS parent_sku, parent.uuid AS parent_uuid,
            (SELECT group_concat(a.name || '=' || v.value, '|')
               FROM product_variant_values pvv
               JOIN product_attributes a ON a.id = pvv.attribute_id AND a.deleted_at IS NULL
               JOIN product_attribute_values v ON v.id = pvv.attribute_value_id AND v.deleted_at IS NULL
              WHERE pvv.product_id = p.id AND pvv.deleted_at IS NULL) AS attributes,
            (SELECT group_concat(coalesce(comp.sku, comp.uuid) || '*' || CAST(ki.qty AS TEXT), '|')
               FROM kit_items ki JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
              WHERE ki.kit_product_id = p.id AND ki.deleted_at IS NULL) AS kit_items,
            (SELECT group_concat(coalesce(inp.sku, inp.uuid) || '*' || CAST(ri.qty AS TEXT), '|')
               FROM product_recipe_items ri JOIN products inp ON inp.id = ri.input_product_id AND inp.deleted_at IS NULL
              WHERE ri.produced_product_id = p.id AND ri.deleted_at IS NULL) AS recipe_items,
            (SELECT group_concat(g.name, '|')
               FROM product_complement_groups pcg JOIN complement_groups g ON g.id = pcg.group_id AND g.deleted_at IS NULL
              WHERE pcg.product_id = p.id AND pcg.deleted_at IS NULL) AS complement_groups,
            (SELECT group_concat(DISTINCT a2.name, '|')
               FROM products ch
               JOIN product_variant_values pvv2 ON pvv2.product_id = ch.id AND pvv2.deleted_at IS NULL
               JOIN product_attributes a2 ON a2.id = pvv2.attribute_id AND a2.deleted_at IS NULL
              WHERE ch.parent_product_id = p.id AND ch.deleted_at IS NULL) AS child_attributes
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN products parent ON parent.id = p.parent_product_id
     WHERE p.deleted_at IS NULL
     ORDER BY (p.product_type = 'variante' AND p.parent_product_id IS NOT NULL) ASC,
              (SELECT EXISTS(SELECT 1 FROM kit_items WHERE kit_product_id = p.id)) ASC,
              p.name`).all();
  console.log('OK, linhas:', rows.length);
} catch (e) {
  console.log('ERRO:', (e as Error).message);
}
