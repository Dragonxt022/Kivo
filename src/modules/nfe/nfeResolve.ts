/**
 * Classificação dos itens da NF-e contra o catálogo (identificação + conflitos).
 *
 * Regra central do PRD: NUNCA decidir dois produtos são iguais só pelo nome, e nunca
 * usar apenas o cProd como identificador global. A cascata é:
 *
 *   1. EAN/GTIN (cEAN) — match exato no código de barras do produto;
 *   2. código do fornecedor (product_suppliers, por cProd) já vinculado;
 *   3. código interno + fornecedor (cProd == SKU do produto já vinculado a esse fornecedor);
 *   4. nome apenas como SUGESTÃO (possível correspondência, exige confirmação).
 *
 * Conflitos são sinalizados em `flags`, nunca resolvidos em silêncio: EAN diferente no
 * mesmo produto, unidade/NCM diferentes, custo diferente, código de fornecedor ambíguo.
 */
import type { NfeDetItem } from './nfeParse';

export interface CatalogProduct {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  ncm: string | null;
  costCents: number;
}

export interface SupplierCodeMapping {
  productId: number;
  code: string;
}

export interface NfeCatalog {
  products: CatalogProduct[];
  byBarcode: Map<string, CatalogProduct[]>;
  bySku: Map<string, CatalogProduct[]>;
  byCode: Map<string, CatalogProduct[]>;
  byNameExact: Map<string, CatalogProduct[]>;
  /** Produtos que já têm vínculo com o fornecedor da nota (p/ casar cProd == SKU). */
  supplierProductIds: Set<number>;
}

export type NfeLineKind = 'new' | 'matched' | 'possible' | 'invalid';

export type NfeLineFlag =
  | 'ean_conflict'
  | 'ean_invalid'
  | 'name_conflict'
  | 'supplier_code_conflict'
  | 'unit_conflict'
  | 'ncm_conflict'
  | 'price_changed';

export interface NfeLineResolution {
  kind: NfeLineKind;
  /** Motivo da decisão (máquina): ean | supplier_code | internal_code | name | none. */
  reason: string;
  product: CatalogProduct | null;
  candidates: CatalogProduct[];
  flags: NfeLineFlag[];
  /** Presente quando kind == invalid. */
  error?: string;
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeUnit(s: string | null): string {
  return (s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function sameUnit(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return normalizeUnit(a) === normalizeUnit(b);
}

/** Similaridade de descrição por tokens (Jaccard) para SUGERIR possíveis. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function buildCatalog(
  products: CatalogProduct[],
  codeMappings: SupplierCodeMapping[],
  supplierProductIds: Set<number> = new Set(),
): NfeCatalog {
  const byBarcode = new Map<string, CatalogProduct[]>();
  const bySku = new Map<string, CatalogProduct[]>();
  const byCode = new Map<string, CatalogProduct[]>();
  const byNameExact = new Map<string, CatalogProduct[]>();

  const push = <T,>(map: Map<string, T[]>, key: string, val: T): void => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(val);
    else map.set(key, [val]);
  };

  for (const p of products) {
    push(byBarcode, (p.barcode ?? '').trim(), p);
    push(bySku, (p.sku ?? '').trim(), p);
    push(byNameExact, normalizeName(p.name), p);
  }
  for (const m of codeMappings) {
    const prod = products.find((p) => p.id === m.productId);
    if (prod) push(byCode, m.code.trim(), prod);
  }
  return { products, byBarcode, bySku, byCode, byNameExact, supplierProductIds };
}

/** Sugestões por nome quando não há match forte — até `limit` por similaridade. */
function suggestByName(item: NfeDetItem, cat: NfeCatalog, limit = 5): CatalogProduct[] {
  const exact = cat.byNameExact.get(normalizeName(item.description));
  if (exact) return exact.slice(0, limit);
  const scored: { p: CatalogProduct; s: number }[] = [];
  for (const p of cat.products) {
    const s = nameSimilarity(item.description, p.name);
    if (s >= 0.45) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

export function resolveItem(item: NfeDetItem, cat: NfeCatalog): NfeLineResolution {
  if (!item.description.trim() || !item.unit?.trim() || !(item.qty > 0) || !(item.unitCostCents > 0)) {
    return { kind: 'invalid', reason: 'none', product: null, candidates: [], flags: [], error: 'Item sem dados mínimos (descrição, unidade, quantidade ou custo).' };
  }

  const ean = item.ean;
  const flags: NfeLineFlag[] = [];

  const pick = (list: CatalogProduct[], reason: string, kind: NfeLineKind = 'matched'): NfeLineResolution | null => {
    if (list.length !== 1) return null;
    const product = list[0];
    return { kind, reason, product, candidates: list, flags: computeFlags(item, product, flags) };
  };

  const singleEan = ean ? cat.byBarcode.get(ean.trim()) ?? [] : [];
  if (ean && singleEan.length === 1) {
    const r = pick(singleEan, 'ean');
    if (r) return r;
  }
  if (ean && singleEan.length > 1) {
    // Duplicidade de código de barras no próprio cadastro: não decide sozinho.
    return {
      kind: 'possible',
      reason: 'ean',
      product: null,
      candidates: singleEan,
      flags: ['ean_conflict'],
    };
  }

  const byCodeList = cat.byCode.get((item.cProd || '').trim()) ?? [];
  if (byCodeList.length === 1) {
    const product = byCodeList[0];
    // O cProd aponta para um produto, mas o EAN da nota pertence a OUTRO produto:
    // contradição real — nunca decide sozinho.
    if (ean && product.barcode && product.barcode.trim() !== ean) {
      const eanProd = cat.byBarcode.get(ean.trim());
      if (eanProd && eanProd.length === 1 && eanProd[0].id !== product.id) {
        return {
          kind: 'possible',
          reason: 'supplier_code',
          product,
          candidates: [product, eanProd[0]],
          flags: ['ean_conflict', 'supplier_code_conflict'],
        };
      }
    }
    return { kind: 'matched', reason: 'supplier_code', product, candidates: [product], flags: computeFlags(item, product, flags) };
  }
  if (byCodeList.length > 1) {
    return {
      kind: 'possible',
      reason: 'supplier_code',
      product: null,
      candidates: byCodeList,
      flags: ['supplier_code_conflict'],
    };
  }

  // Código interno + fornecedor: cProd == SKU de um produto JÁ vinculado a este
  // fornecedor. Nunca casa cProd com SKU de produto não vinculado (cProd é do
  // emitente; dois fornecedores podem usar o mesmo código para produtos diferentes).
  const skuList = cat.bySku.get((item.cProd || '').trim()) ?? [];
  if (!ean && skuList.length === 1 && cat.supplierProductIds.has(skuList[0].id)) {
    return { kind: 'matched', reason: 'internal_code', product: skuList[0], candidates: skuList, flags: computeFlags(item, skuList[0], flags) };
  }

  // Nome apenas como SUGESTÃO — nunca auto.
  const byName = suggestByName(item, cat);
  if (byName.length) {
    const exactCount = byName.filter((p) => normalizeName(p.name) === normalizeName(item.description)).length;
    const fl = exactCount > 1 ? ['name_conflict' as NfeLineFlag] : [];
    return { kind: 'possible', reason: 'name', product: byName[0], candidates: byName, flags: fl };
  }

  return { kind: 'new', reason: 'none', product: null, candidates: [], flags: [] };
}

function computeFlags(item: NfeDetItem, product: CatalogProduct, base: NfeLineFlag[]): NfeLineFlag[] {
  const flags = [...base];
  if (item.ean && product.barcode && product.barcode.trim() !== item.ean) flags.push('ean_conflict');
  if (item.unit && product.unit && !sameUnit(item.unit, product.unit)) flags.push('unit_conflict');
  if (item.ncm && product.ncm && product.ncm.trim() !== item.ncm.trim()) flags.push('ncm_conflict');
  if (product.costCents > 0 && product.costCents !== item.unitCostCents) flags.push('price_changed');
  return flags;
}

/** Labels PT-BR das flags para a tela de conferência. */
export const FLAG_LABELS: Record<NfeLineFlag, string> = {
  ean_conflict: 'EAN diferente do cadastrado',
  ean_invalid: 'EAN da nota com dígito verificador inválido',
  name_conflict: 'Mais de um produto com este nome',
  supplier_code_conflict: 'Código do fornecedor ambíguo',
  unit_conflict: 'Unidade diferente',
  ncm_conflict: 'NCM diferente do cadastrado',
  price_changed: 'Custo diferente do cadastrado',
};

/** Label do status primário (kind) para a tela. */
export function kindLabel(kind: NfeLineKind): string {
  switch (kind) {
    case 'matched': return 'Encontrado';
    case 'new': return 'Novo';
    case 'possible': return 'Possível conflito';
    case 'invalid': return 'Inválido';
  }
}
