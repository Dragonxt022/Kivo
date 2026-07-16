/**
 * Importação/exportação de produtos (v1 — só produto simples, tipo 'fisico').
 *
 * Este arquivo é lógica pura: parse, coerção e validação. Não toca no banco nem no
 * Express — quem grava é productsImportRoutes.ts. A separação existe para o parser
 * (que é onde mora o risco de corromper preço) ser testável direto, sem subir servidor.
 *
 * Decisões de formato (ver também o modelo baixável):
 *  - CSV com `;` e BOM UTF-8: é o que o Excel brasileiro abre e salva por padrão.
 *    Com vírgula decimal em dinheiro, `,` como separador de campo seria ambíguo.
 *  - O arquivo exportado É o modelo de importação — um formato só, ida e volta.
 *  - `estoque_inicial` só vale para produto NOVO, e entra como movimentação de
 *    entrada (nunca escrevendo stock_qty direto — ver stock.ts).
 */

export const IMPORT_COLUMNS = [
  // Identidade estável do produto. Vem preenchida na exportação e serve para o
  // reimport atualizar o produto certo — inclusive quando ele não tem SKU nem
  // código de barras (sem isso, exportar e importar de volta DUPLICA o catálogo).
  // Em linha nova fica vazia. É só chave de busca: nunca é gravada.
  'uuid',
  'sku',
  'codigo_barras',
  'nome',
  'descricao',
  'categoria',
  'unidade',
  'preco_venda',
  'preco_custo',
  'estoque_minimo',
  'estoque_inicial',
] as const;

/** Coluna informativa: sai na exportação, é ignorada na importação. */
export const EXPORT_ONLY_COLUMNS = ['estoque_atual'] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type RowStatus = 'novo' | 'atualizar' | 'erro';

export interface ParsedRow {
  /** Linha no arquivo como o usuário vê no Excel (1 = cabeçalho, dados começam em 2). */
  line: number;
  status: RowStatus;
  errors: string[];
  matchedId: number | null;
  matchedBy: 'uuid' | 'codigo_barras' | 'sku' | null;
  data: {
    sku: string | null;
    barcode: string | null;
    name: string;
    description: string | null;
    categoryName: string | null;
    unit: string;
    priceCents: number;
    costCents: number;
    minStock: number;
    initialStock: number | null;
  };
}

export interface PreviewReport {
  rows: ParsedRow[];
  newCategories: string[];
  totals: { total: number; novos: number; atualizar: number; erros: number };
}

// ─────────────────────────── CSV ───────────────────────────

const BOM = '﻿';

/**
 * Parser de CSV com aspas. Não usamos split(';') porque campo entre aspas pode
 * conter o separador e quebra de linha — descrição de produto faz isso o tempo todo.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } // "" escapa uma aspa
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ';') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Linhas em branco NÃO são removidas aqui: quem consome numera as linhas para o
  // usuário achar o erro no Excel, e filtrar aqui deslocaria essa numeração.
  return rows;
}

export function isBlankRow(r: string[]): boolean {
  return !r.some((f) => String(f ?? '').trim() !== '');
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return BOM + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

// ─────────────────────── Coerção de valores ───────────────────────

/**
 * Converte texto de dinheiro em centavos. É o ponto mais perigoso do importador:
 * errar aqui vende produto de R$ 1.234,00 por R$ 1,23 sem ninguém perceber.
 *
 * Regra (documentada no modelo):
 *  - "R$ 1.234,56" / "1.234,56" / "1234,56"  → vírgula é decimal, ponto é milhar
 *  - "1234.56"                               → ponto é decimal (2 casas)
 *  - "1.234"                                 → ponto com 3 dígitos depois é MILHAR → 1234,00
 *  - "1234"                                  → inteiro
 * O preview mostra o valor já convertido para a pessoa conferir antes de gravar.
 */
export function parseMoneyToCents(raw: string): { ok: true; cents: number } | { ok: false; error: string } {
  const s = String(raw ?? '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return { ok: true, cents: 0 };
  if (!/^-?[\d.,]+$/.test(s)) return { ok: false, error: `valor inválido: "${raw}"` };

  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Os dois presentes: o que vier por último é o decimal.
    normalized = lastComma > lastDot
      ? body.replace(/\./g, '').replace(',', '.')
      : body.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = body.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = body.length - lastDot - 1;
    const manyDots = (body.match(/\./g) as string[]).length > 1;
    // "1.234" e "1.234.567": ponto separando milhar. "12.5"/"12.50": decimal.
    normalized = manyDots || decimals === 3 ? body.replace(/\./g, '') : body;
  } else {
    normalized = body;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return { ok: false, error: `valor inválido: "${raw}"` };
  const cents = Math.round(n * 100);
  if (neg) return { ok: false, error: `valor não pode ser negativo: "${raw}"` };
  if (cents > 100_000_000_00) return { ok: false, error: `valor fora do limite: "${raw}"` };
  return { ok: true, cents };
}

/** Inteiro não-negativo (estoque mínimo/inicial). Aceita "10", "10,0" e "10.0". */
export function parseIntField(raw: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };
  const cents = parseMoneyToCents(s);
  if (!cents.ok) return { ok: false, error: `${label} inválido: "${raw}"` };
  if (cents.cents % 100 !== 0) return { ok: false, error: `${label} deve ser inteiro: "${raw}"` };
  return { ok: true, value: cents.cents / 100 };
}

/** "Descrição" / "DESCRICAO" / "preço venda" → "descricao" / "preco_venda". */
export function normalizeHeader(h: string): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove os diacríticos separados pelo NFD
    .replace(/\s+/g, '_');
}

// ─────────────────────────── Validação ───────────────────────────

export interface ExistingProduct {
  id: number;
  uuid: string;
  sku: string | null;
  barcode: string | null;
}

export interface BuildPreviewInput {
  csv: string;
  existing: ExistingProduct[];
  existingCategories: { id: number; name: string }[];
  /** Injetado para reusar a validação de dígito verificador do app (shared/barcode). */
  validateBarcode: (code: string) => boolean;
}

const norm = (v: string | null | undefined): string => String(v ?? '').trim();
const normCat = (v: string): string => norm(v).toLowerCase();

export function buildPreview(input: BuildPreviewInput): { ok: true; report: PreviewReport } | { ok: false; error: string } {
  const table = parseCsv(input.csv);
  if (!table.length) return { ok: false, error: 'Arquivo vazio.' };

  const headers = table[0].map(normalizeHeader);
  const missing = (['nome'] as const).filter((c) => !headers.includes(c));
  if (missing.length) {
    return { ok: false, error: `Faltando a coluna obrigatória: ${missing.join(', ')}. Baixe o modelo e use o mesmo cabeçalho.` };
  }
  const idx = (col: string): number => headers.indexOf(col);
  const cell = (r: string[], col: string): string => {
    const i = idx(col);
    return i < 0 ? '' : norm(r[i]);
  };

  // Índices do que já existe no banco, para decidir criar vs. atualizar.
  const byUuid = new Map<string, ExistingProduct>();
  const byBarcode = new Map<string, ExistingProduct>();
  const bySku = new Map<string, ExistingProduct>();
  for (const p of input.existing) {
    if (p.uuid) byUuid.set(norm(p.uuid).toLowerCase(), p);
    if (p.barcode) byBarcode.set(norm(p.barcode), p);
    if (p.sku) bySku.set(norm(p.sku).toLowerCase(), p);
  }
  const catByName = new Map<string, { id: number; name: string }>();
  for (const c of input.existingCategories) catByName.set(normCat(c.name), c);

  // Duplicata DENTRO do arquivo é erro à parte: sku/codigo_barras têm índice único
  // parcial no banco, então duas linhas iguais estouram no meio do INSERT.
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  // Chaveado pelo nome normalizado, guardando a grafia da 1ª ocorrência: sem isso,
  // "Bebidas" e "bebidas" no mesmo arquivo criariam DUAS categorias.
  const newCategories = new Map<string, string>();
  const rows: ParsedRow[] = [];

  for (let r = 1; r < table.length; r++) {
    const raw = table[r];
    if (isBlankRow(raw)) continue; // pula, mas sem mexer no contador: `line` tem que bater com o Excel
    const line = r + 1; // 1 = cabeçalho; casa com o número de linha do Excel
    const errors: string[] = [];

    const name = cell(raw, 'nome');
    if (!name) errors.push('nome é obrigatório');

    const sku = cell(raw, 'sku') || null;
    const barcode = cell(raw, 'codigo_barras') || null;

    if (barcode && !input.validateBarcode(barcode)) {
      errors.push(`código de barras inválido (dígito verificador não confere): "${barcode}"`);
    }
    if (sku) {
      const key = sku.toLowerCase();
      const prev = seenSku.get(key);
      if (prev) errors.push(`SKU "${sku}" repetido na linha ${prev} deste arquivo`);
      else seenSku.set(key, line);
    }
    if (barcode) {
      const prev = seenBarcode.get(barcode);
      if (prev) errors.push(`código de barras "${barcode}" repetido na linha ${prev} deste arquivo`);
      else seenBarcode.set(barcode, line);
    }

    const price = parseMoneyToCents(cell(raw, 'preco_venda'));
    if (!price.ok) errors.push(`preço de venda — ${price.error}`);
    const cost = parseMoneyToCents(cell(raw, 'preco_custo'));
    if (!cost.ok) errors.push(`preço de custo — ${cost.error}`);
    const minStock = parseIntField(cell(raw, 'estoque_minimo'), 'estoque mínimo');
    if (!minStock.ok) errors.push(minStock.error);
    const initialStock = parseIntField(cell(raw, 'estoque_inicial'), 'estoque inicial');
    if (!initialStock.ok) errors.push(initialStock.error);

    // Ordem do casamento: uuid (identidade real) → código de barras → SKU.
    // Nome nunca casa: dois produtos podem legitimamente ter o mesmo nome.
    // uuid que não existe aqui (arquivo de outra instalação) cai nas chaves seguintes.
    const uuidCell = cell(raw, 'uuid');
    const hitUuid = uuidCell ? byUuid.get(uuidCell.toLowerCase()) : undefined;
    const hitBarcode = barcode ? byBarcode.get(barcode) : undefined;
    const hitSku = sku ? bySku.get(sku.toLowerCase()) : undefined;
    let matchedId: number | null = null;
    let matchedBy: 'uuid' | 'codigo_barras' | 'sku' | null = null;
    if (hitUuid) { matchedId = hitUuid.id; matchedBy = 'uuid'; }
    else if (hitBarcode) { matchedId = hitBarcode.id; matchedBy = 'codigo_barras'; }
    else if (hitSku) { matchedId = hitSku.id; matchedBy = 'sku'; }

    // As chaves apontando para produtos diferentes: gravar violaria o índice único.
    // Melhor barrar aqui do que estourar no meio do INSERT.
    const hits: { key: string; p: ExistingProduct }[] = [];
    if (hitUuid) hits.push({ key: 'uuid', p: hitUuid });
    if (hitBarcode) hits.push({ key: 'código de barras', p: hitBarcode });
    if (hitSku) hits.push({ key: 'SKU', p: hitSku });
    const distinct = new Set(hits.map((h) => h.p.id));
    if (distinct.size > 1) {
      errors.push(`conflito: ${hits.map((h) => `${h.key} é do produto #${h.p.id}`).join(' e ')}`);
    }

    const categoryName = cell(raw, 'categoria') || null;
    if (categoryName && !catByName.has(normCat(categoryName)) && !newCategories.has(normCat(categoryName))) {
      newCategories.set(normCat(categoryName), categoryName);
    }

    if (matchedId && initialStock.ok && initialStock.value != null && initialStock.value > 0) {
      errors.push('estoque inicial só vale para produto novo — use uma entrada de estoque para ajustar o saldo');
    }

    rows.push({
      line,
      status: errors.length ? 'erro' : matchedId ? 'atualizar' : 'novo',
      errors,
      matchedId,
      matchedBy,
      data: {
        sku,
        barcode,
        name,
        description: cell(raw, 'descricao') || null,
        categoryName,
        unit: cell(raw, 'unidade') || 'un',
        priceCents: price.ok ? price.cents : 0,
        costCents: cost.ok ? cost.cents : 0,
        minStock: minStock.ok ? (minStock.value ?? 0) : 0,
        initialStock: initialStock.ok ? initialStock.value : null,
      },
    });
  }

  if (!rows.length) return { ok: false, error: 'O arquivo só tem cabeçalho — nenhuma linha de produto.' };

  return {
    ok: true,
    report: {
      rows,
      newCategories: [...newCategories.values()],
      totals: {
        total: rows.length,
        novos: rows.filter((x) => x.status === 'novo').length,
        atualizar: rows.filter((x) => x.status === 'atualizar').length,
        erros: rows.filter((x) => x.status === 'erro').length,
      },
    },
  };
}

/**
 * Cabeçalho + duas linhas de exemplo, para o cliente ver o formato esperado.
 * A coluna uuid fica vazia: produto novo não tem identidade ainda.
 */
export function templateCsv(): string {
  return toCsv([
    [...IMPORT_COLUMNS],
    ['', 'CAF-001', '7891000315507', 'Café Torrado 500g', 'Torra média, moído', 'Mercearia', 'un', '18,90', '12,50', '5', '30'],
    ['', '', '', 'Pão Francês', 'Vendido por quilo', 'Padaria', 'kg', '14,90', '9,00', '0', ''],
  ]);
}
