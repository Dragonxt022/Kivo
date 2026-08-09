/**
 * Importação/exportação de produtos — catálogo inteiro: fisico, variante (pai e
 * filhas), kit/combo, produzido, complemento, serviço etc., com as relações
 * (atributos, componentes, ficha técnica, grupos de complemento).
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
 *  - Colunas novas são SEMPRE acrescentadas ao fim: quem já usa a planilha não
 *    perde a posição das colunas que conhece.
 *  - Referências (produto_pai, componentes, ficha_tecnica) usam SKU, com uuid e
 *    NOME como fallback, nessa ordem. A resolução olha primeiro o próprio arquivo
 *    (a ordem das linhas não importa — o commit grava em duas passagens) e depois
 *    o catálogo do banco. O nome entra porque planilha montada à mão quase nunca
 *    tem SKU: quem digita escreve "Poltrona (1 Lugar)" na coluna produto_pai, não
 *    um código. Nome repetido não resolve — vira erro de ambiguidade, para nunca
 *    ligar a variante ao produto errado em silêncio.
 *  - As relações das linhas presentes no arquivo SÃO substituídas pelo conteúdo do
 *    arquivo (DELETE + INSERT no commit). O arquivo é a fonte da verdade.
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
  // Dados fiscais (módulo fiscal). Ficam no fim para não mexer na ordem das colunas de
  // quem já usa a planilha. Um lojista que vai emitir nota fiscal precisa preencher NCM
  // em centenas de produtos — exportar, preencher no Excel e reimportar é o caminho
  // prático; a tela de edição em lote cobre o ajuste fino.
  'ncm',
  'cest',
  'csosn',
  'cst',
  'origem',
  // Tipo e relacionamentos (v2). Também no fim, pela mesma regra de nunca mexer na
  // ordem das colunas que já existem.
  'tipo',
  'produto_pai',
  'atributos',
  'componentes',
  'ficha_tecnica',
  'grupos_complemento',
  'controla_estoque',
  'visivel_cardapio',
] as const;

/** Valores aceitos na coluna `tipo` (mesmos do schema products.product_type). */
export const PRODUCT_TYPES = [
  'fisico', 'fracionado', 'composto', 'kit', 'combo', 'produzido',
  'servico', 'variante', 'complemento', 'digital', 'assinatura',
] as const;

/** Par de atributo da coluna `atributos`: `Tamanho=M` → { name: 'Tamanho', value: 'M' }. */
export interface AttributePart {
  name: string;
  /** null quando a linha só cita o nome (`Tamanho|Cor` — linha do variante mestre). */
  value: string | null;
}

/** Referência de produto com quantidade da coluna `componentes`/`ficha_tecnica`. */
export interface RefItem {
  /** SKU (ou uuid como fallback) do produto referenciado. */
  ref: string;
  qty: number;
}

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
    /** Identidade vinda do arquivo (preenchida na exportação). Nunca é gravada. */
    uuid: string | null;
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
    ncm: string | null;
    cest: string | null;
    csosn: string | null;
    cst: string | null;
    origem: number | null;
    /** product_type do schema; vazio na planilha → 'fisico'. */
    productType: string;
    /** Referência do produto variante mestre (SKU/uuid). Só para tipo 'variante'. */
    parentRef: string | null;
    /** Atributos da linha: `Tamanho=M|Cor=Azul` (filha) ou `Tamanho|Cor` (mestre). */
    attributes: AttributePart[];
    /** Componentes de kit/combo: `CAF-001*1|PAO-001*2`. */
    kitItems: RefItem[];
    /** Insumos de ficha técnica: `FAR-01*0.5|OVO-01*3`. */
    recipeItems: RefItem[];
    /** Nomes dos grupos de complemento ligados ao produto: `Bordas|Molhos`. */
    complementGroups: string[];
    /** null = usar o padrão do tipo (variante filha 1, mestre/complemento 0, demais 1). */
    trackStock: boolean | null;
    /** null = manter o que está no banco (update) ou 0 (novo). */
    visivelCardapio: boolean | null;
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

// ─────────────────────── Novos campos (v2) ───────────────────────

/**
 * `tipo` → product_type. Vazio = 'fisico' (retrocompatível com a planilha v1,
 * onde todo produto era simples).
 */
export function parseTipo(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = norm(raw).toLowerCase();
  if (!s) return { ok: true, value: 'fisico' };
  if (!(PRODUCT_TYPES as readonly string[]).includes(s)) {
    return { ok: false, error: `tipo inválido: "${raw}" (use ${PRODUCT_TYPES.join(', ')})` };
  }
  return { ok: true, value: s };
}

/**
 * `atributos` → pares nome/valor. Duas formas, que se misturam no mesmo arquivo:
 *  - `Tamanho=M|Cor=Azul` (linha da variante filha: grava product_variant_values);
 *  - `Tamanho|Cor` (linha do variante mestre: só garante que o atributo existe).
 */
export function parseAttributes(raw: string): { ok: true; value: AttributePart[] } | { ok: false; error: string } {
  const s = norm(raw);
  if (!s) return { ok: true, value: [] };
  const parts = s.split('|').map((p) => p.trim()).filter((p) => p !== '');
  const out: AttributePart[] = [];
  const seenNames = new Set<string>();
  const seenPairs = new Set<string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      if (seenNames.has(part.toLowerCase())) return { ok: false, error: `atributo "${part}" repetido` };
      seenNames.add(part.toLowerCase());
      out.push({ name: part, value: null });
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) return { ok: false, error: `atributo sem nome: "${part}"` };
    if (!value) return { ok: false, error: `atributo "${name}" sem valor (use ${name}=Valor)` };
    // O mesmo atributo duas vezes quebraria o UNIQUE(product_id, attribute_id) de
    // product_variant_values no commit — pega aqui, antes de gravar.
    if (seenNames.has(name.toLowerCase())) return { ok: false, error: `atributo "${name}" repetido` };
    seenNames.add(name.toLowerCase());
    const key = `${name.toLowerCase()}=${value.toLowerCase()}`;
    if (seenPairs.has(key)) return { ok: false, error: `atributo "${name}=${value}" repetido` };
    seenPairs.add(key);
    out.push({ name, value });
  }
  return { ok: true, value: out };
}

/**
 * `componentes` / `ficha_tecnica` → lista de referências com quantidade.
 * Formato: `CAF-001*1|PAO-001*2`. Sem `*qtd` a quantidade vale 1.
 * Quantidade aceita vírgula ou ponto decimal (ficha técnica usa 0,5).
 */
export function parseRefList(raw: string, label: string): { ok: true; value: RefItem[] } | { ok: false; error: string } {
  const s = norm(raw);
  if (!s) return { ok: true, value: [] };
  const parts = s.split('|').map((p) => p.trim()).filter((p) => p !== '');
  const out: RefItem[] = [];
  for (const part of parts) {
    const star = part.indexOf('*');
    const ref = (star < 0 ? part : part.slice(0, star)).trim();
    if (!ref) return { ok: false, error: `${label}: referência vazia em "${part}"` };
    let qty = 1;
    if (star >= 0) {
      const parsed = parseMoneyToCents(part.slice(star + 1).trim());
      if (!parsed.ok) return { ok: false, error: `${label}: ${parsed.error}` };
      qty = parsed.cents / 100;
      if (qty <= 0) return { ok: false, error: `${label}: quantidade deve ser maior que zero em "${part}"` };
      if (qty > 99999) return { ok: false, error: `${label}: quantidade fora do limite em "${part}"` };
    }
    out.push({ ref, qty });
  }
  return { ok: true, value: out };
}

/** `grupos_complemento` → nomes de grupos (`Bordas|Molhos`). Tolerante a espaços. */
export function parseGroupList(raw: string): string[] {
  return norm(raw).split('|').map((g) => g.trim()).filter((g) => g !== '');
}

/** `controla_estoque` / `visivel_cardapio` → sim/nao (aceita s/n/1/0/true/false). */
export function parseBoolField(raw: string, label: string): { ok: true; value: boolean | null } | { ok: false; error: string } {
  const s = norm(raw).toLowerCase();
  if (!s) return { ok: true, value: null };
  if (['sim', 's', '1', 'true', 'verdadeiro'].includes(s)) return { ok: true, value: true };
  if (['nao', 'n', '0', 'false', 'falso'].includes(s)) return { ok: true, value: false };
  return { ok: false, error: `${label} inválido: "${raw}" (use sim/nao)` };
}

// ─────────────────────────── Validação ───────────────────────────

export interface ExistingProduct {
  id: number;
  uuid: string;
  sku: string | null;
  barcode: string | null;
  /** Nome do produto — último recurso na resolução de referências (ver cabeçalho). */
  name?: string | null;
  /** product_type do banco — usado para validar refs (pai, componentes, insumos). */
  productType: string | null;
}

export interface BuildPreviewInput {
  csv: string;
  existing: ExistingProduct[];
  existingCategories: { id: number; name: string }[];
  /** Injetado para reusar a validação de dígito verificador do app (shared/barcode). */
  validateBarcode: (code: string) => boolean;
  /** Capabilities comercial.variantes e comercial.complementos, lidas pelo chamador. */
  capabilities: { variantes: boolean; complementos: boolean };
}

const norm = (v: string | null | undefined): string => String(v ?? '').trim();
const normCat = (v: string): string => norm(v).toLowerCase();

/** Alvo de uma referência: outra linha do arquivo ou um produto já no catálogo. */
type RefTarget = { fileRow: number } | { bank: ExistingProduct };

type RefLookup =
  | { found: true; target: RefTarget }
  | { found: false; reason: 'ausente' }
  | { found: false; reason: 'ambiguo'; where: string; count: number };

/**
 * Mensagem de referência não resolvida. Diz o que preencher, não só o que faltou —
 * é a diferença entre a pessoa corrigir a planilha e desistir da importação.
 */
function refError(label: string, ref: string, r: Extract<RefLookup, { found: false }>): string {
  if (r.reason === 'ambiguo') {
    return `${label} "${ref}": ${r.count} produtos com esse nome no ${r.where} — preencha o SKU para dizer qual`;
  }
  return `${label} "${ref}" não encontrado — use o SKU, o uuid ou o nome exato de um produto deste arquivo ou do catálogo`;
}

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
  // Nome é multivalorado de propósito: dois produtos podem ter o mesmo nome, e a
  // resolução por nome só vale quando a lista tem exatamente um elemento.
  const byName = new Map<string, ExistingProduct[]>();
  for (const p of input.existing) {
    if (p.uuid) byUuid.set(norm(p.uuid).toLowerCase(), p);
    if (p.barcode) byBarcode.set(norm(p.barcode), p);
    if (p.sku) bySku.set(norm(p.sku).toLowerCase(), p);
    if (p.name) {
      const key = norm(p.name).toLowerCase();
      const list = byName.get(key);
      if (list) list.push(p); else byName.set(key, [p]);
    }
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

  // Passada A: parse de cada linha. Erros aqui são do próprio campo; os de relação
  // (referências cruzadas) ficam para a passada B.
  for (let r = 1; r < table.length; r++) {
    const raw = table[r];
    if (isBlankRow(raw)) continue; // pula, mas sem mexer no contador: `line` tem que bater com o Excel
    const line = r + 1; // 1 = cabeçalho; casa com o número de linha do Excel
    const errors: string[] = [];

    const name = cell(raw, 'nome');
    if (!name) errors.push('nome é obrigatório');

    const uuidCell = cell(raw, 'uuid') || null;
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

    // Campos fiscais: opcionais, mas se vierem preenchidos têm formato fixo — errar o NCM
    // só apareceria como rejeição da SEFAZ lá na frente, no meio de uma venda.
    const ncmRaw = cell(raw, 'ncm').replace(/\D/g, '');
    if (ncmRaw && ncmRaw.length !== 8) errors.push(`NCM deve ter 8 dígitos: "${cell(raw, 'ncm')}"`);
    const cestRaw = cell(raw, 'cest').replace(/\D/g, '');
    if (cestRaw && cestRaw.length !== 7) errors.push(`CEST deve ter 7 dígitos: "${cell(raw, 'cest')}"`);
    const origemRaw = cell(raw, 'origem').trim();
    let origem: number | null = null;
    if (origemRaw) {
      const n = Number(origemRaw);
      if (!Number.isInteger(n) || n < 0 || n > 8) errors.push(`origem deve ser um número de 0 a 8: "${origemRaw}"`);
      else origem = n;
    }

    // ── v2: tipo e relações ──
    const tipo = parseTipo(cell(raw, 'tipo'));
    if (!tipo.ok) errors.push(tipo.error);
    const productType = tipo.ok ? tipo.value : 'fisico';
    const atributos = parseAttributes(cell(raw, 'atributos'));
    if (!atributos.ok) errors.push(atributos.error);
    const componentes = parseRefList(cell(raw, 'componentes'), 'componentes');
    if (!componentes.ok) errors.push(componentes.error);
    const ficha = parseRefList(cell(raw, 'ficha_tecnica'), 'ficha técnica');
    if (!ficha.ok) errors.push(ficha.error);
    const trackStock = parseBoolField(cell(raw, 'controla_estoque'), 'controla_estoque');
    if (!trackStock.ok) errors.push(trackStock.error);
    const visivel = parseBoolField(cell(raw, 'visivel_cardapio'), 'visivel_cardapio');
    if (!visivel.ok) errors.push(visivel.error);

    if (productType === 'variante' && !input.capabilities.variantes) {
      errors.push('recursos de variantes desligados (commercial.variantes) — ligue em Configurações › Recursos');
    }
    if ((productType === 'complemento' || parseGroupList(cell(raw, 'grupos_complemento')).length > 0) && !input.capabilities.complementos) {
      errors.push('recursos de complementos desligados (commercial.complementos) — ligue em Configurações › Recursos');
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
      status: 'novo', // consolidado na passada B (as referências podem acrescentar erro)
      errors,
      matchedId,
      matchedBy,
      data: {
        uuid: uuidCell,
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
        ncm: ncmRaw || null,
        cest: cestRaw || null,
        csosn: cell(raw, 'csosn').trim() || null,
        cst: cell(raw, 'cst').trim() || null,
        origem,
        productType,
        parentRef: cell(raw, 'produto_pai') || null,
        attributes: atributos.ok ? atributos.value : [],
        kitItems: componentes.ok ? componentes.value : [],
        recipeItems: ficha.ok ? ficha.value : [],
        complementGroups: parseGroupList(cell(raw, 'grupos_complemento')),
        trackStock: trackStock.ok ? trackStock.value : null,
        visivelCardapio: visivel.ok ? visivel.value : null,
      },
    });
  }

  if (!rows.length) return { ok: false, error: 'O arquivo só tem cabeçalho — nenhuma linha de produto.' };

  // Índice de referências do PRÓPRIO arquivo: uma linha pode referenciar outra em
  // qualquer posição (pai, componente, insumo) — a ordem das linhas não importa.
  const fileBySku = new Map<string, number>();
  const fileByUuid = new Map<string, number>();
  const fileByName = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (row.data.sku) fileBySku.set(norm(row.data.sku).toLowerCase(), i);
    if (row.data.uuid) fileByUuid.set(norm(row.data.uuid).toLowerCase(), i);
    if (row.data.name) {
      const key = norm(row.data.name).toLowerCase();
      const list = fileByName.get(key);
      if (list) list.push(i); else fileByName.set(key, [i]);
    }
  });

  // Resolução: arquivo primeiro (o que o arquivo diz vale para esta importação —
  // inclusive produto que já existe no banco), banco em seguida. Dentro de cada um,
  // SKU → uuid → nome. O nome é o último recurso justamente porque é o único que
  // pode ser ambíguo: quando é, a linha vira erro em vez de escolher um dos dois.
  const resolveRef = (ref: string): RefLookup => {
    const key = norm(ref).toLowerCase();
    const fi = fileBySku.get(key) ?? fileByUuid.get(key);
    if (fi != null) return { found: true, target: { fileRow: fi } };
    const hit = bySku.get(key) ?? byUuid.get(key);
    if (hit) return { found: true, target: { bank: hit } };
    const fn = fileByName.get(key);
    if (fn) {
      if (fn.length === 1) return { found: true, target: { fileRow: fn[0] } };
      return { found: false, reason: 'ambiguo', where: 'arquivo', count: fn.length };
    }
    const bn = byName.get(key);
    if (bn) {
      if (bn.length === 1) return { found: true, target: { bank: bn[0] } };
      return { found: false, reason: 'ambiguo', where: 'catálogo', count: bn.length };
    }
    return { found: false, reason: 'ausente' };
  };
  const typeOf = (t: RefTarget): string =>
    'fileRow' in t ? rows[t.fileRow].data.productType : (t.bank.productType ?? '');

  // Passada B: referências cruzadas.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const d = row.data;

    if (d.productType === 'variante') {
      if (d.parentRef) {
        const t = resolveRef(d.parentRef);
        if (!t.found) row.errors.push(refError('produto_pai', d.parentRef, t));
        else if ('fileRow' in t.target && t.target.fileRow === i) row.errors.push('produto não pode ser pai dele mesmo');
        else if (typeOf(t.target) !== 'variante') row.errors.push(`produto_pai "${d.parentRef}" não é um produto variante — a linha dele precisa ter tipo "variante"`);
      }
      // Sem produto_pai é o variante MESTRE (linha de estrutura, com atributos só
      // por nome) — legítimo e exportado como tal.
    } else if (d.parentRef) {
      row.errors.push('produto_pai só vale para linhas do tipo "variante"');
    }

    if (d.productType === 'kit' || d.productType === 'combo') {
      if (!d.kitItems.length) row.errors.push('produto kit/combo precisa de ao menos um componente (coluna componentes)');
    }
    for (const item of d.kitItems) {
      const t = resolveRef(item.ref);
      if (!t.found) row.errors.push(refError('componente', item.ref, t));
      else if ('fileRow' in t.target && t.target.fileRow === i) row.errors.push('produto não pode ser componente dele mesmo');
      else if (typeOf(t.target) === 'kit' || typeOf(t.target) === 'combo') {
        row.errors.push(`componente "${item.ref}" é kit/combo — kit dentro de kit não é suportado`);
      }
    }

    if (d.productType === 'produzido') {
      if (!d.recipeItems.length) row.errors.push('produto produzido precisa de ao menos um insumo (coluna ficha_tecnica)');
    }
    for (const item of d.recipeItems) {
      const t = resolveRef(item.ref);
      if (!t.found) row.errors.push(refError('insumo', item.ref, t));
      else if ('fileRow' in t.target && t.target.fileRow === i) row.errors.push('produto não pode ser insumo dele mesmo');
      else if (['kit', 'combo', 'produzido'].includes(typeOf(t.target))) {
        row.errors.push(`insumo "${item.ref}" não pode ser kit, combo ou produzido (use produtos simples)`);
      }
    }
  }

  // Ciclo em ficha técnica: um produzido que (transitivamente) se consome.
  // Só os produzidos do arquivo entram no grafo; insumo que vem do banco já foi
  // validado quando foi gravado lá.
  const state = new Array<number>(rows.length).fill(0); // 0=novo, 1=em visita, 2=fechado
  const recipeFileInputs = (i: number): number[] => {
    const out: number[] = [];
    for (const item of rows[i].data.recipeItems) {
      const t = resolveRef(item.ref);
      if (t.found && 'fileRow' in t.target) out.push(t.target.fileRow);
    }
    return out;
  };
  const visit = (i: number): void => {
    state[i] = 1;
    for (const j of recipeFileInputs(i)) {
      if (state[j] === 1 && rows[j].data.productType === 'produzido') {
        const label = rows[j].data.name || rows[j].data.sku || `linha ${rows[j].line}`;
        if (!rows[i].errors.some((e) => e.startsWith('ficha técnica cria um ciclo'))) {
          rows[i].errors.push(`ficha técnica cria um ciclo com ${label} (linha ${rows[j].line})`);
        }
      } else if (state[j] === 0 && rows[j].data.productType === 'produzido') {
        visit(j);
      }
    }
    state[i] = 2;
  };
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].data.productType === 'produzido' && state[i] === 0) visit(i);
  }

  for (const row of rows) {
    row.status = row.errors.length ? 'erro' : row.matchedId ? 'atualizar' : 'novo';
  }

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
 * Cabeçalho + exemplos por tipo, para o cliente ver o formato esperado.
 * A coluna uuid fica vazia: produto novo não tem identidade ainda.
 * As linhas de exemplo formam um catálogo coerente (o kit referencia os produtos
 * simples; a variante referencia o mestre), então o modelo importa sem erros.
 */
export function templateCsv(): string {
  return toCsv([
    [...IMPORT_COLUMNS],
    //                                uuid  sku      codigo_barras  nome               descricao             categoria    unid preco_venda preco_custo est_min est_inic ncm cest csosn cst origem tipo  prod_pai atributos  componentes  ficha_tecnica  grupos_complemento  controla_est v_cardapio
    //                                (24 colunas: 16 antigas + 8 novas)
    ['', 'CAF-001', '7891000315507', 'Café Torrado 500g', 'Torra média, moído', 'Mercearia', 'un', '18,90', '12,50', '5', '30', '', '', '', '', '', 'fisico', '', '', '', '', '', 'sim', 'sim'],
    ['', 'PAO-001', '', 'Pão Francês', 'Vendido por quilo', 'Padaria', 'kg', '14,90', '9,00', '0', '', '', '', '', '', '', 'fisico', '', '', '', '', '', 'sim', 'sim'],
    ['', 'KIT-001', '', 'Café da Manhã', 'Café + 2 pães', 'Mercearia', 'un', '25,00', '0', '0', '', '', '', '', '', '', 'kit', '', '', 'CAF-001*1|PAO-001*2', '', '', 'sim', 'sim'],
    ['', 'CAM-001', '', 'Camisa', 'Variante mestre (não se vende)', 'Vestuário', 'un', '0', '0', '0', '', '', '', '', '', '', 'variante', '', 'Tamanho|Cor', '', '', '', 'nao', 'sim'],
    ['', 'CAM-001-P', '', 'Camisa P', 'Filha do mestre CAM-001', 'Vestuário', 'un', '29,90', '10,00', '0', '', '', '', '', '', '', 'variante', 'CAM-001', 'Tamanho=P', '', '', '', 'sim', 'sim'],
  ]);
}
