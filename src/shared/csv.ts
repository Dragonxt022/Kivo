/**
 * CSV para planilha: separador `;` e BOM UTF-8 — o formato que o Excel brasileiro
 * abre e salva por padrão. Campos com `;`, aspas ou quebra de linha são citados.
 */

export const CSV_BOM = '\uFEFF';

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return CSV_BOM + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}
