/**
 * Importação/exportação de grupos de complemento (opcionais) — arquivo
 * `complementos.csv`, a etapa 2 da importação de catálogo.
 *
 * Assim como productsImport.ts, isto é lógica pura: parse, coerção e validação,
 * sem banco nem Express. Quem grava é productsImportRoutes.ts.
 *
 * Formato (uma linha por opção; o grupo se repete nas linhas dele):
 *   grupo;min_selecao;max_selecao;opcao_sku;preco_opcao;ordem
 *
 * Decisões:
 *  - `min_selecao`/`max_selecao` valem por grupo e são lidos da 1ª linha do grupo
 *    no arquivo; se uma linha seguinte divergir, é erro (dado confuso).
 *  - `opcao_sku` referencia um produto existente (SKU ou uuid) — ou um SKU que o
 *    arquivo de produtos (etapa 1) está criando agora.
 *  - `preco_opcao` vazio = sem preço próprio (usa o preço do produto).
 *  - O arquivo é a fonte da verdade para os grupos presentes nele: no commit as
 *    opções dos grupos do arquivo são substituídas pelo conteúdo do arquivo.
 */

import { parseCsv, isBlankRow, normalizeHeader, parseIntField, parseMoneyToCents, toCsv } from './productsImport';

export const COMPLEMENT_COLUMNS = [
  'grupo',
  'min_selecao',
  'max_selecao',
  'opcao_sku',
  'preco_opcao',
  'ordem',
] as const;

export type ComplementRowStatus = 'novo' | 'atualizar' | 'erro';

export interface ParsedComplementRow {
  /** Linha no arquivo como o usuário vê no Excel (1 = cabeçalho). */
  line: number;
  status: ComplementRowStatus;
  errors: string[];
  /** Grupo do banco que esta linha atualiza; null = o arquivo cria um grupo novo. */
  groupId: number | null;
  /** Opção do banco que esta linha atualiza; null = opção nova no grupo. */
  itemId: number | null;
  data: {
    groupName: string;
    minSelect: number;
    maxSelect: number | null;
    optionSku: string;
    /** Produto da opção, resolvido no banco; null quando só existe como pendente (produtos.csv). */
    optionProductId: number | null;
    priceOverrideCents: number | null;
    sortOrder: number;
  };
}

export interface ExistingComplementItem {
  id: number;
  productId: number;
  productSku: string | null;
  priceOverrideCents: number | null;
  sortOrder: number;
}

export interface ExistingComplementGroup {
  id: number;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  items: ExistingComplementItem[];
}

export interface BuildComplementsPreviewInput {
  csv: string;
  existingGroups: ExistingComplementGroup[];
  /** Resolve o SKU/uuid de uma opção contra o banco. undefined = não existe. */
  resolveProduct: (sku: string) => { productId: number } | undefined;
  /** SKUs que o arquivo de produtos (etapa 1) vai criar — contam como existentes. */
  pendingSkus: string[];
}

export interface ComplementsPreviewReport {
  rows: ParsedComplementRow[];
  groups: {
    name: string;
    minSelect: number;
    maxSelect: number | null;
    /** true = grupo novo que o commit vai criar. */
    novo: boolean;
    /** Quantas opções o arquivo lista para o grupo. */
    totalOptions: number;
  }[];
  totals: { total: number; novos: number; atualizar: number; erros: number };
}

const norm = (v: string | null | undefined): string => String(v ?? '').trim();
const normGroup = (v: string): string => norm(v).toLowerCase();

export function buildComplementsPreview(input: BuildComplementsPreviewInput):
  | { ok: true; report: ComplementsPreviewReport }
  | { ok: false; error: string } {
  const table = parseCsv(input.csv);
  if (!table.length) return { ok: false, error: 'Arquivo vazio.' };

  const headers = table[0].map(normalizeHeader);
  const missing = (['grupo', 'opcao_sku'] as const).filter((c) => !headers.includes(c));
  if (missing.length) {
    return { ok: false, error: `Faltando a coluna obrigatória: ${missing.join(', ')}. Baixe o modelo e use o mesmo cabeçalho.` };
  }
  const idx = (col: string): number => headers.indexOf(col);
  const cell = (r: string[], col: string): string => {
    const i = idx(col);
    return i < 0 ? '' : norm(r[i]);
  };

  const groupByName = new Map<string, ExistingComplementGroup>();
  for (const g of input.existingGroups) groupByName.set(normGroup(g.name), g);
  const pending = new Set(input.pendingSkus.map((s) => norm(s).toLowerCase()));

  // min/max definidos pela 1ª linha de cada grupo do arquivo; divergência = erro.
  const groupMeta = new Map<string, { line: number; min: number; max: number | null }>();
  const rows: ParsedComplementRow[] = [];

  for (let r = 1; r < table.length; r++) {
    const raw = table[r];
    if (isBlankRow(raw)) continue;
    const line = r + 1;
    const errors: string[] = [];

    const groupName = cell(raw, 'grupo');
    if (!groupName) errors.push('grupo é obrigatório');

    const min = parseIntField(cell(raw, 'min_selecao'), 'min_selecao');
    if (!min.ok) errors.push(min.error);
    const max = parseIntField(cell(raw, 'max_selecao'), 'max_selecao');
    if (!max.ok) errors.push(max.error);
    const minVal = min.ok ? (min.value ?? 0) : 0;
    const maxVal = max.ok ? max.value : null;
    if (minVal > 0 && maxVal != null && minVal > maxVal) {
      errors.push(`min_selecao (${minVal}) maior que max_selecao (${maxVal})`);
    }

    const key = normGroup(groupName);
    const first = groupMeta.get(key);
    if (groupName && !first) {
      groupMeta.set(key, { line, min: minVal, max: maxVal });
    } else if (first && (first.min !== minVal || first.max !== maxVal)) {
      errors.push(`min_selecao/max_selecao divergem da linha ${first.line} do mesmo grupo`);
    }

    const optionSku = cell(raw, 'opcao_sku');
    if (!optionSku) errors.push('opcao_sku é obrigatório');
    const optionResolved = optionSku ? input.resolveProduct(optionSku) : undefined;
    if (optionSku && !optionResolved && !pending.has(optionSku.toLowerCase())) {
      errors.push(`opção "${optionSku}" não encontrada (nem no catálogo nem no arquivo de produtos)`);
    }

    const price = parseMoneyToCents(cell(raw, 'preco_opcao'));
    if (!price.ok) errors.push(`preço da opção — ${price.error}`);
    const priceCents = price.ok && price.cents > 0 ? price.cents : null;

    const ordem = parseIntField(cell(raw, 'ordem'), 'ordem');
    if (!ordem.ok) errors.push(ordem.error);
    const sortOrder = ordem.ok ? (ordem.value ?? 1) : 1;

    const g = groupName ? groupByName.get(key) : undefined;
    let itemId: number | null = null;
    if (g && optionSku) {
      const hit = g.items.find(
        (it) => it.productSku != null && norm(it.productSku).toLowerCase() === optionSku.toLowerCase(),
      );
      itemId = hit?.id ?? null;
    }

    rows.push({
      line,
      status: errors.length ? 'erro' : itemId != null ? 'atualizar' : 'novo',
      errors,
      groupId: g?.id ?? null,
      itemId,
      data: {
        groupName,
        minSelect: minVal,
        maxSelect: maxVal,
        optionSku,
        optionProductId: optionResolved?.productId ?? null,
        priceOverrideCents: priceCents,
        sortOrder,
      },
    });
  }

  if (!rows.length) return { ok: false, error: 'O arquivo só tem cabeçalho — nenhuma linha de opção.' };

  const groups = [...groupMeta.entries()].map(([key, meta]) => ({
    name: rows.find((x) => normGroup(x.data.groupName) === key)?.data.groupName ?? key,
    minSelect: meta.min,
    maxSelect: meta.max,
    novo: !groupByName.has(key),
    totalOptions: rows.filter((x) => normGroup(x.data.groupName) === key).length,
  }));

  return {
    ok: true,
    report: {
      rows,
      groups,
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
 * Cabeçalho + exemplos. As opções referenciam SKUs do modelo de produtos
 * (CAF-001/PAO-001), então os dois modelos importam juntos sem erro.
 */
export function complementsTemplateCsv(): string {
  return toCsv([
    [...COMPLEMENT_COLUMNS],
    ['Bordas', '0', '2', 'CAF-001', '', '1'],
    ['Bordas', '0', '2', 'PAO-001', '5,00', '2'],
    ['Molhos', '0', '1', 'CAF-001', '', '1'],
  ]);
}
