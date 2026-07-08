/**
 * shared/barcode — validação de dígito verificador (EAN-13/EAN-8/UPC-A) e geração
 * de código interno para produtos sem código de fábrica.
 * Funções puras: zero dependência de Core ou Apps (mesmo padrão de shared/money, shared/documents).
 */

const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Dígito verificador padrão EAN (peso 3/1 alternado a partir da direita). */
export function eanCheckDigit(payload: string): string {
  const d = onlyDigits(payload);
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    const weight = (d.length - i) % 2 === 0 ? 1 : 3;
    sum += Number(d[i]) * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

export function validateEAN13(code: string): boolean {
  const d = onlyDigits(code);
  if (d.length !== 13) return false;
  return eanCheckDigit(d.slice(0, 12)) === d[12];
}

export function validateUPCA(code: string): boolean {
  const d = onlyDigits(code);
  if (d.length !== 12) return false;
  return validateEAN13('0' + d);
}

export function validateEAN8(code: string): boolean {
  const d = onlyDigits(code);
  if (d.length !== 8) return false;
  return eanCheckDigit(d.slice(0, 7)) === d[7];
}

/** Só "parece" EAN/UPC quando é só dígitos e tem 8, 12 ou 13 caracteres. */
export function looksLikeEanUpc(code: string): boolean {
  return /^\d{8}$|^\d{12}$|^\d{13}$/.test(code.trim());
}

/**
 * Valida o dígito verificador só quando o código parece EAN/UPC (8/12/13 dígitos).
 * Códigos que não seguem esse formato (Code128 de fornecedor, texto livre) são
 * aceitos sem checagem — nem todo código de barras do mundo real é EAN/UPC.
 */
export function validateBarcode(code: string): boolean {
  const d = code.trim();
  if (!looksLikeEanUpc(d)) return true;
  if (d.length === 13) return validateEAN13(d);
  if (d.length === 12) return validateUPCA(d);
  return validateEAN8(d);
}

/** Prefixo reservado GS1 de "circulação restrita/uso interno" (faixa 20-29). */
export const INTERNAL_BARCODE_PREFIX = '2';

/** Gera um EAN-13 interno a partir do id do produto: prefixo 2 + id com zero-padding + dígito verificador. */
export function generateInternalBarcode(productId: number): string {
  const body = INTERNAL_BARCODE_PREFIX + String(productId).padStart(11, '0');
  return body + eanCheckDigit(body);
}
