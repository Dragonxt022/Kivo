/**
 * Unidades de medida do catálogo (Kivo).
 *
 * O formulário de produto usa um conjunto fixo de unidades (ver o `<select>` em
 * commercial-products.ejs). Importadores (CSV e NF-e) recebem a unidade do fornecedor
 * como texto livre — "UN", "PC", "CX", "KG" — e precisam normalizar para esse conjunto,
 * senão o catálogo acumula "UN" e "un" como se fossem unidades diferentes.
 *
 * Função pura: zero dependência de Core ou Apps (mesmo padrão de shared/money e
 * shared/barcode).
 */

export const PRODUCT_UNITS = [
  'un', 'kg', 'g', 'L', 'ml', 'cx', 'pct', 'porcao', 'dz', 'par', 'm',
] as const;

export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/** Apelidos aceitos nos arquivos/notas. A chave já vem sem acento e maiúscula. */
const UNIT_ALIASES: Record<string, ProductUnit> = {
  UN: 'un', UND: 'un', UNID: 'un', UNIDADE: 'un', U: 'un', PC: 'un', PECA: 'un', UNI: 'un',
  KG: 'kg', QUILO: 'kg', QUILOGRAMA: 'kg',
  G: 'g', GR: 'g', GRAMA: 'g',
  L: 'L', LT: 'L', LITRO: 'L',
  ML: 'ml', MLT: 'ml', MILILITRO: 'ml',
  CX: 'cx', CAIXA: 'cx',
  PCT: 'pct', PCOTE: 'pct', PACK: 'pct', PACOTE: 'pct',
  PORCAO: 'porcao', PORC: 'porcao',
  DZ: 'dz', DUZIA: 'dz',
  PAR: 'par', PARES: 'par',
  M: 'm', MT: 'm', METRO: 'm',
};

/**
 * Normaliza a unidade para o conjunto canônico. Unidade desconhecida é mantida como veio
 * (apenas `trim`) — melhor preservar um "FD" (fardo) do fornecedor do que forçá-lo a "un"
 * e perder a informação. Vazio vira "un".
 */
export function normalizeProductUnit(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return 'un';
  const key = trimmed
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return UNIT_ALIASES[key] ?? trimmed;
}
