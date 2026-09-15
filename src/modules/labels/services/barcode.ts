import bwipjs from 'bwip-js';
import { validateEAN13, validateEAN8, validateUPCA } from '../../../shared/barcode';

/**
 * Geração de código de barras/QR como SVG inline, via bwip-js (BWIPP). Renderizar no
 * servidor (e não no navegador) mantém a folha de impressão como HTML puro: sem canvas,
 * sem espera de JS e sem depender da CSP da tela.
 *
 * `ean13` é tolerante de propósito: só usa EAN-13/EAN-8/UPC quando o código é um
 * EAN/UPC válido (dígito verificador confere); qualquer outra coisa cai para Code128,
 * que aceita texto livre — é o que permite imprimir produto com SKU ou código interno.
 */

export type Symbology = 'ean13' | 'code128' | 'qrcode' | 'none';

export const SYMBOLOGIES: Symbology[] = ['ean13', 'code128', 'qrcode', 'none'];

export function isSymbology(v: unknown): v is Symbology {
  return typeof v === 'string' && (SYMBOLOGIES as string[]).includes(v);
}

export interface BarcodeSvg {
  /** SVG completo (com viewBox) ou string vazia quando não há código a imprimir. */
  svg: string;
  /** Simbologia realmente usada — pode diferir do pedido quando o código não coube. */
  used: Symbology;
  /** Código efetivamente codificado. */
  text: string;
  /** Motivo do fallback, quando houve. */
  note?: string;
}

const onlyDigits = (s: string): string => s.replace(/\D/g, '');

/** Decide a simbologia concreta do bwip-js a partir do código do produto. */
function resolveEan(text: string): { bcid: string; payload: string; note?: string } | null {
  const d = onlyDigits(text);
  if (d.length === 13 && validateEAN13(d)) return { bcid: 'ean13', payload: d.slice(0, 12) };
  if (d.length === 12 && validateUPCA(d)) return { bcid: 'upca', payload: d };
  if (d.length === 8 && validateEAN8(d)) return { bcid: 'ean8', payload: d };
  return null;
}

/**
 * Gera o SVG. Nunca lança: erro de codificação (texto fora do padrão, código vazio)
 * devolve `svg` vazio com a explicação em `note`, para a folha sair com o resto intacto.
 */
export function barcodeSvg(symbology: Symbology, rawText: string): BarcodeSvg {
  const text = (rawText ?? '').trim();
  if (symbology === 'none' || !text) return { svg: '', used: 'none', text };

  let bcid = symbology as string;
  let payload = text;
  let note: string | undefined;

  if (symbology === 'ean13') {
    const ean = resolveEan(text);
    if (ean) {
      bcid = ean.bcid;
      payload = ean.payload;
    } else {
      bcid = 'code128';
      note = 'Código não é um EAN/UPC válido — impresso como Code128.';
    }
  }

  try {
    const svg = bwipjs.toSVG({
      bcid,
      text: payload,
      scale: 3,
      height: symbology === 'qrcode' ? undefined : 12,
      includetext: symbology !== 'qrcode',
      textxalign: 'center',
    });
    return { svg, used: bcid === 'code128' ? 'code128' : (symbology === 'qrcode' ? 'qrcode' : 'ean13'), text, note };
  } catch (e) {
    return {
      svg: '',
      used: 'none',
      text,
      note: `Não foi possível gerar o código: ${String(e).replace(/^Error:\s*/, '').slice(0, 120)}`,
    };
  }
}
