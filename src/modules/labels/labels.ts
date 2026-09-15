import { getSqlite } from '../../core/database/connection';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import { generateInternalBarcode } from '../../shared/barcode';
import { barcodeSvg, isSymbology, type Symbology } from './services/barcode';
import { labelSheetRepository, type LabelSheetRow } from './repositories/LabelSheetRepository';

/**
 * Regras do gerador: busca de produto, montagem das etiquetas e paginação na folha.
 * A view de impressão só posiciona o que sai daqui — nenhuma regra de negócio no EJS.
 */

export interface LabelProduct {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  price_cents: number;
}

export interface LabelFields {
  name: boolean;
  price: boolean;
  sku: boolean;
  company: boolean;
}

export interface PrintConfig {
  sheetId: number;
  symbology: Symbology;
  fields: LabelFields;
}

export interface LabelRequestItem {
  id: number;
  qty: number;
}

export interface LabelData {
  productId: number;
  name: string;
  sku: string | null;
  unit: string;
  priceCents: number;
  /** Código impresso no código de barras/QR (barcode do produto ou EAN interno). */
  code: string;
  /** true quando o código é gerado internamente (produto sem código de fábrica). */
  internalCode: boolean;
  barcodeSvg: string;
  barcodeNote?: string;
}

export interface PlacedLabel extends LabelData {
  leftMm: number;
  topMm: number;
}

export interface LabelPage {
  labels: PlacedLabel[];
}

const DEFAULT_FIELDS: LabelFields = { name: true, price: true, sku: false, company: false };

/** Busca produtos para o seletor da tela (nome, código de barras ou SKU). */
export function searchProducts(q: string, limit = 40): LabelProduct[] {
  const term = (q ?? '').trim();
  const lim = Math.min(Math.max(1, Math.floor(limit)), 200);
  const db = getSqlite();
  if (!term) {
    return db
      .prepare(
        `SELECT id, name, sku, barcode, unit, price_cents FROM products
         WHERE deleted_at IS NULL ORDER BY name LIMIT ?`,
      )
      .all(lim) as LabelProduct[];
  }
  return db
    .prepare(
      `SELECT id, name, sku, barcode, unit, price_cents FROM products
       WHERE deleted_at IS NULL AND (name LIKE ? OR barcode = ? OR sku = ?)
       ORDER BY name LIMIT ?`,
    )
    .all(`%${term}%`, term, term, lim) as LabelProduct[];
}

function loadProducts(ids: number[]): Map<number, LabelProduct> {
  const map = new Map<number, LabelProduct>();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = getSqlite()
    .prepare(
      `SELECT id, name, sku, barcode, unit, price_cents FROM products
       WHERE deleted_at IS NULL AND id IN (${ph})`,
    )
    .all(...ids) as LabelProduct[];
  for (const r of rows) map.set(r.id, r);
  return map;
}

/**
 * Normaliza o corpo recebido da tela. Rejeita quantidade absurda por item (o teto evita
 * uma folha de milhares de páginas por engano de digitação) e limita o total de etiquetas.
 */
export function parseRequest(body: unknown): { ok: true; items: LabelRequestItem[]; config: PrintConfig } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items: LabelRequestItem[] = [];
  for (const it of rawItems) {
    const o = it as Record<string, unknown>;
    const id = Number(o?.id);
    const qty = Math.floor(Number(o?.qty));
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    items.push({ id, qty: Math.min(qty, 1000) });
  }
  if (!items.length) return { ok: false, error: 'Selecione ao menos um produto.' };

  const total = items.reduce((s, i) => s + i.qty, 0);
  if (total > 2000) return { ok: false, error: 'Muitas etiquetas de uma vez (máximo 2000).' };

  const sheetId = Number(b.sheetId);
  if (!Number.isFinite(sheetId) || sheetId <= 0) return { ok: false, error: 'Escolha um modelo de folha.' };

  const symbology: Symbology = isSymbology(b.symbology) ? b.symbology : 'ean13';
  const f = (b.fields ?? {}) as Record<string, unknown>;
  const fields: LabelFields = {
    name: f.name !== false,
    price: f.price !== false,
    sku: f.sku === true,
    company: f.company === true,
  };
  return { ok: true, items, config: { sheetId, symbology, fields } };
}

export function getSheet(id: number): LabelSheetRow | undefined {
  return labelSheetRepository.findById(id);
}

export function companyName(): string {
  return settingsRepository.get('empresa.nome') || 'Kivo';
}

/**
 * Expande os itens em etiquetas (uma por cópia). O código de barras de cada código
 * distinto é gerado UMA vez (cache) — repetir o mesmo produto na folha não re-renderiza.
 */
export function buildLabels(items: LabelRequestItem[], symbology: Symbology): LabelData[] {
  const products = loadProducts(items.map((i) => i.id));
  const cache = new Map<string, ReturnType<typeof barcodeSvg>>();
  const labels: LabelData[] = [];

  for (const item of items) {
    const p = products.get(item.id);
    if (!p) continue;
    const internalCode = !(p.barcode ?? '').trim();
    const code = internalCode ? generateInternalBarcode(p.id) : (p.barcode ?? '').trim();
    const key = `${symbology}|${code}`;
    let svg = cache.get(key);
    if (!svg) {
      svg = barcodeSvg(symbology, code);
      cache.set(key, svg);
    }
    for (let n = 0; n < item.qty; n++) {
      labels.push({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        priceCents: p.price_cents,
        code,
        internalCode,
        barcodeSvg: svg.svg,
        barcodeNote: svg.note,
      });
    }
  }
  return labels;
}

/** Posição (mm) de uma etiqueta dentro da folha, a partir do índice na grade. */
export function positionFor(indexInSheet: number, sheet: LabelSheetRow): { leftMm: number; topMm: number } {
  const col = indexInSheet % sheet.cols;
  const row = Math.floor(indexInSheet / sheet.cols);
  return {
    leftMm: sheet.margin_left_mm + col * (sheet.label_w_mm + sheet.gutter_x_mm),
    topMm: sheet.margin_top_mm + row * (sheet.label_h_mm + sheet.gutter_y_mm),
  };
}

/** Divide as etiquetas em páginas de `perSheet` (colunas × linhas) e calcula as posições. */
export function paginate(labels: LabelData[], sheet: LabelSheetRow): LabelPage[] {
  const perSheet = Math.max(1, sheet.cols * sheet.rows);
  const pages: LabelPage[] = [];
  for (let i = 0; i < labels.length; i += perSheet) {
    const slice = labels.slice(i, i + perSheet);
    pages.push({
      labels: slice.map((l, idx) => ({ ...l, ...positionFor(idx, sheet) })),
    });
  }
  return pages.length ? pages : [{ labels: [] }];
}

export { DEFAULT_FIELDS };
