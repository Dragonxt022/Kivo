import { BaseRepository, type Row } from '../../../core/database/repository';
import { stableUuid } from '../../../shared/uuid';
import { LABEL_PRESETS, type LabelSheetPreset } from '../presets';

export interface LabelSheetRow extends Row {
  id: number;
  name: string;
  brand: string | null;
  code: string | null;
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
  is_preset: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

class LabelSheetRepository extends BaseRepository<LabelSheetRow> {
  constructor() {
    super('label_sheets');
  }

  /** Presets primeiro (na ordem de cadastro), depois os modelos do lojista por nome. */
  listAll(): LabelSheetRow[] {
    return this.raw(
      `SELECT * FROM label_sheets WHERE deleted_at IS NULL
       ORDER BY is_preset DESC, brand, code, name`,
    );
  }

  /**
   * Recria/atualiza os presets de fábrica. O uuid é estável (deriva do código), então a
   * mesma folha tem a mesma identidade em toda instalação. Dimensões são reescritas a cada
   * boot para que uma correção de medida chegue às instalações já existentes; um preset
   * "excluído" (soft delete) continua oculto — o lojista o removeu de propósito.
   */
  seedPresets(presets: LabelSheetPreset[] = LABEL_PRESETS): void {
    const stmt = this.db.prepare(
      `INSERT INTO label_sheets
         (name, brand, code, page_w_mm, page_h_mm, label_w_mm, label_h_mm, cols, rows,
          margin_top_mm, margin_left_mm, gutter_x_mm, gutter_y_mm, is_preset, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name, brand = excluded.brand, code = excluded.code,
         page_w_mm = excluded.page_w_mm, page_h_mm = excluded.page_h_mm,
         label_w_mm = excluded.label_w_mm, label_h_mm = excluded.label_h_mm,
         cols = excluded.cols, rows = excluded.rows,
         margin_top_mm = excluded.margin_top_mm, margin_left_mm = excluded.margin_left_mm,
         gutter_x_mm = excluded.gutter_x_mm, gutter_y_mm = excluded.gutter_y_mm,
         is_preset = 1, updated_at = datetime('now')`,
    );
    this.transaction(() => {
      for (const p of presets) {
        stmt.run(
          p.name, p.brand, p.code, p.page_w_mm, p.page_h_mm, p.label_w_mm, p.label_h_mm,
          p.cols, p.rows, p.margin_top_mm, p.margin_left_mm, p.gutter_x_mm, p.gutter_y_mm,
          stableUuid(`label_sheet:${p.brand}:${p.code}`),
        );
      }
    });
  }
}

export const labelSheetRepository = new LabelSheetRepository();
