/**
 * Interpretação do peso que chega da balança serial.
 *
 * Fica em `shared` (e não dentro de `electron/hardware.ts`) por dois motivos:
 * 1. é lógica pura, sem Electron nem porta serial — dá para testar no Node;
 * 2. o protocolo é a parte que mais varia entre fabricantes, então merece um lugar
 *    óbvio para quem for adicionar suporte a um modelo novo.
 */

export type ScaleProtocol = 'toledo' | 'generic';

/**
 * Extrai o peso em **kg** do buffer recebido.
 *
 * - `generic`: visores que mandam uma linha de texto ("  1,235 kg\r\n"). Se vier sem
 *   separador decimal, assume gramas ("001235" → 1,235 kg).
 * - `toledo`: frame com 6 dígitos contínuos em gramas (Toledo/Filizola), com ou sem STX.
 *
 * Devolve `null` enquanto não houver leitura plausível — quem chama continua lendo.
 */
export function parseScaleWeight(raw: string, protocol: ScaleProtocol): number | null {
  if (!raw) return null;

  if (protocol === 'toledo') {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 6) return null;
    const grams = Number(digits.slice(-6));
    return Number.isFinite(grams) ? Math.round(grams) / 1000 : null;
  }

  const text = raw.replace(/[^\d,.-]/g, ' ').trim();
  if (!text) return null;

  // Com separador decimal, o valor já está em kg.
  const decimal = /(-?\d+)[.,](\d{1,3})/.exec(text);
  if (decimal) {
    const kg = Number(decimal[1] + '.' + decimal[2]);
    return Number.isFinite(kg) && Math.abs(kg) < 1000 ? kg : null;
  }

  // Sem separador: assume gramas (padrão dos visores com 5–6 dígitos).
  const inteiro = /(-?\d{3,6})/.exec(text);
  if (!inteiro) return null;
  const grams = Number(inteiro[1]);
  return Number.isFinite(grams) ? Math.round(grams) / 1000 : null;
}
