import { z } from 'zod';

/** Medidas em milímetros. Limites generosos, só para barrar valor absurdo/negativo. */
const mm = (max: number) => z.number().min(0).max(max);

export const labelSheetSchema = z.object({
  name: z.string().trim().min(1, 'Informe um nome para o modelo.').max(80, 'Nome muito longo.'),
  brand: z.string().trim().max(40).nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  page_w_mm: z.number().positive().max(1000),
  page_h_mm: z.number().positive().max(1000),
  label_w_mm: z.number().positive().max(1000),
  label_h_mm: z.number().positive().max(1000),
  cols: z.number().int().min(1).max(50),
  rows: z.number().int().min(1).max(50),
  margin_top_mm: mm(200),
  margin_left_mm: mm(200),
  gutter_x_mm: mm(100),
  gutter_y_mm: mm(100),
});

export const updateLabelSheetSchema = labelSheetSchema.partial();
