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
  UNDS: 'un', UNIDS: 'un',
  KG: 'kg', KGS: 'kg', QUILO: 'kg', QUILOGRAMA: 'kg',
  G: 'g', GR: 'g', GRS: 'g', GRAMA: 'g',
  L: 'L', LT: 'L', LTS: 'L', LITRO: 'L',
  ML: 'ml', MLS: 'ml', MLT: 'ml', MILILITRO: 'ml',
  CX: 'cx', CXA: 'cx', CAIXA: 'cx',
  PCT: 'pct', PCTE: 'pct', PCOTE: 'pct', PACK: 'pct', PACOTE: 'pct',
  PORCAO: 'porcao', PORC: 'porcao',
  DZ: 'dz', DZIA: 'dz', DUZIA: 'dz',
  PAR: 'par', PARES: 'par',
  M: 'm', MT: 'm', MTS: 'm', METRO: 'm',
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

/**
 * Chave de comparação de unidade: sem acento, maiúscula, só alfanuméricos. Serve para
 * dizer se "UN", "un" e "Unidade" são a mesma coisa sem depender do conjunto canônico
 * (importador precisa comparar a unidade CRUA do fornecedor com a do produto).
 */
export function unitKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * A unidade é conhecida (canônica do catálogo ou um apelido mapeado)? Serve SÓ para
 * diagnóstico/log — uma unidade desconhecida NÃO é rejeitada em lugar nenhum: é
 * preservada como veio (o leiaute da NF-e aceita siglas livres, e forçar "un" perderia
 * a informação). O importador registra no log as siglas não mapeadas para análise.
 */
export function isKnownProductUnit(raw: string | null | undefined): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return true; // vazio normaliza para 'un'
  const key = unitKey(trimmed);
  if (key in UNIT_ALIASES) return true;
  return (PRODUCT_UNITS as readonly string[]).some((u) => unitKey(u) === key);
}

/**
 * A unidade parece uma EMBALAGEM (caixa, pacote, fardo, rolo, engradado...)? Usado para
 * decidir se o EAN da nota é código da caixa e se é preciso converter quantidade/custo
 * para a unidade de venda do produto. É uma lista de HEURÍSTICA, não de validação: uma
 * sigla fora dela continua sendo aceita normalmente.
 */
const PACKAGING_UNIT_KEYS = new Set([
  'CX', 'CXA', 'CAIXA', 'CXF', 'CXM', 'PCT', 'PACOTE', 'PCOTE', 'PACK', 'FD', 'FR', 'FARDO',
  'DISPLAY', 'ENGRADADO', 'PALETE', 'PALLET', 'FEIXE', 'LASTRO', 'SACO', 'SC', 'SCA',
  'BD', 'BDJ', 'BANDEJA', 'BALDE', 'BOMBONA', 'GARRAFA', 'LATA', 'TONEL', 'RL', 'ROLO',
]);

export function isPackagingUnit(raw: string | null | undefined): boolean {
  return PACKAGING_UNIT_KEYS.has(unitKey(raw));
}
