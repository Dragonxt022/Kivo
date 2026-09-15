/**
 * Presets de folha de etiqueta de fábrica.
 *
 * Medidas em MILÍMETROS, no padrão "altura × largura" do catálogo Pimaco. As dimensões
 * da etiqueta e a quantidade por folha vêm das fichas oficiais dos produtos Pimaco
 * (linha Inkjet/Laser, vendida como A4/Carta); as margens são calculadas para centralizar
 * a grade na página A4 (210 × 297 mm), já que a Pimaco não publica a quebra exata de
 * margem/espaçamento. Quem tiver uma folha fora do padrão cria um modelo custom e ajusta
 * as margens na tela.
 *
 * `seedLabelPresets` grava tudo com uuid ESTÁVEL (derivado do código), então o mesmo
 * preset tem a mesma identidade em toda instalação e nunca duplica.
 */

export interface LabelSheetPreset {
  name: string;
  brand: string;
  code: string;
  page_w_mm: number;
  page_h_mm: number;
  label_w_mm: number;
  label_h_mm: number;
  cols: number;
  rows: number;
  margin_top_mm: number;
  margin_left_mm: number;
  gutter_x_mm: number;
  gutter_y_mm: number;
}

interface Grid {
  code: string;
  /** Altura da etiqueta em mm. */
  h: number;
  /** Largura da etiqueta em mm. */
  w: number;
  cols: number;
  rows: number;
}

const A4_W = 210;
const A4_H = 297;

/** Centraliza a grade na página; sem gutter informado, as etiquetas ficam encostadas. */
function preset(code: string, g: Grid, gutter = 0): LabelSheetPreset {
  const gridW = g.cols * g.w + (g.cols - 1) * gutter;
  const gridH = g.rows * g.h + (g.rows - 1) * gutter;
  return {
    name: `Pimaco ${code} (${g.cols}×${g.rows} = ${g.cols * g.rows} etiquetas)`,
    brand: 'Pimaco',
    code,
    page_w_mm: A4_W,
    page_h_mm: A4_H,
    label_w_mm: g.w,
    label_h_mm: g.h,
    cols: g.cols,
    rows: g.rows,
    margin_left_mm: Math.max(0, (A4_W - gridW) / 2),
    margin_top_mm: Math.max(0, (A4_H - gridH) / 2),
    gutter_x_mm: gutter,
    gutter_y_mm: gutter,
  };
}

export const LABEL_PRESETS: LabelSheetPreset[] = [
  preset('6180', { code: '6180', w: 66.7, h: 25.4, cols: 3, rows: 10 }),
  preset('6181', { code: '6181', w: 101.6, h: 25.4, cols: 2, rows: 10 }),
  preset('6182', { code: '6182', w: 101.6, h: 33.9, cols: 2, rows: 7 }),
  preset('6183', { code: '6183', w: 101.6, h: 50.8, cols: 2, rows: 5 }),
  preset('6184', { code: '6184', w: 101.6, h: 84.67, cols: 2, rows: 3 }),
  preset('6187', { code: '6187', w: 44.45, h: 12.7, cols: 4, rows: 20 }),
  {
    // Folha genérica A4 de 24 etiquetas (equivalente métrico da Avery L7159), para quem
    // usa etiqueta branca sem marca/modelo específico.
    name: 'A4 genérica (3×8 = 24 etiquetas)',
    brand: 'Genérica',
    code: 'A4-24',
    page_w_mm: A4_W,
    page_h_mm: A4_H,
    label_w_mm: 63.5,
    label_h_mm: 33.9,
    cols: 3,
    rows: 8,
    margin_left_mm: (A4_W - 3 * 63.5) / 2,
    margin_top_mm: (A4_H - 8 * 33.9) / 2,
    gutter_x_mm: 0,
    gutter_y_mm: 0,
  },
];
