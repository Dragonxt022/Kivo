import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

export interface FiscalDocumentRow extends Row {
  id: number;
  model: string;
  serie: number;
  number: number;
  environment: number;
  key: string | null;
  status: string;
  sale_id: number | null;
  is_test: number;
  total_cents: number;
  protocol: string | null;
  cstat: number | null;
  motive: string | null;
  attempts: number;
  emitted_at: string;
  authorized_at: string | null;
}

export class FiscalDocumentRepository extends BaseRepository<FiscalDocumentRow> {
  constructor() {
    super('fiscal_documents');
  }

  findBySale(saleId: number): FiscalDocumentRow | undefined {
    return this.rawOne(
      `SELECT * FROM fiscal_documents
       WHERE sale_id = ? AND deleted_at IS NULL AND status <> 'cancelada'
       ORDER BY id DESC LIMIT 1`,
      saleId,
    ) as FiscalDocumentRow | undefined;
  }

  /** Existe nota válida (autorizada ou a caminho) para esta venda? Usado para barrar
   * o cancelamento da venda enquanto o documento fiscal continuar de pé. */
  hasLiveDocument(saleId: number): boolean {
    const row = this.rawOne(
      `SELECT 1 AS x FROM fiscal_documents
       WHERE sale_id = ? AND deleted_at IS NULL
         AND status IN ('pendente', 'enviando', 'autorizada', 'contingencia')
       LIMIT 1`,
      saleId,
    ) as { x: number } | undefined;
    return !!row;
  }

  /** Fila: pendentes cuja hora de retentativa já chegou. */
  dueForRetry(limit = 20): FiscalDocumentRow[] {
    return this.raw(
      `SELECT * FROM fiscal_documents
       WHERE deleted_at IS NULL AND status = 'pendente'
         AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       ORDER BY id ASC LIMIT ?`,
      limit,
    ) as FiscalDocumentRow[];
  }
}

export class FiscalSequenceRepository extends BaseRepository {
  constructor() {
    super('fiscal_sequences');
  }

  /**
   * Reserva o próximo número da série de forma atômica.
   *
   * O `UPDATE ... RETURNING` sob transação garante que dois caixas na mesma máquina nunca
   * levem o mesmo número — número repetido é rejeição na SEFAZ e trabalho manual de
   * inutilização depois.
   */
  reserveNext(model: string, serie: number, environment: number): number {
    return this.transaction(() => {
      this.rawRun(
        `INSERT INTO fiscal_sequences (model, serie, environment, next_number, uuid)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(model, serie, environment) DO NOTHING`,
        model,
        serie,
        environment,
        randomUUID(),
      );
      const row = this.rawOne(
        `UPDATE fiscal_sequences SET next_number = next_number + 1, updated_at = datetime('now')
         WHERE model = ? AND serie = ? AND environment = ?
         RETURNING next_number - 1 AS reserved`,
        model,
        serie,
        environment,
      ) as { reserved: number };
      return row.reserved;
    });
  }

  peek(model: string, serie: number, environment: number): number {
    const row = this.rawOne(
      'SELECT next_number FROM fiscal_sequences WHERE model = ? AND serie = ? AND environment = ?',
      model,
      serie,
      environment,
    ) as { next_number: number } | undefined;
    return row?.next_number ?? 1;
  }
}

export const fiscalDocumentRepository = new FiscalDocumentRepository();
export const fiscalSequenceRepository = new FiscalSequenceRepository();
