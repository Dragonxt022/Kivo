/**
 * Rotas de importação/exportação de produtos — catálogo inteiro (v2): tipos,
 * variantes com pai/atributos, kits, ficha técnica e grupos de complemento.
 *
 * O parse e a validação vivem em productsImport.ts e complementsImport.ts
 * (lógica pura). Aqui só entra o que precisa de banco: ler o catálogo, resolver
 * categorias/referências e gravar.
 *
 * Garantias que valem o desenho:
 *  1. Estoque inicial entra por moveStockRaw('entrada'), nunca escrevendo stock_qty —
 *     o saldo é derivado do ledger stock_movements (ver stock.ts).
 *  2. O commit é tudo-ou-nada: uma transação só. Importação pela metade deixa o
 *     cliente sem saber quais linhas entraram.
 *  3. Commit em duas passagens dentro da mesma transação: passagem 1 faz o upsert
 *     de todos os produtos e monta o mapa sku|uuid → id; passagem 2 grava as
 *     relações. Assim a ordem das linhas no arquivo não importa. As relações são
 *     substituídas (DELETE + INSERT) apenas para os produtos presentes no arquivo.
 *  4. Track stock de variante tem um valor só (definição canônica): filha de
 *     variante = 1 (igual ao gerador de variantes), variante mestre e complemento
 *     = 0 (igual ao CRUD). A coluna controla_estoque da planilha sobrepõe.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { hasCapability } from '../../core/capabilities/service';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { validateBarcode } from '../../shared/barcode';
import { moveStockRaw } from './stock';
import { productRepository } from './repositories/ProductRepository';
import { categoryRepository } from './repositories/CategoryRepository';
import {
  buildPreview, templateCsv, toCsv, IMPORT_COLUMNS, EXPORT_ONLY_COLUMNS,
  type ParsedRow, type ExistingProduct,
} from './productsImport';
import {
  buildComplementsPreview, complementsTemplateCsv, COMPLEMENT_COLUMNS,
  type ExistingComplementGroup,
} from './complementsImport';

const router = Router();

/** Limite de linhas: o commit roda numa transação só e trava o processo enquanto grava. */
const MAX_ROWS = 5000;

const normKey = (v: string | null | undefined): string => String(v ?? '').trim().toLowerCase();

function centsToBr(cents: number): string {
  return (Number(cents ?? 0) / 100).toFixed(2).replace('.', ',');
}

function readCapabilities(): { variantes: boolean; complementos: boolean } {
  return {
    variantes: hasCapability('commercial.variantes'),
    complementos: hasCapability('commercial.complementos'),
  };
}

function loadExisting(): ExistingProduct[] {
  return productRepository.raw(
    'SELECT id, uuid, sku, barcode, product_type AS productType FROM products WHERE deleted_at IS NULL',
  ) as unknown as ExistingProduct[];
}

function loadCategories(): { id: number; name: string }[] {
  return productRepository.raw(
    'SELECT id, name FROM categories WHERE deleted_at IS NULL',
  ) as { id: number; name: string }[];
}

/** Resolve SKU/uuid de produto no banco — usado pelas opções de complemento. */
function resolveProductRef(ref: string): { productId: number } | undefined {
  const hit = productRepository.rawOne(
    'SELECT id FROM products WHERE deleted_at IS NULL AND (sku = ? OR uuid = ?)',
    ref, ref,
  );
  return hit ? { productId: hit.id as number } : undefined;
}

function loadComplementGroups(): ExistingComplementGroup[] {
  const groups = productRepository.raw(
    'SELECT id, name, min_select, max_select FROM complement_groups WHERE deleted_at IS NULL ORDER BY name',
  ) as unknown as { id: number; name: string; min_select: number; max_select: number | null }[];
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    minSelect: Number(g.min_select ?? 0),
    maxSelect: g.max_select != null ? Number(g.max_select) : null,
    items: productRepository.raw(
      `SELECT i.id, i.product_id, p.sku, i.price_override_cents, i.sort_order
       FROM complement_group_items i JOIN products p ON p.id = i.product_id
       WHERE i.group_id = ? AND i.deleted_at IS NULL`,
      g.id,
    ).map((i) => ({
      id: i.id as number,
      productId: i.product_id as number,
      productSku: i.sku != null ? String(i.sku) : null,
      priceOverrideCents: (i.price_override_cents as number | null) ?? null,
      sortOrder: Number(i.sort_order ?? 0),
    })),
  }));
}

function readPreview(body: unknown): { csv: string } | { error: string } {
  const csv = (body as { csv?: unknown })?.csv;
  if (typeof csv !== 'string' || !csv.trim()) return { error: 'Envie o conteúdo do arquivo CSV no campo "csv".' };
  if (csv.length > 8_000_000) return { error: 'Arquivo grande demais (máx. ~8 MB).' };
  return { csv };
}

function readBodyString(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * SKUs que o arquivo de produtos (etapa 1) vai criar — usados para as opções de
 * complemento que referenciam produto novo. Se o arquivo de produtos estiver com
 * erro, a validação dele não é deste endpoint; só não se conhece os SKUs pendentes.
 */
function pendingSkusFrom(productsCsv: string | undefined): string[] {
  if (!productsCsv) return [];
  const p = buildPreview({
    csv: productsCsv,
    existing: loadExisting(),
    existingCategories: loadCategories(),
    validateBarcode,
    capabilities: readCapabilities(),
  });
  if (!p.ok) return [];
  return p.report.rows.filter((r) => r.status === 'novo').map((r) => r.data.sku).filter((s): s is string => !!s);
}

// ─────────────────────────── Exportar produtos ───────────────────────────

router.get('/products/export.csv', requirePermission('commercial.products.view'), (req, res) => {
  // Catálogo inteiro, incluindo variantes (pai e filhas), kits, produzidos etc.
  // Filhas de variante vão por último, e kits depois de componentes — só para
  // legibilidade no Excel: o importador resolve referências em qualquer ordem.
  const rows = productRepository.raw(
    `SELECT p.uuid, p.sku, p.barcode, p.name, p.description, c.name AS category, p.unit,
            p.price_cents, p.cost_cents, p.min_stock, p.stock_qty,
            p.ncm, p.cest, p.csosn, p.cst, p.origem,
            p.product_type, p.track_stock, p.visivel_cardapio,
            parent.sku AS parent_sku, parent.uuid AS parent_uuid,
            (SELECT group_concat(a.name || '=' || v.value, '|')
               FROM product_variant_values pvv
               JOIN product_attributes a ON a.id = pvv.attribute_id AND a.deleted_at IS NULL
               JOIN product_attribute_values v ON v.id = pvv.attribute_value_id AND v.deleted_at IS NULL
              WHERE pvv.product_id = p.id AND pvv.deleted_at IS NULL) AS attributes,
            (SELECT group_concat(coalesce(comp.sku, comp.uuid) || '*' || rtrim(rtrim(CAST(ki.qty AS TEXT), '0'), '.'), '|')
               FROM kit_items ki JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
              WHERE ki.kit_product_id = p.id AND ki.deleted_at IS NULL) AS kit_items,
            (SELECT group_concat(coalesce(inp.sku, inp.uuid) || '*' || rtrim(rtrim(CAST(ri.qty AS TEXT), '0'), '.'), '|')
               FROM product_recipe_items ri JOIN products inp ON inp.id = ri.input_product_id AND inp.deleted_at IS NULL
              WHERE ri.produced_product_id = p.id AND ri.deleted_at IS NULL) AS recipe_items,
            (SELECT group_concat(g.name, '|')
               FROM product_complement_groups pcg JOIN complement_groups g ON g.id = pcg.group_id AND g.deleted_at IS NULL
              WHERE pcg.product_id = p.id AND pcg.deleted_at IS NULL) AS complement_groups,
            (SELECT group_concat(name, '|')
               FROM (SELECT DISTINCT a2.name AS name
                       FROM products ch
                       JOIN product_variant_values pvv2 ON pvv2.product_id = ch.id AND pvv2.deleted_at IS NULL
                       JOIN product_attributes a2 ON a2.id = pvv2.attribute_id AND a2.deleted_at IS NULL
                      WHERE ch.parent_product_id = p.id AND ch.deleted_at IS NULL)) AS child_attributes
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN products parent ON parent.id = p.parent_product_id
     WHERE p.deleted_at IS NULL
     ORDER BY (p.product_type = 'variante' AND p.parent_product_id IS NOT NULL) ASC,
              (SELECT EXISTS(SELECT 1 FROM kit_items WHERE kit_product_id = p.id)) ASC,
              p.name`,
  ) as unknown as {
    uuid: string; sku: string | null; barcode: string | null; name: string; description: string | null;
    category: string | null; unit: string; price_cents: number; cost_cents: number;
    min_stock: number; stock_qty: number;
    ncm: string | null; cest: string | null; csosn: string | null; cst: string | null; origem: number | null;
    product_type: string; track_stock: number; visivel_cardapio: number;
    parent_sku: string | null; parent_uuid: string | null;
    attributes: string | null; kit_items: string | null; recipe_items: string | null;
    complement_groups: string | null; child_attributes: string | null;
  }[];

  const csv = toCsv([
    [...IMPORT_COLUMNS, ...EXPORT_ONLY_COLUMNS],
    ...rows.map((p) => {
      // Atributos: linha de variante mestre mostra só os nomes (Tamanho|Cor) — é o
      // que recria a estrutura no reimport; filha mostra os pares (Tamanho=M).
      const isMaster = p.product_type === 'variante' && !p.parent_sku && !p.parent_uuid;
      const attributes = isMaster
        ? p.child_attributes ?? ''
        : p.attributes ?? '';
      return [
        // uuid vai preenchido: é o que faz o reimport deste arquivo ATUALIZAR em vez
        // de duplicar, mesmo em produto sem SKU nem código de barras.
        p.uuid,
        p.sku ?? '', p.barcode ?? '', p.name, p.description ?? '', p.category ?? '', p.unit ?? 'un',
        centsToBr(p.price_cents), centsToBr(p.cost_cents), String(p.min_stock ?? 0),
        '', // estoque_inicial: em branco de propósito — só vale para produto novo
        p.ncm ?? '', p.cest ?? '', p.csosn ?? '', p.cst ?? '',
        p.origem != null ? String(p.origem) : '',
        p.product_type,
        (p.parent_sku ?? p.parent_uuid) ?? '',
        attributes,
        p.kit_items ?? '',
        p.recipe_items ?? '',
        p.complement_groups ?? '',
        p.track_stock ? 'sim' : 'nao',
        p.visivel_cardapio ? 'sim' : 'nao',
        String(p.stock_qty ?? 0),
      ];
    }),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="produtos-${stamp}.csv"`);
  audit(req, 'exportar', 'product', 0, null, { total: rows.length });
  res.send(csv);
});

router.get('/products/import-template.csv', requirePermission('commercial.products.create'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-produtos.csv"');
  res.send(templateCsv());
});

// ─────────────────────── Importar produtos: pré-visualização ───────────────────────

router.post('/products/import/preview', requirePermission('commercial.products.create'), (req, res) => {
  const parsed = readPreview(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const result = buildPreview({
    csv: parsed.csv,
    existing: loadExisting(),
    existingCategories: loadCategories(),
    validateBarcode,
    capabilities: readCapabilities(),
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  if (result.report.totals.total > MAX_ROWS) {
    res.status(400).json({ error: `Arquivo com ${result.report.totals.total} linhas — o limite é ${MAX_ROWS}. Divida em partes.` });
    return;
  }
  res.json(result.report);
});

// ─────────────────────── Importar produtos: gravar ───────────────────────

router.post('/products/import/commit', requirePermission('commercial.products.create'), (req, res) => {
  assertAuth(req);
  const parsed = readPreview(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Revalida do zero em vez de confiar num preview vindo do cliente: o preview é
  // informativo, esta é a decisão. Se o arquivo mudou entre os dois passos, é aqui
  // que se descobre.
  const result = buildPreview({
    csv: parsed.csv,
    existing: loadExisting(),
    existingCategories: loadCategories(),
    validateBarcode,
    capabilities: readCapabilities(),
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const report = result.report;
  if (report.totals.total > MAX_ROWS) {
    res.status(400).json({ error: `Arquivo com ${report.totals.total} linhas — o limite é ${MAX_ROWS}.` });
    return;
  }
  if (report.totals.erros > 0) {
    res.status(400).json({
      error: `O arquivo tem ${report.totals.erros} linha(s) com erro. Corrija e importe de novo — nada foi gravado.`,
      totals: report.totals,
    });
    return;
  }

  const wantsPrice = report.rows.some((r) => r.data.priceCents > 0 || r.data.costCents > 0);
  if (wantsPrice && !req.user.permissions.has('commercial.products.price')) {
    res.status(403).json({ error: 'Permissão negada: commercial.products.price (definir preço).' });
    return;
  }
  const wantsStock = report.rows.some((r) => (r.data.initialStock ?? 0) > 0);
  if (wantsStock && !req.user.permissions.has('commercial.stock.move')) {
    res.status(403).json({ error: 'Permissão negada: commercial.stock.move (estoque inicial).' });
    return;
  }

  const created: number[] = [];
  const updated: number[] = [];
  let categoriesCreated = 0;
  let error: string | null = null;

  try {
    productRepository.transaction(() => {
      // Mapa de categorias montado dentro da transação: as criadas aqui precisam
      // valer para as linhas seguintes do mesmo arquivo.
      const catIdByName = new Map<string, number>();
      for (const c of loadCategories()) catIdByName.set(normKey(c.name), c.id);

      const resolveCategory = (name: string | null): number | null => {
        if (!name) return null;
        const key = normKey(name);
        const hit = catIdByName.get(key);
        if (hit) return hit;
        const id = Number(
          categoryRepository.rawRun(
            'INSERT INTO categories (name, uuid) VALUES (?, ?)',
            name.trim(), randomUUID(),
          ).lastInsertRowid,
        );
        catIdByName.set(key, id);
        categoriesCreated++;
        return id;
      };

      // Referências (produto_pai, componentes, insumos) resolvidas por sku|uuid →
      // id. Começa com o catálogo do banco e ganha cada linha do arquivo na
      // passagem 1 — assim a ordem das linhas não importa.
      const idByRef = new Map<string, number>();
      for (const p of loadExisting()) {
        if (p.sku) idByRef.set(`sku:${normKey(p.sku)}`, p.id);
        if (p.uuid) idByRef.set(`uuid:${normKey(p.uuid)}`, p.id);
      }
      const resolveRefId = (ref: string): number | undefined =>
        idByRef.get(`sku:${normKey(ref)}`) ?? idByRef.get(`uuid:${normKey(ref)}`);

      const getAttrId = (name: string): number => {
        const hit = productRepository.rawOne(
          'SELECT id FROM product_attributes WHERE name = ? AND deleted_at IS NULL',
          name,
        );
        if (hit) return hit.id as number;
        return Number(
          productRepository.rawRun(
            'INSERT INTO product_attributes (name, uuid) VALUES (?, ?)',
            name, randomUUID(),
          ).lastInsertRowid,
        );
      };
      const getAttrValueId = (attributeId: number, value: string): number => {
        const hit = productRepository.rawOne(
          'SELECT id FROM product_attribute_values WHERE attribute_id = ? AND value = ? AND deleted_at IS NULL',
          attributeId, value,
        );
        if (hit) return hit.id as number;
        return Number(
          productRepository.rawRun(
            'INSERT INTO product_attribute_values (attribute_id, value, uuid) VALUES (?, ?, ?)',
            attributeId, value, randomUUID(),
          ).lastInsertRowid,
        );
      };
      const getGroupId = (name: string): number => {
        const hit = productRepository.rawOne(
          'SELECT id FROM complement_groups WHERE name = ? AND deleted_at IS NULL',
          name,
        );
        if (hit) return hit.id as number;
        return Number(
          productRepository.rawRun(
            'INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, 0, NULL, ?)',
            name, randomUUID(),
          ).lastInsertRowid,
        );
      };

      // ── Passagem 1: upsert de todos os produtos ──
      const rowId = new Map<ParsedRow, number>();
      for (const row of report.rows as ParsedRow[]) {
        const d = row.data;
        const categoryId = resolveCategory(d.categoryName);
        // Definição canônica de track_stock (ver cabeçalho do arquivo).
        const trackStock = d.trackStock != null
          ? (d.trackStock ? 1 : 0)
          : (d.productType === 'variante' && d.parentRef
              ? 1
              : (d.productType === 'variante' || d.productType === 'complemento' ? 0 : 1));
        const cardapio = d.visivelCardapio != null ? (d.visivelCardapio ? 1 : 0) : null;

        if (row.matchedId) {
          // Update não mexe em estoque nem cria produto — só os campos do arquivo.
          // Campos fiscais usam COALESCE: coluna em branco na planilha PRESERVA o que já
          // está cadastrado, em vez de apagar. Quem exporta, mexe só no preço e reimporta
          // não pode perder o NCM que preencheu antes.
          productRepository.rawRun(
            `UPDATE products SET name = ?, description = ?, sku = ?, barcode = ?, category_id = ?,
               unit = ?, price_cents = ?, cost_cents = ?, min_stock = ?,
               product_type = ?, track_stock = ?, visivel_cardapio = COALESCE(?, visivel_cardapio),
               ncm = COALESCE(?, ncm), cest = COALESCE(?, cest), csosn = COALESCE(?, csosn),
               cst = COALESCE(?, cst), origem = COALESCE(?, origem),
               updated_at = datetime('now')
             WHERE id = ?`,
            d.name, d.description, d.sku, d.barcode, categoryId,
            d.unit, d.priceCents, d.costCents, d.minStock,
            d.productType, trackStock, cardapio,
            d.ncm, d.cest, d.csosn, d.cst, d.origem, row.matchedId,
          );
          updated.push(row.matchedId);
          rowId.set(row, row.matchedId);
        } else {
          const info = productRepository.rawRun(
            `INSERT INTO products (name, description, sku, barcode, category_id, unit,
               price_cents, cost_cents, track_stock, min_stock, product_type, uuid,
               visivel_cardapio, ncm, cest, csosn, cst, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            d.name, d.description, d.sku, d.barcode, categoryId, d.unit,
            d.priceCents, d.costCents, trackStock, d.minStock, d.productType, randomUUID(),
            cardapio ?? 0,
            d.ncm, d.cest, d.csosn, d.cst, d.origem,
          );
          const newId = Number(info.lastInsertRowid);
          created.push(newId);
          rowId.set(row, newId);

          if (d.initialStock != null && d.initialStock > 0) {
            // Caminho oficial do estoque: gera movimentação e deixa o saldo derivar dela.
            const move = moveStockRaw(req, newId, 'entrada', d.initialStock, 'importação de produtos');
            if (!move.ok) throw new Error(`linha ${row.line}: ${move.error}`);
          }
        }

        // Registra as chaves desta linha para as referências da passagem 2.
        if (d.sku) idByRef.set(`sku:${normKey(d.sku)}`, rowId.get(row)!);
        if (d.uuid) idByRef.set(`uuid:${normKey(d.uuid)}`, rowId.get(row)!);
      }

      // ── Passagem 2: relações (substituídas só para produtos do arquivo) ──
      for (const row of report.rows as ParsedRow[]) {
        const d = row.data;
        const id = rowId.get(row)!;

        // Pai: variante re-grava o pai; demais tipos limpam para não sobrar filho
        // órfão quando o tipo muda (ex.: filha reclassificada como produto simples).
        if (d.productType === 'variante' && d.parentRef) {
          const parentId = resolveRefId(d.parentRef);
          if (parentId) {
            productRepository.rawRun(
              "UPDATE products SET parent_product_id = ?, updated_at = datetime('now') WHERE id = ?",
              parentId, id,
            );
          }
        } else {
          productRepository.rawRun(
            "UPDATE products SET parent_product_id = NULL, updated_at = datetime('now') WHERE id = ?",
            id,
          );
        }

        // Atributos: só linhas com pares gravam product_variant_values (as filhas);
        // nomes nus (mestre) apenas garantem o atributo na estrutura.
        productRepository.rawRun('DELETE FROM product_variant_values WHERE product_id = ?', id);
        for (const attr of d.attributes) {
          const attrId = getAttrId(attr.name);
          if (attr.value == null) continue;
          const valueId = getAttrValueId(attrId, attr.value);
          productRepository.rawRun(
            'INSERT INTO product_variant_values (product_id, attribute_id, attribute_value_id, uuid) VALUES (?, ?, ?, ?)',
            id, attrId, valueId, randomUUID(),
          );
        }

        productRepository.rawRun('DELETE FROM kit_items WHERE kit_product_id = ?', id);
        d.kitItems.forEach((item, i) => {
          const compId = resolveRefId(item.ref);
          if (!compId) return; // validado no preview; guarda defensiva
          productRepository.rawRun(
            'INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
            id, compId, item.qty, i + 1, randomUUID(),
          );
        });

        productRepository.rawRun('DELETE FROM product_recipe_items WHERE produced_product_id = ?', id);
        d.recipeItems.forEach((item, i) => {
          const inputId = resolveRefId(item.ref);
          if (!inputId) return; // validado no preview; guarda defensiva
          productRepository.rawRun(
            'INSERT INTO product_recipe_items (produced_product_id, input_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
            id, inputId, item.qty, i + 1, randomUUID(),
          );
        });

        productRepository.rawRun('DELETE FROM product_complement_groups WHERE product_id = ?', id);
        d.complementGroups.forEach((name, i) => {
          const groupId = getGroupId(name);
          productRepository.rawRun(
            'INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)',
            id, groupId, i + 1, randomUUID(),
          );
        });
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // O índice único pode pegar algo que o preview não viu (ex.: outro usuário
    // gravou o mesmo SKU no intervalo entre pré-visualizar e confirmar).
    error = msg.includes('UNIQUE constraint failed')
      ? 'Conflito de SKU ou código de barras com um produto gravado por outra pessoa enquanto você conferia. Pré-visualize de novo.'
      : msg;
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }

  audit(req, 'importar', 'product', 0, null, {
    criados: created.length, atualizados: updated.length, categoriasCriadas: categoriesCreated,
  });
  res.json({
    ok: true,
    criados: created.length,
    atualizados: updated.length,
    categoriasCriadas: categoriesCreated,
  });
});

// ─────────────────────── Complementos: exportar ───────────────────────

router.get(
  '/products/complements-export.csv',
  requirePermission('commercial.products.view'),
  requireCapability('commercial.complementos'),
  (req, res) => {
    const rows = productRepository.raw(
      `SELECT g.name, g.min_select, g.max_select, coalesce(p.sku, p.uuid) AS option_ref,
              i.price_override_cents, i.sort_order
       FROM complement_groups g
       JOIN complement_group_items i ON i.group_id = g.id AND i.deleted_at IS NULL
       JOIN products p ON p.id = i.product_id AND p.deleted_at IS NULL
       WHERE g.deleted_at IS NULL
       ORDER BY g.name, i.sort_order, option_ref`,
    ) as unknown as {
      name: string; min_select: number; max_select: number | null;
      option_ref: string; price_override_cents: number | null; sort_order: number;
    }[];

    const csv = toCsv([
      [...COMPLEMENT_COLUMNS],
      ...rows.map((g) => [
        g.name,
        String(g.min_select ?? 0),
        g.max_select != null ? String(g.max_select) : '',
        g.option_ref,
        g.price_override_cents != null ? centsToBr(g.price_override_cents) : '',
        String(g.sort_order ?? 0),
      ]),
    ]);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="complementos-${stamp}.csv"`);
    audit(req, 'exportar', 'complement_group', 0, null, { total: rows.length });
    res.send(csv);
  },
);

router.get(
  '/products/complements-template.csv',
  requirePermission('commercial.products.create'),
  requireCapability('commercial.complementos'),
  (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modelo-complementos.csv"');
    res.send(complementsTemplateCsv());
  },
);

// ─────────────────────── Complementos: pré-visualização ───────────────────────

router.post(
  '/products/complements/import/preview',
  requirePermission('commercial.products.create'),
  requireCapability('commercial.complementos'),
  (req, res) => {
    const csv = readBodyString(req.body, 'csv');
    if (!csv || !csv.trim()) {
      res.status(400).json({ error: 'Envie o conteúdo do arquivo CSV no campo "csv".' });
      return;
    }
    if (csv.length > 8_000_000) {
      res.status(400).json({ error: 'Arquivo grande demais (máx. ~8 MB).' });
      return;
    }
    // productsCsv (etapa 1) é opcional: permite validar opções que apontam para
    // produto que o arquivo de produtos vai criar.
    const result = buildComplementsPreview({
      csv,
      existingGroups: loadComplementGroups(),
      resolveProduct: resolveProductRef,
      pendingSkus: pendingSkusFrom(readBodyString(req.body, 'productsCsv')),
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (result.report.totals.total > MAX_ROWS) {
      res.status(400).json({ error: `Arquivo com ${result.report.totals.total} linhas — o limite é ${MAX_ROWS}.` });
      return;
    }
    res.json(result.report);
  },
);

// ─────────────────────── Complementos: gravar ───────────────────────

router.post(
  '/products/complements/import/commit',
  requirePermission('commercial.products.create'),
  requireCapability('commercial.complementos'),
  (req, res) => {
    assertAuth(req);
    const csv = readBodyString(req.body, 'csv');
    if (!csv || !csv.trim()) {
      res.status(400).json({ error: 'Envie o conteúdo do arquivo CSV no campo "csv".' });
      return;
    }
    if (csv.length > 8_000_000) {
      res.status(400).json({ error: 'Arquivo grande demais (máx. ~8 MB).' });
      return;
    }

    const result = buildComplementsPreview({
      csv,
      existingGroups: loadComplementGroups(),
      resolveProduct: resolveProductRef,
      pendingSkus: pendingSkusFrom(readBodyString(req.body, 'productsCsv')),
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const report = result.report;
    if (report.totals.total > MAX_ROWS) {
      res.status(400).json({ error: `Arquivo com ${report.totals.total} linhas — o limite é ${MAX_ROWS}.` });
      return;
    }
    if (report.totals.erros > 0) {
      res.status(400).json({
        error: `O arquivo tem ${report.totals.erros} linha(s) com erro. Corrija e importe de novo — nada foi gravado.`,
        totals: report.totals,
      });
      return;
    }

    let error: string | null = null;
    const gruposCriados: number[] = [];
    const opcoesGravadas: number[] = [];
    try {
      productRepository.transaction(() => {
        // Passagem 1: grupos — cria os que faltam, atualiza min/max dos existentes.
        const groupIdByName = new Map<string, number>();
        for (const g of loadComplementGroups()) groupIdByName.set(normKey(g.name), g.id);
        const groupIds: number[] = [];
        for (const row of report.rows) {
          const d = row.data;
          let gid = row.groupId;
          if (gid == null) {
            gid = Number(
              productRepository.rawRun(
                'INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)',
                d.groupName, d.minSelect, d.maxSelect, randomUUID(),
              ).lastInsertRowid,
            );
            groupIdByName.set(normKey(d.groupName), gid);
            gruposCriados.push(gid);
          } else {
            productRepository.rawRun(
              "UPDATE complement_groups SET min_select = ?, max_select = ?, updated_at = datetime('now') WHERE id = ?",
              d.minSelect, d.maxSelect, gid,
            );
          }
          if (!groupIds.includes(gid)) groupIds.push(gid);
        }

        // Passagem 2: o arquivo é a fonte da verdade para os grupos dele — as
        // opções atuais são desativadas e as do arquivo entram no lugar. Grupos
        // que não estão no arquivo não são tocados.
        for (const gid of groupIds) {
          productRepository.rawRun(
            "UPDATE complement_group_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE group_id = ?",
            gid,
          );
        }
        for (const row of report.rows) {
          const d = row.data;
          const gid = row.groupId ?? groupIdByName.get(normKey(d.groupName));
          if (gid == null) throw new Error(`linha ${row.line}: grupo "${d.groupName}" não resolvido`);
          if (d.optionProductId == null) {
            throw new Error(
              `linha ${row.line}: a opção "${d.optionSku}" é criada pelo arquivo de produtos — importe e confirme antes o arquivo de produtos.`,
            );
          }
          productRepository.rawRun(
            'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
            gid, d.optionProductId, d.priceOverrideCents, d.sortOrder, randomUUID(),
          );
          opcoesGravadas.push(gid);
        }
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (error) {
      res.status(400).json({ error });
      return;
    }

    audit(req, 'importar', 'complement_group', 0, null, {
      gruposCriados: gruposCriados.length,
      opcoesGravadas: opcoesGravadas.length,
    });
    res.json({
      ok: true,
      gruposCriados: gruposCriados.length,
      opcoesGravadas: opcoesGravadas.length,
    });
  },
);

export default router;
