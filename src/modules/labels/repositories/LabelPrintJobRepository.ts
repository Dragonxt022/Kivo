import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

export interface LabelPrintJobRow extends Row {
  id: number;
  sheet_id: number | null;
  sheet_name: string;
  symbology: string;
  fields_json: string;
  payload_json: string;
  summary_json: string | null;
  total_labels: number;
  pages: number;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
}

class LabelPrintJobRepository extends BaseRepository<LabelPrintJobRow> {
  constructor() {
    super('label_print_jobs');
  }

  createJob(data: {
    sheetId: number | null;
    sheetName: string;
    symbology: string;
    fieldsJson: string;
    payloadJson: string;
    summaryJson: string;
    totalLabels: number;
    pages: number;
    userId: number | null;
    userName: string | null;
  }): number {
    return this.create({
      sheet_id: data.sheetId,
      sheet_name: data.sheetName,
      symbology: data.symbology,
      fields_json: data.fieldsJson,
      payload_json: data.payloadJson,
      summary_json: data.summaryJson,
      total_labels: data.totalLabels,
      pages: data.pages,
      user_id: data.userId,
      user_name: data.userName,
      uuid: randomUUID(),
    });
  }

  /** Impressões mais recentes primeiro. */
  listRecent(limit = 50): LabelPrintJobRow[] {
    const lim = Math.min(Math.max(1, Math.floor(limit)), 200);
    return this.raw(
      'SELECT * FROM label_print_jobs WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?',
      lim,
    );
  }
}

export const labelPrintJobRepository = new LabelPrintJobRepository();
